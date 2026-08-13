'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { MessageDedup } = require('../src/core/message-dedup');

function makeMocks(overrides = {}) {
  const sessionService = {
    getCurrent: () => null,
    getSession: () => null,
    createSession: (opts) => ({ id: 'wks_new1', status: 'idle', ...opts }),
    bindRoute: () => {},
    listSessionsInRoute: () => [],
    getRouteCwd: () => '',
    touchRoute: () => {},
    markRunning: () => {},
    markIdle: () => {},
    markError: () => {},
    deleteSession: overrides.deleteSession || (() => {}),
    listSessions: overrides.sessionList || (() => []),
    updateSessionField: () => {},
  };
  const claudeDriver = {
    ensureReady: async () => true,
    listSessions: overrides.claudeListSessions || (async () => []),
    resumeSession: overrides.claudeResumeSession || (async (ref) => ({ provider: 'claude', transport: 'pty-attach', runtimeId: 'rt1', cwd: ref.cwd, claudeSessionId: ref.claudeSessionId })),
    watchSession: () => () => {},
    isSessionRefActive: overrides.isSessionRefActive || (() => false),
    stop: async () => {},
    delete: async () => {},
  };
  const opencodeDriver = { ensureReady: async () => true, listSessions: async () => [], resumeSession: async (r) => r, watchSession: () => () => {}, stop: async () => {}, delete: async () => {} };
  const driverRegistry = { get: (agent) => (agent === 'claude' ? claudeDriver : opencodeDriver) };
  const feishuApi = {
    calls: [],
    replyText: (_ctx, text) => { feishuApi.calls.push({ type: 'replyText', text }); return [{ message_id: 'om_r' }]; },
    sendAttachableSessionList: (_ctx, sessions, options) => { feishuApi.calls.push({ type: 'sendAttachableSessionList', sessions, options }); },
    sendErrorCard: (_ctx, message) => { feishuApi.calls.push({ type: 'sendErrorCard', message }); },
    sendUnboundGuide: (_ctx) => { feishuApi.calls.push({ type: 'sendUnboundGuide' }); },
  };
  const dedup = new MessageDedup({ windowMs: 300000 });
  return { sessionService, claudeDriver, opencodeDriver, driverRegistry, feishuApi, dedup };
}

function makeDispatcher(mocks) {
  return new MessageDispatcher({
    sessionService: mocks.sessionService,
    driverRegistry: mocks.driverRegistry,
    feishuApi: mocks.feishuApi,
    dedup: mocks.dedup,
    routeMode: 'thread',
    defaultCwd: 'H:\\walker',
    runtimeType: 'windows',
  });
}

function attachCmd(args, extra = {}) {
  return { name: 'attach', args, routeKey: 'rk1', messageId: 'om1', chatId: 'c1', ...extra };
}

