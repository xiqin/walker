'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app/bootstrap');
const { getPluginSource } = require('../src/opencode-hook/plugin-template');

const ROUTE_KEY = 'feishu:oc_question:root:oc_question';
const CHAT_ID = 'oc_question';
const CWD = 'H:\\walker';

function waitFor(check, timeoutMs) {
  const timeout = timeoutMs || 4000;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        if (check()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - startedAt >= timeout) {
          clearInterval(timer);
          reject(new Error('等待异步集成步骤超时'));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 10);
  });
}

function makeFeishuApi() {
  let cardSequence = 0;
  const calls = [];
  return {
    calls,
    async replyCard(replyCtx, card) {
      const cardId = 'om_question_card_' + (++cardSequence);
      calls.push({ type: 'replyCard', replyCtx, card, cardId });
      return cardId;
    },
    async patchCard(cardId, card) { calls.push({ type: 'patchCard', cardId, card }); },
    async replyText(replyCtx, text) { calls.push({ type: 'replyText', replyCtx, text }); },
    async sendText(chatId, text) { calls.push({ type: 'sendText', chatId, text }); },
    async sendMarkdown(chatId, text) { calls.push({ type: 'sendMarkdown', chatId, text }); },
    async sendProgressCard(replyCtx, sessionId) {
      calls.push({ type: 'sendProgressCard', replyCtx, sessionId });
      return 'om_progress';
    },
    async updateProgressCard(cardId, sessionId, event) {
      calls.push({ type: 'updateProgressCard', cardId, sessionId, event });
    },
    async sendErrorCard(replyCtx, text) { calls.push({ type: 'sendErrorCard', replyCtx, text }); },
  };
}

function findButtonValue(card, text) {
  for (const element of card.elements || []) {
    for (const action of element.actions || element.elements || []) {
      if (action.tag === 'button' && action.text && action.text.content === text) return action.value;
    }
  }
  throw new Error('未找到卡片按钮: ' + text);
}

