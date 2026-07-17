# T2: 抽离 heartbeat.js

## 目标
将 prompt 心跳机制从 `message-dispatcher.js` 抽到 `src/dispatch/heartbeat.js`，行为不变。

## 要迁移的方法
- `_startPromptHeartbeat(session, progressCardId)` → 返回 stop 函数
- `_stopPromptHeartbeat(sessionId)`
- `_formatDuration(ms)`

## 共享状态（保留在 dispatcher 实例上）
- `dispatcher.promptHeartbeatStops` (Map)
- `dispatcher.promptHeartbeatInitialMs` / `promptHeartbeatIntervalMs` / `promptHeartbeatStuckMs`
- `dispatcher.progressStyle`
- `dispatcher.sessionWatchStops`（间接，通过 dispatcher 访问）

## 实现步骤
1. 新建 `src/dispatch/heartbeat.js`，导出 `PromptHeartbeat` 类，构造接收 `{ dispatcher, feishuApi, initialMs, intervalMs, stuckMs, progressStyle }`。
2. 迁入方法，方法体内 `this.promptHeartbeatStops` → `this.dispatcher.promptHeartbeatStops`，`this.progressStyle` → `this.dispatcher.progressStyle`，`this._isTerminalSession(...)` → `this.dispatcher._isTerminalSession(...)`，`this._sendFeishu(...)` → `this.dispatcher._sendFeishu(...)`，`this._formatDuration` 可内化到 manager（无外部依赖）。
3. 主类构造函数实例化 `this.promptHeartbeat = new PromptHeartbeat({ dispatcher: this, feishuApi: this.feishuApi, initialMs, intervalMs, stuckMs, progressStyle })`。
4. 主类保留薄委托：`_startPromptHeartbeat(...args) { return this.promptHeartbeat.start(...args); }`、`_stopPromptHeartbeat(id) { return this.promptHeartbeat.stop(id); }`。
5. `_formatDuration` 仅被心跳内部使用，迁入 manager 即可，主类无需保留委托（除非有外部调用——需 grep 确认无外部引用后才能移除主类方法）。

## 验收
- 全套回归测试通过（同 T1）
- `dispatcher.promptHeartbeatStops` 仍可直接访问（虽测试未直接访问，但保持字段位置不变最安全）

## 风险
- `_formatDuration` 是否被其他方法调用？需 grep 确认。若仅心跳用，直接迁走；若被外部用，主类保留委托。
- `_isTerminalSession` 是主类方法，心跳通过 `this.dispatcher._isTerminalSession` 调用，保证主类该方法仍在。
