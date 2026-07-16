'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getPluginSource } = require('../src/opencode-hook/plugin-template');

describe('plugin-template v3 protocol', () => {
  it('register payload 包含 bridgeProtocolVersion: 3', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    assert.ok(src.includes('bridgeProtocolVersion: 3'));
  });

  it('源码包含 accepted 上报', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    assert.ok(src.includes("'accepted'"));
  });

  it('源码包含 heartbeat 上报', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    assert.ok(src.includes("'heartbeat'"));
  });

  it('源码包含 final 上报', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    assert.ok(src.includes("'final'"));
  });

  it('源码包含 startHeartbeat 函数', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    assert.ok(src.includes('function startHeartbeat('));
  });

  it('源码包含 stopHeartbeat 函数', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    assert.ok(src.includes('function stopHeartbeat('));
  });

  it('heartbeat 间隔使用传入参数', () => {
    const customMs = 45000;
    const src = getPluginSource(8787, 'token123', customMs);
    assert.ok(src.includes(`HEARTBEAT_INTERVAL_MS = ${customMs}`));
  });

  it('dispose 中清理 heartbeat timer', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    assert.ok(src.includes('if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer)'));
  });

  it('report 函数包含 deliveryState 参数', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    const reportMatch = src.match(/async function report\([^)]*\)/);
    assert.ok(reportMatch, 'report 函数应存在');
    assert.ok(reportMatch[0].includes('deliveryState'), 'report 应有 deliveryState 参数');
  });

  it('report 中 deliveryState 条件赋值到 body', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    assert.ok(src.includes('if (deliveryState) body.deliveryState = deliveryState'));
  });

  it('executeDelivery 中 accepted 上报在 promptAsync 之前', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    const acceptedIdx = src.indexOf("'accepted'");
    const promptAsyncIdx = src.indexOf('promptAsync');
    assert.ok(acceptedIdx > 0, 'accepted 上报应存在');
    assert.ok(promptAsyncIdx > 0, 'promptAsync 调用应存在');
    assert.ok(acceptedIdx < promptAsyncIdx, 'accepted 应在 promptAsync 之前');
  });

  it('startHeartbeat 在 promptAsync 成功后调用', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    const promptAsyncIdx = src.indexOf('promptAsync');
    const startHeartbeatCallIdx = src.indexOf('startHeartbeat(sessionId, delivery.deliveryId)');
    assert.ok(promptAsyncIdx > 0);
    assert.ok(startHeartbeatCallIdx > 0);
    assert.ok(startHeartbeatCallIdx > promptAsyncIdx, 'startHeartbeat 应在 promptAsync 之后');
  });

  it('session.idle 中 report 带 final', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    const idleIdx = src.indexOf("'session.idle'");
    const finalAfterIdle = src.indexOf("'final'", idleIdx);
    assert.ok(finalAfterIdle > idleIdx, 'session.idle 处理中应有 final 上报');
  });

  it('session.error 中 report 带 final', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    const errorIdx = src.indexOf("'session.error'");
    const finalAfterError = src.indexOf("'final'", errorIdx);
    assert.ok(finalAfterError > errorIdx, 'session.error 处理中应有 final 上报');
  });

  it('executeDelivery catch 中 report 带 final', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    const catchIdx = src.indexOf('} catch (error) {', src.indexOf('executeDelivery'));
    const finalAfterCatch = src.indexOf("'final'", catchIdx);
    assert.ok(finalAfterCatch > catchIdx, 'executeDelivery catch 中应有 final 上报');
  });

  it('clear 相关 report 不带 deliveryState', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    const clearDelStart = src.indexOf('async function executeClearDelivery(');
    const nextFuncStart = src.indexOf('async function ', clearDelStart + 1);
    const clearSection = src.substring(clearDelStart, nextFuncStart);
    const clearReportCalls = clearSection.match(/await report\([^)]*\)/g) || [];
    for (const call of clearReportCalls) {
      assert.ok(!call.includes('accepted') && !call.includes('heartbeat') && !call.includes('final'),
        `clear report 不应带 deliveryState: ${call}`);
    }
  });

  it('bridge version 注释保持为 5', () => {
    const src = getPluginSource(8787, 'token123', 30000);
    assert.ok(src.includes('// Walker TUI bridge version: 5'));
  });

  it('默认 heartbeat 间隔为 30000ms', () => {
    const src = getPluginSource(8787, 'token123');
    assert.ok(src.includes('HEARTBEAT_INTERVAL_MS = 30000'));
  });
});
