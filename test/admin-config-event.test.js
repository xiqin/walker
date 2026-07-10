const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadEnvConfig } = require('../src/config/env');
const {
  EDITABLE_ENV_KEYS,
  SENSITIVE_ENV_KEYS,
  buildConfigSummary,
  isSensitiveEnvKey,
} = require('../src/admin/config');
const { updateDotEnv } = require('../src/admin/config-editor');
const {
  createEventStore,
  recordEvent,
  listEvents,
  recordMetric,
  getMetrics,
  timelineForSession,
} = require('../src/admin/event-store');

test('loadEnvConfig 解析 admin 默认值、布尔和端口回退', () => {
  assert.deepEqual(loadEnvConfig({ env: {} }).admin, {
    enabled: true,
    host: '127.0.0.1',
    port: 8787,
    token: '',
  });

  const disabled = loadEnvConfig({
    env: {
      WALKER_ADMIN_ENABLED: 'false',
      WALKER_ADMIN_HOST: '0.0.0.0',
      WALKER_ADMIN_PORT: '9900',
      WALKER_ADMIN_TOKEN: 'secret-token',
    },
  });
  assert.equal(disabled.admin.enabled, false);
  assert.equal(disabled.admin.host, '0.0.0.0');
  assert.equal(disabled.admin.port, 9900);
  assert.equal(disabled.admin.token, 'secret-token');

  assert.equal(loadEnvConfig({ env: { WALKER_ADMIN_PORT: 'not-a-number' } }).admin.port, 8787);
  assert.equal(loadEnvConfig({ env: { WALKER_ADMIN_PORT: '8787abc' } }).admin.port, 8787);
});

test('config 摘要脱敏并暴露可编辑字段 allowlist', () => {
  assert.equal(isSensitiveEnvKey('FEISHU_APP_SECRET'), true);
  assert.equal(isSensitiveEnvKey('WALKER_ADMIN_TOKEN'), true);
  assert.equal(EDITABLE_ENV_KEYS.includes('WALKER_ADMIN_TOKEN'), false);
  assert.equal(EDITABLE_ENV_KEYS.includes('FEISHU_APP_SECRET'), false);
  assert.equal(SENSITIVE_ENV_KEYS.includes('WALKER_ADMIN_TOKEN'), true);

  const summary = buildConfigSummary({
    FEISHU_APP_ID: 'cli_xxx',
    FEISHU_APP_SECRET: 'secret',
    WALKER_ADMIN_TOKEN: 'admin-secret',
    WALKER_ADMIN_HOST: '127.0.0.1',
    WALKER_DEFAULT_AGENT: 'opencode',
  });

  assert.equal(summary.values.FEISHU_APP_ID, 'cli_xxx');
  assert.equal(summary.values.FEISHU_APP_SECRET, '********');
  assert.equal(summary.values.WALKER_ADMIN_TOKEN, '********');
  assert.equal(summary.values.WALKER_ADMIN_HOST, '127.0.0.1');
  assert.deepEqual(summary.editableKeys, EDITABLE_ENV_KEYS);
  assert.equal(summary.sensitiveKeys.includes('FEISHU_APP_SECRET'), true);
});

