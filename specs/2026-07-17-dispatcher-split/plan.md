# 重构 plan：message-dispatcher.js 按职责拆分

## 目标

将 `src/dispatch/message-dispatcher.js`（1575 行单文件、`MessageDispatcher` 单类）按职责拆分为 5 个文件，**行为完全不变**，所有现有测试保持通过。

## 现状

- 单文件 1575 行，`MessageDispatcher` 类承载 5 类职责：turn 状态机、心跳、进度卡片渲染、权限处理、主调度骨架 + 命令处理。
- 外部依赖入口：仅 `src/app/bootstrap.js` 通过 `require('../dispatch/message-dispatcher')` 导入 `MessageDispatcher`，并支持 `deps.MessageDispatcher` 注入。
- health-poller (`src/core/health-poller.js`) 仅通过公开方法 `getTurnState` / `cancelTurnBySessionId` / `stopSessionWatch` 访问 dispatcher，不依赖内部字段。

## 兼容性约束（必须保持）

测试直接访问 dispatcher 实例的 3 个内部 Map 字段：

| 字段 | 类型 | 访问点 | 用途 |
|------|------|--------|------|
| `turnStates` | `Map` | message-dispatcher.test.js (4 处 set/get)、integration-feishu-tui-sync.test.js (set/delete)、integration-hook-routing.test.js (set) | 模拟活动 turn |
| `sessionWatchStops` | `Map` | message-dispatcher.test.js (set/has/size，4 处) | 模拟 watch stop 函数 |
| `sessionWatchProgressCards` | `Map` | message-dispatcher.test.js (has，1 处) | 断言进度卡片清理 |

**结论**：拆分时这 3 个 Map 必须仍作为 `dispatcher` 实例的直接可访问字段（不能用纯内部闭包），否则测试会 break。最稳妥方式：让拆分出的 helper 模块**接收并共享 dispatcher 实例引用**，把状态 Map 留在 dispatcher 上，helper 通过 `this.dispatcher.turnStates` 等访问。

## 拆分边界

### 1. `turn-state.js` — TurnStateManager

迁移方法（约 80 行）：
- `_startTurnState(session, event, driver, agentRef, token, progressCardId, stopHeartbeat)`
- `_startTurnTimeout(session, turnState)`
- `_cancelTurn(session, driver, turnState, options)` (async)
- `_clearTurnState(sessionId, token)`
- `_isTurnCancelled(sessionId, token)`
- `_isTurnSuppressed(sessionId)`
- `_touchTurnState(turnState)`
- `_isTransportRecoverableError(err)`

共享状态：`turnStates` Map、`cancelledTurnSessions` Set、`_turnSeq` 计数器、`maxTurnTimeMins`。

设计：导出 `TurnStateManager` 类，构造接收 `{ dispatcher, sessionService, driverRegistry, maxTurnTimeMins }`。`turnStates` 和 `cancelledTurnSessions` 仍挂在 `dispatcher` 上（兼容测试），manager 通过 `this.dispatcher.turnStates` 访问。

### 2. `heartbeat.js` — PromptHeartbeat

迁移方法（约 55 行）：
- `_startPromptHeartbeat(session, progressCardId)`
- `_stopPromptHeartbeat(sessionId)`
- `_formatDuration(ms)`

共享状态：`promptHeartbeatStops` Map、`promptHeartbeatInitialMs` / `promptHeartbeatIntervalMs` / `promptHeartbeatStuckMs`、`progressStyle`、`sessionWatchStops`（间接通过 dispatcher）。

设计：导出 `PromptHeartbeat` 类，构造接收 `{ dispatcher, feishuApi, config }`。`promptHeartbeatStops` 仍挂在 `dispatcher` 上。

### 3. `progress-renderer.js` — ProgressRenderer

迁移方法（约 180 行）：
- `_renderEvents(session, event, events, progressCardId)` (async)
- `_renderCardProgress(session, event, displayEvents, progressCardId)` (async)
- `_renderLegacyProgress(session, event, displayEvents)` (async)
- `_coalesceDisplayEvents(events, promptText)`
- `_pushDisplayEvent(displayEvents, agentEvent)`
- `_stripPromptEcho(text, promptText)`
- `_collapseNumberedSnapshots(text)`
- `_pushTextSnapshot(snapshots, nextText)`
- `_textFromDisplayEvents(displayEvents)`
- `_appendModelFooter(text, session)` / `_formatModel(model)`
- 模型相关：`_resolveSessionModel` / `_resolveInheritedModel` / `_normalizeDefaultModel` / `_resolveModelRef` / `_formatModelListText`

