'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { SessionService } = require('../src/core/session-service');
const { JsonStore } = require('../src/core/json-store');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { MessageDedup } = require('../src/core/message-dedup');
const { AgentEvent } = require('../src/drivers/agent-driver');
const { OpencodeDriver } = require('../src/drivers/opencode-driver');
const { OpencodeTuiBridge } = require('../src/opencode-tui-bridge/bridge');
const { buildRouteKey } = require('../src/core/route-key');
const http = require('node:http');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { FeishuApi } = require('../src/platform/feishu/api');
const { ProgressCard } = require('../src/platform/feishu/progress-card');
const { basicAuthHeader } = require('../src/drivers/opencode-service');

/** SQL目标只允许当前夹具目录；同时识别普通文件名与只读file URI。 */
function assertFixtureDatabase(tmpDir, args) {
  const target = String(args[2]);
  const database = target.startsWith('file:') ? fileURLToPath(new URL(target)) : path.resolve(target);
  const relative = path.relative(tmpDir, database);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'SQLite目标必须位于当前测试临时目录');
}

/** 沿用驱动既有注入点隔离数据库、模型与服务发现，路径断言失败不会被业务降级吞掉。 */
function isolatedDriverOptions(tmpDir) {
  const exec = promisify(execFile);
  const rejected = [];
  return {
    opencodeDbPath: path.join(tmpDir, 'opencode.db'),
    modelState: null,
    readServiceRecord: () => null,
    execFile: async (command, args, options) => {
      try { assertFixtureDatabase(tmpDir, args); }
      catch (error) { rejected.push(error); throw error; }
      return exec(command, args, options);
    },
    assertDatabaseIsolation: () => assert.equal(rejected.length, 0, '驱动曾试图越出夹具目录执行SQL'),
  };
}

describe('真实标题源到飞书页脚的跨层验证', () => {
  it('数据库路径守卫接受夹具普通路径与只读URI，拒绝目录穿越及相似前缀', (t) => {
    const ctx = makeRealCtx();
    t.after(() => ctx.cleanup());
    const database = path.join(ctx.tmpDir, '标题.db');
    const uri = pathToFileURL(database);
    uri.searchParams.set('mode', 'ro');
    assert.doesNotThrow(() => assertFixtureDatabase(ctx.tmpDir, ['-batch', '-noheader', database]));
    assert.doesNotThrow(() => assertFixtureDatabase(ctx.tmpDir, ['-batch', '-noheader', uri.href]));
    for (const target of [path.join(ctx.tmpDir, '..', '越界.db'), ctx.tmpDir + '-other/标题.db']) {
      assert.throws(() => assertFixtureDatabase(ctx.tmpDir, ['-batch', '-noheader', target]));
      assert.throws(() => assertFixtureDatabase(ctx.tmpDir, ['-batch', '-noheader', pathToFileURL(target).href]));
    }
  });

  /** 隔离HTTP标题服务，仅使用合成会话，测试结束实际关闭所有连接。 */
  async function serve(t, handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      handler(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    return { serverUrl: 'http://127.0.0.1:' + server.address().port, requests };
  }

  /** 真实存储、驱动、调度和飞书格式化；只拦截不可回滚的飞书外网发送。 */
  function harness(t, options) {
    const ctx = makeRealCtx();
    const driver = new OpencodeDriver({ ...ctx.driverOptions, ...options });
    const api = new FeishuApi({ appId: '合成应用', appSecret: '合成密钥' });
    api.token = '合成token';
    api.tokenExpiresAt = Date.now() + 600000;
    const requests = [];
    api._request = async (method, _host, url, body) => {
      const envelope = JSON.parse(body);
      requests.push({ method, url, content: JSON.parse(envelope.content) });
      return { code: 0, data: { message_id: 'om_synthetic_' + requests.length } };
    };
    const dispatcher = new MessageDispatcher({
      sessionService: ctx.sessionService, driverRegistry: { get: () => driver },
      feishuApi: api, dedup: new MessageDedup({ windowMs: 300000 }),
    });
    t.after(() => { dispatcher.destroy(); ctx.cleanup(); });
    return { ...ctx, driver, api, dispatcher, requests };
  }

  /** 创建已纳入但仅有自动名称的旧记录，模型和上下文预先就绪。 */
  function owner(h, id, ref = {}, title) {
    const created = h.sessionService.createSession({ route: 'feishu:oc_same_chat', agent: 'opencode',
      cwd: h.tmpDir, title, agentRef: { opencodeSessionId: id, ...ref }, model: { providerID: 'p', modelID: 'm' } });
    const session = h.sessionService.getSession(created.id);
    // 上下文来自运行时，不通过仅允许持久字段的服务接口写入。
    session.contextTokens = 123;
    Object.freeze(session.agentRef);
    return Object.freeze(session);
  }

  /** 通过真实调度发送桥接，测试正文唯一以便并发时按所属正文定位请求。 */
  function send(h, session, text = '合成正文', method = 'sendText') {
    return h.dispatcher._callFeishu(method, ['oc_same_chat', text], null, { session });
  }

  it('HTTP官方响应经真实驱动进入文本、Markdown、进度与问题卡，认证和本地记录保持', async (t) => {
    const title = '中文😀真实标题';
    const server = await serve(t, (_req, res) => {
      const data = Buffer.from(JSON.stringify({ data: { id: 'ses_A', title } }));
      const split = data.indexOf(Buffer.from('中')) + 1;
      res.write(data.subarray(0, split));
      setTimeout(() => res.end(data.subarray(split)), 10);
    });
    const h = harness(t, { serverUrl: server.serverUrl, serverPassword: '合成口令' });
    const session = owner(h, 'ses_A');
    const before = fs.readFileSync(path.join(h.tmpDir, 'state.json'));
    await send(h, session);
    assert.equal(h.requests.at(-1).content.text, '合成正文\n\n---\n会话：' + title + '\n模型：p/m\n上下文：123 tokens');
    await send(h, session, '**Markdown正文**', 'sendMarkdown');
    assert.ok(h.requests.at(-1).content.body.elements[0].content.includes('会话：' + title));
    const progress = new ProgressCard({ sessionId: session.id });
    progress.append(new AgentEvent(AgentEvent.TYPE_TOOL_USE, { name: '合成工具', status: 'running' }));
    await h.dispatcher._callFeishu('replyCard', [{ chatId: 'oc_same_chat' }, progress.render()], null, { session });
    assert.ok(h.requests.at(-1).content.body.elements.at(-1).content.includes('会话：' + title));
    await h.dispatcher.questionHandler.handleAsked(session, 'oc_same_chat', 'feishu:oc_same_chat', new AgentEvent(AgentEvent.TYPE_QUESTION_ASKED, {
      requestID: 'req_source_title', sessionID: 'ses_A',
      questions: [{ header: '合成问题', question: '请选择', options: [{ label: 'A', description: '' }] }],
    }));
    assert.ok(h.requests.at(-1).content.body.elements.at(-1).content.includes('会话：' + title));
    assert.deepEqual(server.requests, [{ method: 'GET', url: '/api/session/ses_A', auth: basicAuthHeader('合成口令') }]);
    assert.deepEqual(fs.readFileSync(path.join(h.tmpDir, 'state.json')), before, '标题不得写本地名称或其他会话状态');
    assert.match(session.title, /^session wks_/);
  });

  it('同聊天A/B的真实HTTP响应逆序完成，各自正文及页脚不受焦点切换影响', async (t) => {
    let finishA;
    let receivedA;
    const aReady = new Promise((resolve) => { receivedA = resolve; });
    const server = await serve(t, (req, res) => {
      const id = decodeURIComponent(req.url.split('/').at(-1));
      if (id === 'ses_A') {
        finishA = () => res.end(JSON.stringify({ data: { id, title: '甲的真实标题' } }));
        receivedA();
      } else res.end(JSON.stringify({ data: { id, title: '乙的真实标题' } }));
    });
    const h = harness(t, { serverUrl: server.serverUrl });
    const a = owner(h, 'ses_A');
    const b = owner(h, 'ses_B');
    h.sessionService.setFocus('feishu:oc_same_chat', a.id);
    const pendingA = send(h, a, '甲的正文');
    const sameA = send(h, a, '甲的并发正文');
    await aReady;
    h.sessionService.setFocus('feishu:oc_same_chat', b.id);
    await send(h, b, '乙的正文');
    finishA();
    await Promise.all([pendingA, sameA]);
    for (const request of h.requests) {
      const text = request.content.text;
      const expected = text.startsWith('乙') ? '乙的真实标题' : '甲的真实标题';
      const unexpected = text.startsWith('乙') ? '甲的真实标题' : '乙的真实标题';
      assert.ok(text.includes('会话：' + expected) && !text.includes(unexpected));
    }
    assert.equal(server.requests.length, 2, '同键并发必须只有一次真实GET');
    assert.equal(h.sessionService.getCurrent('feishu:oc_same_chat').id, b.id);
  });

  it('真实HTTP权限错误按完成后30秒缓存，历史优先及到期恢复且错误正文不泄漏', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    let forbidden = false;
    let title = '历史真实标题';
    const marker = '合成错误正文不应记录';
    const server = await serve(t, (_req, res) => {
      if (forbidden) { res.writeHead(403); res.end(marker); }
      else res.end(JSON.stringify({ data: { id: 'ses_A', title } }));
    });
    const h = harness(t, { serverUrl: server.serverUrl, serverPassword: '合成口令' });
    const session = owner(h, 'ses_A', {}, '本地有效名称');
    await send(h, session);
    forbidden = true;
    t.mock.timers.setTime(31000);
    let output = '';
    const original = process.stderr.write;
    process.stderr.write = function capture(chunk) { output += String(chunk); return true; };
    try { await send(h, session); } finally { process.stderr.write = original; }
    assert.ok(h.requests.at(-1).content.text.includes('会话：历史真实标题'));
    assert.ok(!output.includes(marker) && !output.includes('合成口令'));
    forbidden = false;
    title = '恢复后的真实标题';
    t.mock.timers.setTime(60999);
    await send(h, session);
    assert.ok(h.requests.at(-1).content.text.includes('会话：历史真实标题'));
    assert.equal(server.requests.length, 2);
    t.mock.timers.setTime(61000);
    await send(h, session);
    assert.ok(h.requests.at(-1).content.text.includes('会话：恢复后的真实标题'));
    assert.equal(server.requests.length, 3);
  });

  it('真实SQLite精确只读标题经发送边界安全展示，库及runtime切换不共用旧结果', async (t) => {
    const h = harness(t, { serverUrl: 'http://127.0.0.1:1' });
    const exec = promisify(execFile);
    const databaseA = path.join(h.tmpDir, '合成标题甲.db');
    const databaseB = path.join(h.tmpDir, '合成标题乙.db');
    const id = "ses_'; DROP TABLE session;--";
    const titleA = '甲标题\n<at id="all"> *仅文本*';
    const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
    for (const [database, title] of [[databaseA, titleA], [databaseB, '乙库真实标题']]) {
      await exec(h.driver.sqliteCmd, [database, 'CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT); INSERT INTO session VALUES(' + quote(id) + ',' + quote(title) + ');']);
    }
    h.driver.opencodeDbPath = databaseA;
    const a = owner(h, id, { transport: 'tui-bridge' });
    const beforeA = fs.readFileSync(databaseA);
    const beforeB = fs.readFileSync(databaseB);
    await send(h, a, '正文', 'sendMarkdown');
    const content = h.requests.at(-1).content.body.elements[0].content;
    assert.ok(content.includes('会话：甲标题 &lt;at id="all"&gt; \\*仅文本\\*'));
    h.driver.opencodeDbPath = databaseB;
    await send(h, a);
    assert.ok(h.requests.at(-1).content.text.includes('会话：乙库真实标题'));
    h.driver.opencodeDbPath = databaseA;
    const runtimeB = owner(h, id, { transport: 'tui-bridge', runtimeId: 'runtime_B' });
    await send(h, runtimeB);
    assert.ok(h.requests.at(-1).content.text.includes('会话：甲标题 <at id="all"> *仅文本*'));
    assert.deepEqual(fs.readFileSync(databaseA), beforeA);
    assert.deepEqual(fs.readFileSync(databaseB), beforeB);
    h.driver.opencodeDbPath = path.join(h.tmpDir, '不存在.db');
    await send(h, a);
    assert.ok(!h.requests.at(-1).content.text.includes('会话：'));
    assert.equal(fs.existsSync(h.driver.opencodeDbPath), false, '只读查询不得创建缺失数据库');
  });

  it('真实源的空白、默认名及响应ID错配不泄漏伪标题或其他会话标题', async (t) => {
    let responseTitle;
    let responseId;
    const server = await serve(t, (_req, res) => res.end(JSON.stringify({ data: { id: responseId, title: responseTitle } })));
    const h = harness(t, { serverUrl: server.serverUrl });
    const cases = [null, 123, ' ', 'ses_3', 'opencode ses_4', 'session ses_5', '他人标题'];
    for (const [index, title] of cases.entries()) {
      const id = 'ses_' + index;
      responseId = index === 6 ? 'ses_other' : id;
      responseTitle = title;
      await send(h, owner(h, id));
      const text = h.requests.at(-1).content.text;
      assert.equal(text, '合成正文\n\n---\n模型：p/m\n上下文：123 tokens');
    }
    assert.ok(server.requests.every((request) => request.method === 'GET'));
  });

  it('真实挂起HTTP在标题预算后实际关闭连接，发送降级且重复发送不再请求', async (t) => {
    let closed;
    const connectionClosed = new Promise((resolve) => { closed = resolve; });
    const server = await serve(t, (_req, res) => res.on('close', closed));
    const h = harness(t, { serverUrl: server.serverUrl });
    const session = owner(h, 'ses_timeout');
    const start = Date.now();
    await send(h, session);
    await connectionClosed;
    assert.ok(Date.now() - start < 3500, '只允许标题预算及本地调度余量，不可无限等待');
    assert.equal(h.requests.at(-1).content.text, '合成正文\n\n---\n模型：p/m\n上下文：123 tokens');
    await send(h, session);
    assert.equal(server.requests.length, 1);
  });
});

