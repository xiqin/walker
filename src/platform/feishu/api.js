const https = require('https');
const { createLogger } = require('../../core/logger');

const logger = createLogger('feishu-api');
const MAX_TEXT_CHARS = 3500;

function splitTextChunks(text, maxChars) {
  const value = text == null ? '' : String(text);
  const limit = maxChars || MAX_TEXT_CHARS;
  if (value.length <= limit) return [value];

  const chunks = [];
  let remaining = value;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut > 0 && cut >= Math.floor(limit * 0.6)) cut += 1;
    else cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  chunks.push(remaining);
  return chunks;
}

/**
 * 飞书 API 客户端，封装与飞书开放平台的 HTTP 交互
 */
class FeishuApi {
  /**
   * 初始化飞书 API 客户端
   * @param {Object} options - 配置选项
   * @param {string} options.appId - 飞书应用 ID
   * @param {string} options.appSecret - 飞书应用密钥
   */
  constructor({ appId, appSecret }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.token = '';
    this.tokenExpiresAt = 0;
    this._tokenPromise = null;
  }

  /**
   * 获取飞书租户访问令牌，缓存未过期时直接返回，否则重新请求
   * 带并发去重保护，避免多个并发调用同时请求 token
   * @returns {Promise<string>} 租户访问令牌
   */
  async getTenantToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }
    if (this._tokenPromise) {
      return this._tokenPromise;
    }
    this._tokenPromise = this._fetchTenantToken();
    try {
      return await this._tokenPromise;
    } finally {
      this._tokenPromise = null;
    }
  }

  async _fetchTenantToken() {
    const body = JSON.stringify({ app_id: this.appId, app_secret: this.appSecret });
    const result = await this._request('POST', 'open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal', body);

    if (!result.tenant_access_token) {
      throw new Error('feishu token error: ' + JSON.stringify(result));
    }

    this.token = result.tenant_access_token;
    const expire = result.expire && result.expire > 300 ? result.expire : 7200;
    this.tokenExpiresAt = Date.now() + (expire - 300) * 1000;
    logger.info('tenant token refreshed', { expireIn: expire });
    return this.token;
  }

  /**
   * 以文本消息回复飞书消息或发送到指定群聊
   * @param {Object} replyCtx - 回复上下文，包含 messageId 或 chatId
   * @param {string} text - 回复文本内容
   * @returns {Promise<Object>} 飞书 API 返回结果
   */
  async replyText(replyCtx, text) {
    if (typeof replyCtx === 'string') replyCtx = { messageId: replyCtx };
    const token = await this.getTenantToken();
    const chunks = splitTextChunks(text);
    const results = [];
    if (replyCtx && replyCtx.messageId) {
      results.push(await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages/' + replyCtx.messageId + '/reply', JSON.stringify({
        msg_type: 'text',
        content: JSON.stringify({ text: chunks[0] }),
      }), token));
      if (chunks.length > 1 && replyCtx.chatId) {
        for (const chunk of chunks.slice(1)) {
          results.push(await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
            receive_id: replyCtx.chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          }), token));
        }
      }
      return results;
    }
    if (replyCtx && replyCtx.chatId) {
      for (const chunk of chunks) {
        results.push(await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
          receive_id: replyCtx.chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        }), token));
      }
      return results;
    }
    throw new Error('replyText: no messageId or chatId in replyCtx');
  }

  async sendText(chatId, text) {
    const token = await this.getTenantToken();
    const results = [];
    for (const chunk of splitTextChunks(text)) {
      results.push(await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      }), token));
    }
    return results;
  }

  /**
   * 以 markdown 卡片回复飞书消息或发送到指定群聊
   * 使用 v1 卡片 + div + lark_md 结构，飞书客户端支持 markdown 渲染
   * @param {Object} replyCtx - 回复上下文，包含 messageId 或 chatId
   * @param {string} text - markdown 文本内容
   * @returns {Promise<Object|Object[]>} 飞书 API 返回结果
   */
  async replyMarkdown(replyCtx, text) {
    if (typeof replyCtx === 'string') replyCtx = { messageId: replyCtx };
    const token = await this.getTenantToken();
    const chunks = splitTextChunks(text);
    const buildCard = (content) => ({ elements: [{ tag: 'div', text: { tag: 'lark_md', content } }] });
    const results = [];
    if (replyCtx && replyCtx.messageId) {
      results.push(await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages/' + replyCtx.messageId + '/reply', JSON.stringify({
        msg_type: 'interactive',
        content: JSON.stringify(buildCard(chunks[0])),
      }), token));
      if (chunks.length > 1 && replyCtx.chatId) {
        for (const chunk of chunks.slice(1)) {
          results.push(await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
            receive_id: replyCtx.chatId,
            msg_type: 'interactive',
            content: JSON.stringify(buildCard(chunk)),
          }), token));
        }
      }
      return results;
    }
    if (replyCtx && replyCtx.chatId) {
      for (const chunk of chunks) {
        results.push(await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
          receive_id: replyCtx.chatId,
          msg_type: 'interactive',
          content: JSON.stringify(buildCard(chunk)),
        }), token));
      }
      return results;
    }
    throw new Error('replyMarkdown: no messageId or chatId in replyCtx');
  }

  /**
   * 以 markdown 卡片发送到指定群聊
   * @param {string} chatId - 群聊 ID
   * @param {string} text - markdown 文本内容
   * @returns {Promise<Object[]>} 飞书 API 返回结果列表
   */
  async sendMarkdown(chatId, text) {
    const token = await this.getTenantToken();
    const results = [];
    const buildCard = (content) => ({ elements: [{ tag: 'div', text: { tag: 'lark_md', content } }] });
    for (const chunk of splitTextChunks(text)) {
      results.push(await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(buildCard(chunk)),
      }), token));
    }
    return results;
  }

  async replyCard(replyCtx, card) {
    if (typeof replyCtx === 'string') replyCtx = { messageId: replyCtx };
    const token = await this.getTenantToken();
    const cardContent = JSON.stringify(card);
    const sendByChat = () => this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
      receive_id: replyCtx.chatId,
      msg_type: 'interactive',
      content: cardContent,
    }), token);
    let result;
    if (replyCtx && replyCtx.messageId) {
      try {
        result = await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages/' + replyCtx.messageId + '/reply', JSON.stringify({
          msg_type: 'interactive',
          content: cardContent,
        }), token);
      } catch (err) {
        if (!replyCtx.chatId) throw err;
        logger.warn('reply card failed, fallback to chat message', {
          messageId: replyCtx.messageId,
          chatId: replyCtx.chatId,
          status: err.status,
          code: err.code,
          error: err.message,
        });
        result = await sendByChat();
      }
    } else if (replyCtx && replyCtx.chatId) {
      result = await sendByChat();
    } else {
      throw new Error('replyCard: no messageId or chatId');
    }

    const messageId = result && result.data && result.data.message_id;
    if (!messageId) {
      throw new Error('feishu replyCard missing data.message_id: ' + JSON.stringify(result));
    }
    return messageId;
  }

  /**
   * 更新已有卡片消息的内容
   * @param {string} messageId - 卡片消息 ID
   * @param {Object} card - 新的飞书卡片 JSON 结构
   * @returns {Promise<Object>} 飞书 API 返回结果
   */
  async patchCard(messageId, card) {
    const token = await this.getTenantToken();
    const cardContent = JSON.stringify(card);
    return this._request('PATCH', 'open.feishu.cn', '/open-apis/im/v1/messages/' + messageId, JSON.stringify({
      content: cardContent,
    }), token);
  }

  /**
   * 为指定消息添加表情回应
   * @param {string} messageId - 消息 ID
   * @param {string} emoji - 表情符号名称
   * @returns {Promise<Object|void>} 飞书 API 返回结果，失败时仅输出警告
   */
  async addReaction(messageId, emoji) {
    try {
      const token = await this.getTenantToken();
      return await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages/' + messageId + '/reactions', JSON.stringify({
        reaction_type: { emoji_type: emoji },
      }), token);
    } catch (err) {
      logger.warn('add reaction failed', { messageId, emoji, error: err.message });
    }
  }

  /**
   * 内部方法：发送 HTTPS 请求到飞书开放平台
   * @param {string} method - HTTP 方法
   * @param {string} host - 目标主机名
   * @param {string} path - API 路径
   * @param {string|null} body - 请求体 JSON 字符串
   * @param {string} [authToken] - 认证令牌
   * @returns {Promise<Object>} 解析后的 JSON 响应
   */
  async _request(method, host, path, body, authToken) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) { headers['Authorization'] = 'Bearer ' + authToken; }
      const req = https.request({ method, hostname: host, path, headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch (_) {
            reject(new Error('feishu api parse error: ' + data.slice(0, 200)));
            return;
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error('feishu api http error: ' + method + ' ' + path + ' status=' + res.statusCode);
            err.method = method;
            err.path = path;
            err.status = res.statusCode;
            err.code = parsed && parsed.code;
            err.response = parsed;
            reject(err);
            return;
          }

          if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'code') && parsed.code !== 0) {
            const err = new Error('feishu api business error: ' + method + ' ' + path + ' code=' + parsed.code);
            err.method = method;
            err.path = path;
            err.status = res.statusCode;
            err.code = parsed.code;
            err.response = parsed;
            reject(err);
            return;
          }

          resolve(parsed);
        });
      });
      req.on('error', (err) => { reject(err); });
      if (typeof req.setTimeout === 'function') {
        req.setTimeout(30000, () => {
          req.destroy(new Error('feishu api request timeout: ' + method + ' ' + path));
        });
      }
      if (body) { req.write(body); }
      req.end();
    });
  }
}

FeishuApi.MAX_TEXT_CHARS = MAX_TEXT_CHARS;
FeishuApi.splitTextChunks = splitTextChunks;

module.exports = { FeishuApi, splitTextChunks, MAX_TEXT_CHARS };
