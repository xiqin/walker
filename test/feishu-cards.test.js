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
  buildQuestionCard,
  buildQuestionRepliedCard,
  buildNativeQuestionCard,
  buildNativeQuestionStatusCard,
  buildButtonValue,
  buildCommandValue,
} = require('../src/platform/feishu/cards');
const { COMMAND_LIST } = require('../src/platform/feishu/commands');

function collectButtons(card) {
  return card.elements
    .filter((el) => el.tag === 'action' || el.tag === 'form')
    .flatMap((el) => el.actions || el.elements || []);
}

function collectActionButtons(card) {
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

test('buildPermissionCard 包含允许、始终允许和拒绝按钮', () => {
  const card = buildPermissionCard(
    { data: { id: 'perm_1', title: 'test' } },
    'wks_session1',
    'route_key_1',
  );
  const buttons = collectButtons(card);
  assert.ok(buttons.some((b) => b.text.content === '允许' && b.type === 'primary'));
  assert.ok(buttons.some((b) => b.text.content === '始终允许' && b.type === 'default'));
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
  const alwaysBtn = buttons.find((b) => b.text.content === '始终允许');
  assert.match(alwaysBtn.value.action, /cmd:\/permit perm_abc always/);
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

test('buildPermissionCard metadata 显示权限匹配规则', () => {
  const card = buildPermissionCard(
    { data: { id: 'perm_1', type: 'external_directory', title: 'Access external directory', metadata: { patterns: ['H:\\sacpServ\\*'] } } },
    'wks_s1',
  );
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('external\\_directory'));
  assert.ok(textEl.text.content.includes('匹配规则'));
  assert.ok(textEl.text.content.includes('sacpServ'));
});

test('buildPermissionRepliedCard allow 显示绿色模板和最终选择', () => {
  const card = buildPermissionRepliedCard('perm_abc', 'allow');
  assert.equal(card.header.template, 'green');
  assert.equal(card.header.title.content, '权限已处理');
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('最终选择'));
  assert.ok(textEl.text.content.includes('已允许'));
  assert.ok(textEl.text.content.includes('perm\\_abc'));
});

test('buildPermissionRepliedCard deny 显示灰色模板和最终选择', () => {
  const card = buildPermissionRepliedCard('perm_abc', 'deny');
  assert.equal(card.header.template, 'grey');
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('最终选择'));
  assert.ok(textEl.text.content.includes('已拒绝'));
  assert.ok(textEl.text.content.includes('perm\\_abc'));
});

test('buildPermissionRepliedCard always 显示绿色模板和始终允许', () => {
  const card = buildPermissionRepliedCard('perm_abc', 'always');
  assert.equal(card.header.template, 'green');
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('最终选择'));
  assert.ok(textEl.text.content.includes('已始终允许'));
  assert.ok(textEl.text.content.includes('perm\\_abc'));
});

test('buildQuestionCard confirm 仅生成 preview:/answer 预览动作', () => {
  const card = buildQuestionCard(
    { data: { id: 'q_1', title: '是否继续？', metadata: { inputMode: 'confirm' } } },
    'wks_s1',
  );
  assert.equal(card.header.template, 'blue');
  assert.equal(card.header.title.content, '交互式问题');
  const buttons = collectButtons(card);
  const allowBtn = buttons.find((b) => b.text.content === '允许');
  const denyBtn = buttons.find((b) => b.text.content === '拒绝');
  assert.ok(allowBtn);
  assert.ok(denyBtn);
  assert.equal(allowBtn.type, 'primary');
  assert.equal(denyBtn.type, 'danger');
  assert.match(allowBtn.value.action, /preview:\/answer q_1 allow/);
  assert.match(denyBtn.value.action, /preview:\/answer q_1 deny/);
  assert.ok(allowBtn.value.action.includes('wks_s1'));
});

test('buildQuestionCard single_select 渲染 N 个 button，value 含 option.value', () => {
  const card = buildQuestionCard(
    { data: { id: 'q_2', title: '选择模型', metadata: { inputMode: 'single_select', options: [
      { label: 'GPT-4', value: 'gpt4' },
      { label: 'Claude', value: 'claude' },
    ] } } },
    'wks_s2',
  );
  const buttons = collectButtons(card);
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].text.content, 'GPT-4');
  assert.equal(buttons[1].text.content, 'Claude');
  assert.match(buttons[0].value.action, /preview:\/answer q_2 gpt4/);
  assert.match(buttons[1].value.action, /preview:\/answer q_2 claude/);
});