test('updateDotEnv 只更新 allowlist 字段并保留注释、空行和未知键', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-admin-env-'));
  const envPath = path.join(tmpDir, '.env');
  fs.writeFileSync(envPath, [
    '# walker config',
    'FEISHU_APP_SECRET=keep-secret',
    '',
    'WALKER_ADMIN_HOST=127.0.0.1',
    'UNKNOWN_KEY=keep-me',
  ].join('\n'), 'utf8');

  const result = updateDotEnv(envPath, {
    WALKER_ADMIN_HOST: '0.0.0.0',
    WALKER_ADMIN_PORT: 8788,
    OPENCODE_SERVER_AUTOSTART: false,
  });
  const raw = fs.readFileSync(envPath, 'utf8');

  assert.equal(result.restartRequired, true);
  assert.deepEqual(result.updatedKeys, [
    'WALKER_ADMIN_HOST',
    'WALKER_ADMIN_PORT',
    'OPENCODE_SERVER_AUTOSTART',
  ]);
  assert.match(raw, /^# walker config/m);
  assert.match(raw, /^FEISHU_APP_SECRET=keep-secret/m);
  assert.match(raw, /^UNKNOWN_KEY=keep-me/m);
  assert.match(raw, /^WALKER_ADMIN_HOST=0\.0\.0\.0/m);
  assert.match(raw, /^WALKER_ADMIN_PORT=8788/m);
  assert.match(raw, /^OPENCODE_SERVER_AUTOSTART=false/m);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('updateDotEnv 拒绝 allowlist 外字段', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-admin-env-'));
  const envPath = path.join(tmpDir, '.env');
  fs.writeFileSync(envPath, 'WALKER_ADMIN_HOST=127.0.0.1\n', 'utf8');

  assert.throws(() => updateDotEnv(envPath, { WALKER_ADMIN_TOKEN: 'plain-token' }), /not editable/);
  assert.throws(() => updateDotEnv(envPath, { FEISHU_APP_SECRET: 'plain-secret' }), /not editable/);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'WALKER_ADMIN_HOST=127.0.0.1\n');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('event store 裁剪最近 1000 条事件并支持类型与 session 过滤', () => {
  const store = createEventStore();
  for (let i = 0; i < 1005; i += 1) {
    recordEvent(store, {
      type: i % 2 === 0 ? 'feishu.message' : 'error',
      level: i % 2 === 0 ? 'info' : 'error',
      sessionId: i % 3 === 0 ? 'wks_a' : 'wks_b',
      message: `event ${i}`,
      createdAt: 1000 + i,
    });
  }

  const all = listEvents(store);
  assert.equal(all.length, 1000);
  assert.equal(all[0].message, 'event 5');
  assert.equal(all[999].message, 'event 1004');
  assert.equal(listEvents(store, { type: 'error' }).every((event) => event.type === 'error'), true);
  assert.equal(listEvents(store, { limit: 3 }).length, 3);
  assert.equal(timelineForSession(store, 'wks_a').every((event) => event.sessionId === 'wks_a'), true);
});

test('event store 记录指标计数、平均耗时和 60 分钟桶', () => {
  const store = createEventStore({ now: () => Date.UTC(2026, 6, 10, 10, 30, 0) });
  recordMetric(store, 'messages', 1, Date.UTC(2026, 6, 10, 10, 0, 0));
  recordMetric(store, 'commands', 2, Date.UTC(2026, 6, 10, 10, 5, 0));
  recordMetric(store, 'errors', 1, Date.UTC(2026, 6, 10, 9, 59, 0));
  recordMetric(store, 'prompts', 1, Date.UTC(2026, 6, 10, 10, 15, 0));
  recordMetric(store, 'promptDurationMs', 120, Date.UTC(2026, 6, 10, 10, 15, 0));
  recordMetric(store, 'promptDurationMs', 80, Date.UTC(2026, 6, 10, 10, 45, 0));

  const metrics = getMetrics(store);
  assert.equal(metrics.messages, 1);
  assert.equal(metrics.commands, 2);
  assert.equal(metrics.errors, 1);
  assert.equal(metrics.prompts, 1);
  assert.deepEqual(metrics.promptDurationsMs, [120, 80]);
  assert.equal(metrics.averagePromptDurationMs, 100);
  assert.equal(metrics.buckets.length, 60);

  const ten = metrics.buckets.find((bucket) => bucket.minute === Date.UTC(2026, 6, 10, 10, 0, 0));
  assert.equal(ten.messages, 1);
  assert.equal(ten.commands, 2);
  assert.equal(ten.errors, 0);
  assert.equal(ten.prompts, 1);
  assert.equal(ten.promptDurationMs, 200);

  const nine = metrics.buckets.find((bucket) => bucket.minute === Date.UTC(2026, 6, 10, 9, 0, 0));
  assert.equal(nine.errors, 1);
});

test('event store 导出函数支持默认内存 store', () => {
  const event = recordEvent({ type: 'admin.action', sessionId: 'default-session', message: 'created' });
  recordMetric('messages');

  assert.equal(event.type, 'admin.action');
  assert.equal(timelineForSession('default-session').some((item) => item.id === event.id), true);
  assert.equal(getMetrics().messages >= 1, true);
});
