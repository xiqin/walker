const test = require('node:test');
const assert = require('node:assert/strict');
const {
  renderSessionListCard,
  renderUnboundRouteCard,
  renderAttachableSessionCard,
  renderModelListCard,
  renderHelpCard,
  renderErrorCard,
  buildPermissionCard,
  buildPermissionRepliedCard,
  buildButtonValue,
  buildCommandValue,
} = require('../src/platform/feishu/cards');
const { COMMAND_LIST } = require('../src/platform/feishu/commands');

function collectButtons(card) {
  return card.elements
    .filter((el) => el.tag === 'action')
    .flatMap((el) => el.actions || []);
}

function collectModelButtons(card) {
  return collectButtons(card).filter((button) => button.value.action.startsWith('cmd:/model ') && !button.value.action.startsWith('cmd:/model --page '));
}

function collectNavigationButtons(card) {
  return collectButtons(card).filter((button) => button.value.action.startsWith('cmd:/model --page '));
}

function createPagedModels() {
  const models = Array.from({ length: 47 }, (_, index) => ({
    id: 'model_' + String(index).padStart(2, '0'),
    name: 'Model ' + index,
    provider: 'standard',
    status: 'available',
    enabled: true,
    groups: [],
  }));
  models.push(
    { id: 'configured_a', name: 'Configured A', provider: 'config', status: 'available', enabled: true, groups: ['configured'] },
    { id: 'configured_b', name: 'Configured B', provider: 'config', status: 'available', enabled: true, groups: ['configured'] },
    { id: 'recent_old', name: 'Recent Old', provider: 'recent', status: 'available', enabled: true, groups: ['recent'], lastUsedAt: 1000 },
    { id: 'recent_new', name: 'Recent New', provider: 'recent', status: 'available', enabled: true, groups: ['recent'], lastUsedAt: 3000 },
    { id: 'recent_configured', name: 'Recent Configured', provider: 'recent', status: 'available', enabled: true, groups: ['recent', 'configured'], lastUsedAt: 2000 },
    { id: 'current', name: 'Current', provider: 'current', status: 'available', enabled: true, groups: ['configured'] },
  );
  models.push({ ...models[52] }, { ...models[50] }, { ...models[47] });
  return models;
}

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

test('非焦点 session 有设为焦点按钮', () => {
  const sessions = [
    { id: 'wks_focus', title: 'focus session', agent: 'opencode', status: 'idle', cwd: '/home/user', updatedAt: Date.now() },
    { id: 'wks_other', title: 'other session', agent: 'opencode', status: 'running', cwd: '/home/user2', updatedAt: Date.now() },
  ];
  const card = renderSessionListCard(sessions, 'wks_focus');
  const actionEls = card.elements.filter((el) => el.tag === 'action');
  const otherAction = actionEls.find((el) => {
    const btn = el.actions.find((a) => a.text && a.text.content === '设为焦点');
    return btn !== undefined;
  });
  assert.ok(otherAction, '非焦点 session 应有"设为焦点"按钮');
  const focusBtn = otherAction.actions.find((a) => a.text.content === '设为焦点');
  assert.deepEqual(focusBtn.value, { action: 'cmd:/use wks_other' });
  assert.equal(focusBtn.type, 'primary');
});

test('焦点 session 标记已聚焦', () => {
  const sessions = [
    { id: 'wks_focus', title: 'focus session', agent: 'opencode', status: 'idle', cwd: '/home/user', updatedAt: Date.now() },
  ];
  const card = renderSessionListCard(sessions, 'wks_focus');
  const actionEl = card.elements.find((el) => el.tag === 'action');
  assert.ok(actionEl);
  const focusBtn = actionEl.actions.find((a) => a.text && a.text.content === '已聚焦');
  assert.ok(focusBtn, '焦点 session 应有"已聚焦"标记');
  assert.equal(focusBtn.type, 'default');
  assert.deepEqual(focusBtn.value, { action: 'cmd:/use wks_focus' });
});