describe('MessageDispatcher /attach claude', () => {
  it('无参列出 Claude 会话卡片(agent=claude, managedIds)', async () => {
    const now = Date.now();
    const mocks = makeMocks({
      claudeListSessions: async () => [
        { id: '11111111-1111-4111-8111-111111111111', title: 't1', status: 'idle', cwd: 'H:\\walker', updatedAt: now },
        { id: '22222222-2222-4222-8222-222222222222', title: 't2', status: 'idle', cwd: 'H:\\other', updatedAt: now - 1000 },
      ],
    });
    const dispatcher = makeDispatcher(mocks);
    await dispatcher.handleCommand(attachCmd(['claude']));
    const call = mocks.feishuApi.calls.find((c) => c.type === 'sendAttachableSessionList');
    assert.ok(call, '发送了可纳入会话卡片');
    assert.equal(call.options.agent, 'claude');
    assert.deepEqual(call.options.managedIds, []);
    assert.equal(call.sessions.length, 2);
  });

  it('单候选自动附加且 resumeSession 收到被选会话 cwd', async () => {
    let resumed = null;
    const mocks = makeMocks({
      claudeListSessions: async () => [{ id: '11111111-1111-4111-8111-111111111111', title: 'only', status: 'idle', cwd: 'H:\\proj', updatedAt: Date.now() }],
      claudeResumeSession: async (ref) => { resumed = ref; return { provider: 'claude', transport: 'pty-attach', runtimeId: 'rt1', cwd: ref.cwd, claudeSessionId: ref.claudeSessionId }; },
    });
    const dispatcher = makeDispatcher(mocks);
    await dispatcher.handleCommand(attachCmd(['claude']));
    assert.ok(resumed, '调用了 resumeSession');
    assert.equal(resumed.claudeSessionId, '11111111-1111-4111-8111-111111111111');
    assert.equal(resumed.cwd, 'H:\\proj');
    assert.equal(mocks.feishuApi.calls.find((c) => c.type === 'sendAttachableSessionList'), undefined, '单候选不发卡片');
    assert.ok(mocks.feishuApi.calls.find((c) => c.type === 'replyText' && /Claude session attached/.test(c.text)));
  });

  it('/attach claude <uuid> 用被选会话 cwd resume(非 defaultCwd)', async () => {
    let resumed = null;
    const mocks = makeMocks({
      claudeListSessions: async () => [{ id: '11111111-1111-4111-8111-111111111111', title: 't', status: 'idle', cwd: 'H:\\target', updatedAt: 1000 }],
      claudeResumeSession: async (ref) => { resumed = ref; return { provider: 'claude', transport: 'pty-attach', runtimeId: 'rt1', cwd: ref.cwd, claudeSessionId: ref.claudeSessionId }; },
    });
    const dispatcher = makeDispatcher(mocks);
    await dispatcher.handleCommand(attachCmd(['claude', '11111111-1111-4111-8111-111111111111']));
    assert.ok(resumed);
    assert.equal(resumed.cwd, 'H:\\target');
  });

  it('/attach claude --page 重复回调不被 dedup 拦截', async () => {
    const mocks = makeMocks({ claudeListSessions: async () => [{ id: 'u1', title: 't', status: 'idle', cwd: 'H:\\w', updatedAt: Date.now() }] });
    const dispatcher = makeDispatcher(mocks);
    const r1 = await dispatcher.handleCommand(attachCmd(['claude', '--page', '1']));
    const r2 = await dispatcher.handleCommand(attachCmd(['claude', '--page', '1']));
    assert.equal(r1.duplicate, undefined);
    assert.equal(r2.duplicate, undefined, '分页回调不被去重拦截');
  });

  it('/attach claude --search 透传 formValue.attach_search', async () => {
    const now = Date.now();
    const mocks = makeMocks({
      claudeListSessions: async () => [
        { id: 'u1', title: 'alpha', status: 'idle', cwd: 'H:\\w', updatedAt: now },
        { id: 'u2', title: 'beta', status: 'idle', cwd: 'H:\\w', updatedAt: now - 1000 },
      ],
    });
    const dispatcher = makeDispatcher(mocks);
    await dispatcher.handleCommand(attachCmd(['claude', '--search'], { formValue: { attach_search: 'alpha' } }));
    const call = mocks.feishuApi.calls.find((c) => c.type === 'sendAttachableSessionList');
    assert.ok(call);
    assert.equal(call.options.search, 'alpha');
  });

  it('清理 Walker 管理中但本地历史已不存在的 Claude 孤儿 session', async () => {
    const orphan = { id: 'wks_orphan', agent: 'claude', status: 'idle', agentRef: { claudeSessionId: '33333333-3333-4333-8333-333333333333' } };
    const deleted = [];
    const mocks = makeMocks({
      claudeListSessions: async () => [{ id: '11111111-1111-4111-8111-111111111111', title: 't', status: 'idle', cwd: 'H:\\w', updatedAt: Date.now() }],
      sessionList: () => [orphan],
      deleteSession: (sid) => deleted.push(sid),
    });
    const dispatcher = makeDispatcher(mocks);
    await dispatcher.handleCommand(attachCmd(['claude']));
    assert.deepEqual(deleted, ['wks_orphan']);
  });

  it('/attach 无参同时列出 OpenCode 与 Claude 会话', async () => {
    let opencodeUsed = false;
    const mocks = makeMocks({ claudeListSessions: async () => [{ id: '11111111-1111-4111-8111-111111111111', title: 'claude', status: 'idle', cwd: 'H:\\w', updatedAt: Date.now() }] });
    mocks.opencodeDriver.listSessions = async () => [{ id: 'ses_oc', title: 'opencode', status: 'idle', cwd: 'H:\\w', updatedAt: Date.now() }];
    mocks.driverRegistry.get = (agent) => {
      if (agent === 'opencode') { opencodeUsed = true; return mocks.opencodeDriver; }
      return mocks.claudeDriver;
    };
    const dispatcher = makeDispatcher(mocks);
    await dispatcher.handleCommand(attachCmd([]));
    assert.equal(opencodeUsed, true, 'OpenCode driver 被使用');
    const call = mocks.feishuApi.calls.find((c) => c.type === 'sendAttachableSessionList');
    assert.ok(call);
    assert.equal(call.options.agent, 'mixed');
    assert.deepEqual(call.sessions.map((s) => s.agent).sort(), ['claude', 'opencode']);
  });

  it('/attach 仅列出 14 天内的 OpenCode 与 Claude 记录', async () => {
    const now = Date.now();
    const old = now - 15 * 24 * 60 * 60 * 1000;
    const mocks = makeMocks({
      claudeListSessions: async () => [
        { id: '11111111-1111-4111-8111-111111111111', title: 'recent claude', status: 'idle', cwd: 'H:\\w', updatedAt: now },
        { id: '22222222-2222-4222-8222-222222222222', title: 'old claude', status: 'idle', cwd: 'H:\\w', updatedAt: old },
      ],
    });
    mocks.opencodeDriver.listSessions = async () => [
      { id: 'ses_recent', title: 'recent opencode', status: 'idle', cwd: 'H:\\w', updatedAt: now },
      { id: 'ses_old', title: 'old opencode', status: 'idle', cwd: 'H:\\w', updatedAt: old },
    ];
    const dispatcher = makeDispatcher(mocks);
    await dispatcher.handleCommand(attachCmd([]));
    const call = mocks.feishuApi.calls.find((c) => c.type === 'sendAttachableSessionList');
    assert.ok(call);
    assert.deepEqual(call.sessions.map((s) => s.id).sort(), ['11111111-1111-4111-8111-111111111111', 'ses_recent']);
  });

  it('/attach claude <非UUID> 仍报 invalid_claude_session_id', async () => {
    const mocks = makeMocks({});
    const dispatcher = makeDispatcher(mocks);
    const result = await dispatcher.handleCommand(attachCmd(['claude', 'not-a-uuid']));
    assert.equal(result.error, 'invalid_claude_session_id');
    assert.ok(mocks.feishuApi.calls.find((c) => c.type === 'sendErrorCard'));
  });
});
