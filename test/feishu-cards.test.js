const test = require('node:test');
const assert = require('node:assert/strict');
const {
  renderSessionListCard,
  renderUnboundRouteCard,
  renderAttachableSessionCard,
  renderErrorCard,
  buildButtonValue,
  buildCommandValue,
} = require('../src/platform/feishu/cards');

test('renderSessionListCard 空列表时显示提示', () => {
  const card = renderSessionListCard([], null);
  assert.ok(card.header);
  assert.ok(card.elements);
  assert.ok(card.elements.some((el) => el.tag === 'div'));
});

test('renderSessionListCard 包含 session 状态和按钮', () => {
  const sessions = [
    { id: 'wks_abc1', title: 'session 1', agent: 'opencode', status: 'idle', cwd: '/home/user', updatedAt: Date.now() },
    { id: 'wks_abc2', title: 'session 2', agent: 'opencode', status: 'running', cwd: '/home/user2', updatedAt: Date.now() },
  ];
  const card = renderSessionListCard(sessions, 'wks_abc1');
  assert.ok(card.header);
  assert.ok(card.elements.length >= 2);
  const actionEl = card.elements.find((el) => el.tag === 'action');
  assert.ok(actionEl, 'card should have action element');
  assert.ok(actionEl.actions.length > 0, 'action should have buttons');
});

test('renderSessionListCard 当前 session 有标记', () => {
  const sessions = [
    { id: 'wks_abc1', title: 'session 1', agent: 'opencode', status: 'idle', cwd: '/home/user', updatedAt: Date.now() },
  ];
  const card = renderSessionListCard(sessions, 'wks_abc1');
  const colEl = card.elements.find((el) => el.tag === 'column_set');
  assert.ok(colEl);
  const textEl = colEl.columns[0].elements[0];
  assert.ok(textEl.text.content.includes('wks_abc1'));
  assert.ok(textEl.text.content.includes('idle'));
  assert.ok(textEl.text.content.includes('当前绑定'));
});

test('renderSessionListCard running 状态显示蓝色', () => {
  const sessions = [
    { id: 'wks_run1', title: 'running session', agent: 'opencode', status: 'running', cwd: '/home/user', updatedAt: Date.now() },
  ];
  const card = renderSessionListCard(sessions, null);
  const colEl = card.elements.find((el) => el.tag === 'column_set');
  const textEl = colEl.columns[0].elements[0];
  assert.ok(textEl.text.content.includes('running'));
});

test('buildButtonValue /use 编码正确', () => {
  const val = buildButtonValue('cmd:/use', 'wks_abc1');
  assert.deepEqual(val, { action: 'cmd:/use wks_abc1' });
});

test('buildButtonValue /stop 编码正确', () => {
  const val = buildButtonValue('cmd:/stop', 'wks_abc2');
  assert.deepEqual(val, { action: 'cmd:/stop wks_abc2' });
});

test('buildButtonValue /delete 编码正确', () => {
  const val = buildButtonValue('cmd:/delete', 'wks_xyz');
  assert.deepEqual(val, { action: 'cmd:/delete wks_xyz' });
});

test('buildButtonValue 携带 routeKey', () => {
  const val = buildButtonValue('cmd:/use', 'wks_abc1', 'feishu:oc_chat1:root:om_root1');
  assert.deepEqual(val, { action: 'cmd:/use wks_abc1', routeKey: 'feishu:oc_chat1:root:om_root1' });
});

test('buildCommandValue /attach 编码正确', () => {
  const val = buildCommandValue('cmd:/attach');
  assert.deepEqual(val, { action: 'cmd:/attach' });
});

test('buildCommandValue 携带 routeKey', () => {
  const val = buildCommandValue('cmd:/attach', 'feishu:oc_chat1:root:om_root1');
  assert.deepEqual(val, { action: 'cmd:/attach', routeKey: 'feishu:oc_chat1:root:om_root1' });
});

test('renderUnboundRouteCard 提供 attach/new/list 按钮', () => {
  const card = renderUnboundRouteCard('feishu:oc_chat1:root:om_root1');
  assert.ok(card.header);
  assert.ok(card.elements.some((el) => el.tag === 'div'));
  const actionEl = card.elements.find((el) => el.tag === 'action');
  assert.ok(actionEl);
  const actions = actionEl.actions.map((action) => action.value.action);
  assert.ok(actions.includes('cmd:/attach'));
  assert.ok(actions.includes('cmd:/new'));
  assert.ok(actions.includes('cmd:/list'));
});

test('renderAttachableSessionCard 显示可纳入会话按钮', () => {
  const card = renderAttachableSessionCard([
    { id: 'ses_abc123', title: 'terminal session', cwd: 'H:\\walker', status: 'idle' },
  ], { managedIds: [] });
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  const actionEl = card.elements.find((el) => el.tag === 'action');
  assert.ok(textEl.text.content.includes('terminal session'));
  assert.equal(actionEl.actions[0].value.action, 'cmd:/attach ses_abc123');
});

test('renderAttachableSessionCard 过滤已管理会话', () => {
  const card = renderAttachableSessionCard([
    { id: 'ses_managed', title: 'managed', cwd: 'H:\\walker', status: 'idle' },
  ], { managedIds: ['ses_managed'] });
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('没有发现'));
});

test('renderErrorCard 显示错误信息', () => {
  const card = renderErrorCard('session not found');
  assert.ok(card.header);
  assert.equal(card.header.template, 'red');
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('session not found'));
});