test('buildQuestionCard multi_select 渲染 multi_select_static + 提交 button，name=question_answer', () => {
  const card = buildQuestionCard(
    { data: { id: 'q_3', title: '多选', metadata: { inputMode: 'multi_select', options: [
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
    ] } } },
    'wks_s3',
  );
  const actionEl = card.elements.find((el) => el.tag === 'action');
  assert.ok(actionEl);
  const selectEl = actionEl.actions.find((a) => a.tag === 'multi_select_static');
  assert.ok(selectEl);
  assert.equal(selectEl.name, 'question_answer');
  assert.equal(selectEl.options.length, 2);
  assert.equal(selectEl.options[0].text.content, 'A');
  assert.equal(selectEl.options[0].value, 'a');
  const submitBtn = actionEl.actions.find((a) => a.tag === 'button');
  assert.ok(submitBtn);
  assert.match(submitBtn.value.action, /preview:\/answer q_3 --form/);
});

test('buildQuestionCard single_select option 带 description 拼接到 text', () => {
  const card = buildQuestionCard(
    { data: { id: 'q_sd', title: '选择', metadata: { inputMode: 'single_select', options: [
      { label: '蓝绿部署', value: 'bg', description: '零停机切换' },
      { label: '金丝雀', value: 'canary' },
    ] } } },
    'wks_sd',
  );
  const buttons = collectButtons(card);
  assert.equal(buttons[0].text.content, '蓝绿部署\n零停机切换');
  assert.equal(buttons[1].text.content, '金丝雀');
});

test('buildQuestionCard multi_select option 带 description 拼接到 text', () => {
  const card = buildQuestionCard(
    { data: { id: 'q_md', title: '多选', metadata: { inputMode: 'multi_select', options: [
      { label: 'A', value: 'a', description: '选项A说明' },
      { label: 'B', value: 'b' },
    ] } } },
    'wks_md',
  );
  const selectEl = card.elements.find((el) => el.tag === 'action').actions.find((a) => a.tag === 'multi_select_static');
  assert.equal(selectEl.options[0].text.content, 'A\n选项A说明');
  assert.equal(selectEl.options[1].text.content, 'B');
});

test('buildQuestionCard text 渲染 input + 提交 button，name=question_answer', () => {
  const card = buildQuestionCard(
    { data: { id: 'q_4', title: '请输入', metadata: { inputMode: 'text', description: '请描述你的需求' } } },
    'wks_s4',
  );
  const actionEl = card.elements.find((el) => el.tag === 'action');
  assert.ok(actionEl);
  const inputEl = actionEl.actions.find((a) => a.tag === 'input');
  assert.ok(inputEl);
  assert.equal(inputEl.name, 'question_answer');
  assert.equal(inputEl.placeholder.content, '请描述你的需求');
  const submitBtn = actionEl.actions.find((a) => a.tag === 'button');
  assert.ok(submitBtn);
  assert.match(submitBtn.value.action, /preview:\/answer q_4 --form/);
});

test('buildQuestionCard 未知 inputMode 降级为 confirm', () => {
  const card = buildQuestionCard(
    { data: { id: 'q_5', title: '未知类型', metadata: { inputMode: 'unknown_mode' } } },
    'wks_s5',
  );
  const buttons = collectButtons(card);
  const allowBtn = buttons.find((b) => b.text.content === '允许');
  const denyBtn = buttons.find((b) => b.text.content === '拒绝');
  assert.ok(allowBtn);
  assert.ok(denyBtn);
  assert.match(allowBtn.value.action, /preview:\/answer q_5 allow/);
});

test('buildQuestionCard select 缺少 options 渲染错误状态', () => {
  const card = buildQuestionCard(
    { data: { id: 'q_6', title: '缺选项', metadata: { inputMode: 'single_select' } } },
    'wks_s6',
  );
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('选项缺失'));
  const actionEl = card.elements.find((el) => el.tag === 'action');
  assert.equal(actionEl, undefined);
});

test('buildQuestionCard 缺少 label 时用 value 展示', () => {
  const card = buildQuestionCard(
    { data: { id: 'q_7', title: '无label', metadata: { inputMode: 'single_select', options: [
      { value: 'opt_a' },
    ] } } },
    'wks_s7',
  );
  const buttons = collectButtons(card);
  assert.equal(buttons[0].text.content, 'opt_a');
});

