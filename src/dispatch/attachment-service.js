'use strict';

const path = require('path');
const { createLogger } = require('../core/logger');

const logger = createLogger('attachment-service');

/** 匹配文件名中危险字符的正则表达式 */
const DANGEROUS_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;
/** 匹配路径遍历字符的正则表达式 */
const DOT_DOT_RE = /\.\./g;

/**
 * 清理文件名中的危险字符和路径遍历，确保文件名安全
 * @param {string} name - 原始文件名
 * @returns {string} 清理后的安全文件名，无扩展名时追加 .bin
 */
function sanitizeFilename(name) {
  let safe = name.replace(DOT_DOT_RE, '').replace(DANGEROUS_CHARS_RE, '_');
  if (!safe || safe === '_') safe = 'attachment';
  const ext = path.extname(safe);
  if (!ext) safe = safe + '.bin';
  return safe;
}

/**
 * 附件管理服务，处理消息附件的存储和发送
 */
class AttachmentService {
  /**
   * 初始化附件服务
   * @param {Object} options - 配置选项
   * @param {string} [options.dataDir] - 数据存储目录路径
   */
  constructor(options) {
    this.dataDir = options.dataDir || '';
  }

  /**
   * 获取入站附件的存储路径
   * @param {string} sessionId - 会话 ID
   * @param {string} filename - 原始文件名
   * @returns {string} 安全的文件存储绝对路径
   */
  getInboundPath(sessionId, filename) {
    const safeName = sanitizeFilename(filename);
    const dir = path.join(this.dataDir, 'attachments', sessionId);
    return path.join(dir, safeName);
  }

  /**
   * 保存入站附件到本地文件系统
   * @param {string} sessionId - 会话 ID
   * @param {string} filename - 原始文件名
   * @param {Buffer} buffer - 文件内容缓冲区
   * @returns {Promise<string>} 保存后的文件路径
   */
  async saveInbound(sessionId, filename, buffer) {
    const filePath = this.getInboundPath(sessionId, filename);
    const dir = path.dirname(filePath);
    const fs = require('fs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buffer);
    logger.info('attachment saved', { sessionId, filename, filePath });
    return filePath;
  }

  /**
   * 发送出站附件到飞书对话（当前为占位实现）
   * @param {Object} feishuApi - 飞书 API 实例
   * @param {string} chatId - 飞书群聊 ID
   * @param {string} filePath - 本地文件路径
   * @param {string} caption - 附件说明文字
   * @returns {Promise<void>}
   */
  async sendOutbound(feishuApi, chatId, filePath, caption) {
    logger.info('outbound attachment stub', { chatId, filePath });
  }
}

module.exports = { AttachmentService, sanitizeFilename };
