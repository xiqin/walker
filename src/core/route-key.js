/**
 * 根据消息信息和路由模式构建路由键，用于将消息映射到对应会话
 * @param {Object} message - 消息对象，包含 chatId、openId、rootId、parentId、messageId 等字段
 * @param {string} [mode='thread'] - 路由模式：thread（按消息线程）、user（按用户）、channel（按频道）
 * @param {string} [platform='feishu'] - 平台前缀，用于多平台支持
 * @returns {string} 路由键字符串，格式为 <platform>:<chatId>:<模式特定部分>
 */
function buildRouteKey(message, mode, platform) {
  const normalizedMode = mode != null ? mode : 'thread';
  const msg = message != null ? message : {};
  const prefix = (platform != null && platform) || 'feishu';

  const chatId = msg.chatId || 'default';
  const openId = msg.openId || chatId;

  if (normalizedMode === 'thread') {
    const rootId = msg.rootId;
    if (rootId) return prefix + ':' + chatId + ':root:' + rootId;
    return prefix + ':' + chatId + ':root:' + chatId;
  }

  if (normalizedMode === 'user') {
    return prefix + ':' + chatId + ':' + openId;
  }

  if (normalizedMode === 'channel') {
    return prefix + ':' + chatId;
  }

  return prefix + ':' + chatId + ':' + openId;
}

module.exports = { buildRouteKey };