test('buildQuestionCard routeKey 透传到 buildButtonValue', () => {
  const card = buildQuestionCard(
    { data: { id: 'q_8', title: 'routeKey测试', metadata: { inputMode: 'confirm' } } },
    'wks_s8',
    'rk_test',
  );
  const buttons = collectButtons(card);
  const allowBtn = buttons.find((b) => b.text.content === '允许');
  assert.equal(allowBtn.value.routeKey, 'rk_test');
});

test('buildQuestionRepliedCard string answer 展示', () => {
  const card = buildQuestionRepliedCard('q_1', 'yes');
  assert.equal(card.header.template, 'green');
  assert.equal(card.header.title.content, '问题已回复');
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('已回答: yes'));
});

test('buildQuestionRepliedCard string[] answer 用逗号连接展示', () => {
  const card = buildQuestionRepliedCard('q_2', ['a', 'b', 'c']);
  const textEl = card.elements.find((el) => el.tag === 'div' && el.text);
  assert.ok(textEl.text.content.includes('已回答: a, b, c'));
});

test('buildNativeQuestionCard 渲染单选 v1 普通按钮并在正文展示选项说明', () => {
  const card = buildNativeQuestionCard({
    requestID: 'req_123',
    questionIndex: 1,
    questionCount: 3,
    question: {
      header: '部署方式',
      question: '请选择发布方式',
      custom: false,
      options: [
        { label: '蓝绿部署', description: '零停机切换' },
        { label: '金丝雀', description: '逐步放量' },
      ],
    },
    walkerSessionId: 'wks_question',
    routeKey: 'feishu:oc_1:root:om_1',
  });

  assert.equal(card.header.title.content, '部署方式');
  assert.equal(card.schema, undefined);
  assert.equal(card.body, undefined);
  const content = card.elements.find((element) => element.tag === 'div').text.content;
  assert.match(content, /问题 2\/3/);
  assert.match(content, /请选择发布方式/);
  assert.match(content, /\*\*1\. 蓝绿部署\*\*/);
  assert.match(content, /零停机切换/);
  assert.match(content, /\*\*2\. 金丝雀\*\*/);
  assert.match(content, /逐步放量/);
  assert.equal(card.elements.some((element) => element.tag === 'form'), false);
  const actions = collectActionButtons(card);
  assert.equal(actions.some((action) => action.tag === 'select_static' || action.tag === 'multi_select_static' || action.tag === 'input'), false);
  assert.deepEqual(actions.map((action) => action.text.content), ['蓝绿部署', '金丝雀']);
  assert.deepEqual(actions.map((action) => action.value.action), [
    'cmd:/answer req_123:1 --option option_0 wks_question',
    'cmd:/answer req_123:1 --option option_1 wks_question',
  ]);
  assert.deepEqual(actions[0].value, {
    action: 'cmd:/answer req_123:1 --option option_0 wks_question',
    routeKey: 'feishu:oc_1:root:om_1',
  });
  assert.equal(actions.some((action) => action.behaviors), false);
});

test('buildNativeQuestionCard 单选允许自定义时渲染飞书表单输入', () => {
  const card = buildNativeQuestionCard({
    requestID: 'req_single_custom',
    questionIndex: 0,
    questionCount: 1,
    question: {
      header: '权限测试',
      question: '是否授权？',
      options: [{ label: '批准' }, { label: '拒绝' }],
    },
    walkerSessionId: 'wks_single',
    routeKey: 'route_single',
  });

  assert.equal(card.schema, '2.0');
  const markdown = card.body.elements.find((element) => element.tag === 'markdown');
  assert.match(markdown.content, /是否授权？/);
  const form = card.body.elements.find((element) => element.tag === 'form');
  const select = form.elements.find((element) => element.tag === 'select_static');
  const input = form.elements.find((element) => element.tag === 'input');
  const submit = form.elements.find((element) => element.tag === 'button' && element.name === 'question_submit');
  assert.equal(select.name, 'question_selected');
  assert.deepEqual(select.options.map((option) => option.value), ['option_0', 'option_1']);
  assert.equal(input.name, 'question_custom');
  assert.deepEqual(submit.value, {
    action: 'cmd:/answer req_single_custom:0 --form wks_single',
    routeKey: 'route_single',
  });
});

