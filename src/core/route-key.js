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