共享状态：`progressStyle`、`doneEmoji`、`sessionDeliveredTexts` Map、`sessionWatchBuffers`/`sessionWatchProgressCards`/`sessionWatchProgressPromises`、`turnStates`（_touchTurnState）、`nonFocusOutput`、`defaultModel`。

设计：导出 `ProgressRenderer` 类，构造接收 `{ dispatcher, feishuApi, config }`。共享 Map 仍挂在 dispatcher 上。

### 4. `permission-handler.js` — PermissionHandler

迁移方法（约 40 行）：
- `_handlePermissionEvent(session, chatId, agentEvent)`
- `_handlePermissionRepliedEvent(session, chatId, agentEvent)`

共享状态：`permissionCardIds` Map（当前在方法内 lazy init 为 `this.permissionCardIds`，已挂在实例上）。

设计：导出 `PermissionHandler` 类，构造接收 `{ dispatcher, feishuApi, sessionService }`。`permissionCardIds` 仍挂在 dispatcher 上（虽然测试没直接访问，但保持现有 lazy init 行为最安全）。

### 5. `message-dispatcher.js` — 主调度骨架（保留）

保留：
- 构造函数（初始化所有共享 Map，实例化 4 个 helper，传 `this`）
- `handleIncomingMessage` / `handleCommand` 主入口
- 所有 `_cmdXxx` 命令处理方法
- 路由锁：`_enqueueRouteLock` / `_withRouteTouch` / `_preflightClear`
- prompt 队列：`_enqueuePrompt`
- watch 管理：`_watchSessionEvents` / `_ensureWatch` / `restoreWatches` / `_stopSessionWatch` / `_handleWatchedSessionEvent` / `_isWatchProgressEvent` / `_updateWatchProgressCard` / `_renderWatchProgressCard`
- 公共 API：`destroy` / `getTurnState` / `cancelTurnBySessionId` / `stopSessionWatch` / `ensureWatchForSession`
- feishu 调用封装：`_sendFeishu` / `_callFeishu` / `_replyCtx`
- session 状态标记：`_markIdleIfActive` / `_markErrorIfActive` / `_isTerminalSession`
- 焦点/去重辅助：`_isFocusSession` / `_rememberDeliveredText` / `_hasDeliveredText`
- session 发现辅助：`_managedOpencodeSessionIds` / `_findSessionByOpencodeId` / `_formatAttachableSessions` / `_formatRouteStatus` / `_formatSessionSummary` / `_chatIdFromRouteKey`

预计主文件保留约 800 行，拆出约 770 行到 4 个 helper。

## 委托模式

helper 通过 `this.dispatcher` 反向访问主类的共享字段和其他方法。例如：

```js
class TurnStateManager {
  constructor({ dispatcher, sessionService, driverRegistry, maxTurnTimeMins }) {
    this.dispatcher = dispatcher;
    // ...
  }
  _startTurnState(...) {
    // 用 this.dispatcher.turnStates 代替 this.turnStates
    // 用 this.dispatcher._callFeishu(...) 调主类方法
  }
}
```

主类构造函数：

```js
constructor(options) {
  // ... 原有字段初始化 ...
  this.turnStateManager = new TurnStateManager({ dispatcher: this, ... });
  this.promptHeartbeat = new PromptHeartbeat({ dispatcher: this, ... });
  this.progressRenderer = new ProgressRenderer({ dispatcher: this, ... });
  this.permissionHandler = new PermissionHandler({ dispatcher: this, ... });
}
```

主类保留同名方法作为薄委托（`_startTurnState(...args) { return this.turnStateManager._startTurnState(...args); }`），保证所有 `this._xxx()` 内部调用无需改动。

## 执行策略

**分 4 个子任务，每个子任务独立提交，每个子任务完成后跑全套回归测试**：

1. **T1**：抽离 `turn-state.js` → 跑测试 → 提交
2. **T2**：抽离 `heartbeat.js` → 跑测试 → 提交
3. **T3**：抽离 `progress-renderer.js` → 跑测试 → 提交
4. **T4**：抽离 `permission-handler.js` → 跑测试 → 提交

每步只动一个职责，blast radius 最小，回归点明确。任一步骤测试失败立即回滚该步。

## 回归测试集

每个子任务完成后必须全部通过：

- `node --test test/message-dispatcher.test.js` (123 tests)
- `node --test test/integration-feishu-tui-sync.test.js`
- `node --test test/integration-hook-routing.test.js`
- `node --test test/opencode-hook-health-poller.test.js`
- `node --test test/progress-card.test.js`

## 非目标

- 不改变任何公开方法签名或行为
- 不优化性能、不修 bug
- 不改变日志格式
- 不重构 `_cmdXxx` 命令处理（它们与主调度耦合紧，留在主文件）
- 不改 `bootstrap.js`（导入路径不变）