test('buildNativeQuestionCard 多选输出 Card JSON 2.0 checker 勾选器', () => {
  const card = buildNativeQuestionCard({
    requestID: 'req_multi',
    questionIndex: 0,
    questionCount: 1,
    question: {
      header: '选择模块',
      question: '可选择多个模块',
      multiple: true,
      custom: false,
      options: [
        { label: '认证', description: '登录鉴权' },
        { label: '通知', description: '消息推送' },
      ],
    },
    walkerSessionId: 'wks_multi',
    routeKey: 'feishu:oc_multi:root:om_multi',
  });

  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.equal(card.body !== undefined, true);
  assert.equal(card.elements, undefined);
  const markdown = card.body.elements.find((element) => element.tag === 'markdown');
  assert.match(markdown.content, /问题 1\/1/);
  assert.match(markdown.content, /可选择多个模块/);
  assert.doesNotMatch(markdown.content, /\*\*1\. 认证\*\*/);
  assert.doesNotMatch(markdown.content, /登录鉴权/);
  assert.doesNotMatch(markdown.content, /\*\*2\. 通知\*\*/);
  assert.doesNotMatch(markdown.content, /消息推送/);
  const form = card.body.elements.find((element) => element.tag === 'form');
  assert.ok(form, '多选卡片必须包含 v2 form');
  const checkers = form.elements.filter((el) => el.tag === 'checker');
  assert.equal(checkers.length, 2, 'v2 form 必须包含每个选项对应的 checker');
  assert.equal(checkers[0].name, 'question_selected_0');
  assert.equal(checkers[0].checked, false);
  assert.match(checkers[0].text.content, /认证/);
  assert.match(checkers[0].text.content, /登录鉴权/);
  assert.equal(checkers[0].behaviors[0].type, 'callback');
  assert.equal(checkers[0].behaviors[0].value.action, 'cmd:/answer req_multi:0 --toggle option_0 wks_multi');
  assert.equal(checkers[1].name, 'question_selected_1');
  assert.equal(checkers[1].behaviors[0].value.action, 'cmd:/answer req_multi:0 --toggle option_1 wks_multi');
  const input = form.elements.find((el) => el.tag === 'input');
  assert.equal(input, undefined, 'custom=false 时不渲染自定义输入框');
  const submitBtn = form.elements.find((el) => el.tag === 'button' && el.name === 'question_submit');
  assert.ok(submitBtn, 'v2 form 必须包含提交按钮');
  assert.equal(submitBtn.action_type, 'form_submit');
  assert.equal(submitBtn.value.action, 'cmd:/answer req_multi:0 --submit wks_multi');
  assert.equal(card.elements, undefined);
  assert.equal(card.body.elements.some((el) => el.tag === 'action'), false);
});

test('buildNativeQuestionCard 多选允许自定义时在 checker 表单内渲染输入框', () => {
  const card = buildNativeQuestionCard({
    requestID: 'req_multi_custom',
    questionIndex: 0,
    questionCount: 1,
    question: {
      header: '选择模块',
      question: '可选择多个模块',
      multiple: true,
      custom: true,
      options: [{ label: '认证' }],
    },
    walkerSessionId: 'wks_multi',
  });

  const form = card.body.elements.find((element) => element.tag === 'form');
  const input = form.elements.find((el) => el.tag === 'input');
  assert.equal(input.name, 'question_custom');
  assert.equal(input.placeholder.content, '请输入自定义答案');
});

test('buildNativeQuestionCard 无预设选项且允许自定义答案时渲染飞书输入框', () => {
  const card = buildNativeQuestionCard({
    requestID: 'req_text',
    questionIndex: 0,
    questionCount: 1,
    question: { header: '补充说明', question: '请输入说明', options: [] },
    walkerSessionId: 'wks_text',
  });

  assert.equal(card.schema, '2.0');
  const markdown = card.body.elements.find((element) => element.tag === 'markdown');
  assert.match(markdown.content, /请输入说明/);
  const form = card.body.elements.find((element) => element.tag === 'form');
  assert.equal(form.elements.find((element) => element.tag === 'input').name, 'question_custom');
  assert.equal(form.elements.find((element) => element.tag === 'button').value.action, 'cmd:/answer req_text:0 --form wks_text');
});

