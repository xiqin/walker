const https = require('https');
const { createLogger } = require('../../core/logger');

const logger = createLogger('feishu-api');

class FeishuApi {
  constructor({ appId, appSecret }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.token = '';
    this.tokenExpiresAt = 0;
  }

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

  async sendText(chatId, text) {
    const token = await this.getTenantToken();
    return this._request('POST', 'open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }), token);
  }

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

  async patchCard(messageId, card) {
    const token = await this.getTenantToken();
    const cardContent = JSON.stringify(card);
    return this._request('PATCH', 'open.feishu.cn', '/open-apis/im/v1/messages/' + messageId, JSON.stringify({
      content: cardContent,
    }), token);
  }

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
