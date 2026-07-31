const test = require('node:test');
const assert = require('node:assert/strict');
const { PlatformDriver, validatePlatformEvent, assertPlatformEvent } = require('../src/platforms/platform-driver');
const { PlatformRegistry } = require('../src/platforms/platform-registry');

function makeDriver() {
  return {
    start: async () => 'started',
    stop: async () => 'stopped',
    sendMessage: async () => 'sent',
    updateMessage: async () => 'updated',
    sendCard: async () => 'card',
    uploadAttachment: async () => 'file',
  };
}

test('PlatformDriver 定义标准方法占位', async () => {
  const driver = new PlatformDriver({ platform: 'test' });
  assert.equal(driver.platform, 'test');
  await assert.rejects(driver.start(), /not implemented/);
  await assert.rejects(driver.sendMessage(), /not implemented/);
});

test('validatePlatformEvent 接受字段完整的标准事件', () => {
  const event = {
    platform: 'feishu', type: 'message', messageId: 'om_1', routeKey: 'feishu:oc_1:root:oc_1', userId: 'ou_1', text: 'hello', attachments: [], raw: {},
  };
  assert.deepEqual(validatePlatformEvent(event), { ok: true });
  assert.equal(assertPlatformEvent(event), event);
});

test('REQ-005-B02: validatePlatformEvent 允许空文本', () => {
  const event = {
    platform: 'feishu', type: 'message', messageId: 'om_1', routeKey: 'feishu:oc_1:root:oc_1', userId: 'ou_1', text: '', attachments: [], raw: {},
  };
  assert.deepEqual(validatePlatformEvent(event), { ok: true });
});

test('validatePlatformEvent 拒绝缺失必要字段的事件', () => {
  const result = validatePlatformEvent({ platform: 'feishu', type: 'message', messageId: 'om_1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_REQUEST');
  assert.match(result.errors.join('\n'), /missing routeKey/);
});

test('REQ-005-B03: validatePlatformEvent 仍拒绝不可恢复结构', () => {
  const result = validatePlatformEvent({ platform: 'feishu', type: 'message', messageId: '', routeKey: '', userId: 'ou_1', text: '', attachments: [], raw: {} });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /messageId is required/);
  assert.match(result.errors.join('\n'), /routeKey is required/);
});

test('PlatformRegistry 管理驱动状态', async () => {
  const registry = new PlatformRegistry();
  const driver = makeDriver();
  registry.register('feishu', driver);
  assert.deepEqual(registry.list(), ['feishu']);
  assert.equal(registry.get('feishu'), driver);
  assert.equal(registry.status('feishu').status, 'registered');
  assert.equal(await registry.start('feishu'), 'started');
  assert.equal(registry.status('feishu').status, 'started');
  assert.equal(await registry.stop('feishu'), 'stopped');
  assert.equal(registry.status('feishu').status, 'stopped');
});

test('PlatformRegistry 禁止注册或启动真实其他平台接入', async () => {
  const registry = new PlatformRegistry();
  assert.throws(() => registry.register('telegram', makeDriver()), /not allowed/);
  await assert.rejects(registry.start('slack'), /not allowed/);
});
