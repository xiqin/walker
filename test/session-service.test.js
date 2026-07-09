const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { SessionService } = require('../src/core/session-service');
const { JsonStore } = require('../src/core/json-store');

function createTempStores() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-session-'));
  const sessionsStore = new JsonStore(path.join(tmpDir, 'sessions.json'), {});
  const routesStore = new JsonStore(path.join(tmpDir, 'routes.json'), {});
  return { tmpDir, sessionsStore, routesStore };
}

test('createSession 创建并自动绑定 routeKey', () => {
  const { tmpDir, sessionsStore, routesStore } = createTempStores();
  const service = new SessionService({ sessionsStore, routesStore });
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
  const { tmpDir, sessionsStore, routesStore } = createTempStores();
  const service = new SessionService({ sessionsStore, routesStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s1 = service.createSession({ route: routeKey, agent: 'opencode' });
  const s2 = service.createSession({ route: routeKey, agent: 'opencode' });

  assert.equal(service.getCurrent(routeKey).id, s2.id);
  assert.equal(s1.status, 'created');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('bindRoute 绑定已存在 session 到新 routeKey', () => {
  const { tmpDir, sessionsStore, routesStore } = createTempStores();
  const service = new SessionService({ sessionsStore, routesStore });
  const s1 = service.createSession({ route: 'feishu:oc_1:ou_a', agent: 'opencode' });
  service.bindRoute('feishu:oc_2:ou_b', s1.id);

  assert.equal(service.getCurrent('feishu:oc_2:ou_b').id, s1.id);
  assert.equal(service.getCurrent('feishu:oc_1:ou_a').id, s1.id);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unbindRoute 清除 routeKey 的绑定', () => {
  const { tmpDir, sessionsStore, routesStore } = createTempStores();
  const service = new SessionService({ sessionsStore, routesStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  service.createSession({ route: routeKey, agent: 'opencode' });
  service.unbindRoute(routeKey);

  assert.equal(service.getCurrent(routeKey), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('listSessions 返回所有 session', () => {
  const { tmpDir, sessionsStore, routesStore } = createTempStores();
  const service = new SessionService({ sessionsStore, routesStore });
  service.createSession({ route: 'feishu:oc_1:ou_a', agent: 'opencode', title: 'first' });
  service.createSession({ route: 'feishu:oc_2:ou_b', agent: 'opencode', title: 'second' });

  const list = service.listSessions();
  assert.equal(list.length, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('状态切换：created -> running -> idle -> stopped', () => {
  const { tmpDir, sessionsStore, routesStore } = createTempStores();
  const service = new SessionService({ sessionsStore, routesStore });
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
  const { tmpDir, sessionsStore, routesStore } = createTempStores();
  const service = new SessionService({ sessionsStore, routesStore });
  const s = service.createSession({ route: 'feishu:oc_abc:ou_user', agent: 'opencode' });
  service.markError(s.id, 'API key expired');
  assert.equal(service.getSession(s.id).status, 'error');
  assert.equal(service.getSession(s.id).errorMessage, 'API key expired');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('deleteSession 标记删除并清除绑定', () => {
  const { tmpDir, sessionsStore, routesStore } = createTempStores();
  const service = new SessionService({ sessionsStore, routesStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s = service.createSession({ route: routeKey, agent: 'opencode' });
  service.deleteSession(s.id);

  assert.equal(service.getSession(s.id).status, 'deleted');
  assert.equal(service.getCurrent(routeKey), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('重启后恢复持久化数据', () => {
  const { tmpDir, sessionsStore, routesStore } = createTempStores();
  const service1 = new SessionService({ sessionsStore, routesStore });
  const routeKey = 'feishu:oc_abc:ou_user';
  const s = service1.createSession({ route: routeKey, agent: 'opencode', title: 'persistent' });

  const service2 = new SessionService({ sessionsStore, routesStore });
  assert.equal(service2.getCurrent(routeKey).id, s.id);
  assert.equal(service2.getSession(s.id).title, 'persistent');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('bindRoute 到不存在的 session 报错', () => {
  const { tmpDir, sessionsStore, routesStore } = createTempStores();
  const service = new SessionService({ sessionsStore, routesStore });
  assert.throws(() => service.bindRoute('feishu:oc_1:ou_a', 'wks_nonexistent'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
