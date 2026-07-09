const https = require('https');
const { createLogger } = require('../../core/logger');

const logger = createLogger('feishu-api');

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
  }

  /**
   * 获取飞书租户访问令牌，缓存未过期时直接返回，否则重新请求
   * @returns {Promise<string>} 租户访问令牌
   */
  async getTenantToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }

    const body = JSON.stringify({ app_id: this.appId, app_secret: this.appSecret });
    const result = await this._request('POST', 'open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal', body);

    if (!result.tenant_access_token) {
      throw new Error('feishu token error: ' + JSON.stringify(result));
    }

    this.token = result.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (result.expire - 300) * 1000;
    logger.info('tenant token refreshed', { expireIn: result.expire });
    return this.token;
  }

  /**
   * 以文本消息回复飞书消息或发送到指定群聊
   * @param {Object} replyCtx - 回复上下文，包含 messageId 或 chatId
   * @param {string} text - 回复文本内容
   * @returns {Promise<Object>} 飞书 API 返回结果
   */
  async replyText(replyCtx, text) {
    const token = await this.getTenantToken();
    if (replyCtx && replyCtx.messageId) {
      return this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages/' + replyCtx.messageId + '/reply', JSON.stringify({
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }), token);
    }
    if (replyCtx && replyCtx.chatId) {
      return this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
        receive_id: replyCtx.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }), token);
    }
    throw new Error('replyText: no messageId or chatId in replyCtx');
  }

  /**
   * 向指定群聊发送文本消息
   * @param {string} chatId - 群聊 ID
   * @param {string} text - 消息文本内容
   * @returns {Promise<Object>} 飞书 API 返回结果
   */
  async sendText(chatId, text) {
    const token = await this.getTenantToken();
    return this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }), token);
  }

  /**
   * 以卡片消息回复飞书消息或发送到指定群聊，返回卡片消息 ID
   * @param {Object} replyCtx - 回复上下文，包含 messageId 或 chatId
   * @param {Object} card - 飞书卡片 JSON 结构
   * @returns {Promise<string>} 卡片消息 ID
   */
  async replyCard(replyCtx, card) {
    const token = await this.getTenantToken();
    const cardContent = JSON.stringify(card);
    if (replyCtx && replyCtx.messageId) {
      const result = await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages/' + replyCtx.messageId + '/reply', JSON.stringify({
        msg_type: 'interactive',
        content: cardContent,
      }), token);
      return result && result.data && result.data.message_id || 'om_card_stub';
    }
    if (replyCtx && replyCtx.chatId) {
      const result = await this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
        receive_id: replyCtx.chatId,
        msg_type: 'interactive',
        content: cardContent,
      }), token);
      return result && result.data && result.data.message_id || 'om_card_stub';
    }
    throw new Error('replyCard: no messageId or chatId');
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
    const token = await this.getTenantToken();
    try {
      return this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages/' + messageId + '/reactions', JSON.stringify({
        reaction_type: { emoji: emoji },
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
          try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('feishu api parse error: ' + data.slice(0, 200))); }
        });
      });
      req.on('error', (err) => { reject(err); });
      if (body) { req.write(body); }
      req.end();
    });
  }
}

module.exports = { FeishuApi };