async function createFixture(options) {
  const opts = options || {};
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-feishu-question-'));
  const app = createApp({
    walkerDataDir: tmpDir,
    walkerDefaultCwd: CWD,
    walkerDefaultRuntime: 'windows',
    feishuRouteMode: 'thread',
    opencodeServerAutostart: false,
    opencodeTuiLeaseTimeoutMs: 10000,
    opencodeTuiHeartbeatIntervalMs: 15,
    admin: { enabled: false },
  });
  const feishuApi = makeFeishuApi();
  app.platform.api = feishuApi;
  app.sessionService.createSession({ route: ROUTE_KEY, agent: 'opencode', cwd: CWD });
  app.sessionService.setRouteCwd(ROUTE_KEY, CWD);

  const handlers = new Map();
  const requests = [];
  const sdk = { promptCalls: [], questionCalls: [], createCalls: [], navigations: [] };
  const route = {
    current: { name: 'session', params: { sessionID: 'ses_native_question' } },
    navigate: (_name, params) => { route.current = { name: 'session', params }; },
  };
  let sessionBusy = false;
  let dispose;
  let heldQuestionReply;
  let heldPrompt;
  const originalFetch = global.fetch;

  global.fetch = async (url, request) => {
    const body = JSON.parse(request.body);
    const pathname = String(url);
    const record = { url: pathname, body };
    requests.push(record);
    if (opts.onRequest) {
      const intercepted = await opts.onRequest({ url: pathname, body, bridge: app.tuiBridge });
      if (intercepted) {
        return {
          ok: false,
          status: intercepted.status || 503,
          json: async () => ({ ok: false, error: { message: intercepted.message || '模拟传输失败' } }),
        };
      }
    }
    let data;
    if (pathname.endsWith('/register')) data = app.tuiBridge.register(body);
    else if (pathname.endsWith('/poll')) data = { delivery: app.tuiBridge.poll(body) };
    else if (pathname.endsWith('/events')) data = app.tuiBridge.reportEvents(body);
    else if (pathname.endsWith('/dispose')) {
      app.tuiBridge.dispose(body);
      data = { disposed: true };
    } else {
      throw new Error('未知插件请求: ' + pathname);
    }
    record.response = data;
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  const source = getPluginSource(8787, '', 15);
  const plugin = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  try {
    await plugin.default.tui({
      route,
      client: {
        session: {
          promptAsync: async (input) => {
            sdk.promptCalls.push(input);
            sessionBusy = true;
            if (opts.holdPrompt) return new Promise((resolve) => { heldPrompt = resolve; });
            return { data: null };
          },
          create: async () => {
            sdk.createCalls.push(true);
            return { data: { id: 'ses_after_clear' } };
          },
        },
        question: {
          reply: async (input) => {
            sdk.questionCalls.push(input);
            if (opts.holdQuestionReply) return new Promise((resolve) => { heldQuestionReply = resolve; });
            return { data: null };
          },
        },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: {
        path: { directory: CWD },
        session: {
          status: () => ({ type: sessionBusy ? 'busy' : 'idle' }),
          messages: () => [{ id: 'msg_final', role: 'assistant' }],
        },
        part: () => [{ type: 'text', text: '完成' }],
      },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
      app: { version: '1.17.20' },
    });
  } catch (err) {
    global.fetch = originalFetch;
    app.tuiBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  await waitFor(() => app.sessionService.getCurrent(ROUTE_KEY) && app.sessionService.getCurrent(ROUTE_KEY).agentRef);
  const session = app.sessionService.getCurrent(ROUTE_KEY);
  const answerCommands = [];
  const handleAnswer = app.dispatcher.questionHandler.handleAnswer.bind(app.dispatcher.questionHandler);
  app.dispatcher.questionHandler.handleAnswer = async (cmd) => {
    answerCommands.push({
      formValue: cmd.formValue,
      messageId: cmd.messageId,
      routeKey: cmd.routeKey,
      args: cmd.args,
    });
    return handleAnswer(cmd);
  };

  return {
    app,
    bridge: app.tuiBridge,
    dispatcher: app.dispatcher,
    driver: app.registry.get('opencode'),
    feishuApi,
    handlers,
    requests,
    route,
    sdk,
    session,
    runtimeId: session.agentRef.runtimeId,
    answerCommands,
    cards: () => feishuApi.calls.filter((call) => call.type === 'replyCard'),
    patchCards: () => feishuApi.calls.filter((call) => call.type === 'patchCard'),
    async emitQuestionAsked(requestID, questions) {
      await handlers.get('question.asked')({ properties: {
        id: requestID,
        sessionID: 'ses_native_question',
        questions,
        tool: { messageID: 'msg_question', callID: 'call_question' },
      } });
    },
    async emitQuestionReplied(requestID, answers) {
      await handlers.get('question.replied')({ properties: { requestID, sessionID: 'ses_native_question', answers } });
    },
    async emitQuestionRejected(requestID) {
      await handlers.get('question.rejected')({ properties: { requestID, sessionID: 'ses_native_question' } });
    },
    async submitCard(index, formValue, buttonText) {
      const cardCall = this.cards()[index];
      const value = findButtonValue(cardCall.card, buttonText || '提交');
      return app.platform._handleCardAction({
        context: { open_id: 'ou_question', chat_id: CHAT_ID, message_id: cardCall.cardId },
        action: { value, form_value: formValue },
      });
    },
    async submitPatchedCard(cardId, buttonText) {
      let patchCall = null;
      for (const call of feishuApi.calls) {
        if (call.type !== 'patchCard' || call.cardId !== cardId) continue;
        try { findButtonValue(call.card, buttonText); patchCall = call; } catch (_) {}
      }
      if (!patchCall) throw new Error('未找到含按钮 ' + buttonText + ' 的已更新卡片: ' + cardId);
      const value = findButtonValue(patchCall.card, buttonText);
      return app.platform._handleCardAction({
        context: { open_id: 'ou_question', chat_id: CHAT_ID, message_id: cardId },
        action: { value, form_value: undefined },
      });
    },
    resolveHeldQuestionReply() { if (heldQuestionReply) heldQuestionReply({ data: null }); },
    resolveHeldPrompt() { if (heldPrompt) heldPrompt({ data: null }); },
    setBusy(value) { sessionBusy = value; },
    async close() {
      if (heldQuestionReply) heldQuestionReply({ data: null });
      if (heldPrompt) heldPrompt({ data: null });
      if (dispose) await dispose();
      await app.stop();
      global.fetch = originalFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function requestState(fixture, requestID) {
  return fixture.dispatcher.questionHandler.requests.get(
    fixture.dispatcher.questionHandler._key(fixture.session.agentRef, requestID),
  );
}

describe('集成测试: 原生 question protocol v4', () => {
  it('由原始飞书卡片回调经平台和 bootstrap adapter 逐题收集，并只调用一次原生 SDK', async () => {
    const fixture = await createFixture();
    try {
      await fixture.emitQuestionAsked('req_multi', [
        { header: '模式', question: '选择模式', options: [{ label: '快速', description: '快速执行' }, { label: '稳妥', description: '完整检查' }], multiple: false, custom: false },
        { header: '范围', question: '选择范围', options: [{ label: '代码', description: '源代码' }, { label: '测试', description: '测试文件' }], multiple: true, custom: true },
      ]);
      await waitFor(() => fixture.cards().length === 2);
      assert.deepEqual(fixture.cards().map((call) => call.card.elements[0].text.content.includes('问题')), [true, true]);

      await fixture.submitCard(0, null, '稳妥');
      await fixture.submitCard(1, null, '测试');
      await fixture.submitCard(1, null, '代码');
      void fixture.submitCard(1, null, '提交');

      await waitFor(() => fixture.sdk.questionCalls.length === 1);
      assert.deepEqual(fixture.answerCommands, [
        { formValue: null, messageId: fixture.cards()[0].cardId, routeKey: ROUTE_KEY, args: ['req_multi:0', '--option', 'option_1', fixture.session.id] },
        { formValue: null, messageId: fixture.cards()[1].cardId, routeKey: ROUTE_KEY, args: ['req_multi:1', '--toggle', 'option_1', fixture.session.id] },
        { formValue: null, messageId: fixture.cards()[1].cardId, routeKey: ROUTE_KEY, args: ['req_multi:1', '--toggle', 'option_0', fixture.session.id] },
        { formValue: null, messageId: fixture.cards()[1].cardId, routeKey: ROUTE_KEY, args: ['req_multi:1', '--submit', fixture.session.id] },
      ], 'FeishuPlatform._handleCardAction -> parseCardAction -> bootstrap onCardAction -> parseCommand -> Dispatcher 必须完整保留按钮命令/messageId/routeKey');
      assert.deepEqual(fixture.sdk.questionCalls, [{
        requestID: 'req_multi',
        answers: [['稳妥'], ['代码', '测试']],
      }]);
      assert.deepEqual(fixture.sdk.promptCalls, [], 'question_reply 不得走 promptAsync');
      await waitFor(() => fixture.patchCards().filter((call) => call.card.elements[0].text.content.includes('已处理')).length >= 2);
    } finally {
      await fixture.close();
    }
  });

  it('本地 TUI replied/rejected 抢先，重复和并发飞书卡片回调不会产生第二次原生回复', async () => {
    const replied = await createFixture();
    try {
      await replied.emitQuestionAsked('req_tui_replied', [{ header: '确认', question: '继续？', options: [{ label: '继续', description: '' }], custom: false }]);
      await waitFor(() => replied.cards().length === 1);
      await replied.emitQuestionReplied('req_tui_replied', [['本地答案']]);
      void replied.submitCard(0, null, '继续');
      await waitFor(() => requestState(replied, 'req_tui_replied') && requestState(replied, 'req_tui_replied').status === 'replied');
      assert.equal(requestState(replied, 'req_tui_replied').status, 'replied');
      assert.deepEqual(replied.sdk.questionCalls, []);
    } finally {
      await replied.close();
    }

    const rejected = await createFixture();
    try {
      await rejected.emitQuestionAsked('req_tui_rejected', [{ header: '确认', question: '继续？', options: [{ label: '继续', description: '' }], custom: false }]);
      await waitFor(() => rejected.cards().length === 1);
      await rejected.emitQuestionRejected('req_tui_rejected');
      void rejected.submitCard(0, null, '继续');
      await waitFor(() => requestState(rejected, 'req_tui_rejected') && requestState(rejected, 'req_tui_rejected').status === 'rejected');
      assert.equal(requestState(rejected, 'req_tui_rejected').status, 'rejected');
      assert.deepEqual(rejected.sdk.questionCalls, []);
    } finally {
      await rejected.close();
    }

    const concurrent = await createFixture();
    try {
      await concurrent.emitQuestionAsked('req_concurrent', [
        { header: '一', question: '第一题', options: [{ label: 'A', description: '' }], custom: false },
        { header: '二', question: '第二题', options: [{ label: 'B', description: '' }], custom: false },
      ]);
      await waitFor(() => concurrent.cards().length === 2);
      await concurrent.submitCard(0, null, 'A');
      void concurrent.submitCard(1, null, 'B');
      void concurrent.submitCard(1, null, 'B');
      await waitFor(() => concurrent.sdk.questionCalls.length === 1);
      assert.deepEqual(concurrent.sdk.questionCalls[0].answers, [['A'], ['B']]);
    } finally {
      await concurrent.close();
    }
  });

  it('accepted 前失败可安全重试，accepted 后租约丢失收敛为 processed_unknown 且不可重试', async () => {
    const retryable = await createFixture();
    try {
      const replyQuestion = retryable.driver.replyQuestion.bind(retryable.driver);
      let firstAttempt = true;
      retryable.driver.replyQuestion = async (...args) => {
        if (firstAttempt) {
          firstAttempt = false;
          const error = new Error('accepted 前传输失败');
          error.code = 'TUI_ACCEPTED_TIMEOUT';
          error.deliveryPhase = 'queued';
          error.sdkInvoked = false;
          error.safeToRetry = true;
          throw error;
        }
        return replyQuestion(...args);
      };
      await retryable.emitQuestionAsked('req_retryable', [{ header: '确认', question: '继续？', options: [{ label: '是', description: '' }], custom: false }]);
      await waitFor(() => retryable.cards().length === 1);
      void retryable.submitCard(0, null, '是');
      await waitFor(() => requestState(retryable, 'req_retryable').status === 'collecting');
      assert.deepEqual(retryable.sdk.questionCalls, []);
      await waitFor(() => retryable.patchCards().some((call) => call.card.elements.some((el) => el.actions && el.actions.some((a) => a.tag === 'button' && a.text && a.text.content === '重试提交'))));

      void retryable.submitPatchedCard(retryable.cards()[0].cardId, '重试提交');
      await waitFor(() => retryable.sdk.questionCalls.length === 1);
      assert.deepEqual(retryable.sdk.questionCalls[0].answers, [['是']]);
    } finally {
      await retryable.close();
    }

    const uncertain = await createFixture({ holdQuestionReply: true });
    try {
      await uncertain.emitQuestionAsked('req_unknown', [{ header: '确认', question: '继续？', options: [{ label: '是', description: '' }], custom: false }]);
      await waitFor(() => uncertain.cards().length === 1);
      void uncertain.submitCard(0, null, '是');
      await waitFor(() => uncertain.sdk.questionCalls.length === 1);
      uncertain.bridge.dispose({ runtimeId: uncertain.runtimeId });
      await waitFor(() => requestState(uncertain, 'req_unknown').status === 'processed_unknown');
      void uncertain.submitCard(0, null, '是');
      await waitFor(() => requestState(uncertain, 'req_unknown').status === 'processed_unknown');
      assert.equal(requestState(uncertain, 'req_unknown').status, 'processed_unknown');
      assert.equal(uncertain.sdk.questionCalls.length, 1);
    } finally {
      await uncertain.close();
    }
  });

  it('protocol v3 的 QUESTION_REPLY_UNSUPPORTED 降级为 feishu_unavailable，并提示在本地 TUI 回答', async () => {
    const fixture = await createFixture();
    try {
      fixture.bridge.runtimes.get(fixture.runtimeId).bridgeProtocolVersion = 3;
      await fixture.emitQuestionAsked('req_v3', [
        { header: '确认', question: '继续？', options: [{ label: '是', description: '' }], custom: false },
      ]);
      await waitFor(() => fixture.cards().length === 1);
      void fixture.submitCard(0, null, '是');
      await waitFor(() => requestState(fixture, 'req_v3').status === 'feishu_unavailable');
      assert.equal(requestState(fixture, 'req_v3').status, 'feishu_unavailable');
      assert.equal(fixture.bridge.runtimes.get(fixture.runtimeId).queue.some((delivery) => delivery.type === 'question_reply'), false);
      assert.deepEqual(fixture.sdk.questionCalls, []);
      assert.ok(fixture.patchCards().some((call) => call.card.elements[0].text.content.includes('请在本地 TUI 回答')),
        'v3 降级卡片必须提示用户在本地 TUI 回答，而非由 Walker 自动替用户回答');
    } finally {
      await fixture.close();
    }
  });

  it('父 prompt busy 时由真实插件 poll、accepted 和 SDK question.reply 完成控制 delivery，且保留父 prompt 与队列顺序', async () => {
    const fixture = await createFixture({ holdQuestionReply: true });
    try {
      const parent = fixture.driver.prompt(fixture.session.agentRef, '父 prompt');
      parent.catch(() => {});
      await waitFor(() => fixture.sdk.promptCalls.length === 1);
      const parentPoll = fixture.requests.find((request) => request.response
        && request.response.delivery && request.response.delivery.type === 'prompt');
      const parentDeliveryId = parentPoll.response.delivery.deliveryId;
      assert.deepEqual(parentPoll.body.acceptedTypes, ['prompt', 'clear', 'question_reply']);

      const queuedPrompt = fixture.bridge.prompt(fixture.session.agentRef, '后续 prompt');
      const queuedClear = fixture.bridge.clearSession(fixture.session.agentRef);
      queuedPrompt.catch(() => {});
      queuedClear.catch(() => {});
      await fixture.emitQuestionAsked('req_nested', [{
        header: '确认', question: '继续？', options: [{ label: '确认', description: '' }], custom: false,
      }]);
      await waitFor(() => fixture.cards().length === 1);
      void fixture.submitCard(0, null, '确认');

      await waitFor(() => fixture.sdk.questionCalls.length === 1);
      assert.deepEqual(fixture.sdk.questionCalls, [{ requestID: 'req_nested', answers: [['确认']] }]);
      assert.ok(fixture.requests.some((request) => request.url.endsWith('/poll')
        && JSON.stringify(request.body.acceptedTypes) === JSON.stringify(['question_reply'])),
      'busy 插件 poll 必须仅接受 question_reply');
      assert.ok(fixture.requests.some((request) => request.url.endsWith('/events') && request.body.deliveryState === 'accepted'),
        '控制 delivery 必须由插件上报 accepted');
      assert.deepEqual(fixture.bridge.runtimes.get(fixture.runtimeId).queue.map((delivery) => delivery.type), ['prompt', 'clear']);

      fixture.resolveHeldQuestionReply();
      await waitFor(() => fixture.requests.some((request) => request.url.endsWith('/events')
        && request.body.deliveryState === 'final' && request.body.deliveryId !== parentDeliveryId));
      await waitFor(() => fixture.requests.some((request) => request.url.endsWith('/events')
        && request.body.deliveryId === parentDeliveryId && request.body.deliveryState === 'heartbeat'));
      fixture.setBusy(false);
      await fixture.handlers.get('session.idle')({ properties: { sessionID: 'ses_native_question' } });
      await parent;
      assert.ok(fixture.requests.some((request) => request.url.endsWith('/events')
        && request.body.deliveryId === parentDeliveryId && request.body.deliveryState === 'final'),
      '父 prompt 在控制回复后仍必须正常 final');
    } finally {
      fixture.resolveHeldQuestionReply();
      await fixture.close();
    }
  });

  it('真实 Driver 的 permission 回复失败会经飞书 /permit 回调显示错误，同时普通 prompt 与 clear 保持回归', async () => {
    const fixture = await createFixture();
    try {
      await fixture.handlers.get('permission.updated')({ properties: {
        id: 'perm_native', sessionID: 'ses_native_question', type: 'file_write', title: '写入文件', metadata: {},
      } });
      await waitFor(() => fixture.cards().length === 1);
      void fixture.submitCard(0, undefined, '允许');
      await waitFor(() => fixture.feishuApi.calls.some((call) => call.type === 'replyText'
        && call.text.includes('权限不存在或已过期: perm_native')));
      assert.ok(fixture.feishuApi.calls.some((call) => call.type === 'replyText'
        && call.text.includes('权限不存在或已过期: perm_native')),
      'TUI bridge transport 的 replyPermission 不支持时必须可见 dispatcher 错误反馈');
      assert.equal(fixture.bridge.runtimes.get(fixture.runtimeId).queue.some((delivery) => delivery.type === 'question_reply'), false);
      assert.deepEqual(fixture.sdk.questionCalls, []);

      const prompt = fixture.dispatcher.handleIncomingMessage({
        messageId: 'om_prompt', createTime: Date.now(), routeKey: ROUTE_KEY, chatId: CHAT_ID, text: '普通消息', rootId: 'root',
      });
      await waitFor(() => fixture.sdk.promptCalls.length === 1);
      fixture.setBusy(false);
      await fixture.handlers.get('session.idle')({ properties: { sessionID: 'ses_native_question' } });
      assert.equal(await prompt, 'prompted');

      const cleared = fixture.driver.clearSession(fixture.session.agentRef);
      await waitFor(() => fixture.sdk.createCalls.length === 1);
      const result = await cleared;
      assert.equal(result.newSessionId, 'ses_after_clear');
      assert.equal(fixture.sdk.questionCalls.length, 0);
    } finally {
      await fixture.close();
    }
  });
});