test('设为焦点按钮携带 routeKey', () => {
  const sessions = [
    { id: 'wks_other', title: 'other session', agent: 'opencode', status: 'idle', cwd: '/home/user', updatedAt: Date.now() },
  ];
  const card = renderSessionListCard(sessions, 'wks_focus', 'feishu:oc_chat1:root:om_root1');
  const actionEl = card.elements.find((el) => el.tag === 'action');
  const focusBtn = actionEl.actions.find((a) => a.text && a.text.content === '设为焦点');
  assert.deepEqual(focusBtn.value, { action: 'cmd:/use wks_other', routeKey: 'feishu:oc_chat1:root:om_root1' });
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
    { id: 'ses_abc1234567890_full', title: 'terminal session', cwd: 'H:\\walker', status: 'idle' },
  ], { managedIds: [] });
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  const actionEl = card.elements.find((el) => el.tag === 'action');
  assert.ok(textEl.text.content.includes('terminal session'));
  assert.ok(textEl.text.content.includes('ses_abc12345'));
  assert.equal(actionEl.actions[0].value.action, 'cmd:/attach ses_abc1234567890_full');
});

test('renderAttachableSessionCard 候选过多时限制展示数量避免飞书拒绝整卡', () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    id: 'ses_candidate_' + String(index + 1).padStart(2, '0'),
    title: 'candidate ' + (index + 1),
    cwd: 'H:\\walker',
    status: 'idle',
  }));
  const card = renderAttachableSessionCard(sessions, { managedIds: [] });
  const text = card.elements
    .filter((el) => el.tag === 'div' && el.text)
    .map((el) => el.text.content)
    .join('\n');

  assert.ok(text.includes('candidate 1'));
  assert.equal(text.includes('candidate 11'), false);
  assert.ok(text.includes('还有 2 个候选未展示'));
  assert.equal(card.elements.filter((el) => el.tag === 'action').length, 10);
});

test('renderAttachableSessionCard 明确提示会话可能来自多个项目', () => {
  const card = renderAttachableSessionCard([
    { id: 'ses_abc123', title: 'terminal session', cwd: 'H:\\walker', status: 'idle' },
  ], { managedIds: [], crossProject: true });
  const text = card.elements
    .filter((el) => el.tag === 'div' && el.text)
    .map((el) => el.text.content)
    .join('\n');

  assert.ok(text.includes('多个 OpenCode 项目'));
  assert.ok(text.includes('工作目录'));
});

test('renderAttachableSessionCard 过滤已管理会话', () => {
  const card = renderAttachableSessionCard([
    { id: 'ses_managed', title: 'managed', cwd: 'H:\\walker', status: 'idle' },
  ], { managedIds: ['ses_managed'] });
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('没有发现'));
});

test('renderModelListCard 对完整稳定去重序列分页为 20、20、13', () => {
  const routeKey = 'feishu:oc_chat1:root:om_root1';
  const models = createPagedModels();
  const cards = [1, 2, 3].map((page) => renderModelListCard(models, {
    page,
    routeKey,
    currentModel: { providerID: 'current', modelID: 'current' },
  }));
  const pageButtons = cards.map(collectModelButtons);
  const actions = pageButtons.flat().map((button) => button.value.action);

  assert.deepEqual(pageButtons.map((buttons) => buttons.length), [20, 20, 13]);
  assert.equal(new Set(actions).size, 53);
  assert.equal(actions.length, 53);
  assert.deepEqual(actions.slice(0, 6), [
    'cmd:/model current/current',
    'cmd:/model recent/recent_new',
    'cmd:/model recent/recent_configured',
    'cmd:/model recent/recent_old',
    'cmd:/model config/configured_a',
    'cmd:/model config/configured_b',
  ]);
  assert.deepEqual(cards.map((card) => card.header.title.content), [
    'Walker 模型列表 (53)',
    'Walker 模型列表 (53)',
    'Walker 模型列表 (53)',
  ]);
  assert.deepEqual(cards.map((card) => card.elements.find((el) => el.tag === 'div' && el.text.content.startsWith('第 ')).text.content), [
    '第 1 / 3 页',
    '第 2 / 3 页',
    '第 3 / 3 页',
  ]);
  assert.ok(pageButtons.flat().every((button) => button.value.routeKey === routeKey));
  assert.equal(pageButtons[0][0].type, 'primary');
  assert.equal(pageButtons[0][1].type, 'primary');
  assert.equal(pageButtons[0][4].type, 'default');
});

