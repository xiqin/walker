'use strict';

const path = require('path');
const { createLogger } = require('../core/logger');

const logger = createLogger('attachment-service');

const DANGEROUS_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;
const DOT_DOT_RE = /\.\./g;

function sanitizeFilename(name) {
  let safe = name.replace(DOT_DOT_RE, '').replace(DANGEROUS_CHARS_RE, '_');
  if (!safe || safe === '_') safe = 'attachment';
  const ext = path.extname(safe);
  if (!ext) safe = safe + '.bin';
  return safe;
}

class AttachmentService {
  constructor(options) {
    this.dataDir = options.dataDir || '';
  }

  getInboundPath(sessionId, filename) {
    const safeName = sanitizeFilename(filename);
    const dir = path.join(this.dataDir, 'attachments', sessionId);
    return path.join(dir, safeName);
  }

  async saveInbound(sessionId, filename, buffer) {
    const filePath = this.getInboundPath(sessionId, filename);
    const dir = path.dirname(filePath);
    const fs = require('fs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buffer);
    logger.info('attachment saved', { sessionId, filename, filePath });
    return filePath;
  }

  async sendOutbound(feishuApi, chatId, filePath, caption) {
    logger.info('outbound attachment stub', { chatId, filePath });
  }
}

module.exports = { AttachmentService, sanitizeFilename };