function makeRealCtx() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-feishu-tui-'));
  const stateStore = new JsonStore(path.join(tmpDir, 'state.json'), {});
  const sessionService = new SessionService({ stateStore });
  const driverOptions = isolatedDriverOptions(tmpDir);
  return {
    tmpDir,
    sessionService,
    driverOptions,
    config: { admin: { token: '' } },
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      driverOptions.assertDatabaseIsolation();
    },
  };
}

function makeFeishuStub() {
  const calls = [];
  return {
    calls,
    replyText: (replyCtx, text) => { calls.push({ type: 'replyText', replyCtx, text }); return [{ message_id: 'om_reply_' + calls.length }]; },
    replyMarkdown: (replyCtx, text) => { calls.push({ type: 'replyMarkdown', replyCtx, text }); return [{ message_id: 'om_reply_' + calls.length }]; },
    sendText: (chatId, text) => { calls.push({ type: 'sendText', chatId, text }); },
    sendMarkdown: (chatId, text) => { calls.push({ type: 'sendMarkdown', chatId, text }); },
    replyCard: (replyCtx, card) => { calls.push({ type: 'replyCard', replyCtx, card }); return 'om_card_' + calls.length; },
    patchCard: (cardId, card) => { calls.push({ type: 'patchCard', cardId, card }); },
    addReaction: (msgId, emoji) => { calls.push({ type: 'addReaction', msgId, emoji }); },
    sendUnboundGuide: (replyCtx, routeKey) => { calls.push({ type: 'sendUnboundGuide', replyCtx, routeKey }); },
    sendSessionList: (replyCtx, sessions, currentId, routeKey) => { calls.push({ type: 'sendSessionList', replyCtx, sessions, currentId, routeKey }); },
    sendAttachableSessionList: (replyCtx, sessions, options) => { calls.push({ type: 'sendAttachableSessionList', replyCtx, sessions, options }); },
    sendErrorCard: (replyCtx, message) => { calls.push({ type: 'sendErrorCard', replyCtx, message }); },
    sendProgressCard: (replyCtx, sessionId) => { calls.push({ type: 'sendProgressCard', replyCtx, sessionId }); return 'om_prog_' + calls.length; },
    updateProgressCard: (cardId, sessionId, agentEvent) => { calls.push({ type: 'updateProgressCard', cardId, sessionId, agentEvent }); return null; },
  };
}

function makeStubDriver(options) {
  const opts = options || {};
  const promptCalls = [];
  let watchHandlers = null;

  return {
    promptCalls,
    getWatchHandlers: () => watchHandlers,
    ensureReady: async () => true,
    createSession: async () => ({ opencodeSessionId: 'ses_' + Math.random().toString(36).slice(2, 8), serverUrl: 'http://localhost:4096' }),
    listSessions: async () => [],
    watchSession: (sessionRef, handlers) => {
      watchHandlers = handlers;
      return () => { watchHandlers = null; };
    },
    prompt: async (agentRef, text) => {
      promptCalls.push({ agentRef, text });
      return opts.promptEvents || [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'echo:' + text }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })];
    },
    stop: async () => {},
    delete: async () => {},
    resumeSession: async (ref) => ref,
    listModels: async () => [],
  };
}

