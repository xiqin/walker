const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { SessionService } = require('../src/core/session-service');
const { JsonStore } = require('../src/core/json-store');

function createTempStore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-session-'));
  const stateStore = new JsonStore(path.join(tmpDir, 'state.json'), {});
  return { tmpDir, stateStore };
}

test('createSession 创建并自动绑定 routeKey', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const session = service.createSession({ route: routeKey, agent: 'opencode', title: 'test session', runtime: 'windows', cwd: '/home/project' });

  assert.ok(session.id.startsWith('wks_'));
  assert.equal(session.agent, 'opencode');
  assert.equal(session.status, 'created');
  assert.equal(session.title, 'test session');

  const current = service.getCurrent(routeKey);
  assert.equal(current.id, session.id);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('同一 routeKey 再创建新 session 会覆盖旧绑定', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode' });
  const s2 = service.createSession({ route: routeKey, agent: 'opencode' });

  assert.equal(service.getCurrent(routeKey).id, s2.id);
  assert.equal(s1.status, 'created');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('bindRoute 绑定已存在 session 到新 routeKey', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const s1 = service.createSession({ route: 'feishu:oc_1:ou_a', agent: 'opencode' });
  service.bindRoute('feishu:oc_2:ou_b', s1.id);

  assert.equal(service.getCurrent('feishu:oc_2:ou_b').id, s1.id);
  assert.equal(service.getCurrent('feishu:oc_1:ou_a').id, s1.id);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unbindRoute 清除 routeKey 的绑定', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  service.createSession({ route: routeKey, agent: 'opencode' });
  service.unbindRoute(routeKey);

  assert.equal(service.getCurrent(routeKey), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('listSessions 返回所有 session', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  service.createSession({ route: 'feishu:oc_1:ou_a', agent: 'opencode', title: 'first' });
  service.createSession({ route: 'feishu:oc_2:ou_b', agent: 'opencode', title: 'second' });

  const list = service.listSessions();
  assert.equal(list.length, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('状态切换：created -> running -> idle -> stopped', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const s = service.createSession({ route: 'feishu:oc_abc:ou_user', agent: 'opencode' });

  assert.equal(s.status, 'created');
  service.markRunning(s.id);
  assert.equal(service.getSession(s.id).status, 'running');
  service.markIdle(s.id);
  assert.equal(service.getSession(s.id).status, 'idle');
  service.stopSession(s.id);
  assert.equal(service.getSession(s.id).status, 'stopped');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('markError 设置错误状态', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const s = service.createSession({ route: 'feishu:oc_abc:ou_user', agent: 'opencode' });
  service.markError(s.id, 'API key expired');
  assert.equal(service.getSession(s.id).status, 'error');
  assert.equal(service.getSession(s.id).errorMessage, 'API key expired');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('deleteSession 标记删除并清除绑定', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s = service.createSession({ route: routeKey, agent: 'opencode' });
  service.deleteSession(s.id);

  assert.equal(service.getSession(s.id).status, 'deleted');
  assert.equal(service.getCurrent(routeKey), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('bindRoute 拒绝绑定 deleted session', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const s = service.createSession({ route: 'feishu:oc_1:ou_a', agent: 'opencode' });
  service.deleteSession(s.id);

  assert.throws(() => service.bindRoute('feishu:oc_2:ou_b', s.id), /deleted/);
  assert.equal(service.getCurrent('feishu:oc_2:ou_b'), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getCurrent 遇到指向 deleted session 的脏 route 返回 null 并清理 route', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const cleanRoute = 'feishu:oc_1:ou_a';
  const dirtyRoute = 'feishu:oc_2:ou_b';
  const s = service.createSession({ route: cleanRoute, agent: 'opencode' });
  service.deleteSession(s.id);
  stateStore.update((state) => { state.routes[dirtyRoute] = s.id; });

  assert.equal(service.getCurrent(dirtyRoute), null);
  const state = stateStore.read();
  assert.equal(state.routes[dirtyRoute], undefined);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getCurrent 遇到指向 missing session 的脏 route 返回 null 并清理 route', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const dirtyRoute = 'feishu:oc_2:ou_b';
  stateStore.update((state) => { if (!state.routes) state.routes = {}; state.routes[dirtyRoute] = 'wks_missing'; });

  assert.equal(service.getCurrent(dirtyRoute), null);
  const state = stateStore.read();
  assert.equal(state.routes[dirtyRoute], undefined);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('stopped 和 deleted 终态不被后续状态更新覆盖', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const stopped = service.createSession({ route: 'feishu:oc_1:ou_a', agent: 'opencode' });
  const deleted = service.createSession({ route: 'feishu:oc_2:ou_b', agent: 'opencode' });

  service.markRunning(stopped.id);
  service.stopSession(stopped.id);
  service.markIdle(stopped.id);
  assert.equal(service.getSession(stopped.id).status, 'stopped');
  service.markError(stopped.id, 'late failure');
  assert.equal(service.getSession(stopped.id).status, 'stopped');
  assert.equal(service.getSession(stopped.id).errorMessage, null);

  service.deleteSession(deleted.id);
  service.markRunning(deleted.id);
  service.markIdle(deleted.id);
  service.markError(deleted.id, 'late failure');
  service.stopSession(deleted.id);
  assert.equal(service.getSession(deleted.id).status, 'deleted');
  assert.equal(service.getSession(deleted.id).errorMessage, null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('重启后恢复持久化数据', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service1 = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s = service1.createSession({ route: routeKey, agent: 'opencode', title: 'persistent' });

  const service2 = new SessionService({ stateStore });
  assert.equal(service2.getCurrent(routeKey).id, s.id);
  assert.equal(service2.getSession(s.id).title, 'persistent');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('bindRoute 到不存在的 session 报错', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  assert.throws(() => service.bindRoute('feishu:oc_1:ou_a', 'wks_nonexistent'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('recoverOnStartup 将 running 和 error session 重置为 idle 并清除 errorMessage', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const s1 = service.createSession({ route: 'feishu:oc_1:ou_a', agent: 'opencode' });
  service.markRunning(s1.id);
  const s2 = service.createSession({ route: 'feishu:oc_2:ou_b', agent: 'opencode' });
  service.markError(s2.id, 'some error');
  const s3 = service.createSession({ route: 'feishu:oc_3:ou_c', agent: 'opencode' });
  service.markIdle(s3.id);

  const recovered = service.recoverOnStartup();
  assert.ok(recovered.includes(s1.id));
  assert.ok(recovered.includes(s2.id));
  assert.equal(service.getSession(s1.id).status, 'idle');
  assert.equal(service.getSession(s1.id).errorMessage, null);
  assert.equal(service.getSession(s2.id).status, 'idle');
  assert.equal(service.getSession(s2.id).errorMessage, null);
  assert.equal(service.getSession(s3.id).status, 'idle');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('cleanOrphanRoutes 清除指向 missing session 的 route', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  stateStore.update((state) => {
    if (!state.routes) state.routes = {};
    state.routes['feishu:orphan1'] = 'wks_missing';
    state.routes['feishu:orphan2'] = 'wks_also_missing';
  });

  const cleaned = service.cleanOrphanRoutes();
  assert.ok(cleaned.includes('feishu:orphan1'));
  assert.ok(cleaned.includes('feishu:orphan2'));
  assert.equal(service.getCurrent('feishu:orphan1'), null);
  assert.equal(service.getCurrent('feishu:orphan2'), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('旧单值 routes 格式自动迁移', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const s1 = service.createSession({ agent: 'opencode', cwd: 'H:\\walker' });
  stateStore.update((state) => {
    if (!state.routes) state.routes = {};
    state.routes['feishu:legacy:ou_old'] = s1.id;
  });

  service.listSessionsInRoute('feishu:legacy:ou_old');
  const state = stateStore.read();
  assert.ok(state.routes['feishu:legacy:ou_old'], 'route 条目应保留为对象格式');
  assert.equal(typeof state.routes['feishu:legacy:ou_old'], 'object');
  assert.equal(state.routes['feishu:legacy:ou_old'].focusSessionId, s1.id);
  assert.deepEqual(state.routes['feishu:legacy:ou_old'].sessions, [s1.id]);
  assert.equal(state.routes['feishu:legacy:ou_old'].cwd, 'H:\\walker');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('空 route cwd 自动从已有 session cwd 回填', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:legacy-empty-cwd:ou_old';
  const s1 = service.createSession({ agent: 'opencode', cwd: 'H:\\walker' });
  stateStore.update((state) => {
    if (!state.routes) state.routes = {};
    state.routes[routeKey] = {
      focusSessionId: s1.id,
      sessions: [s1.id],
      cwd: '',
      updatedAt: Date.now(),
    };
  });

  service.listSessionsInRoute(routeKey);
  const state = stateStore.read();
  assert.equal(state.routes[routeKey].cwd, 'H:\\walker');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('addSessionToRoute 新增 session 到 route', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ agent: 'opencode' });
  service.addSessionToRoute(routeKey, s1.id, '/home/proj');

  const state = stateStore.read();
  assert.equal(state.routes[routeKey].focusSessionId, s1.id);
  assert.deepEqual(state.routes[routeKey].sessions, [s1.id]);
  assert.equal(state.routes[routeKey].cwd, '/home/proj');

  const s2 = service.createSession({ agent: 'opencode' });
  service.addSessionToRoute(routeKey, s2.id, '/home/proj');
  const stateAfter = stateStore.read();
  assert.deepEqual(stateAfter.routes[routeKey].sessions, [s1.id, s2.id]);
  assert.equal(stateAfter.routes[routeKey].focusSessionId, s1.id, '新增不改变焦点');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getCurrent 返回焦点 session', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode' });
  const s2 = service.createSession({ agent: 'opencode' });
  service.addSessionToRoute(routeKey, s2.id, '/home/proj');
  service.setFocus(routeKey, s2.id);

  assert.equal(service.getCurrent(routeKey).id, s2.id);

  service.setFocus(routeKey, s1.id);
  assert.equal(service.getCurrent(routeKey).id, s1.id);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('setFocus 切换焦点 session', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode' });
  const s2 = service.createSession({ agent: 'opencode' });
  service.addSessionToRoute(routeKey, s2.id, '/home/proj');

  service.setFocus(routeKey, s2.id);
  assert.equal(service.getCurrent(routeKey).id, s2.id);

  const state = stateStore.read();
  assert.equal(state.routes[routeKey].focusSessionId, s2.id);
  assert.ok(state.routes[routeKey].updatedAt >= s1.createdAt);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('setFocus 拒绝不在 sessions 列表中的 sessionId', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  service.createSession({ route: routeKey, agent: 'opencode' });

  assert.throws(() => service.setFocus(routeKey, 'wks_not_in_route'), /not in route/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('removeSessionFromRoute 移除焦点后自动切', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode' });
  const s2 = service.createSession({ agent: 'opencode' });
  service.addSessionToRoute(routeKey, s2.id, '/home/proj');
  service.setFocus(routeKey, s2.id);

  service.removeSessionFromRoute(routeKey, s2.id);
  assert.equal(service.getCurrent(routeKey).id, s1.id, '移除焦点后应自动切到第一个');

  const state = stateStore.read();
  assert.deepEqual(state.routes[routeKey].sessions, [s1.id]);
  assert.equal(state.routes[routeKey].focusSessionId, s1.id);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('removeSessionFromRoute 移除最后一个 session 后删除 route', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode' });

  service.removeSessionFromRoute(routeKey, s1.id);
  const state = stateStore.read();
  assert.equal(state.routes[routeKey], undefined, '空列表应删除 route 条目');
  assert.equal(service.getCurrent(routeKey), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('listSessionsInRoute 列出 route 下所有 session', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode', title: 'first' });
  const s2 = service.createSession({ agent: 'opencode', title: 'second' });
  service.addSessionToRoute(routeKey, s2.id, '/home/proj');
  service.setFocus(routeKey, s2.id);

  const list = service.listSessionsInRoute(routeKey);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, s2.id, '焦点排在第一位');
  assert.equal(list[1].id, s1.id);

  service.deleteSession(s1.id);
  const listAfter = service.listSessionsInRoute(routeKey);
  assert.equal(listAfter.length, 1, '过滤已删除 session');
  assert.equal(listAfter[0].id, s2.id);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('listSessionsInRoute 不存在的 route 返回空数组', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const list = service.listSessionsInRoute('feishu:nope:ou_nope');
  assert.deepEqual(list, []);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getRouteCwd 返回 route 的 cwd 字段', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  service.createSession({ route: routeKey, agent: 'opencode', cwd: '/home/proj' });

  assert.equal(service.getRouteCwd(routeKey), '/home/proj');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getRouteCwd 不存在的 route 返回空字符串', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  assert.equal(service.getRouteCwd('feishu:nope:ou_nope'), '');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('setRouteCwd 设置 route 的 cwd 字段', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  service.createSession({ route: routeKey, agent: 'opencode' });

  service.setRouteCwd(routeKey, '/new/cwd');
  assert.equal(service.getRouteCwd(routeKey), '/new/cwd');

  const state = stateStore.read();
  assert.equal(state.routes[routeKey].cwd, '/new/cwd');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('touchRoute 刷新 route 活跃时间', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  service.createSession({ route: routeKey, agent: 'opencode' });

  const before = stateStore.read().routes[routeKey];
  const beforeActiveAt = before.lastActiveAt || 0;
  const beforeUpdatedAt = before.updatedAt || 0;
  service.touchRoute(routeKey);

  const after = stateStore.read().routes[routeKey];
  assert.ok(after.lastActiveAt >= beforeActiveAt);
  assert.ok(after.updatedAt >= beforeUpdatedAt);
  assert.equal(after.lastActiveAt, after.updatedAt);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('createSession 带 route 时加入 sessions 列表', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode' });
  const s2 = service.createSession({ route: routeKey, agent: 'opencode' });

  const state = stateStore.read();
  assert.deepEqual(state.routes[routeKey].sessions, [s1.id, s2.id], '两个 session 都在列表');
  assert.equal(state.routes[routeKey].focusSessionId, s2.id, '最新创建的成为焦点');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('deleteSession 从 route sessions 移除并自动切焦点', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode' });
  const s2 = service.createSession({ route: routeKey, agent: 'opencode' });
  const s3 = service.createSession({ route: routeKey, agent: 'opencode' });
  service.setFocus(routeKey, s2.id);

  service.deleteSession(s2.id);
  const state = stateStore.read();
  assert.deepEqual(state.routes[routeKey].sessions, [s1.id, s3.id], '已删除 session 从列表移除');
  assert.ok(
    state.routes[routeKey].focusSessionId === s1.id || state.routes[routeKey].focusSessionId === s3.id,
    '删除焦点后自动切换到活跃 session',
  );
  assert.equal(service.getCurrent(routeKey).id, state.routes[routeKey].focusSessionId);

  service.deleteSession(s1.id);
  service.deleteSession(s3.id);
  const stateEmpty = stateStore.read();
  assert.equal(stateEmpty.routes[routeKey], undefined, '全部删除后 route 条目移除');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getRouteForSession 遍历 sessions 数组查找', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode' });
  const s2 = service.createSession({ agent: 'opencode' });
  service.addSessionToRoute(routeKey, s2.id, '/home/proj');

  assert.equal(service.getRouteForSession(s1.id), routeKey);
  assert.equal(service.getRouteForSession(s2.id), routeKey);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unbindRoute 从 sessions 列表移除焦点 session', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode' });
  const s2 = service.createSession({ route: routeKey, agent: 'opencode' });
  service.setFocus(routeKey, s1.id);

  service.unbindRoute(routeKey);
  const state = stateStore.read();
  assert.equal(state.routes[routeKey].focusSessionId, s2.id, '移除焦点后自动切到剩余 session');
  assert.deepEqual(state.routes[routeKey].sessions, [s2.id]);
  assert.equal(service.getCurrent(routeKey).id, s2.id);

  service.unbindRoute(routeKey);
  const stateEmpty = stateStore.read();
  assert.equal(stateEmpty.routes[routeKey], undefined, '最后一个 session 移除后 route 条目删除');
  assert.equal(service.getCurrent(routeKey), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('createSession 保存并复制 model 对象', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4' };
  const session = service.createSession({ route: routeKey, agent: 'opencode', model });

  assert.deepEqual(session.model, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });

  const stored = service.getSession(session.id);
  assert.deepEqual(stored.model, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });

  model.modelID = 'claude-opus-4';
  assert.equal(stored.model.modelID, 'claude-sonnet-4', '后续修改原对象不影响已保存模型');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('createSession 未传 model 时不写入 model 字段', () => {
  const { tmpDir, stateStore } = createTempStore();
  const service = new SessionService({ stateStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const session = service.createSession({ route: routeKey, agent: 'opencode' });

  assert.equal(session.model, undefined);

  const stored = service.getSession(session.id);
  assert.equal(stored.model, undefined);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