test('renderModelListCard 导航遵守页面边界并透传 routeKey', () => {
  const routeKey = 'feishu:oc_chat1:root:om_root1';
  const models = createPagedModels();
  const cards = [1, 2, 3].map((page) => renderModelListCard(models, { page, routeKey }));

  assert.deepEqual(collectNavigationButtons(cards[0]).map((button) => button.value), [
    { action: 'cmd:/model --page 2', routeKey },
  ]);
  assert.deepEqual(collectNavigationButtons(cards[1]).map((button) => button.value), [
    { action: 'cmd:/model --page 1', routeKey },
    { action: 'cmd:/model --page 3', routeKey },
  ]);
  assert.deepEqual(collectNavigationButtons(cards[2]).map((button) => button.value), [
    { action: 'cmd:/model --page 2', routeKey },
  ]);
  assert.deepEqual(cards.map((card) => collectModelButtons(card).length), [20, 20, 13]);
});

test('renderModelListCard 将无效页码归一化到有效的 1-based 页码', () => {
  const models = createPagedModels();
  const cases = [
    { page: undefined, expected: '第 1 / 3 页' },
    { page: 'not-a-number', expected: '第 1 / 3 页' },
    { page: -2, expected: '第 1 / 3 页' },
    { page: 99, expected: '第 3 / 3 页' },
    { page: '2', expected: '第 2 / 3 页' },
  ];

  for (const item of cases) {
    const card = renderModelListCard(models, { page: item.page });
    const pageText = card.elements.find((el) => el.tag === 'div' && el.text.content.startsWith('第 '));
    assert.equal(pageText.text.content, item.expected);
  }
});

test('renderModelListCard 对其余模型保持 provider 首次出现顺序和组内顺序', () => {
  const card = renderModelListCard([
    { id: 'beta_1', name: 'Beta 1', provider: 'beta', status: 'available', enabled: true, groups: [] },
    { id: 'alpha_1', name: 'Alpha 1', provider: 'alpha', status: 'available', enabled: true, groups: [] },
    { id: 'beta_2', name: 'Beta 2', provider: 'beta', status: 'available', enabled: true, groups: [] },
    { id: 'alpha_2', name: 'Alpha 2', provider: 'alpha', status: 'available', enabled: true, groups: [] },
  ]);

  assert.deepEqual(collectModelButtons(card).map((button) => button.value.action), [
    'cmd:/model beta/beta_1',
    'cmd:/model beta/beta_2',
    'cmd:/model alpha/alpha_1',
    'cmd:/model alpha/alpha_2',
  ]);
});

test('renderModelListCard 保持空列表与单页卡片兼容', () => {
  const emptyCard = renderModelListCard([], { page: 3 });
  assert.equal(emptyCard.header.title.content, 'Walker 模型列表');
  assert.ok(emptyCard.elements.some((el) => el.tag === 'div' && el.text.content === '暂无可用模型。'));
  assert.equal(collectButtons(emptyCard).length, 0);

  const singleCard = renderModelListCard([
    { id: 'recent', name: 'Recent', provider: 'one', status: 'available', enabled: true, groups: ['recent'] },
    { id: 'regular', name: 'Regular', provider: 'one', status: 'available', enabled: true, groups: [] },
  ], { page: 8 });
  assert.equal(singleCard.elements.find((el) => el.tag === 'div' && el.text.content.startsWith('第 ')).text.content, '第 1 / 1 页');
  assert.equal(collectModelButtons(singleCard).length, 2);
  assert.equal(collectNavigationButtons(singleCard).length, 0);
  assert.deepEqual(collectModelButtons(singleCard).map((button) => button.type), ['primary', 'default']);
});

