'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionHandler } = require('../src/dispatch/permission-handler');
const { AgentEvent } = require('../src/drivers/agent-driver');

function makeMocks() {
  const calls = [];
  const dispatcher = {
    permissionCardIds: null,
    _sendFeishu(methodName, args) {
      calls.push({ type: methodName, args });
    },
    _callFeishu(methodName, args) {
      calls.push({ type: methodName, args });
      if (methodName === 'replyCard') return Promise.resolve('om_card_q1');
      return Promise.resolve(undefined);
    },
  };
  const sessionService = {
    getRouteForSession: () => 'feishu:oc_chat1:root:om_root1',
  };
  const feishuApi = {};
  return { dispatcher, sessionService, feishuApi, calls };
}

describe('PermissionHandler 传统 permission 不受影响', () => {
  it('handle 用 buildPermissionCard', async () => {
    const mocks = makeMocks();
    const handler = new PermissionHandler({ dispatcher: mocks.dispatcher, feishuApi: mocks.feishuApi, sessionService: mocks.sessionService });
    const session = { id: 'wks_p1' };
    const agentEvent = new AgentEvent(AgentEvent.TYPE_PERMISSION, {
      id: 'perm_abc', type: 'bash', title: '执行命令',
    });
    handler.handle(session, 'oc_chat1', agentEvent);
    await new Promise((r) => setImmediate(r));
    const replyCall = mocks.calls.find((c) => c.type === 'replyCard');
    assert.ok(replyCall, '传统 permission 应调用 replyCard');
    const card = replyCall.args[1];
    assert.equal(card.header.title.content, '权限确认请求');
  });

  it('handleReplied 用 buildPermissionRepliedCard', async () => {
    const mocks = makeMocks();
    mocks.dispatcher.permissionCardIds = new Map([['perm_abc', 'om_perm1']]);
    const handler = new PermissionHandler({ dispatcher: mocks.dispatcher, feishuApi: mocks.feishuApi, sessionService: mocks.sessionService });
    const session = { id: 'wks_p1' };
    const agentEvent = new AgentEvent(AgentEvent.TYPE_PERMISSION_REPLIED, {
      permissionId: 'perm_abc', response: 'allow',
    });
    handler.handleReplied(session, 'oc_chat1', agentEvent);
    const patchCall = mocks.calls.find((c) => c.type === 'patchCard');
    assert.ok(patchCall, '传统 permission_replied 应 patchCard');
    const card = patchCall.args[1];
    assert.equal(card.header.title.content, '权限已处理');
  });

  it('patchReplied 返回 true 当存在原卡片并 patch', () => {
    const mocks = makeMocks();
    mocks.dispatcher.permissionCardIds = new Map([['perm_abc', 'om_perm1']]);
    const handler = new PermissionHandler({ dispatcher: mocks.dispatcher, feishuApi: mocks.feishuApi, sessionService: mocks.sessionService });
    const ok = handler.patchReplied('perm_abc', 'allow');
    assert.equal(ok, true);
    assert.ok(mocks.calls.some((c) => c.type === 'patchCard'));
  });

  it('patchReplied 返回 false 当无原卡片', () => {
    const mocks = makeMocks();
    const handler = new PermissionHandler({ dispatcher: mocks.dispatcher, feishuApi: mocks.feishuApi, sessionService: mocks.sessionService });
    const ok = handler.patchReplied('perm_abc', 'allow');
    assert.equal(ok, false);
    assert.equal(mocks.calls.some((c) => c.type === 'patchCard'), false);
  });
});