async function pollDelivery(bridge, runtimeId, sessionId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 1000);
  while (Date.now() < deadline) {
    const delivery = bridge.poll({ runtimeId, sessionId });
    if (delivery) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for TUI bridge delivery');
}

async function waitForCall(feishuApi, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 1000);
  while (Date.now() < deadline) {
    const call = feishuApi.calls.find(predicate);
    if (call) return call;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for Feishu API call');
}

describe('飞书-TUI 双向链路集成测试', () => {
  let ctx;
  let feishuApi;
  let dispatcher;

  beforeEach(() => {
    ctx = makeRealCtx();
    feishuApi = makeFeishuStub();
  });

  afterEach(() => {
    if (dispatcher) {
      dispatcher.destroy();
      dispatcher = null;
    }
    ctx.cleanup();
  });

  describe('已 attach 会话双向消息', () => {
    it('飞书 thread 消息进入已 attach session → prompt 被调用 → TUI assistant 回复通过 watch 出站到飞书', async () => {
      const chatId = 'oc_chat_bidir';
      const rootId = 'om_root_bidir';
      const cwd = process.cwd();
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const agentRef = { opencodeSessionId: 'ses_bidir_1', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const driver = makeStubDriver();
      const driverRegistry = { get: () => driver };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const result = await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_bidir_1',
        chatId,
        rootId,
        text: 'hello from feishu thread',
      });

      assert.equal(result, 'prompted', 'handleIncomingMessage 应返回 prompted');
      assert.equal(driver.promptCalls.length, 1, 'driver.prompt 应被调用一次');
      assert.equal(driver.promptCalls[0].text, 'hello from feishu thread');
      assert.equal(driver.promptCalls[0].agentRef.opencodeSessionId, 'ses_bidir_1');

      const handlers = driver.getWatchHandlers();
      assert.ok(handlers, 'watchSession 应已注册 handlers');
      assert.ok(typeof handlers.onEvent === 'function', 'handlers 应包含 onEvent');

      const tuiReplyText = 'TUI assistant reply from watched session';
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: tuiReplyText }));
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const sendMarkdownCalls = feishuApi.calls.filter((c) => c.type === 'sendMarkdown');
      const tuiReply = sendMarkdownCalls.find((c) => c.text && c.text.includes(tuiReplyText));
      assert.ok(tuiReply, '飞书 sendText 应收到 TUI assistant 回复');
      assert.equal(tuiReply.chatId, chatId, '回复应发送到正确的 chatId');
    });

    it('watch 收到空 message 的 upstream_error 仍回传可读错误到飞书', async () => {
      const chatId = 'oc_chat_upstream_error';
      const rootId = 'om_root_upstream_error';
      const cwd = process.cwd();
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const agentRef = { opencodeSessionId: 'ses_upstream_error_1', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const driver = makeStubDriver();
      const driverRegistry = { get: () => driver };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_upstream_error_1',
        chatId,
        rootId,
        text: 'trigger upstream error',
      });

      const handlers = driver.getWatchHandlers();
      assert.ok(handlers, 'watchSession 应已注册 handlers');

      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_ERROR, { message: '', type: 'upstream_error' }));
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));

      const errorReply = await waitForCall(feishuApi, (call) => {
        return call.type === 'sendMarkdown' && call.chatId === chatId && /upstream_error/.test(call.text || '');
      });
      assert.match(errorReply.text, /OpenCode.*upstream_error|upstream_error.*OpenCode/);
    });

    it('REQ-005-B04: 旧 Claude 会话的入站消息在 watch 前返回 claude_removed', async () => {
      const chatId = 'oc_chat_claude_question';
      const rootId = 'om_root_claude_question';
      const cwd = process.cwd();
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const claudeSessionId = '11111111-1111-4111-8111-111111111111';
      const agentRef = { claudeSessionId, cwd };

      const created = ctx.sessionService.createSession({ route: routeKey, agent: 'claude', cwd, agentRef });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const driver = makeStubDriver();
      const gets = [];
      const driverRegistry = {
        get: (name) => {
          gets.push(name);
          return driver;
        },
      };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const result = await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_claude_question_1',
        chatId,
        rootId,
        text: 'trigger claude question',
      });

      assert.deepEqual(result, { error: 'claude_removed' });
      assert.equal(driver.promptCalls.length, 0);
      assert.equal(driver.getWatchHandlers(), null);
      assert.equal(gets.includes('claude'), false);
      const current = ctx.sessionService.getCurrent(routeKey);
      assert.equal(current.id, created.id);
      assert.equal(current.agent, 'claude');
      assert.equal(current.agentRef.claudeSessionId, claudeSessionId);
      const errorCard = feishuApi.calls.find((call) => call.type === 'sendErrorCard');
      assert.ok(errorCard);
      assert.equal(errorCard.message, 'Claude integration has been removed.');
      assert.equal(feishuApi.calls.some((call) => call.type === 'replyCard'), false);
    });

    it('REQ-004-B07: route 仅有 cwd 时不自动绑定 Claude，也不启动 watch', async () => {
      const chatId = 'oc_chat_claude_autobind';
      const rootId = 'om_root_claude_autobind';
      const cwd = process.cwd();
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const claudeSessionId = '11111111-1111-4111-8111-222222222222';

      ctx.sessionService.setRouteCwd(routeKey, cwd);
      const before = ctx.sessionService.listSessions().length;

      const driver = makeStubDriver({ promptEvents: [new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })] });
      let listCalls = 0;
      let resumeCalls = 0;
      driver.listSessions = async () => {
        listCalls += 1;
        return [{ id: claudeSessionId, cwd, title: 'local claude', updatedAt: Date.now() }];
      };
      driver.resumeSession = async () => {
        resumeCalls += 1;
        return { claudeSessionId, cwd };
      };
      const gets = [];
      const driverRegistry = {
        get: (name) => {
          gets.push(name);
          return name === 'claude' ? driver : null;
        },
      };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const result = await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_claude_autobind_1',
        chatId,
        rootId,
        text: 'hello claude',
      });

      assert.equal(result, 'unbound');
      assert.equal(listCalls, 0);
      assert.equal(resumeCalls, 0);
      assert.equal(driver.promptCalls.length, 0);
      assert.equal(driver.getWatchHandlers(), null);
      assert.equal(gets.includes('claude'), false);
      assert.equal(ctx.sessionService.getCurrent(routeKey), null);
      assert.equal(ctx.sessionService.listSessions().length, before);
      assert.equal(feishuApi.calls.some((call) => call.type === 'sendUnboundGuide'), true);
      assert.equal(feishuApi.calls.some((call) => call.type === 'replyCard'), false);
    });

    it('thread route 无绑定 → 回退到同群根 route → prompt 和 watch 均正常', async () => {
      const chatId = 'oc_chat_fallback';
      const rootId = 'om_root_fallback';
      const cwd = process.cwd();
      const fallbackRouteKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const agentRef = { opencodeSessionId: 'ses_fallback_1', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: fallbackRouteKey, agent: 'opencode', cwd, agentRef });
      ctx.sessionService.setRouteCwd(fallbackRouteKey, cwd);

      const driver = makeStubDriver();
      const driverRegistry = { get: () => driver };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const result = await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_fallback_1',
        chatId,
        rootId,
        text: 'hello from thread without binding',
      });

      assert.equal(result, 'prompted', '回退到群根 route 后应返回 prompted');
      assert.equal(driver.promptCalls.length, 1, 'prompt 应被调用');
      assert.equal(driver.promptCalls[0].agentRef.opencodeSessionId, 'ses_fallback_1', 'prompt 应发往群根 route 的 session');

      const handlers = driver.getWatchHandlers();
      assert.ok(handlers, '回退后也应建立 watch');

      const replyText = 'fallback TUI reply';
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: replyText }));
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const sendMarkdownCalls = feishuApi.calls.filter((c) => c.type === 'sendMarkdown');
      const reply = sendMarkdownCalls.find((c) => c.text && c.text.includes(replyText));
      assert.ok(reply, '回退场景下飞书也应收到 TUI 回复');
      assert.equal(reply.chatId, chatId, '回复应发送到正确的 chatId');
    });
  });

  describe('普通 embedded TUI bridge', () => {
    it('飞书 prompt 经本地 TUI runtime 执行并回传，且不访问独立 4096 服务', async () => {
      const chatId = 'oc_chat_embedded';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const runtimeId = 'runtime-embedded-e2e';
      const opencodeSessionId = 'ses_embedded_e2e';

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        promptTimeoutMs: 1000,
        runtimeStaleMs: 1000,
      });
      bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      let networkCalls = 0;
      const driver = new OpencodeDriver({
        ...ctx.driverOptions,
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: {
          request: async () => {
            networkCalls++;
            throw new Error('embedded TUI bridge must not use HTTP');
          },
        },
        sseClient: {
          connect: async () => {
            networkCalls++;
            throw new Error('embedded TUI bridge must not use SSE');
          },
        },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_embedded_e2e',
        chatId,
        text: 'hello embedded TUI',
      });

      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);
      assert.equal(delivery.text, 'hello embedded TUI');
      assert.equal(delivery.sessionId, opencodeSessionId);

      bridge.reportEvents({
        runtimeId,
        sessionId: opencodeSessionId,
        deliveryId: delivery.deliveryId,
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'embedded assistant reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      assert.equal(await promptResult, 'prompted');
      assert.equal(networkCalls, 0, 'bridge session 不应访问独立 OpenCode HTTP/SSE');

      const renderedReply = feishuApi.calls.find((call) => {
        return call.type === 'replyMarkdown'
          && call.text
          && call.text.includes('embedded assistant reply');
      });
      assert.ok(renderedReply, '飞书应通过markdown 卡片收到 embedded TUI 的回答');

      bridge.reportEvents({
        runtimeId,
        sessionId: opencodeSessionId,
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'manual TUI turn reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      const manualReply = await waitForCall(feishuApi, (call) => {
        return call.type === 'sendMarkdown' && call.chatId === chatId && call.text.includes('manual TUI turn reply');
      }, 2000);
      assert.ok(manualReply, 'TUI 手工发起的回答应通过 watch 回传飞书');

      bridge.reportEvents({
        runtimeId,
        sessionId: opencodeSessionId,
        error: [{ message: '', type: 'upstream_error' },
          { message: 'Upstream HTTP/2 stream failed', type: 'upstream_error', code: 'upstream_http2_stream_error' }],
      });
      const manualError = await waitForCall(feishuApi, (call) => {
        return call.type === 'sendMarkdown' && call.chatId === chatId
          && (call.text || '').includes('Upstream HTTP/2 stream failed');
      }, 2000);
      assert.match(manualError.text, /OpenCode error/);

      bridge.reportEvents({
        runtimeId,
        sessionId: opencodeSessionId,
        events: [
          {
            type: AgentEvent.TYPE_PERMISSION,
            data: {
              id: 'perm_external_dir',
              type: 'tool',
              title: 'Access external directory H:\\sacpserv',
              metadata: { patterns: ['H:\\sacpServ\\*'] },
              sessionID: opencodeSessionId,
              messageID: 'msg_perm_external_dir',
            },
          },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));

      const permissionCard = feishuApi.calls.find((call) => {
        return call.type === 'replyCard'
          && call.replyCtx
          && call.replyCtx.chatId === chatId
          && call.card
          && call.card.header
          && call.card.header.title
          && call.card.header.title.content === '权限确认请求';
      });
      assert.ok(permissionCard, 'TUI permission 事件应通过 watch 回传飞书权限确认卡片');
      bridge.close();
    });

    it('TUI 重启复用同 opencodeSessionId 后，手工 TUI 回复仍推送到原飞书 route', async () => {
      const chatId = 'oc_chat_tui_restart_push';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const oldRuntimeId = 'runtime-restart-old-e2e';
      const newRuntimeId = 'runtime-restart-new-e2e';
      const opencodeSessionId = 'ses_restart_push_e2e';

      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        promptTimeoutMs: 1000,
        runtimeStaleMs: 1000,
      });
      const driver = new OpencodeDriver({
        ...ctx.driverOptions,
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: { request: async () => { throw new Error('TUI bridge test must not use HTTP'); } },
        sseClient: { connect: async () => { throw new Error('TUI bridge test must not use SSE'); } },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });
      bridge.setOnSessionEnrolled(({ sessionId }) => dispatcher.ensureWatchForSession(sessionId));

      const oldReg = bridge.register({ runtimeId: oldRuntimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });
      assert.equal(oldReg.routeKey, routeKey);
      bridge.dispose({ runtimeId: oldRuntimeId });

      const newReg = bridge.register({ runtimeId: newRuntimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });
      assert.equal(newReg.routeKey, routeKey);
      assert.notEqual(newReg.sessionId, oldReg.sessionId);

      bridge.reportEvents({
        runtimeId: newRuntimeId,
        sessionId: opencodeSessionId,
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'manual reply after TUI restart' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });
      const manualReply = await waitForCall(feishuApi, (call) => {
        return call.type === 'sendMarkdown' && call.chatId === chatId && call.text.includes('manual reply after TUI restart');
      });
      assert.ok(manualReply, 'TUI 重启后的手工回复应继续推送到原飞书 route');
      bridge.close();
    });
  });

  describe('不会重复或跨 route 推送 TUI 回复', () => {
    it('/new 创建的 HTTP session 在 TUI 注册后应原地升级且只推送一次回复', async () => {
      const chatId = 'oc_chat_http_upgrade';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = 'H:\\rsstest';
      const opencodeSessionId = 'ses_http_upgrade';
      const runtimeId = 'runtime-http-upgrade';
      const httpSession = ctx.sessionService.createSession({
        route: routeKey,
        agent: 'opencode',
        cwd,
        agentRef: { opencodeSessionId, serverUrl: 'http://localhost:4096', cwd },
      });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({ sessionService: ctx.sessionService, promptTimeoutMs: 1000 });
      let httpWatchActive = false;
      const driver = {
        watchSession: (sessionRef, handlers) => {
          if (sessionRef.transport === 'tui-bridge') return bridge.watchSession(sessionRef, handlers);
          httpWatchActive = true;
          return () => { httpWatchActive = false; };
        },
        prompt: (sessionRef, text) => bridge.prompt(sessionRef, text),
        getSessionMessages: async () => [],
      };
      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
        nonFocusOutput: true,
      });
      dispatcher.ensureWatchForSession(httpSession.id);
      assert.equal(httpWatchActive, true, 'TUI 注册前应存在 HTTP watcher');
      bridge.setOnSessionEnrolled(({ sessionId }) => dispatcher.ensureWatchForSession(sessionId, { refresh: true }));

      const registered = bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd });
      assert.equal(registered.sessionId, httpSession.id, 'TUI 注册应复用 /new 创建的 Walker session');
      assert.equal(httpWatchActive, false, '升级 transport 时应停止旧 HTTP watcher');
      assert.equal(ctx.sessionService.listSessionsInRoute(routeKey).length, 1, 'route 中应只有一个 Walker session');

      const prompted = dispatcher.handleIncomingMessage({
        messageId: 'om_http_upgrade',
        chatId,
        text: 'hi',
      });
      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);
      bridge.reportEvents({
        runtimeId,
        sessionId: opencodeSessionId,
        deliveryId: delivery.deliveryId,
        assistantMessageId: 'msg_http_upgrade',
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: '你好！' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });
      assert.equal(await prompted, 'prompted');

      assert.equal(feishuApi.calls.filter((call) => call.type === 'replyMarkdown' && call.text === '你好！').length, 1);
      assert.equal(feishuApi.calls.filter((call) => call.type === 'sendMarkdown' && call.text && call.text.includes('你好！')).length, 0,
        '旧 HTTP watcher 不应再群发同一回答');
      bridge.close();
    });

    it('同一 OpenCode session 的多个 TUI runtime 不应重复推送同一 assistant message', async () => {
      const chatId = 'oc_chat_multi_runtime_dedup';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const opencodeSessionId = 'ses_multi_runtime_dedup';
      const secondaryRuntimeId = 'runtime-multi-secondary';
      const primaryRuntimeId = 'runtime-multi-primary';

      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        promptTimeoutMs: 1000,
        runtimeStaleMs: 1000,
      });
      const driver = new OpencodeDriver({
        ...ctx.driverOptions,
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: { request: async () => { throw new Error('TUI bridge test must not use HTTP'); } },
        sseClient: { connect: async () => { throw new Error('TUI bridge test must not use SSE'); } },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
        nonFocusOutput: true,
      });
      bridge.setOnSessionEnrolled(({ sessionId }) => dispatcher.ensureWatchForSession(sessionId));

      const secondaryRegistration = bridge.register({ runtimeId: secondaryRuntimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });
      bridge.register({ runtimeId: primaryRuntimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_multi_runtime_dedup',
        chatId,
        text: 'hi',
      });
      const delivery = await pollDelivery(bridge, primaryRuntimeId, opencodeSessionId);
      const events = [
        { type: AgentEvent.TYPE_TEXT, data: { text: 'hi\n你好！有什么需要我帮忙的吗？' } },
        { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
      ];

      bridge.reportEvents({
        runtimeId: primaryRuntimeId,
        sessionId: opencodeSessionId,
        deliveryId: delivery.deliveryId,
        assistantMessageId: 'msg_multi_runtime_reply',
        events,
      });
      assert.equal(await promptResult, 'prompted');

      const duplicate = bridge.reportEvents({
        runtimeId: secondaryRuntimeId,
        sessionId: opencodeSessionId,
        assistantMessageId: 'msg_multi_runtime_reply',
        events,
      });
      assert.equal(duplicate.duplicate, true, '其他 runtime 上报同一 assistant message 时应在 bridge 层去重');
      assert.equal(dispatcher.sessionDoneInFlight.has(secondaryRegistration.sessionId), false,
        '重复 final 不应进入旧 Walker session watcher');

      const replies = feishuApi.calls.filter((call) => call.type === 'replyMarkdown'
        && call.text && call.text.includes('你好！有什么需要我帮忙的吗？'));
      const watcherSends = feishuApi.calls.filter((call) => call.type === 'sendMarkdown'
        && call.text && call.text.includes('你好！有什么需要我帮忙的吗？'));
      assert.equal(replies.length, 1, '飞书 prompt 最终回复应只发送一次');
      assert.equal(watcherSends.length, 0, '其他 TUI runtime 不应把同一 assistant message 再作为手工 turn 群发');
      bridge.close();
    });

    it('其他 TUI runtime 先上报 prompt 回答时也不应抢先群发', async () => {
      const routeKey = buildRouteKey({ chatId: 'oc_chat_multi_runtime_early', rootId: '' }, 'thread');
      const cwd = process.cwd();
      const sessionId = 'ses_multi_runtime_early';
      ctx.sessionService.setRouteCwd(routeKey, cwd);
      const bridge = new OpencodeTuiBridge({ sessionService: ctx.sessionService, promptTimeoutMs: 1000, runtimeStaleMs: 1000 });
      const secondary = bridge.register({ runtimeId: 'runtime-early-secondary', sessionId, cwd });
      const primary = bridge.register({ runtimeId: 'runtime-early-primary', sessionId, cwd });
      const secondarySession = ctx.sessionService.getSession(secondary.sessionId);
      const primarySession = ctx.sessionService.getSession(primary.sessionId);
      const received = [];
      bridge.watchSession(secondarySession.agentRef, { onEvent: (event) => received.push(event) });

      const prompt = bridge.prompt(primarySession.agentRef, 'hi');
      const delivery = await pollDelivery(bridge, 'runtime-early-primary', sessionId);
      const events = [
        { type: AgentEvent.TYPE_TEXT, data: { text: '你好！' } },
        { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
      ];
      const suppressed = bridge.reportEvents({
        runtimeId: 'runtime-early-secondary',
        sessionId,
        assistantMessageId: 'msg_multi_runtime_early',
        events,
      });
      assert.equal(suppressed.suppressed, true, '活动 prompt 的旁路 final 应被抑制');
      assert.equal(received.length, 0, '旁路 final 不应进入 watcher');

      bridge.reportEvents({
        runtimeId: 'runtime-early-primary',
        sessionId,
        deliveryId: delivery.deliveryId,
        assistantMessageId: 'msg_multi_runtime_early',
        events,
      });
      const result = await prompt;
      assert.deepEqual(result.map((event) => event.type), [AgentEvent.TYPE_TEXT, AgentEvent.TYPE_DONE]);
      bridge.close();
    });

    it('旁路 final 被活动 prompt 抑制后，主 delivery 失败时应自动恢复', async () => {
      const routeKey = buildRouteKey({ chatId: 'oc_chat_multi_runtime_recover', rootId: '' }, 'thread');
      const cwd = process.cwd();
      const sessionId = 'ses_multi_runtime_recover';
      ctx.sessionService.setRouteCwd(routeKey, cwd);
      const bridge = new OpencodeTuiBridge({ sessionService: ctx.sessionService, promptTimeoutMs: 1000, runtimeStaleMs: 1000 });
      const secondary = bridge.register({ runtimeId: 'runtime-recover-secondary', sessionId, cwd });
      const primary = bridge.register({ runtimeId: 'runtime-recover-primary', sessionId, cwd });
      const secondarySession = ctx.sessionService.getSession(secondary.sessionId);
      const primarySession = ctx.sessionService.getSession(primary.sessionId);
      const received = [];
      bridge.watchSession(secondarySession.agentRef, { onEvent: (event) => received.push(event) });

      const prompt = bridge.prompt(primarySession.agentRef, 'hi');
      await pollDelivery(bridge, 'runtime-recover-primary', sessionId);
      const events = [
        { type: AgentEvent.TYPE_TEXT, data: { text: '可恢复的回答' } },
        { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
      ];
      const suppressed = bridge.reportEvents({
        runtimeId: 'runtime-recover-secondary',
        sessionId,
        assistantMessageId: 'msg_multi_runtime_recover',
        events,
      });
      assert.equal(suppressed.suppressed, true);

      bridge.dispose({ runtimeId: 'runtime-recover-primary' });
      await assert.rejects(prompt, /runtime disposed/);
      assert.deepEqual(received.map((event) => event.type), [AgentEvent.TYPE_TEXT, AgentEvent.TYPE_DONE]);
      bridge.close();
    });

    it('单次双向流程不会重复发送回复', async () => {
      const chatId = 'oc_chat_dedup';
      const rootId = 'om_root_dedup';
      const cwd = process.cwd();
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const agentRef = { opencodeSessionId: 'ses_dedup_1', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const driver = makeStubDriver();
      const driverRegistry = { get: () => driver };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_dedup_1',
        chatId,
        rootId,
        text: 'test dedup',
      });

      const handlers = driver.getWatchHandlers();
      const uniqueText = 'unique reply from TUI ' + Date.now();
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: uniqueText }));
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: uniqueText }));
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const sendMarkdownCalls = feishuApi.calls.filter((c) => c.type === 'sendMarkdown' && c.text && c.text.includes(uniqueText));
      assert.equal(sendMarkdownCalls.length, 1, '相同回复文本不应被重复发送');
    });

    it('不同 chat 的回复不会误投递到其他 chatId', async () => {
      const chatIdA = 'oc_chat_iso_a';
      const chatIdB = 'oc_chat_iso_b';
      const cwd = process.cwd();

      const routeKeyA = buildRouteKey({ chatId: chatIdA, rootId: '' }, 'thread');
      const agentRefA = { opencodeSessionId: 'ses_iso_a', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: routeKeyA, agent: 'opencode', cwd, agentRef: agentRefA });
      ctx.sessionService.setRouteCwd(routeKeyA, cwd);

      let watchHandlersA = null;
      const driverA = {
        ensureReady: async () => true,
        prompt: async () => [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'echo' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })],
        watchSession: (ref, handlers) => { watchHandlersA = handlers; return () => { watchHandlersA = null; }; },
        resumeSession: async (ref) => ref,
      };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driverA },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_iso_a',
        chatId: chatIdA,
        rootId: 'om_root_a',
        text: 'message to A',
      });

      assert.ok(watchHandlersA, 'chatA 的 watch 应已建立');

      watchHandlersA.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'reply from A session' }));
      watchHandlersA.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const sendToA = feishuApi.calls.filter((c) => c.type === 'sendMarkdown' && c.chatId === chatIdA);
      assert.ok(sendToA.length >= 1, 'chatA 应收到回复');

      const sendToB = feishuApi.calls.filter((c) => c.type === 'sendMarkdown' && c.chatId === chatIdB);
      assert.equal(sendToB.length, 0, 'chatA 的回复不应误投递到 chatB');
    });

    it('不同 session 的 watch 回复隔离，不会跨 session 投递', async () => {
      const chatId = 'oc_chat_session_iso';
      const cwd = process.cwd();
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');

      const agentRef1 = { opencodeSessionId: 'ses_iso_s1', serverUrl: 'http://localhost:4096', cwd };
      const agentRef2 = { opencodeSessionId: 'ses_iso_s2', serverUrl: 'http://localhost:4096', cwd };

      const session1 = ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef: agentRef1 });
      ctx.sessionService.setRouteCwd(routeKey, cwd);
      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef: agentRef2 });

      const feishuLocal = makeFeishuStub();

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => ({ watchSession: () => () => {}, prompt: async () => [] }) },
        feishuApi: feishuLocal,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      dispatcher._handleWatchedSessionEvent(session1, chatId, new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'session1 output' }));
      dispatcher._handleWatchedSessionEvent(session1, chatId, new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
      await new Promise((resolve) => setImmediate(resolve));

      const session1Send = feishuLocal.calls.filter((c) => c.type === 'sendMarkdown' && c.text && c.text.includes('session1 output'));
      assert.equal(session1Send.length, 1, 'session1 输出应发送一次');

      const session2 = ctx.sessionService.listSessions().find((s) => s.id !== session1.id);
      const session2Text = 'session2 exclusive output ' + Date.now();
      dispatcher._handleWatchedSessionEvent(session2, chatId, new AgentEvent(AgentEvent.TYPE_TEXT, { text: session2Text }));
      dispatcher._handleWatchedSessionEvent(session2, chatId, new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const allSendText = feishuLocal.calls.filter((c) => c.type === 'sendMarkdown');
      const session2Duplicates = allSendText.filter((c) => c.text && c.text.includes(session2Text));
      assert.ok(session2Duplicates.length <= 1, 'session2 输出不应重复发送');
    });
  });

  describe('飞书 /clear 全链路集成', () => {
    function makeClearHarness(opts) {
      opts = opts || {};
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-feishu-clear-'));
      const stateStore = new JsonStore(path.join(tmpDir, 'state.json'), {});
      const sessionService = new SessionService({ stateStore });
      const chatId = opts.chatId || 'oc_chat_clear';
      const routeKey = opts.routeKey || buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = opts.cwd || process.cwd();
      const runtimeId = opts.runtimeId || 'runtime-clear-e2e';
      const opencodeSessionId = opts.opencodeSessionId || 'ses_old_e2e';
      const model = opts.model || { modelID: 'gpt-4o' };

      sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService,
        promptTimeoutMs: opts.promptTimeoutMs || 1500,
        runtimeStaleMs: opts.runtimeStaleMs || 60000,
      });
      bridge.register({
        runtimeId,
        sessionId: opencodeSessionId,
        cwd,
        opencodeVersion: '1.17.20',
        bridgeProtocolVersion: 2,
      });
      const walkerSession = sessionService.getCurrent(routeKey);
      if (model) sessionService.updateSessionField(walkerSession.id, 'model', model);

      let networkCalls = 0;
      let createSessionCalls = 0;
      const driverOptions = isolatedDriverOptions(tmpDir);
      const driver = new OpencodeDriver({
        ...driverOptions,
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: {
          request: async () => {
            networkCalls++;
            throw new Error('clear bridge must not use HTTP');
          },
        },
        sseClient: {
          connect: async () => {
            networkCalls++;
            throw new Error('clear bridge must not use SSE');
          },
        },
      });
      const realCreateSession = driver.createSession.bind(driver);
      driver.createSession = async (...args) => {
        createSessionCalls++;
        return realCreateSession(...args);
      };

      const feishuApi = makeFeishuStub();
      dispatcher = new MessageDispatcher({
        sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      return {
        tmpDir, sessionService, bridge, driver, feishuApi, dispatcher,
        routeKey, chatId, cwd, runtimeId, opencodeSessionId, walkerSession, model,
        networkCalls, createSessionCalls,
        getNetworkCalls: () => networkCalls,
        getCreateSessionCalls: () => createSessionCalls,
        cleanup() {
          if (dispatcher) { dispatcher.destroy(); dispatcher = null; }
          bridge.close();
          fs.rmSync(tmpDir, { recursive: true, force: true });
          driverOptions.assertDatabaseIsolation();
        },
        async sendClear(messageId) {
          return dispatcher.handleCommand({
            name: 'clear',
            routeKey,
            chatId,
            messageId: messageId || ('om_clear_' + Math.random().toString(36).slice(2, 8)),
          });
        },
      };
    }

    async function pollClearDelivery(h) {
      return pollDelivery(h.bridge, h.runtimeId, h.opencodeSessionId, 1000);
    }

    function completeClear(h, delivery, newSessionId, order) {
      const newSes = newSessionId || 'ses_new_e2e';
      const registerPayload = {
        runtimeId: h.runtimeId,
        sessionId: newSes,
        cwd: h.cwd,
        controlDeliveryId: delivery.deliveryId,
        opencodeVersion: '1.17.20',
      };
      const controlPayload = {
        runtimeId: h.runtimeId,
        sessionId: h.opencodeSessionId,
        deliveryId: delivery.deliveryId,
        control: { type: 'clear', newSessionId: newSes },
      };
      if (order === 'control-first') {
        h.bridge.reportEvents(controlPayload);
        h.bridge.register(registerPayload);
      } else if (order === 'register-first') {
        h.bridge.register(registerPayload);
        h.bridge.reportEvents(controlPayload);
      } else {
        h.bridge.register(registerPayload);
        h.bridge.reportEvents(controlPayload);
      }
      return newSes;
    }

    it('飞书 /clear 在当前 TUI 创建空上下文（control 携带新 session ID）', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);
        assert.equal(delivery.type, 'clear', 'delivery 类型应为 clear');
        assert.equal(delivery.sessionId, h.opencodeSessionId, 'delivery 指向旧 OpenCode session');

        const newSes = completeClear(h, delivery, 'ses_new_a');

        const result = await clearPromise;
        assert.ok(result.cleared, 'handleCommand 应返回 cleared:true');
        assert.equal(result.oldSessionId, h.opencodeSessionId);
        assert.equal(result.newSessionId, newSes);
        assert.ok(result.walkerSessionId, '应返回新 walker session id');

        const reply = h.feishuApi.calls.find((c) => c.type === 'replyText' && c.text && c.text.includes('Cleared session'));
        assert.ok(reply, '应回复 clear 成功消息');
      } finally {
        h.cleanup();
      }
    });

    it('clear 全链路不访问独立服务或 createSession', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);
        completeClear(h, delivery, 'ses_new_nohost');
        await clearPromise;

        assert.equal(h.getNetworkCalls(), 0, 'clear 不应访问独立 OpenCode HTTP/SSE');
        assert.equal(h.getCreateSessionCalls(), 0, 'clear 不应调用 driver.createSession()');
      } finally {
        h.cleanup();
      }
    });

    for (const order of ['control-first', 'register-first']) {
      it('关联 register 与 control 完成后 route 焦点切换（' + order + '）', async () => {
        const h = makeClearHarness();
        try {
          const clearPromise = h.sendClear();
          const delivery = await pollClearDelivery(h);

          const currentBefore = h.sessionService.getCurrent(h.routeKey);
          assert.equal(currentBefore.agentRef.opencodeSessionId, h.opencodeSessionId,
            order + ': 汇合前 route 焦点应保持旧 session');
          assert.equal(h.bridge.runtimes.get(h.runtimeId).currentSessionId, h.opencodeSessionId,
            order + ': 汇合前 runtime 当前 session 应保持旧 session');

          const newSes = completeClear(h, delivery, 'ses_new_order', order);
          await clearPromise;

          const currentAfter = h.sessionService.getCurrent(h.routeKey);
          assert.equal(currentAfter.agentRef.opencodeSessionId, newSes,
            order + ': 汇合后 route 焦点应切换到新 session');
          assert.equal(h.bridge.runtimes.get(h.runtimeId).currentSessionId, newSes,
            order + ': 汇合后 runtime 当前 session 应为新 session');
        } finally {
          h.cleanup();
        }
      });
    }

    it('clear 后旧 session 仍在 route 且可通过 setFocus 恢复', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);
        completeClear(h, delivery, 'ses_new_keep');
        await clearPromise;

        const sessionsInRoute = h.sessionService.listSessionsInRoute(h.routeKey);
        const oldStillInRoute = sessionsInRoute.find((s) => s.agentRef && s.agentRef.opencodeSessionId === h.opencodeSessionId);
        assert.ok(oldStillInRoute, '旧 session 应保留在 route 中');
        assert.notEqual(oldStillInRoute.status, 'stopped', '旧 session 不应被 stop');
        assert.notEqual(oldStillInRoute.status, 'deleted', '旧 session 不应被 delete');

        h.sessionService.setFocus(h.routeKey, oldStillInRoute.id);
        const restored = h.sessionService.getCurrent(h.routeKey);
        assert.equal(restored.id, oldStillInRoute.id, '旧 session 可通过 setFocus 恢复为焦点');
      } finally {
        h.cleanup();
      }
    });

    it('新 session 继承 model 与 cwd', async () => {
      const h = makeClearHarness({ model: { modelID: 'claude-3.5-sonnet' } });
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);
        const newSes = completeClear(h, delivery, 'ses_new_inherit');
        const result = await clearPromise;

        const newWalker = h.sessionService.getSession(result.walkerSessionId);
        assert.deepEqual(newWalker.model, { modelID: 'claude-3.5-sonnet' }, '新 session 应继承旧 model');
        assert.equal(newWalker.cwd, h.cwd, '新 session cwd 应来自关联 register');
        assert.equal(newWalker.agentRef.opencodeSessionId, newSes, '新 session agentRef 指向新 OpenCode session');
      } finally {
        h.cleanup();
      }
    });

    it('注入无关普通 register 不阻断 clear 且不提前改变原 route 焦点', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);

        h.bridge.register({
          runtimeId: h.runtimeId,
          sessionId: 'ses_unrelated',
          cwd: h.cwd,
          opencodeVersion: '1.17.20',
        });

        const currentAfterUnrelated = h.sessionService.getCurrent(h.routeKey);
        assert.notEqual(currentAfterUnrelated.agentRef.opencodeSessionId, h.opencodeSessionId,
          '普通 register 会聚焦自己的新 session（与 clear 无关）');

        const runtimeCurrent = h.bridge.runtimes.get(h.runtimeId).currentSessionId;
        assert.equal(runtimeCurrent, 'ses_unrelated',
          '普通 register 更新 runtime 当前 session');

        completeClear(h, delivery, 'ses_new_isolated');
        const result = await clearPromise;
        assert.equal(result.newSessionId, 'ses_new_isolated',
          'clear 仍可在普通 register 后完成');
        const finalCurrent = h.sessionService.getCurrent(h.routeKey);
        assert.equal(finalCurrent.agentRef.opencodeSessionId, 'ses_new_isolated',
          'clear 完成后焦点切换到新 session');
      } finally {
        h.cleanup();
      }
    });

    it('错误关联 ID 的 register 被拒绝且不回退为普通注册', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);

        assert.throws(
          () => h.bridge.register({
            runtimeId: h.runtimeId,
            sessionId: 'ses_unknown',
            cwd: h.cwd,
            controlDeliveryId: 'del_nonexistent',
          }),
          /unknown|controlDeliveryId|关联|过期|expired/i,
          '未知 controlDeliveryId 应被拒绝',
        );

        const current = h.sessionService.getCurrent(h.routeKey);
        assert.equal(current.agentRef.opencodeSessionId, h.opencodeSessionId,
          '被拒绝的 register 不应改变 route 焦点');

        completeClear(h, delivery, 'ses_new_reject');
        await clearPromise;
      } finally {
        h.cleanup();
      }
    });

    it('同一 runtime 并发 clear 在投递前失败且只创建一个新 OpenCode session', async () => {
      const h = makeClearHarness();
      try {
        const first = h.sendClear('om_clear_concurrent_1');
        const delivery = await pollClearDelivery(h);
        assert.ok(delivery, '第一个 clear 应投递 delivery');

        const secondResult = await h.sendClear('om_clear_concurrent_2');
        assert.ok(secondResult.busy || secondResult.rejected || secondResult.error,
          '第二个 clear 应在投递前被拒绝');

        const replyCalls = h.feishuApi.calls.filter((c) => c.type === 'replyText');
        const rejectReply = replyCalls.find((c) => c.text && /clear|在途|in progress|in flight/i.test(c.text));
        assert.ok(rejectReply, '应回复并发 clear 拒绝消息');

        completeClear(h, delivery, 'ses_new_concurrent');
        await first;

        const newSessions = h.sessionService.listSessions().filter((s) =>
          s.agentRef && s.agentRef.opencodeSessionId === 'ses_new_concurrent');
        assert.equal(newSessions.length, 1, '只创建一个新 Walker session');
      } finally {
        h.cleanup();
      }
    });

    it('stale runtime 与运行中 clear 保持旧焦点', async () => {
      const h = makeClearHarness({ runtimeStaleMs: 50 });
      try {
        await new Promise((r) => setTimeout(r, 80));
        const result = await h.sendClear();
        assert.ok(result.error, 'stale runtime 时应返回错误');

        const current = h.sessionService.getCurrent(h.routeKey);
        assert.equal(current.agentRef.opencodeSessionId, h.opencodeSessionId,
          'stale runtime 时旧焦点不变');
      } finally {
        h.cleanup();
      }
    });

    it('运行中 /clear 在 route lock 外立即提示先 /cancel', async () => {
      const h = makeClearHarness();
      try {
        const current = h.sessionService.getCurrent(h.routeKey);
        h.sessionService.markRunning(current.id);
        h.dispatcher.turnStates.set(current.id, { token: 1, cancelled: false });

        const result = await h.sendClear();
        assert.ok(result.busy || result.rejected, '运行中应立即拒绝');

        const reply = h.feishuApi.calls.find((c) => c.type === 'replyText' && c.text && /cancel/i.test(c.text));
        assert.ok(reply, '应提示先执行 /cancel');

        h.dispatcher.turnStates.delete(current.id);
        h.sessionService.markIdle(current.id);

        const stillCurrent = h.sessionService.getCurrent(h.routeKey);
        assert.equal(stillCurrent.agentRef.opencodeSessionId, h.opencodeSessionId,
          '运行中拒绝后旧焦点不变，且不会自动执行 clear');
      } finally {
        h.cleanup();
      }
    });

    it('clear error 可恢复（旧焦点不变，pending 清理）', async () => {
      const h = makeClearHarness();
      try {
        const errorPromise = h.sendClear('om_clear_err_1');
        const delivery = await pollClearDelivery(h);
        h.bridge.reportEvents({
          runtimeId: h.runtimeId,
          sessionId: h.opencodeSessionId,
          deliveryId: delivery.deliveryId,
          error: 'SDK create failed',
        });
        const errorResult = await errorPromise;
        assert.ok(errorResult.error, '插件 error 应返回错误');

        const currentAfterError = h.sessionService.getCurrent(h.routeKey);
        assert.equal(currentAfterError.agentRef.opencodeSessionId, h.opencodeSessionId,
          'error 后旧焦点不变');
        assert.equal(h.bridge._clearPending.size, 0, 'error 后 pending 应清理');
      } finally {
        h.cleanup();
      }
    });

    it('clear 超时可恢复（旧焦点不变，pending 清理）', async () => {
      const h = makeClearHarness({ promptTimeoutMs: 50 });
      try {
        const timeoutPromise = h.sendClear('om_clear_timeout_1');
        const keepAlive = setInterval(() => {}, 10);
        const timeoutResult = await timeoutPromise;
        clearInterval(keepAlive);
        assert.ok(timeoutResult.error, '超时应返回错误，实际: ' + JSON.stringify(timeoutResult));

        assert.equal(h.bridge._clearPending.size, 0, '超时后 pending 应清理');
        const currentAfterTimeout = h.sessionService.getCurrent(h.routeKey);
        assert.equal(currentAfterTimeout.agentRef.opencodeSessionId, h.opencodeSessionId,
          '超时后旧焦点不变');
      } finally {
        h.cleanup();
      }
    });

    it('超时后迟到 control 与关联 register 均不切换焦点', async () => {
      const h = makeClearHarness({ promptTimeoutMs: 100 });
      try {
        const timeoutPromise = h.sendClear('om_clear_late_1');
        const delivery = await pollClearDelivery(h);
        const keepAlive = setInterval(() => {}, 10);
        await timeoutPromise;
        clearInterval(keepAlive);

        assert.throws(
          () => h.bridge.reportEvents({
            runtimeId: h.runtimeId,
            sessionId: h.opencodeSessionId,
            deliveryId: delivery.deliveryId,
            control: { type: 'clear', newSessionId: 'ses_late' },
          }),
          /unknown|过期|expired|delivery/i,
          '超时后迟到 control 应被拒绝',
        );
        assert.throws(
          () => h.bridge.register({
            runtimeId: h.runtimeId,
            sessionId: 'ses_late',
            cwd: h.cwd,
            controlDeliveryId: delivery.deliveryId,
          }),
          /unknown|过期|expired|controlDeliveryId/i,
          '超时后迟到 register 应被拒绝',
        );

        const current = h.sessionService.getCurrent(h.routeKey);
        assert.equal(current.agentRef.opencodeSessionId, h.opencodeSessionId,
          '迟到事件不切换焦点');
      } finally {
        h.cleanup();
      }
    });

    it('clear 后现有 prompt 双向链路仍正常工作', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear('om_clear_then_prompt');
        const delivery = await pollClearDelivery(h);
        const newSes = completeClear(h, delivery, 'ses_new_then_prompt');
        await clearPromise;
        await new Promise((r) => setTimeout(r, 0));

        const promptResult = h.dispatcher.handleIncomingMessage({
          messageId: 'om_msg_after_clear',
          chatId: h.chatId,
          text: 'hello after clear',
        });

        h.bridge.runtimes.get(h.runtimeId);
        const newDelivery = await pollDelivery(h.bridge, h.runtimeId, newSes, 3000);
        h.bridge.runtimes.get(h.runtimeId);
        const pendingEntry = h.bridge.pending.get(newDelivery.deliveryId);
        assert.ok(newDelivery, '应拿到 prompt delivery');
        assert.equal(newDelivery.type, 'prompt', 'clear 后 prompt delivery 类型应为 prompt');
        assert.equal(newDelivery.text, 'hello after clear');
        assert.equal(newDelivery.sessionId, newSes);
        assert.ok(pendingEntry, 'pending 应有该 delivery 条目');

        h.bridge.reportEvents({
          runtimeId: h.runtimeId,
          sessionId: newSes,
          deliveryId: newDelivery.deliveryId,
          events: [
            { type: AgentEvent.TYPE_TEXT, data: { text: 'reply after clear' } },
            { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
          ],
        });

        assert.equal(await promptResult, 'prompted');

        const reply = h.feishuApi.calls.find((c) =>
          c.type === 'replyMarkdown' && c.text && c.text.includes('reply after clear'));
        assert.ok(reply, 'clear 后 prompt 回复应回到飞书');
      } finally {
        h.cleanup();
      }
    });
  });

  describe('v3 租约协议长任务与 v2 兼容', () => {
    it('v3 accepted/heartbeat/final 长任务超过旧固定阈值仍完成', async () => {
      const chatId = 'oc_chat_v3_long';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const runtimeId = 'runtime-v3-long';
      const opencodeSessionId = 'ses_v3_long';

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        leaseTimeoutMs: 5000,
        heartbeatIntervalMs: 1000,
        runtimeStaleMs: 60000,
      });
      bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      const driver = new OpencodeDriver({
        ...ctx.driverOptions,
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: { request: async () => { throw new Error('no http'); } },
        sseClient: { connect: async () => { throw new Error('no sse'); } },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_v3_long',
        chatId,
        text: 'long running task',
      });

      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);
      assert.equal(delivery.text, 'long running task');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'accepted',
        events: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const pendingAfterAccepted = bridge.pending.get(delivery.deliveryId);
      assert.ok(pendingAfterAccepted, 'accepted 后 pending 应存在');
      assert.equal(pendingAfterAccepted.state, 'leased', '状态应为 leased');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'heartbeat',
        events: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const pendingAfterHeartbeat = bridge.pending.get(delivery.deliveryId);
      assert.ok(pendingAfterHeartbeat, 'heartbeat 后 pending 应仍存在');
      assert.equal(pendingAfterHeartbeat.state, 'leased', 'heartbeat 后仍为 leased');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'final',
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'v3 long task result' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      assert.equal(await promptResult, 'prompted');

      const reply = feishuApi.calls.find((c) =>
        c.type === 'replyMarkdown' && c.text && c.text.includes('v3 long task result'));
      assert.ok(reply, 'v3 长任务最终结果应到达飞书');
      bridge.close();
    });

    it('v2 plugin 无 deliveryState 时按 final 兼容完成 prompt', async () => {
      const chatId = 'oc_chat_v2_compat';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const runtimeId = 'runtime-v2-compat';
      const opencodeSessionId = 'ses_v2_compat';

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        leaseTimeoutMs: 5000,
        heartbeatIntervalMs: 1000,
        runtimeStaleMs: 60000,
      });
      bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      const driver = new OpencodeDriver({
        ...ctx.driverOptions,
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: { request: async () => { throw new Error('no http'); } },
        sseClient: { connect: async () => { throw new Error('no sse'); } },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_v2_compat',
        chatId,
        text: 'v2 compat task',
      });

      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);
      assert.equal(delivery.text, 'v2 compat task');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'v2 compat reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      assert.equal(await promptResult, 'prompted');

      const reply = feishuApi.calls.find((c) =>
        c.type === 'replyMarkdown' && c.text && c.text.includes('v2 compat reply'));
      assert.ok(reply, 'v2 兼容 final 应到达飞书');
      bridge.close();
    });

    it('transport_lost tombstone 迟到 final 补投至 watcher 且至多一次', async () => {
      const chatId = 'oc_chat_tomb_recover';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const runtimeId = 'runtime-tomb-recover';
      const opencodeSessionId = 'ses_tomb_recover';

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        leaseTimeoutMs: 100,
        heartbeatIntervalMs: 30,
        runtimeStaleMs: 60000,
        tombstoneTtlMs: 30000,
      });
      bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      const driver = new OpencodeDriver({
        ...ctx.driverOptions,
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: { request: async () => { throw new Error('no http'); } },
        sseClient: { connect: async () => { throw new Error('no sse'); } },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_tomb_recover',
        chatId,
        text: 'tomb recover task',
      });

      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'accepted',
        events: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      try {
        await Promise.race([
          promptResult,
          new Promise((resolve) => setTimeout(() => { resolve('timeout'); }, 50)),
        ]);
        await Promise.race([promptResult.then(() => 'done'), new Promise((r) => setTimeout(() => r('pending'), 10))]);
      } catch (_) {
        ;
      }

      const tombstone = bridge._tombstones.get(delivery.deliveryId);
      assert.ok(tombstone, '租约超时应创建 transport_lost tombstone');
      assert.equal(tombstone.reason, 'transport_lost');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'final',
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'recovered late reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'final',
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'recovered late reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const recoveredReplies = feishuApi.calls.filter((c) =>
        c.type === 'sendMarkdown' && c.text && c.text.includes('recovered late reply'));
      assert.ok(recoveredReplies.length <= 1, '迟到 final 至多投递一次到飞书');
      bridge.close();
    });

    it('cancelled tombstone 迟到 final 被抑制不投递到飞书', async () => {
      const chatId = 'oc_chat_tomb_cancel';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const runtimeId = 'runtime-tomb-cancel';
      const opencodeSessionId = 'ses_tomb_cancel';

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        leaseTimeoutMs: 5000,
        heartbeatIntervalMs: 1000,
        runtimeStaleMs: 60000,
        tombstoneTtlMs: 30000,
      });
      bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      const driver = new OpencodeDriver({
        ...ctx.driverOptions,
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: { request: async () => { throw new Error('no http'); } },
        sseClient: { connect: async () => { throw new Error('no sse'); } },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_tomb_cancel',
        chatId,
        text: 'tomb cancel task',
      });

      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'accepted',
        events: [],
      });

      await new Promise((resolve) => setImmediate(resolve));

      await dispatcher.handleCommand({
        type: 'command', name: 'cancel', args: [],
        routeKey, messageId: 'om_cancel_tomb_cmd', chatId,
      });

      const tombstone = bridge._tombstones.get(delivery.deliveryId);
      assert.ok(tombstone, 'cancel 应创建 cancelled tombstone');
      assert.equal(tombstone.reason, 'cancelled');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'final',
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'cancelled late reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const cancelledReplies = feishuApi.calls.filter((c) =>
        c.type === 'sendMarkdown' && c.text && c.text.includes('cancelled late reply'));
      assert.equal(cancelledReplies.length, 0, 'cancelled tombstone 迟到 final 不应投递到飞书');

      assert.equal(await promptResult, 'cancelled');
      bridge.close();
    });

    it('相同 completed text 经 prompt 和 watcher 两路径只回复一次', async () => {
      const chatId = 'oc_chat_dedup_pw';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const agentRef = { opencodeSessionId: 'ses_dedup_pw', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      let watchHandlers = null;
      const driver = {
        ensureReady: async () => true,
        prompt: async () => [
          new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'shared answer' }),
          new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }),
        ],
        watchSession: (_ref, handlers) => { watchHandlers = handlers; return () => { watchHandlers = null; }; },
        stop: async () => {},
        delete: async () => {},
        resumeSession: async (ref) => ref,
        listModels: async () => [],
        listSessions: async () => [],
        createSession: async () => ({ opencodeSessionId: 'ses_new' }),
      };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_dedup_pw',
        chatId,
        text: 'dedup test',
      });

      if (watchHandlers) {
        watchHandlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'shared answer' }));
        watchHandlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      }
      await new Promise((resolve) => setImmediate(resolve));

      const replies = feishuApi.calls.filter((c) =>
        (c.type === 'replyMarkdown' || c.type === 'sendMarkdown') && c.text && c.text.includes('shared answer'));
      assert.equal(replies.length, 1, '相同文本只投递一次');
    });
  });
});