test('renderHelpCard 基于命令元数据生成帮助按钮', () => {
  const routeKey = 'feishu:oc_chat1:root:om_root1';
  const card = renderHelpCard(COMMAND_LIST, { routeKey });
  const text = card.elements
    .filter((el) => el.tag === 'div' && el.text)
    .map((el) => el.text.content)
    .join('\n');
  const actions = collectButtons(card).map((button) => button.value);

  for (const name of ['new', 'attach', 'list', 'model']) {
    assert.ok(text.includes('/' + name));
    assert.ok(actions.some((value) => value.action === 'cmd:/' + name && value.routeKey === routeKey));
  }
});

test('renderErrorCard 显示错误信息', () => {
  const card = renderErrorCard('session not found');
  assert.ok(card.header);
  assert.equal(card.header.template, 'red');
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('session not found'));
});

test('buildPermissionCard header 红色且标题为权限确认请求', () => {
  const card = buildPermissionCard(
    { data: { id: 'perm_1', type: 'bash', title: '执行 bash 命令' } },
    'wks_session1',
  );
  assert.equal(card.header.template, 'red');
  assert.equal(card.header.title.content, '权限确认请求');
});

test('buildPermissionCard body 包含权限标题', () => {
  const card = buildPermissionCard(
    { data: { id: 'perm_1', title: '执行 rm 命令' } },
    'wks_session1',
  );
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('执行 rm 命令'));
});

test('buildPermissionCard 包含允许和拒绝按钮', () => {
  const card = buildPermissionCard(
    { data: { id: 'perm_1', title: 'test' } },
    'wks_session1',
    'route_key_1',
  );
  const buttons = collectButtons(card);
  assert.ok(buttons.some((b) => b.text.content === '允许' && b.type === 'primary'));
  assert.ok(buttons.some((b) => b.text.content === '拒绝' && b.type === 'danger'));
});

test('buildPermissionCard 按钮 value 携带 permit 命令', () => {
  const card = buildPermissionCard(
    { data: { id: 'perm_abc', title: 'test' } },
    'wks_s1',
    'rk1',
  );
  const buttons = collectButtons(card);
  const allowBtn = buttons.find((b) => b.text.content === '允许');
  assert.match(allowBtn.value.action, /cmd:\/permit perm_abc allow/);
  assert.match(allowBtn.value.action, /wks_s1/);
  assert.equal(allowBtn.value.routeKey, 'rk1');
  const denyBtn = buttons.find((b) => b.text.content === '拒绝');
  assert.match(denyBtn.value.action, /cmd:\/permit perm_abc deny/);
});

test('buildPermissionCard 缺少 title 时显示未知权限请求', () => {
  const card = buildPermissionCard(
    { data: { id: 'perm_1' } },
    'wks_s1',
  );
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('未知权限请求'));
});

test('buildPermissionCard metadata 显示命令信息', () => {
  const card = buildPermissionCard(
    { data: { id: 'perm_1', type: 'bash', title: '执行命令', metadata: { command: 'npm test' } } },
    'wks_s1',
  );
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('npm test'));
});

test('buildPermissionRepliedCard header 灰色且显示已处理', () => {
  const card = buildPermissionRepliedCard('perm_abc', 'allow');
  assert.equal(card.header.template, 'default');
  assert.equal(card.header.title.content, '权限已处理');
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('已允许'));
  assert.ok(textEl.text.content.includes('perm\\_abc'));
});

test('buildPermissionRepliedCard deny 显示已拒绝', () => {
  const card = buildPermissionRepliedCard('perm_abc', 'deny');
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('已拒绝'));
  assert.ok(textEl.text.content.includes('perm\\_abc'));
});
