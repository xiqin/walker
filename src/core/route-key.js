/**
 * 根据消息信息和路由模式构建路由键，用于将消息映射到对应会话
 * @param {Object} message - 消息对象，包含 chatId、openId、rootId、parentId、messageId 等字段
 * @param {string} [mode='thread'] - 路由模式：thread（按消息线程）、user（按用户）、channel（按频道）
 * @returns {string} 路由键字符串，格式为 feishu:<chatId>:<模式特定部分>
 */
function buildRouteKey(message, mode) {
  mode = mode || 'thread';

  const chatId = message.chatId || 'default';
  const openId = message.openId || chatId;

  if (mode === 'thread') {
    const rootId = message.rootId || message.parentId || message.messageId || chatId;
    return 'feishu:' + chatId + ':root:' + rootId;
  }

  if (mode === 'user') {
    return 'feishu:' + chatId + ':' + openId;
  }

  if (mode === 'channel') {
    return 'feishu:' + chatId;
  }

  return 'feishu:' + chatId + ':' + openId;
}

module.exports = { buildRouteKey };
