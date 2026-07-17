# T1: 抽离 turn-state.js

## 目标
将 turn 状态机相关方法从 `message-dispatcher.js` 抽到 `src/dispatch/turn-state.js`，行为不变。

## 要迁移的方法
- `_startTurnState(session, event, driver, agentRef, token, progressCardId, stopHeartbeat)`
- `_startTurnTimeout(session, turnState)`
- `_cancelTurn(session, driver, turnState, options)` (async)
- `_clearTurnState(sessionId, token)`
- `_isTurnCancelled(sessionId, token)`
- `_isTurnSuppressed(sessionId)`
- `_touchTurnState(turnState)`
- `_isTransportRecoverableError(err)`

## 共享状态（保留在 dispatcher 实例上）
- `dispatcher.turnStates` (Map)
- `dispatcher.cancelledTurnSessions` (Set)
- `dispatcher._turnSeq` (number)
- `dispatcher.maxTurnTimeMins`

## 实现步骤
1. 新建 `src/dispatch/turn-state.js`，导出 `TurnStateManager` 类，构造接收 `{ dispatcher, sessionService, driverRegistry, maxTurnTimeMins }`。
2. 把上述方法迁入，方法体内所有 `this.xxx` 中属于共享状态的改为 `this.dispatcher.xxx`，调用主类方法的改为 `this.dispatcher._method(...)`（如 `_callFeishu`、`_clearTurnState` 互调、`_markIdleIfActive`、`_replyCtx`）。
3. 在 `message-dispatcher.js` 构造函数末尾实例化 `this.turnStateManager = new TurnStateManager({ dispatcher: this, sessionService, driverRegistry: this.driverRegistry, maxTurnTimeMins: this.maxTurnTimeMins })`。
4. 在主类保留同名薄委托方法，转发到 `this.turnStateManager`，保证所有 `this._startTurnState(...)` 等内部调用无需改动。
5. 删除主类中已迁移的方法体（保留薄委托）。

## 验收
- `node --test test/message-dispatcher.test.js` 全部通过
- `node --test test/integration-feishu-tui-sync.test.js` 全部通过
- `node --test test/integration-hook-routing.test.js` 全部通过
- `node --test test/opencode-hook-health-poller.test.js` 全部通过
- `dispatcher.turnStates` 仍可被测试直接 set/get/delete

## 风险
- `_cancelTurn` 调用 `_clearTurnState`、`_markIdleIfActive`、`_callFeishu`、`sessionWatchBuffers.set`，需保证这些在主类上仍可访问。
- `_clearTurnState` 调用 `turnState.stopHeartbeat` 和 `turnState.timeoutTimer`，这些字段由 `_startTurnState` 写入，迁移后仍在同一 manager 内，无问题。