test('buildNativeQuestionStatusCard 覆盖处理、终态、降级和过期反馈', () => {
  const expected = {
    preparing: '问题仍在准备',
    answered: '答案已收集',
    submitting: '正在处理',
    replied: '已处理',
    rejected: '已取消',
    processed_unknown: '结果待确认',
    feishu_unavailable: '请在本地 TUI 回答',
    expired: '请求已过期',
  };

  for (const [status, message] of Object.entries(expected)) {
    const card = buildNativeQuestionStatusCard({
      requestID: 'req_status',
      questionIndex: 0,
      questionCount: 1,
      question: { header: '状态问题', question: '状态正文' },
      status,
    });
    const content = card.body ? card.body.elements[0].content : card.elements.find((element) => element.tag === 'div').text.content;
    assert.match(content, new RegExp(message));
  }
});

test('buildNativeQuestionStatusCard retryable 提供不读取表单的重试动作', () => {
  const card = buildNativeQuestionStatusCard({
    requestID: 'req_retry',
    questionIndex: 2,
    questionCount: 3,
    question: { header: '重试问题', question: '正文' },
    status: 'retryable',
    walkerSessionId: 'wks_retry',
    routeKey: 'route_retry',
  });

  const content = card.body.elements[0].content;
  assert.match(content, /提交失败/);
  const retry = card.body.elements.find((element) => element.tag === 'button');
  assert.deepEqual(retry.behaviors[0].value, {
    action: 'cmd:/answer req_retry:2 --retry wks_retry',
    routeKey: 'route_retry',
  });
});

test('buildNativeQuestionStatusCard 多选题输出 Card JSON 2.0 状态卡', () => {
  const card = buildNativeQuestionStatusCard({
    requestID: 'req_status_v2',
    questionIndex: 0,
    questionCount: 1,
    question: { header: '多选状态', question: '状态正文', multiple: true, options: [{ label: '文本消息' }, { label: '图片消息' }] },
    answers: ['文本消息'],
    status: 'replied',
  });

  assert.equal(card.schema, '2.0');
  assert.equal(card.elements, undefined);
  assert.equal(card.body.elements[0].tag, 'markdown');
  assert.match(card.body.elements[0].content, /已处理/);
  assert.match(card.body.elements[0].content, /\[已选择\] 文本消息/);
  assert.match(card.body.elements[0].content, /\[未选择\] 图片消息/);
});

test('buildNativeQuestionStatusCard 多选已处理状态展示自定义答案', () => {
  const card = buildNativeQuestionStatusCard({
    requestID: 'req_status_custom',
    questionIndex: 0,
    questionCount: 1,
    question: { header: '多选状态', question: '状态正文', multiple: true, options: [{ label: '文本消息' }] },
    answers: ['文本消息', '私聊消息'],
    status: 'replied',
  });

  assert.match(card.body.elements[0].content, /\[已选择\] 文本消息/);
  assert.match(card.body.elements[0].content, /\[自定义\] 私聊消息/);
});

test('buildNativeQuestionStatusCard 单选已处理状态展示最终选择', () => {
  const card = buildNativeQuestionStatusCard({
    requestID: 'req_status_single',
    questionIndex: 0,
    questionCount: 1,
    question: { header: '单选状态', question: '状态正文', options: [{ label: '批准' }, { label: '拒绝' }] },
    answers: ['拒绝'],
    status: 'replied',
  });

  const content = card.body.elements[0].content;
  assert.match(content, /最终选择/);
  assert.match(content, /\[未选择\] 批准/);
  assert.match(content, /\[已选择\] 拒绝/);
});

test('buildNativeQuestionStatusCard 多选 retryable 用 v2 callback 重试按钮', () => {
  const card = buildNativeQuestionStatusCard({
    requestID: 'req_retry_v2',
    questionIndex: 1,
    questionCount: 2,
    question: { header: '多选重试', question: '正文', multiple: true },
    status: 'retryable',
    walkerSessionId: 'wks_retry',
    routeKey: 'route_retry',
  });

  const retry = card.body.elements.find((element) => element.tag === 'button');
  assert.equal(retry.behaviors[0].type, 'callback');
  assert.deepEqual(retry.behaviors[0].value, {
    action: 'cmd:/answer req_retry_v2:1 --retry wks_retry',
    routeKey: 'route_retry',
  });
});
