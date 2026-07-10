const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRouteKey } = require('../src/core/route-key');

test('thread 模式：rootId 优先', () => {
  const msg = { chatId: 'oc_abc', rootId: 'om_root', parentId: 'om_parent', messageId: 'om_msg', openId: 'ou_user' };
  assert.equal(buildRouteKey(msg, 'thread'), 'feishu:oc_abc:root:om_root');
});

test('thread 模式：无 rootId 时忽略 parentId 并退到 chatId', () => {
  const msg = { chatId: 'oc_abc', rootId: '', parentId: 'om_parent', messageId: 'om_msg', openId: 'ou_user' };
  assert.equal(buildRouteKey(msg, 'thread'), 'feishu:oc_abc:root:oc_abc');
});

test('thread 模式：无 rootId 和 parentId 时用 chatId', () => {
  const msg = { chatId: 'oc_abc', rootId: '', parentId: '', messageId: 'om_msg', openId: 'ou_user' };
  assert.equal(buildRouteKey(msg, 'thread'), 'feishu:oc_abc:root:oc_abc');
});

test('user 模式：chatId + openId', () => {
  const msg = { chatId: 'oc_abc', openId: 'ou_user' };
  assert.equal(buildRouteKey(msg, 'user'), 'feishu:oc_abc:ou_user');
});

test('channel 模式：仅 chatId', () => {
  const msg = { chatId: 'oc_abc', openId: 'ou_user' };
  assert.equal(buildRouteKey(msg, 'channel'), 'feishu:oc_abc');
});

test('默认 mode 为 thread', () => {
  const msg = { chatId: 'oc_abc', rootId: 'om_root', openId: 'ou_user' };
  assert.equal(buildRouteKey(msg), 'feishu:oc_abc:root:om_root');
});

test('chatId 缺失时使用 default', () => {
  const msg = { openId: 'ou_user' };
  assert.equal(buildRouteKey(msg, 'user'), 'feishu:default:ou_user');
});

test('openId 缺失时 user 模式回退到 chatId', () => {
  const msg = { chatId: 'oc_abc' };
  assert.equal(buildRouteKey(msg, 'user'), 'feishu:oc_abc:oc_abc');
});
