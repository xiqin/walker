/**
 * 解析飞书消息事件数据，提取聊天 ID、消息 ID、发送者信息等字段
 * @param {Object} data - 飞书原始事件数据
 * @returns {Object} 标准化的消息事件对象
 */
function parseMessageEvent(data) {
  const sender = data.sender || {};
  const senderId = sender.sender_id || {};
  const msg = data.message || {};

  let text = '';
  if (msg.message_type === 'text' && msg.content) {
    try {
      const content = JSON.parse(msg.content);
      text = content.text || '';
    } catch (_) {
      text = msg.content;
    }
    text = stripBotMentionPrefix(text, msg.mentions || []);
  }

  return {
    chatId: msg.chat_id || '',
    messageId: msg.message_id || '',
    rootId: msg.root_id || '',
    parentId: msg.parent_id || '',
    openId: senderId.open_id || '',
    messageType: msg.message_type || 'text',
    text,
    createTime: msg.create_time ? Number(msg.create_time) : undefined,
  };
}

function stripBotMentionPrefix(text, mentions) {
  let cleaned = text || '';
  const mentionKeys = (mentions || [])
    .map((mention) => mention && mention.key)
    .filter(Boolean);

  for (const key of mentionKeys) {
    const pattern = new RegExp('^\\s*' + escapeRegExp(key) + '\\s*');
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '');
      return cleaned.trimStart();
    }
  }

  return cleaned.replace(/^\s*@_user_\d+\s*/, '').trimStart();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析飞书卡片交互事件数据，提取操作类型、用户信息和表单值
 * @param {Object} data - 飞书卡片交互原始数据
 * @returns {Object} 标准化的卡片动作对象
 */
function parseCardAction(data) {
  const action = data.action || {};
  const context = data.context || {};
  const value = action.value || {};
  const formValue = action.form_value || value.form_value || data.form_value || null;
  const operator = data.operator || {};

  return {
    openId: context.open_id || operator.open_id || operator.openId || '',
    chatId: context.chat_id || context.open_chat_id || data.chatId || data.chat_id || data.open_chat_id || '',
    messageId: context.message_id || context.open_message_id || data.messageId || data.message_id || data.open_message_id || '',
    action: value.action || '',
    formValue,
    routeKey: value.routeKey || '',
  };
}

module.exports = { parseMessageEvent, parseCardAction };
