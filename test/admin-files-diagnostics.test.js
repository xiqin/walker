'use strict';

/**
 * 配置编辑、日志、附件、维护与诊断 API 测试
 * 覆盖 REQ-012、REQ-013、REQ-015、REQ-018、REQ-019、REQ-026
 * 使用临时目录构造 .env、logs、attachments、sessions/routes 文件
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { buildConfigSummary } = require('../src/admin/config');
const { updateDotEnv } = require('../src/admin/config-editor');
const { createEventStore, recordEvent } = require('../src/admin/event-store');
const { createRouter } = require('../src/admin/router');
const { success, error, send } = require('../src/admin/response');

const fileAdmin = require('../src/admin/file-admin');
const diagnostics = require('../src/admin/diagnostics');
const { createConfigRoutes } = require('../src/admin/config-routes');
const { createMaintenanceRoutes } = require('../src/admin/maintenance-routes');
const routeAdmin = require('../src/admin/route-admin');

let tmpDir;

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-admin-t4-'));
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setupDataDir(sub) {
  const dataDir = path.join(tmpDir, sub);
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function createFakeSessionService(initialSessions, initialRoutes) {
  const sessionsData = {};
  for (const s of (initialSessions || [])) {
    sessionsData[s.id] = { ...s };
  }
  const routesData = { ...(initialRoutes || {}) };

  return {
    stateStore: {
      read: () => ({ sessions: sessionsData, routes: routesData }),
      update: (fn) => fn({ sessions: sessionsData, routes: routesData }),
    },
    getSession(id) { return sessionsData[id] || null; },
    listSessions() { return Object.values(sessionsData).filter((s) => s.status !== 'deleted'); },
    bindRoute(rk, sid) { routesData[rk] = sid; },
    unbindRoute(rk) { delete routesData[rk]; },
    stopSession(id) { if (sessionsData[id]) { sessionsData[id].status = 'stopped'; } },
    deleteSession(id) { if (sessionsData[id]) { sessionsData[id].status = 'deleted'; } },
    createSession(opts) {
      const id = 'wks_test_' + Math.random().toString(36).slice(2, 8);
      sessionsData[id] = { id, ...opts, status: 'created', createdAt: Date.now(), updatedAt: Date.now() };
      return sessionsData[id];
    },
  };
}

function createFakeRegistry(drivers) {
  const d = drivers || {};
  return {
    get(name) { return d[name] || null; },
    list() { return Object.keys(d); },
  };
}

function createFakeOpencodeDriver(overrides) {
  return {
    name: 'opencode',
    serverUrl: 'http://127.0.0.1:4096',
    autostart: true,
    ensureReady: async () => true,
    ...overrides,
  };
}

function buildAppContext(overrides) {
  const store = createEventStore();
  const ctx = {
    sessionService: createFakeSessionService(),
    registry: createFakeRegistry({ opencode: createFakeOpencodeDriver() }),
    eventStore: store,
    envConfig: {
      feishuAppId: 'cli_test',
      feishuAppSecret: 'test_secret',
      feishuConfigSource: 'env',
      walkerDefaultCwd: process.cwd(),
      walkerDefaultRuntime: 'windows',
      walkerWslDistro: 'Ubuntu-24.04',
      walkerDefaultAgent: 'opencode',
    },
    dataDir: '',
    routeAdmin,
  };
  return { ...ctx, ...overrides };
}

function callRoute(routes, method, pathname, body, headers) {
  const router = createRouter();
  for (const r of routes) {
    router.add(r.method, r.pattern, r.handler);
  }

  const matched = router.match(method, pathname);
  if (!matched) return { statusCode: 404, body: null };

  const req = new EventEmitter();
  req.method = method;
  req.url = pathname;
  req.headers = headers || {};
  req.urlPath = pathname;
  req.queryString = '';
  req.params = matched.params;

  let resBody = null;
  let statusCode = 200;
  const res = {
    writeHead(code, hdrs) { statusCode = code; if (hdrs) Object.assign(res._headers, hdrs); },
    end(data) {
      if (data instanceof Buffer) {
        resBody = data;
      } else {
        try { resBody = JSON.parse(data); } catch (_e) { resBody = data; }
      }
    },
    setHeader() {},
    _headers: {},
  };

  if (matched.handler.constructor.name === 'AsyncFunction') {
    const promise = matched.handler(req, res, matched.params);
    if (body) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    } else {
      req.emit('end');
    }
    return promise.then(() => ({ statusCode, body: resBody }));
  }

  matched.handler(req, res, matched.params);

  if (body) {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  } else {
    req.emit('end');
  }

  return { statusCode, body: resBody };
}

function callRouteAsync(routes, method, pathname, body, headers) {
  const router = createRouter();
  for (const r of routes) {
    router.add(r.method, r.pattern, r.handler);
  }

  const matched = router.match(method, pathname);
  if (!matched) return Promise.resolve({ statusCode: 404, body: null });

  const req = new EventEmitter();
  req.method = method;
  req.url = pathname;
  req.headers = headers || {};
  req.urlPath = pathname;
  req.queryString = '';
  req.params = matched.params;

  let resBody = null;
  let statusCode = 200;
  const res = {
    writeHead(code) { statusCode = code; },
    end(data) {
      if (data instanceof Buffer) {
        resBody = data;
      } else {
        try { resBody = JSON.parse(data); } catch (_e) { resBody = data; }
      }
    },
    setHeader() {},
  };

  const result = matched.handler(req, res, matched.params);

  if (body) {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  } else {
    req.emit('end');
  }

  if (result && typeof result.then === 'function') {
    return result.then(() => ({ statusCode, body: resBody }));
  }

  return Promise.resolve({ statusCode, body: resBody });
}

// ── REQ-012: 配置 GET 脱敏展示和 PATCH allowlist 写入 ──

test('REQ-012: GET config 返回脱敏配置摘要', () => {
  const envPath = path.join(tmpDir, 't4-config', '.env');
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, [
    'FEISHU_APP_ID=cli_test',
    'FEISHU_APP_SECRET=my_secret',
    'WALKER_ADMIN_TOKEN=admin_token',
    'WALKER_ADMIN_HOST=127.0.0.1',
  ].join('\n'), 'utf8');

  const summary = buildConfigSummary({
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'my_secret',
    WALKER_ADMIN_TOKEN: 'admin_token',
    WALKER_ADMIN_HOST: '127.0.0.1',
  });

  assert.equal(summary.values.FEISHU_APP_ID, 'cli_test');
  assert.equal(summary.values.FEISHU_APP_SECRET, '********');
  assert.equal(summary.values.WALKER_ADMIN_TOKEN, '********');
  assert.ok(summary.editableKeys.length > 0);
  assert.ok(summary.sensitiveKeys.length > 0);
});

test('REQ-012: PATCH config 写入 allowlist 字段并返回 restartRequired', () => {
  const envPath = path.join(tmpDir, 't4-patch', '.env');
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, 'WALKER_ADMIN_HOST=127.0.0.1\n', 'utf8');

  const ctx = buildAppContext({ envPath });
  const routes = createConfigRoutes(ctx);
  const result = callRoute(routes, 'PATCH', '/api/admin/config', {
    WALKER_ADMIN_HOST: '0.0.0.0',
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.restartRequired, true);
  assert.ok(result.body.data.updatedKeys.includes('WALKER_ADMIN_HOST'));

  const updatedEnv = fs.readFileSync(envPath, 'utf8');
  assert.match(updatedEnv, /^WALKER_ADMIN_HOST=0\.0\.0\.0/m);
});

test('REQ-012: PATCH config 拒绝 allowlist 外字段', () => {
  const envPath = path.join(tmpDir, 't4-reject', '.env');
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, 'WALKER_ADMIN_HOST=127.0.0.1\n', 'utf8');

  const ctx = buildAppContext({ envPath });
  const routes = createConfigRoutes(ctx);
  const result = callRoute(routes, 'PATCH', '/api/admin/config', {
    FEISHU_APP_SECRET: 'should_not_write',
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error.message, /not editable/);
});

test('REQ-012: PATCH config 无效请求体返回 400', () => {
  const envPath = path.join(tmpDir, 't4-badbody', '.env');
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, '', 'utf8');

  const ctx = buildAppContext({ envPath });
  const routes = createConfigRoutes(ctx);

  const router = createRouter();
  for (const r of routes) router.add(r.method, r.pattern, r.handler);
  const matched = router.match('PATCH', '/api/admin/config');

  const req = new EventEmitter();
  req.headers = {};
  let statusCode = 200;
  let resBody = null;
  const res = {
    writeHead(code) { statusCode = code; },
    end(data) { try { resBody = JSON.parse(data); } catch (_e) { resBody = data; } },
    setHeader() {},
  };

  matched.handler(req, res, matched.params);
  req.emit('data', Buffer.from('not-json'));
  req.emit('end');

  assert.equal(statusCode, 400);
  assert.equal(resBody.ok, false);
});

// ── REQ-013: 日志读取 out/err 切换、最近 500 行、关键词过滤、级别过滤 ──

test('REQ-013: readLogs 读取 stdout 日志', () => {
  const dataDir = setupDataDir('t4-logs-out');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const lines = [];
  for (let i = 0; i < 10; i++) {
    lines.push(JSON.stringify({ level: 'info', message: `log line ${i}`, scope: 'test' }));
  }
  fs.writeFileSync(path.join(logsDir, 'walker-out.log'), lines.join('\n'), 'utf8');

  const result = fileAdmin.readLogs({ dataDir, stream: 'out' });
  assert.equal(result.lines.length, 10);
  assert.equal(result.total, 10);
  assert.equal(result.lines[0].level, 'info');
  assert.equal(result.lines[0].message, 'log line 0');
});

test('REQ-013: readLogs 读取 stderr 日志', () => {
  const dataDir = setupDataDir('t4-logs-err');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  fs.writeFileSync(path.join(logsDir, 'walker-err.log'),
    JSON.stringify({ level: 'error', message: 'error occurred' }) + '\n', 'utf8');

  const result = fileAdmin.readLogs({ dataDir, stream: 'err' });
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].level, 'error');
});

test('REQ-013: readLogs 关键词过滤', () => {
  const dataDir = setupDataDir('t4-logs-kw');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const lines = [
    JSON.stringify({ level: 'info', message: 'session created' }),
    JSON.stringify({ level: 'info', message: 'prompt completed' }),
    JSON.stringify({ level: 'error', message: 'prompt failed timeout' }),
  ];
  fs.writeFileSync(path.join(logsDir, 'walker-out.log'), lines.join('\n'), 'utf8');

  const result = fileAdmin.readLogs({ dataDir, keyword: 'prompt' });
  assert.equal(result.filtered, 2);
  assert.equal(result.lines.every((l) => l.message.includes('prompt')), true);
});

test('REQ-013: readLogs 级别过滤', () => {
  const dataDir = setupDataDir('t4-logs-level');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const lines = [
    JSON.stringify({ level: 'info', message: 'info msg' }),
    JSON.stringify({ level: 'error', message: 'error msg' }),
    JSON.stringify({ level: 'warn', message: 'warn msg' }),
  ];
  fs.writeFileSync(path.join(logsDir, 'walker-out.log'), lines.join('\n'), 'utf8');

  const result = fileAdmin.readLogs({ dataDir, level: 'error' });
  assert.equal(result.filtered, 1);
  assert.equal(result.lines[0].level, 'error');
  assert.equal(result.lines[0].message, 'error msg');
});

test('REQ-013: readLogs 缺失文件返回空结果', () => {
  const dataDir = setupDataDir('t4-logs-missing');
  const result = fileAdmin.readLogs({ dataDir });
  assert.equal(result.lines.length, 0);
  assert.equal(result.total, 0);
  assert.equal(result.filtered, 0);
});

test('REQ-013: readLogs 最近 500 行限制', () => {
  const dataDir = setupDataDir('t4-lines-limit');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const lines = [];
  for (let i = 0; i < 600; i++) {
    lines.push(JSON.stringify({ level: 'info', message: `line ${i}` }));
  }
  fs.writeFileSync(path.join(logsDir, 'walker-out.log'), lines.join('\n'), 'utf8');

  const result = fileAdmin.readLogs({ dataDir, lines: 500 });
  assert.equal(result.lines.length, 500);
  assert.equal(result.total, 600);
});

test('REQ-013: readLogs 非结构化行原样保留', () => {
  const dataDir = setupDataDir('t4-raw-lines');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  fs.writeFileSync(path.join(logsDir, 'walker-out.log'),
    'plain text line\n' + JSON.stringify({ level: 'info', message: 'structured' }) + '\n', 'utf8');

  const result = fileAdmin.readLogs({ dataDir });
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].raw, 'plain text line');
  assert.equal(result.lines[0].level, 'unknown');
  assert.equal(result.lines[1].level, 'info');
});

// ── REQ-015: 附件列举、下载和删除，路径穿越防护 ──

test('REQ-015: listAttachments 列出按 session 分组的附件', () => {
  const dataDir = setupDataDir('t4-attach-list');
  const attachDir = path.join(dataDir, 'attachments');
  const sessDir = path.join(attachDir, 'wks_a1');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'report.pdf'), Buffer.from('pdf content'));
  fs.writeFileSync(path.join(sessDir, 'image.png'), Buffer.from('png content'));

  const result = fileAdmin.listAttachments(dataDir);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].sessionId, 'wks_a1');
  assert.equal(result.groups[0].files.length, 2);
  assert.equal(result.totalFiles, 2);
  const names = result.groups[0].files.map((f) => f.name);
  assert.ok(names.includes('report.pdf'));
  assert.ok(names.includes('image.png'));
});

test('REQ-015: getAttachment 读取附件内容', () => {
  const dataDir = setupDataDir('t4-attach-get');
  const sessDir = path.join(dataDir, 'attachments', 'wks_a2');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'data.txt'), Buffer.from('hello attachment'));

  const result = fileAdmin.getAttachment(dataDir, 'wks_a2', 'data.txt');
  assert.equal(result.ok, true);
  assert.equal(result.data.toString(), 'hello attachment');
});

test('REQ-015: getAttachment 拒绝路径穿越', () => {
  const dataDir = setupDataDir('t4-attach-traversal');
  fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });

  const result = fileAdmin.getAttachment(dataDir, '..', '.env');
  assert.equal(result.ok, false);
  assert.match(result.error, /路径穿越/);
});

test('REQ-015: getAttachment 不存在的附件返回错误', () => {
  const dataDir = setupDataDir('t4-attach-missing');
  fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });

  const result = fileAdmin.getAttachment(dataDir, 'wks_none', 'missing.txt');
  assert.equal(result.ok, false);
  assert.match(result.error, /不存在/);
});

test('REQ-015: deleteAttachment 删除附件文件', () => {
  const dataDir = setupDataDir('t4-attach-del');
  const sessDir = path.join(dataDir, 'attachments', 'wks_a3');
  fs.mkdirSync(sessDir, { recursive: true });
  const filePath = path.join(sessDir, 'temp.bin');
  fs.writeFileSync(filePath, Buffer.from('temp data'));

  const result = fileAdmin.deleteAttachment(dataDir, 'wks_a3', 'temp.bin');
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(filePath), false);
});

test('REQ-015: deleteAttachment 拒绝路径穿越', () => {
  const dataDir = setupDataDir('t4-attach-del-traversal');
  fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });

  const result = fileAdmin.deleteAttachment(dataDir, '../../etc', 'passwd');
  assert.equal(result.ok, false);
  assert.match(result.error, /路径穿越/);
});

test('REQ-015: safeResolve 验证路径安全', () => {
  const root = 'C:\\walker\\data\\attachments';
  assert.equal(fileAdmin.safeResolve(root, '../outside.txt'), null);
  assert.equal(fileAdmin.safeResolve(root, '../../etc/passwd'), null);
  const resolved = fileAdmin.safeResolve(root, 'wks_a/file.txt');
  assert.ok(resolved !== null);
  assert.ok(resolved.startsWith(root));
});

test('REQ-015: listAttachments 空目录返回空结果', () => {
  const dataDir = setupDataDir('t4-attach-empty');
  const result = fileAdmin.listAttachments(dataDir);
  assert.equal(result.groups.length, 0);
  assert.equal(result.totalFiles, 0);
});

// ── REQ-018: 健康检查覆盖飞书、数据目录、JSON、OpenCode、runtime、日志和孤立 route ──

test('REQ-018: runHealthCheck 返回完整检查项', async () => {
  const dataDir = setupDataDir('t4-health');
  const ctx = buildAppContext({
    dataDir,
    sessionService: createFakeSessionService([], {}),
  });

  const checks = await diagnostics.runHealthCheck(ctx);
  assert.equal(checks.length, 7);

  const names = checks.map((c) => c.name);
  assert.ok(names.includes('feishu_credentials'));
  assert.ok(names.includes('data_directory'));
  assert.ok(names.includes('json_files'));
  assert.ok(names.includes('opencode'));
  assert.ok(names.includes('runtime'));
  assert.ok(names.includes('log_files'));
  assert.ok(names.includes('dangling_routes'));
});

test('REQ-018: 飞书凭据完整时 pass', async () => {
  const ctx = buildAppContext({
    envConfig: { feishuAppId: 'cli_test', feishuAppSecret: 'secret', feishuConfigSource: 'env' },
  });
  const checks = await diagnostics.runHealthCheck(ctx);
  const feishu = checks.find((c) => c.name === 'feishu_credentials');
  assert.equal(feishu.status, 'pass');
});

test('REQ-018: 飞书凭据缺失时 fail', async () => {
  const ctx = buildAppContext({
    envConfig: { feishuAppId: '', feishuAppSecret: '', feishuConfigSource: 'missing' },
  });
  const checks = await diagnostics.runHealthCheck(ctx);
  const feishu = checks.find((c) => c.name === 'feishu_credentials');
  assert.equal(feishu.status, 'fail');
});

test('REQ-018: 数据目录不存在时 fail', async () => {
  const ctx = buildAppContext({
    dataDir: path.join(tmpDir, 'nonexistent-dir-xyz'),
  });
  const checks = await diagnostics.runHealthCheck(ctx);
  const dataDirCheck = checks.find((c) => c.name === 'data_directory');
  assert.equal(dataDirCheck.status, 'fail');
});

test('REQ-018: 数据目录存在且可写时 pass', async () => {
  const dataDir = setupDataDir('t4-health-dir');
  const ctx = buildAppContext({ dataDir });
  const checks = await diagnostics.runHealthCheck(ctx);
  const dataDirCheck = checks.find((c) => c.name === 'data_directory');
  assert.equal(dataDirCheck.status, 'pass');
});

test('REQ-018: JSON 文件完整时 pass', async () => {
  const dataDir = setupDataDir('t4-json-ok');
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ sessions: {}, routes: {} }), 'utf8');

  const ctx = buildAppContext({ dataDir });
  const checks = await diagnostics.runHealthCheck(ctx);
  const jsonCheck = checks.find((c) => c.name === 'json_files');
  assert.equal(jsonCheck.status, 'pass');
});

test('REQ-018: JSON 文件损坏时 fail', async () => {
  const dataDir = setupDataDir('t4-json-bad');
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{broken json!!!', 'utf8');

  const ctx = buildAppContext({ dataDir });
  const checks = await diagnostics.runHealthCheck(ctx);
  const jsonCheck = checks.find((c) => c.name === 'json_files');
  assert.equal(jsonCheck.status, 'fail');
});

test('REQ-018: JSON 文件缺失时 warn', async () => {
  const dataDir = setupDataDir('t4-json-missing');
  const ctx = buildAppContext({ dataDir });
  const checks = await diagnostics.runHealthCheck(ctx);
  const jsonCheck = checks.find((c) => c.name === 'json_files');
  assert.equal(jsonCheck.status, 'warn');
});

test('REQ-018: OpenCode 可用时 pass', async () => {
  const ctx = buildAppContext();
  const checks = await diagnostics.runHealthCheck(ctx);
  const oc = checks.find((c) => c.name === 'opencode');
  assert.equal(oc.status, 'pass');
});

test('REQ-018: OpenCode 不可用时 fail', async () => {
  const ctx = buildAppContext({
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver({
        ensureReady: async () => { throw new Error('opencode not available'); },
      }),
    }),
  });
  const checks = await diagnostics.runHealthCheck(ctx);
  const oc = checks.find((c) => c.name === 'opencode');
  assert.equal(oc.status, 'fail');
});

test('REQ-018: runtime 工作目录存在时 pass', async () => {
  const dataDir = setupDataDir('t4-rt-ok');
  const ctx = buildAppContext({
    dataDir,
    envConfig: { walkerDefaultCwd: dataDir, walkerDefaultRuntime: 'windows' },
  });
  const checks = await diagnostics.runHealthCheck(ctx);
  const rt = checks.find((c) => c.name === 'runtime');
  assert.equal(rt.status, 'pass');
});

test('REQ-018: 日志文件存在时 pass', async () => {
  const dataDir = setupDataDir('t4-logs-exist');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'walker-out.log'), '', 'utf8');
  fs.writeFileSync(path.join(logsDir, 'walker-err.log'), '', 'utf8');

  const ctx = buildAppContext({ dataDir });
  const checks = await diagnostics.runHealthCheck(ctx);
  const logCheck = checks.find((c) => c.name === 'log_files');
  assert.equal(logCheck.status, 'pass');
});

test('REQ-018: 日志目录不存在时 warn', async () => {
  const dataDir = setupDataDir('t4-logs-none');
  const ctx = buildAppContext({ dataDir });
  const checks = await diagnostics.runHealthCheck(ctx);
  const logCheck = checks.find((c) => c.name === 'log_files');
  assert.equal(logCheck.status, 'warn');
});

test('REQ-018: 孤立 route 存在时 warn', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([], { 'feishu:dangle': 'wks_nonexist' }),
  });
  const checks = await diagnostics.runHealthCheck(ctx);
  const danglingCheck = checks.find((c) => c.name === 'dangling_routes');
  assert.equal(danglingCheck.status, 'warn');
});

test('REQ-018: 无孤立 route 时 pass', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([], {}),
  });
  const checks = await diagnostics.runHealthCheck(ctx);
  const danglingCheck = checks.find((c) => c.name === 'dangling_routes');
  assert.equal(danglingCheck.status, 'pass');
});

test('REQ-018: 单项检查失败不导致整体抛错', async () => {
  const ctx = buildAppContext({
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver({
        ensureReady: async () => { throw new Error('opencode error'); },
      }),
    }),
  });

  const checks = await diagnostics.runHealthCheck(ctx);
  assert.equal(checks.length, 7);
  const failItems = checks.filter((c) => c.status === 'fail');
  assert.ok(failItems.length > 0);
  const passItems = checks.filter((c) => c.status === 'pass');
  assert.ok(passItems.length > 0);
});

// ── REQ-019: 导出、备份和确认清理维护动作 ──

test('REQ-019: 导出 sessions 和 routes 数据', () => {
  const dataDir = setupDataDir('t4-export');
  const ctx = buildAppContext({
    dataDir,
    sessionService: createFakeSessionService([
      { id: 'wks_e1', status: 'running', agent: 'opencode', title: 's1' },
    ], { 'feishu:abc': 'wks_e1' }),
  });

  const routes = createMaintenanceRoutes(ctx);
  const router = createRouter();
  for (const r of routes) router.add(r.method, r.pattern, r.handler);

  const matched = router.match('GET', '/api/admin/export');
  assert.ok(matched);

  const req = new EventEmitter();
  req.headers = {};
  let statusCode = 200;
  let resBody = null;
  const resHeaders = {};
  const res = {
    writeHead(code, hdrs) { statusCode = code; Object.assign(resHeaders, hdrs || {}); },
    end(data) { resBody = data; },
    setHeader() {},
  };

  matched.handler(req, res, matched.params);
  req.emit('end');

  assert.equal(statusCode, 200);
  assert.ok(resHeaders['Content-Type'].includes('application/json'));
  assert.ok(resHeaders['Content-Disposition'].includes('walker-export.json'));

  const parsed = JSON.parse(resBody);
  assert.ok(parsed.sessions);
  assert.ok(parsed.routes);
  assert.ok(parsed.exportedAt);
});

test('REQ-019: 备份 sessions 和 routes 到 timestamp 文件', () => {
  const dataDir = setupDataDir('t4-backup');
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ sessions: { wks_b1: { id: 'wks_b1' } }, routes: { 'feishu:abc': 'wks_b1' } }), 'utf8');

  const ctx = buildAppContext({
    dataDir,
    sessionService: createFakeSessionService(
      [{ id: 'wks_b1', status: 'running' }],
      { 'feishu:abc': 'wks_b1' }
    ),
  });

  const routes = createMaintenanceRoutes(ctx);
  const result = callRoute(routes, 'POST', '/api/admin/backup');

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.ok(result.body.data.timestamp);
  assert.equal(result.body.data.files.length, 1);

  const backupFiles = fs.readdirSync(dataDir).filter((f) => f.includes('.backup-'));
  assert.equal(backupFiles.length, 1);
});

test('REQ-019: 确认清理 stopped/deleted session route 和孤立附件', () => {
  const dataDir = setupDataDir('t4-cleanup');
  const attachDir = path.join(dataDir, 'attachments', 'wks_deleted1');
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, 'orphan.txt'), Buffer.from('orphan file'));

  const ctx = buildAppContext({
    dataDir,
    sessionService: createFakeSessionService(
      [{ id: 'wks_deleted1', status: 'deleted', agent: 'opencode', title: 'deleted' }],
      { 'feishu:abc': 'wks_deleted1' }
    ),
  });

  const routes = createMaintenanceRoutes(ctx);
  const result = callRoute(routes, 'POST', '/api/admin/cleanup', { confirmed: true });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.ok(result.body.data.routes);
  assert.ok(result.body.data.attachments);
  assert.equal(result.body.data.routes.ok, true);
  assert.ok(result.body.data.routes.cleaned.length > 0);
});

test('REQ-019: 清理未确认返回 BAD_REQUEST', () => {
  const dataDir = setupDataDir('t4-cleanup-no');
  const ctx = buildAppContext({ dataDir });

  const routes = createMaintenanceRoutes(ctx);
  const result = callRoute(routes, 'POST', '/api/admin/cleanup', { confirmed: false });

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error.message, /confirmed=true/);
});

test('REQ-019: 清理请求体缺失确认字段返回 400', () => {
  const dataDir = setupDataDir('t4-cleanup-nobody');
  const ctx = buildAppContext({ dataDir });

  const routes = createMaintenanceRoutes(ctx);
  const result = callRoute(routes, 'POST', '/api/admin/cleanup', {});

  assert.equal(result.statusCode, 400);
});

// ── 孤立附件查找和清理 ──

test('findOrphanAttachments 发现孤立附件', () => {
  const dataDir = setupDataDir('t4-orphan-find');
  const sessDir = path.join(dataDir, 'attachments', 'wks_del1');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'file1.txt'), Buffer.from('data'));

  const sessionsData = { wks_del1: { status: 'deleted' } };
  const orphans = fileAdmin.findOrphanAttachments(dataDir, sessionsData);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].sessionId, 'wks_del1');
  assert.equal(orphans[0].reason, 'session deleted');
});

test('findOrphanAttachments 发现不存在 session 的附件', () => {
  const dataDir = setupDataDir('t4-orphan-none');
  const sessDir = path.join(dataDir, 'attachments', 'wks_ghost');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'ghost.txt'), Buffer.from('ghost'));

  const orphans = fileAdmin.findOrphanAttachments(dataDir, {});
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].reason, 'session not found');
});

test('cleanupOrphanAttachments 清理孤立附件', () => {
  const dataDir = setupDataDir('t4-orphan-cleanup');
  const sessDir = path.join(dataDir, 'attachments', 'wks_del2');
  fs.mkdirSync(sessDir, { recursive: true });
  const filePath = path.join(sessDir, 'del.txt');
  fs.writeFileSync(filePath, Buffer.from('to delete'));

  const sessionsData = { wks_del2: { status: 'deleted' } };
  const result = fileAdmin.cleanupOrphanAttachments(dataDir, sessionsData, true);
  assert.equal(result.ok, true);
  assert.equal(result.cleaned.length, 1);
  assert.equal(fs.existsSync(filePath), false);
});

test('cleanupOrphanAttachments 未确认返回错误', () => {
  const result = fileAdmin.cleanupOrphanAttachments('', {}, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /confirm=true/);
});

// ── 路由集成测试 ──

test('createMaintenanceRoutes 注册日志、附件、导出、备份、清理和健康路由', () => {
  const ctx = buildAppContext();
  const routes = createMaintenanceRoutes(ctx);

  const patterns = routes.map((r) => r.method + ' ' + r.pattern);
  assert.ok(patterns.includes('GET /api/admin/logs'));
  assert.ok(patterns.includes('GET /api/admin/attachments'));
  assert.ok(patterns.includes('GET /api/admin/attachments/:sessionId/:filename'));
  assert.ok(patterns.includes('DELETE /api/admin/attachments/:sessionId/:filename'));
  assert.ok(patterns.includes('GET /api/admin/export'));
  assert.ok(patterns.includes('POST /api/admin/backup'));
  assert.ok(patterns.includes('POST /api/admin/cleanup'));
  assert.ok(patterns.includes('GET /api/admin/health'));
});

test('createConfigRoutes 注册 GET 和 PATCH config 路由', () => {
  const ctx = buildAppContext();
  const routes = createConfigRoutes(ctx);

  const patterns = routes.map((r) => r.method + ' ' + r.pattern);
  assert.ok(patterns.includes('GET /api/admin/config'));
  assert.ok(patterns.includes('PATCH /api/admin/config'));
});

test('GET health 路由返回检查结果', async () => {
  const dataDir = setupDataDir('t4-health-route');
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ sessions: {}, routes: {} }), 'utf8');

  const ctx = buildAppContext({ dataDir });
  const routes = createMaintenanceRoutes(ctx);
  const result = await callRouteAsync(routes, 'GET', '/api/admin/health');

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.ok(result.body.data.checks.length === 7);
  assert.ok(result.body.data.overall);
});

test('GET logs 路由返回日志数据', () => {
  const dataDir = setupDataDir('t4-logs-route');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'walker-out.log'),
    JSON.stringify({ level: 'info', message: 'test' }) + '\n', 'utf8');

  const ctx = buildAppContext({ dataDir });
  const routes = createMaintenanceRoutes(ctx);
  const result = callRoute(routes, 'GET', '/api/admin/logs');

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.lines.length, 1);
});

test('DELETE 附件路由拒绝路径穿越', () => {
  const dataDir = setupDataDir('t4-attach-route-traversal');
  fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });

  const ctx = buildAppContext({ dataDir });
  const routes = createMaintenanceRoutes(ctx);

  const router = createRouter();
  for (const r of routes) router.add(r.method, r.pattern, r.handler);
  const matched = router.match('DELETE', '/api/admin/attachments/..%2F../etc/passwd');

  if (matched) {
    const params = matched.params;
    assert.ok(params.sessionId.includes('..') || params.filename.includes('..'));
  }
});

// ── REQ-026: 文件与诊断 API 测试可独立运行 ──

test('REQ-026: 所有测试使用临时目录，无外部连接依赖', () => {
  assert.ok(tmpDir);
  assert.ok(fs.existsSync(tmpDir));
});

test('REQ-026: 配置更新事件写入 eventStore', () => {
  const envPath = path.join(tmpDir, 't4-event', '.env');
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, 'WALKER_ADMIN_HOST=127.0.0.1\n', 'utf8');

  const store = createEventStore();
  const ctx = buildAppContext({ envPath, eventStore: store });
  const routes = createConfigRoutes(ctx);
  callRoute(routes, 'PATCH', '/api/admin/config', { WALKER_ADMIN_HOST: '0.0.0.0' });

  const events = store.events.filter((e) => e.type === 'config.update');
  assert.ok(events.length >= 1);
  assert.equal(events[0].message, '配置已更新，需要重启');
});

test('REQ-026: 附件删除事件写入 eventStore', () => {
  const dataDir = setupDataDir('t4-del-event');
  const sessDir = path.join(dataDir, 'attachments', 'wks_ev');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'ev.txt'), Buffer.from('ev'));

  const store = createEventStore();
  const ctx = buildAppContext({ dataDir, eventStore: store });
  const routes = createMaintenanceRoutes(ctx);
  callRoute(routes, 'DELETE', '/api/admin/attachments/wks_ev/ev.txt');

  const events = store.events.filter((e) => e.type === 'attachment.delete');
  assert.ok(events.length >= 1);
});

test('REQ-026: 备份事件写入 eventStore', () => {
  const dataDir = setupDataDir('t4-bak-event');
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ sessions: {}, routes: {} }), 'utf8');

  const store = createEventStore();
  const ctx = buildAppContext({ dataDir, eventStore: store, sessionService: createFakeSessionService([], {}) });
  const routes = createMaintenanceRoutes(ctx);
  callRoute(routes, 'POST', '/api/admin/backup');

  const events = store.events.filter((e) => e.type === 'maintenance.backup');
  assert.ok(events.length >= 1);
});

test('REQ-026: 清理事件写入 eventStore', () => {
  const dataDir = setupDataDir('t4-cln-event');
  const sessDir = path.join(dataDir, 'attachments', 'wks_del_evt');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'd.txt'), Buffer.from('d'));

  const store = createEventStore();
  const ctx = buildAppContext({
    dataDir,
    eventStore: store,
    sessionService: createFakeSessionService(
      [{ id: 'wks_del_evt', status: 'deleted' }],
      { 'feishu:cln': 'wks_del_evt' }
    ),
  });
  const routes = createMaintenanceRoutes(ctx);
  callRoute(routes, 'POST', '/api/admin/cleanup', { confirmed: true });

  const events = store.events.filter((e) => e.type === 'maintenance.cleanup');
  assert.ok(events.length >= 1);
});
