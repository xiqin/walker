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
