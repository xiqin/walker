const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessageEvent, parseCardAction } = require('../src/platform/feishu/events');

test('parseMessageEvent 提取文本消息字段', () => {
  const data = {
    sender: { sender_id: { open_id: 'ou_123', user_id: 'uid_456' } },
    message: {
      message_id: 'om_msg1',
      chat_id: 'oc_chat1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello world' }),
      root_id: 'om_root1',
      parent_id: 'om_parent1',
      create_time: '1783579441000',
    },
  };
  const parsed = parseMessageEvent(data);
  assert.equal(parsed.chatId, 'oc_chat1');
  assert.equal(parsed.messageId, 'om_msg1');
  assert.equal(parsed.rootId, 'om_root1');
  assert.equal(parsed.parentId, 'om_parent1');
  assert.equal(parsed.openId, 'ou_123');
  assert.equal(parsed.messageType, 'text');
  assert.equal(parsed.text, 'hello world');
  assert.equal(parsed.createTime, 1783579441000);
});

test('parseMessageEvent 清理群聊 mention 前缀命令', () => {
  const data = {
    sender: { sender_id: { open_id: 'ou_123' } },
    message: {
      message_id: 'om_msg1',
      chat_id: 'oc_chat1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 /list' }),
      mentions: [{ key: '@_user_1' }],
    },
  };
  const parsed = parseMessageEvent(data);
  assert.equal(parsed.text, '/list');
});

test('parseMessageEvent 普通命令保持不变', () => {
  const data = {
    sender: { sender_id: { open_id: 'ou_123' } },
    message: {
      message_id: 'om_msg2',
      chat_id: 'oc_chat1',
      message_type: 'text',
      content: JSON.stringify({ text: '/list' }),
    },
  };
  const parsed = parseMessageEvent(data);
  assert.equal(parsed.text, '/list');
});

test('parseMessageEvent text 无 root_id 和 parent_id', () => {
  const data = {
    sender: { sender_id: { open_id: 'ou_abc' } },
    message: {
      message_id: 'om_msg2',
      chat_id: 'oc_chat2',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'simple msg' }),
      root_id: '',
      parent_id: '',
      create_time: '0',
    },
  };
  const parsed = parseMessageEvent(data);
  assert.equal(parsed.rootId, '');
  assert.equal(parsed.parentId, '');
  assert.equal(parsed.createTime, 0);
});

test('parseCardAction 提取按钮 action', () => {
  const data = {
    action: {
      value: { action: 'cmd:/use wks_abc123' },
    },
    context: {
      open_id: 'ou_user1',
      chat_id: 'oc_chat1',
      message_id: 'om_msg1',
    },
  };
  const parsed = parseCardAction(data);
  assert.equal(parsed.openId, 'ou_user1');
  assert.equal(parsed.chatId, 'oc_chat1');
  assert.equal(parsed.messageId, 'om_msg1');
  assert.equal(parsed.action, 'cmd:/use wks_abc123');
});

test('parseCardAction 支持飞书卡片回调 open_* 上下文字段', () => {
  const data = {
    action: {
      value: { action: 'cmd:/use wks_abc123' },
    },
    context: {
      open_id: 'ou_user1',
      open_chat_id: 'oc_chat1',
      open_message_id: 'om_msg1',
    },
  };
  const parsed = parseCardAction(data);
  assert.equal(parsed.openId, 'ou_user1');
  assert.equal(parsed.chatId, 'oc_chat1');
  assert.equal(parsed.messageId, 'om_msg1');
  assert.equal(parsed.action, 'cmd:/use wks_abc123');
});

test('parseCardAction 支持飞书卡片回调 operator 用户字段', () => {
  const data = {
    action: {
      value: { action: 'cmd:/answer req_1:0 --form wks_1' },
    },
    context: {
      open_chat_id: 'oc_chat1',
      open_message_id: 'om_msg1',
    },
    operator: {
      open_id: 'ou_user1',
    },
  };
  const parsed = parseCardAction(data);
  assert.equal(parsed.openId, 'ou_user1');
  assert.equal(parsed.chatId, 'oc_chat1');
  assert.equal(parsed.messageId, 'om_msg1');
  assert.equal(parsed.action, 'cmd:/answer req_1:0 --form wks_1');
});

test('parseCardAction 提取 form value', () => {
  const data = {
    action: {
      value: { action: 'cmd:/stop wks_xyz' },
      form_value: { confirm: 'yes' },
    },
    context: {
      open_id: 'ou_2',
      chat_id: 'oc_2',
    },
  };
  const parsed = parseCardAction(data);
  assert.equal(parsed.action, 'cmd:/stop wks_xyz');
  assert.deepEqual(parsed.formValue, { confirm: 'yes' });
});

test('parseCardAction 兼容 action.value 内的 form_value', () => {
  const data = {
    action: {
      value: {
        action: 'cmd:/answer req_1:0 --form wks_1',
        form_value: { question_selected: 'option_0' },
      },
    },
    context: {
      open_id: 'ou_2',
      chat_id: 'oc_2',
    },
  };
  const parsed = parseCardAction(data);
  assert.equal(parsed.action, 'cmd:/answer req_1:0 --form wks_1');
  assert.deepEqual(parsed.formValue, { question_selected: 'option_0' });
});

test('parseCardAction 兼容事件顶层 form_value', () => {
  const data = {
    action: {
      value: { action: 'cmd:/answer req_1:0 --form wks_1' },
    },
    form_value: { question_custom: '自定义答案' },
    context: {
      open_id: 'ou_2',
      chat_id: 'oc_2',
    },
  };
  const parsed = parseCardAction(data);
  assert.equal(parsed.action, 'cmd:/answer req_1:0 --form wks_1');
  assert.deepEqual(parsed.formValue, { question_custom: '自定义答案' });
});

test('parseCardAction 提取嵌入的 routeKey', () => {
  const data = {
    action: {
      value: { action: 'cmd:/use wks_abc123', routeKey: 'feishu:oc_chat1:root:om_root1' },
    },
    context: {
      open_id: 'ou_user1',
      chat_id: 'oc_chat1',
      message_id: 'om_msg1',
    },
  };
  const parsed = parseCardAction(data);
  assert.equal(parsed.routeKey, 'feishu:oc_chat1:root:om_root1');
});

test('parseCardAction 无 routeKey 时返回空字符串', () => {
  const data = {
    action: {
      value: { action: 'cmd:/use wks_abc123' },
    },
    context: {
      open_id: 'ou_user1',
      chat_id: 'oc_chat1',
    },
  };
  const parsed = parseCardAction(data);
  assert.equal(parsed.routeKey, '');
});

test('parseMessageEvent 缺少 create_time 时为 undefined', () => {
  const data = {
    sender: { sender_id: { open_id: 'ou_a' } },
    message: {
      message_id: 'om_m',
      chat_id: 'oc_c',
      message_type: 'text',
      content: JSON.stringify({ text: 'test' }),
    },
  };
  const parsed = parseMessageEvent(data);
  assert.equal(parsed.createTime, undefined);
});
