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
