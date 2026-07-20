'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { QuestionHandler } = require('../src/dispatch/question-handler');
const { AgentEvent } = require('../src/drivers/agent-driver');

function makeFixture() {
  const agentRef = { transport: 'tui-bridge', runtimeId: 'runtime_1', opencodeSessionId: 'ses_1' };
  const session = { id: 'wks_1', agent: 'opencode', agentRef };
  const calls = [];
  const driver = { replyQuestion: async (...args) => { calls.push({ type: 'replyQuestion', args }); } };
  const feishuApi = {
    replyCard: async (ctx, card) => { calls.push({ type: 'replyCard', ctx, card }); return 'om_card_' + calls.filter((call) => call.type === 'replyCard').length; },
    patchCard: async (cardId, card) => { calls.push({ type: 'patchCard', cardId, card }); },
    sendText: async (chatId, text) => { calls.push({ type: 'sendText', chatId, text }); },
  };
  const sessionService = {
    getSession: (id) => id === session.id ? session : null,
  };
  const handler = new QuestionHandler({ feishuApi, sessionService, driverRegistry: { get: () => driver } });
  return { agentRef, session, calls, driver, feishuApi, handler };
}

function asked(requestID, questions) {
  return new AgentEvent(AgentEvent.TYPE_QUESTION_ASKED, {
    requestID,
    sessionID: 'ses_1',
    questions: questions || [{ header: '选择', question: '请选择', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
  });
}

function command(questionKey, mode, formValue) {
  return {
    name: 'answer', args: [questionKey, mode, 'wks_1'], messageId: 'om_card_' + (Number(questionKey.split(':')[1]) + 1),
    chatId: 'oc_chat_1', routeKey: 'route_1', formValue,
  };
}

function optionCommand(questionKey, mode, optionValue) {
  const args = optionValue ? [questionKey, mode, optionValue, 'wks_1'] : [questionKey, mode, 'wks_1'];
  return {
    name: 'answer', args, messageId: 'om_card_' + (Number(questionKey.split(':')[1]) + 1),
    chatId: 'oc_chat_1', routeKey: 'route_1', formValue: null,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('QuestionHandler', () => {
  it('逐题发送卡片，并在所有合法答案齐备后仅提交一次完整答案', async () => {
    const { handler, session, calls, agentRef } = makeFixture();
    const event = asked('req_1', [
      { header: '一', question: '一', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
      { header: '二', question: '二', options: [{ label: 'C', description: '' }, { label: 'D', description: '' }], multiple: true, custom: true },
    ]);
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', event);
    assert.equal(calls.filter((call) => call.type === 'replyCard').length, 2);
    await handler.handleAnswer(command('req_1:0', '--form', { question_selected: 'option_1' }));
    await handler.handleAnswer(command('req_1:1', '--form', { question_selected: ['option_1', 'option_0'], question_custom: '  自定义  ' }));
    assert.deepEqual(calls.filter((call) => call.type === 'replyQuestion')[0].args, [agentRef, 'req_1', [['B'], ['C', 'D', '自定义']]]);
  });

  it('单选按钮直接提交选项答案', async () => {
    const { handler, session, calls, agentRef } = makeFixture();
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_option'));
    const result = await handler.handleAnswer(optionCommand('req_option:0', '--option', 'option_1'));
    assert.equal(result.status, 'replied');
    assert.deepEqual(calls.filter((call) => call.type === 'replyQuestion')[0].args, [agentRef, 'req_option', [['B']]]);
  });

  it('多选按钮先切换高亮，再提交已选答案', async () => {
    const { handler, session, calls, agentRef } = makeFixture();
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_toggle', [
      { header: '多选', question: '请选择', options: [{ label: 'A' }, { label: 'B' }], multiple: true, custom: false },
    ]));
    assert.deepEqual(await handler.handleAnswer(optionCommand('req_toggle:0', '--toggle', 'option_1')), { status: 'collecting', selected: ['option_1'] });
    const patchCall = calls.filter((call) => call.type === 'patchCard').at(-1);
    assert.ok(patchCall.card.schema === '2.0' || patchCall.card.body, 'toggle patch 后多选卡片保持 v2 结构');
    assert.deepEqual(await handler.handleAnswer(optionCommand('req_toggle:0', '--toggle', 'option_0')), { status: 'collecting', selected: ['option_1', 'option_0'] });
    const result = await handler.handleAnswer(optionCommand('req_toggle:0', '--submit'));
    assert.equal(result.status, 'replied');
    assert.deepEqual(calls.filter((call) => call.type === 'replyQuestion')[0].args, [agentRef, 'req_toggle', [['A', 'B']]]);
  });

  it('多选 checker 表单提交布尔字段时解析为选项答案', async () => {
    const { handler, session, calls, agentRef } = makeFixture();
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_checker', [
      { header: '多选', question: '请选择', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiple: true, custom: false },
    ]));
    const result = await handler.handleAnswer(command('req_checker:0', '--submit', {
      question_selected_0: true,
      question_selected_1: false,
      question_selected_2: true,
    }));
    assert.equal(result.status, 'replied');
    assert.deepEqual(calls.filter((call) => call.type === 'replyQuestion')[0].args, [agentRef, 'req_checker', [['A', 'C']]]);
    const statusPatch = calls.filter((call) => call.type === 'patchCard').at(-1);
    assert.match(statusPatch.card.body.elements[0].content, /\[已选择\] A/);
    assert.match(statusPatch.card.body.elements[0].content, /\[未选择\] B/);
    assert.match(statusPatch.card.body.elements[0].content, /\[已选择\] C/);
  });

  it('多选 checker 表单提交布尔字段和自定义答案', async () => {
    const { handler, session, calls, agentRef } = makeFixture();
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_checker_custom', [
      { header: '多选', question: '请选择', options: [{ label: 'A' }, { label: 'B' }], multiple: true, custom: true },
    ]));
    const result = await handler.handleAnswer(command('req_checker_custom:0', '--submit', {
      question_selected_0: true,
      question_selected_1: false,
      question_custom: '  其他  ',
    }));
    assert.equal(result.status, 'replied');
    assert.deepEqual(calls.filter((call) => call.type === 'replyQuestion')[0].args, [agentRef, 'req_checker_custom', [['A', '其他']]]);
  });

  it('无预设选项的问题降级到本地 TUI 回答', async () => {
    const { handler, session } = makeFixture();
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_text_only', [
      { header: '备注', question: '请输入备注', options: [], custom: true },
    ]));
    assert.equal(handler.requests.get(handler._key(session.agentRef, 'req_text_only')).status, 'feishu_unavailable');
  });

  it('单选同时提交预设与自定义答案时拒绝且不提交', async () => {
    const { handler, session, calls } = makeFixture();
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_2'));
    const result = await handler.handleAnswer(command('req_2:0', '--form', { question_selected: 'option_0', question_custom: '其他' }));
    assert.equal(result.error, 'invalid_answer');
    assert.equal(calls.some((call) => call.type === 'replyQuestion'), false);
  });

  it('卡片最多直接尝试两次，失败后降级到本地 TUI', async () => {
    const { handler, session, calls, feishuApi } = makeFixture();
    feishuApi.replyCard = async () => { calls.push({ type: 'replyCard' }); throw new Error('offline'); };
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_3'));
    assert.equal(calls.filter((call) => call.type === 'replyCard').length, 2);
    assert.equal(calls.some((call) => call.type === 'patchCard' && call.card.header.title.content === '请在本地 TUI 回答'), false);
    assert.equal(handler.requests.get(handler._key(session.agentRef, 'req_3')).status, 'feishu_unavailable');
  });

  it('仅在 SDK 未调用且明确安全时保留答案并允许重试', async () => {
    const { handler, session, calls, driver } = makeFixture();
    const failure = Object.assign(new Error('retry'), { safeToRetry: true, sdkInvoked: false });
    driver.replyQuestion = async () => { throw failure; };
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_4'));
    await handler.handleAnswer(command('req_4:0', '--form', { question_selected: 'option_0' }));
    assert.equal(handler.requests.get(handler._key(session.agentRef, 'req_4')).status, 'collecting');
    driver.replyQuestion = async (...args) => { calls.push({ type: 'replyQuestion', args }); };
    await handler.handleAnswer(command('req_4:0', '--retry'));
    assert.equal(calls.filter((call) => call.type === 'replyQuestion').length, 1);
  });

  it('外部 replied 抢先终结迟到的提交结果', async () => {
    const { handler, session, calls, driver } = makeFixture();
    let resolveReply;
    driver.replyQuestion = () => {
      calls.push({ type: 'replyQuestion' });
      return new Promise((resolve) => { resolveReply = resolve; });
    };
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_5'));
    const pending = handler.handleAnswer(command('req_5:0', '--form', { question_selected: 'option_0' }));
    await new Promise((resolve) => setImmediate(resolve));
    await handler.handleReplied(session, 'oc_chat_1', new AgentEvent(AgentEvent.TYPE_QUESTION_REPLIED, { requestID: 'req_5', sessionID: 'ses_1', answers: [['B']] }));
    resolveReply();
    await pending;
    assert.equal(handler.requests.get(handler._key(session.agentRef, 'req_5')).status, 'replied');
    assert.equal(calls.filter((call) => call.type === 'replyQuestion').length, 1);
  });

  it('拒绝错误的卡片路由、会话和消息标识', async () => {
    const { handler, session, calls } = makeFixture();
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_6'));
    const result = await handler.handleAnswer({ ...command('req_6:0', '--form', { question_selected: 'option_0' }), routeKey: 'route_other' });
    assert.equal(result.error, 'invalid_callback');
    assert.equal(calls.some((call) => call.type === 'replyQuestion'), false);
  });

  it('协议不支持时降级为本地 TUI，且明确终态不被矛盾事件反转', async () => {
    const { handler, session, calls, driver } = makeFixture();
    driver.replyQuestion = async () => { throw Object.assign(new Error('unsupported'), { code: 'QUESTION_REPLY_UNSUPPORTED' }); };
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_7'));
    await handler.handleAnswer(command('req_7:0', '--form', { question_selected: 'option_0' }));
    const request = handler.requests.get(handler._key(session.agentRef, 'req_7'));
    assert.equal(request.status, 'feishu_unavailable');
    await handler.handleReplied(session, 'oc_chat_1', new AgentEvent(AgentEvent.TYPE_QUESTION_REPLIED, { requestID: 'req_7', sessionID: 'ses_1', answers: [['A']] }));
    await handler.handleRejected(session, 'oc_chat_1', new AgentEvent(AgentEvent.TYPE_QUESTION_REJECTED, { requestID: 'req_7', sessionID: 'ses_1' }));
    assert.equal(request.status, 'replied');
    assert.equal(calls.filter((call) => call.type === 'patchCard').at(-1).card.header.title.content, '问题已处理');
  });

  it('卡片 patch 失败时向原 chatId 补发一次文本且不改变终态', async () => {
    const { handler, session, calls, feishuApi } = makeFixture();
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_8'));
    feishuApi.patchCard = async () => { calls.push({ type: 'patchCard' }); throw new Error('patch failed'); };
    await handler.handleRejected(session, 'oc_chat_1', new AgentEvent(AgentEvent.TYPE_QUESTION_REJECTED, { requestID: 'req_8', sessionID: 'ses_1' }));
    assert.equal(handler.requests.get(handler._key(session.agentRef, 'req_8')).status, 'rejected');
    assert.deepEqual(calls.filter((call) => call.type === 'sendText')[0], { type: 'sendText', chatId: 'oc_chat_1', text: '**问题 1/1**\n请选择\n\n已取消' });
  });

  it('终态超过保留期限后显示请求已过期', async () => {
    let now = 0;
    const { session, calls, feishuApi, driver } = makeFixture();
    const handler = new QuestionHandler({ feishuApi, sessionService: { getSession: () => session }, driverRegistry: { get: () => driver }, now: () => now });
    await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_9'));
    await handler.handleRejected(session, 'oc_chat_1', new AgentEvent(AgentEvent.TYPE_QUESTION_REJECTED, { requestID: 'req_9', sessionID: 'ses_1' }));
    now = 24 * 60 * 60 * 1000;
    const result = await handler.handleAnswer(command('req_9:0', '--retry'));
    assert.equal(result.error, 'expired');
    assert.equal(calls.filter((call) => call.type === 'patchCard').at(-1).card.header.title.content, '请求已过期');
  });

  for (const terminal of ['replied', 'rejected']) {
    it('卡片发送期间收到 ' + terminal + ' 后保持终态并禁用迟到卡片', async () => {
      const { handler, session, calls, feishuApi } = makeFixture();
      const sending = deferred();
      feishuApi.replyCard = async () => {
        calls.push({ type: 'replyCard' });
        return sending.promise;
      };
      const pending = handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_send_' + terminal));
      await new Promise((resolve) => setImmediate(resolve));
      const event = terminal === 'replied'
        ? new AgentEvent(AgentEvent.TYPE_QUESTION_REPLIED, { requestID: 'req_send_' + terminal, sessionID: 'ses_1', answers: [['A']] })
        : new AgentEvent(AgentEvent.TYPE_QUESTION_REJECTED, { requestID: 'req_send_' + terminal, sessionID: 'ses_1' });
      await handler[terminal === 'replied' ? 'handleReplied' : 'handleRejected'](session, 'oc_chat_1', event);
      sending.resolve('om_card_late');
      await pending;
      const request = handler.requests.get(handler._key(session.agentRef, 'req_send_' + terminal));
      assert.equal(request.status, terminal);
      assert.equal(request.cards[0], 'om_card_late');
      assert.equal(calls.filter((call) => call.type === 'patchCard').at(-1).card.header.title.content, terminal === 'replied' ? '问题已处理' : '问题已取消');
    });

    it('submitting 卡片 patch 期间收到 ' + terminal + ' 后不调用 driver', async () => {
      const { handler, session, calls, feishuApi, driver } = makeFixture();
      const patching = deferred();
      let holdSubmittingPatch = false;
      feishuApi.patchCard = async (cardId, card) => {
        calls.push({ type: 'patchCard', cardId, card });
        if (holdSubmittingPatch && card.header.title.content === '正在处理') return patching.promise;
      };
      await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_submit_' + terminal));
      driver.replyQuestion = async () => { calls.push({ type: 'replyQuestion' }); };
      holdSubmittingPatch = true;
      const pending = handler.handleAnswer(command('req_submit_' + terminal + ':0', '--form', { question_selected: 'option_0' }));
      await new Promise((resolve) => setImmediate(resolve));
      const event = terminal === 'replied'
        ? new AgentEvent(AgentEvent.TYPE_QUESTION_REPLIED, { requestID: 'req_submit_' + terminal, sessionID: 'ses_1', answers: [['A']] })
        : new AgentEvent(AgentEvent.TYPE_QUESTION_REJECTED, { requestID: 'req_submit_' + terminal, sessionID: 'ses_1' });
      await handler[terminal === 'replied' ? 'handleReplied' : 'handleRejected'](session, 'oc_chat_1', event);
      patching.resolve();
      await pending;
      assert.equal(calls.filter((call) => call.type === 'replyQuestion').length, 0);
    });
  }

  it('并发重复 asked 共用发送并在失败时仍最多尝试两次', async () => {
    const { handler, session, calls, feishuApi } = makeFixture();
    const sending = deferred();
    feishuApi.replyCard = async () => {
      calls.push({ type: 'replyCard' });
      return sending.promise;
    };
    const first = handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_concurrent'));
    const second = handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_concurrent'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((call) => call.type === 'replyCard').length, 1);
    sending.resolve('om_card_concurrent');
    await Promise.all([first, second]);
    assert.equal(handler.requests.get(handler._key(session.agentRef, 'req_concurrent')).cards[0], 'om_card_concurrent');
  });

  it('并发重复 asked 在发送失败时合计最多调用两次底层 API', async () => {
    const { handler, session, calls, feishuApi } = makeFixture();
    const firstAttempt = deferred();
    feishuApi.replyCard = async () => {
      calls.push({ type: 'replyCard' });
      if (calls.filter((call) => call.type === 'replyCard').length === 1) return firstAttempt.promise;
      throw new Error('offline');
    };
    const first = handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_concurrent_failed'));
    const second = handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_concurrent_failed'));
    await new Promise((resolve) => setImmediate(resolve));
    firstAttempt.reject(new Error('offline'));
    await Promise.all([first, second]);
    assert.equal(calls.filter((call) => call.type === 'replyCard').length, 2);
    assert.equal(handler.requests.get(handler._key(session.agentRef, 'req_concurrent_failed')).status, 'feishu_unavailable');
  });

  it('SDK 已调用或未知提交错误进入 processed_unknown', async () => {
    for (const error of [Object.assign(new Error('late'), { sdkInvoked: true, safeToRetry: true }), new Error('unknown')]) {
      const { handler, session, driver } = makeFixture();
      driver.replyQuestion = async () => { throw error; };
      await handler.handleAsked(session, 'oc_chat_1', 'route_1', asked('req_unknown_' + (error.sdkInvoked ? 'sdk' : 'plain')));
      await handler.handleAnswer(command('req_unknown_' + (error.sdkInvoked ? 'sdk' : 'plain') + ':0', '--form', { question_selected: 'option_0' }));
      assert.equal(handler.requests.get(handler._key(session.agentRef, 'req_unknown_' + (error.sdkInvoked ? 'sdk' : 'plain'))).status, 'processed_unknown');
    }
  });

  it('终态记录超过 1000 条时淘汰最早记录', () => {
    let now = 0;
    const { handler, session } = makeFixture();
    handler.now = () => now;
    for (let index = 0; index < 1001; index++) {
      const request = { status: 'rejected', completedAt: now++, agentRef: session.agentRef, requestID: 'req_capacity_' + index };
      handler.requests.set(handler._key(session.agentRef, request.requestID), request);
    }
    handler.pruneStates();
    assert.equal(handler.requests.size, 1000);
    assert.equal(handler.requests.has(handler._key(session.agentRef, 'req_capacity_0')), false);
    assert.equal(handler.requests.has(handler._key(session.agentRef, 'req_capacity_1000')), true);
  });
});
