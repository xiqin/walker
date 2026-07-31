const test = require('node:test');
const assert = require('node:assert/strict');
const { FeishuPlatformDriver } = require('../src/platforms/feishu-platform-driver');

test('FeishuPlatformDriver 将飞书消息转成标准 platform event', () => {
  const events = [];
  const driver = new FeishuPlatformDriver({ routeMode: 'thread', onEvent: (event) => events.push(event) });
  const event = driver.toPlatformEvent({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_1', chat_id: 'oc_1', root_id: 'om_root', message_type: 'text', content: JSON.stringify({ text: 'hello' }), create_time: '123' },
  });
  assert.deepEqual({
    platform: event.platform,
    type: event.type,
    messageId: event.messageId,
    routeKey: event.routeKey,
    userId: event.userId,
    text: event.text,
    attachments: event.attachments,
  }, {
    platform: 'feishu',
    type: 'message',
    messageId: 'om_1',
    routeKey: 'feishu:oc_1:root:om_root',
    userId: 'ou_1',
    text: 'hello',
    attachments: [],
  });
  assert.equal(event.raw.message.message_id, 'om_1');
  assert.equal(events.length, 0);
});

test('REQ-005-B01: FeishuPlatformDriver 使用 user_id 作为 open_id fallback', () => {
  const driver = new FeishuPlatformDriver({ routeMode: 'thread' });
  const event = driver.toPlatformEvent({
    sender: { sender_id: { user_id: 'uid_1' } },
    message: { message_id: 'om_1', chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: 'hello' }) },
  });
  assert.equal(event.userId, 'uid_1');
  assert.equal(event.openId, 'uid_1');
});

test('REQ-005-B01: FeishuPlatformDriver 使用 union_id 作为 sender fallback', () => {
  const driver = new FeishuPlatformDriver({ routeMode: 'thread' });
  const event = driver.toPlatformEvent({
    sender: { sender_id: { union_id: 'un_1' } },
    message: { message_id: 'om_1', chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: 'hello' }) },
  });
  assert.equal(event.userId, 'un_1');
});

test('REQ-005-B01: FeishuPlatformDriver 兼容已标准化事件 userId 字段', () => {
  const driver = new FeishuPlatformDriver({ routeMode: 'thread' });
  const event = driver.toPlatformEvent({
    messageId: 'om_1', routeKey: 'feishu:oc_1:root:oc_1', userId: 'ou_standard', text: 'hello', attachments: [], raw: {},
  });
  assert.equal(event.userId, 'ou_standard');
  assert.equal(event.routeKey, 'feishu:oc_1:root:oc_1');
});

test('FeishuPlatformDriver 发送失败可观察并继续抛给调用方', async () => {
  const observed = [];
  const driver = new FeishuPlatformDriver({
    api: { replyText: async () => { throw new Error('send failed'); } },
    onEvent: (event) => observed.push(event),
  });
  await assert.rejects(driver.sendMessage({ messageId: 'om_1' }, 'hello'), /send failed/);
  assert.equal(observed[0].type, 'platform.delivery_failed');
  assert.equal(observed[0].data.method, 'sendMessage');
});

test('FeishuPlatformDriver adapter 错误可观察', () => {
  const observed = [];
  const driver = new FeishuPlatformDriver({ onEvent: (event) => observed.push(event) });
  assert.throws(() => driver.toPlatformEvent({ message: { message_id: 'om_bad', message_type: 'text', content: '{}' } }), /invalid platform event/);
  assert.equal(observed[0].type, 'platform.adapter_error');
});
