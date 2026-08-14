/**
 * 解析飞书消息事件数据，提取聊天 ID、消息 ID、发送者信息等字段
 * @param {Object} data - 飞书原始事件数据
 * @returns {Object} 标准化的消息事件对象
 */
function parseMessageEvent(data) {
  const event = data && data.event && typeof data.event === 'object' ? data.event : (data || {});
  const sender = event.sender || {};
  const senderId = sender.sender_id || {};
  const msg = event.message || {};

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
    rootId: msg.root_id || msg.rootId || msg.thread_id || msg.threadId || '',
    threadId: msg.thread_id || msg.threadId || '',
    parentId: msg.parent_id || msg.parentId || msg.parent_message_id || msg.parentMessageId || msg.quote_message_id || msg.quoteMessageId || '',
    openId: senderId.open_id || senderId.user_id || senderId.union_id || '',
    messageType: msg.message_type || 'text',
    text,
    createTime: msg.create_time ? Number(msg.create_time) : undefined,
  };
}

function toFeishuPlatformEvent(parsed, options) {
  const event = parsed || {};
  const messageId = event.messageId || event.message_id || '';
  const chatId = event.chatId || event.chat_id || '';
  const openId = event.openId || event.userId || event.user_id || event.union_id || '';
  return {
    platform: 'feishu',
    type: 'message',
    messageId,
    routeKey: options && options.routeKey || event.routeKey || '',
    userId: openId,
    text: event.text !== undefined ? String(event.text) : '',
    attachments: event.attachments || [],
    raw: options && options.raw || event.raw || event,
    chatId,
    openId,
    rootId: event.rootId || event.root_id || '',
    threadId: event.threadId || event.thread_id || '',
    parentId: event.parentId || event.parent_id || '',
    messageType: event.messageType || event.message_type || 'text',
    createTime: event.createTime || event.create_time,
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

module.exports = { parseMessageEvent, toFeishuPlatformEvent, parseCardAction };
