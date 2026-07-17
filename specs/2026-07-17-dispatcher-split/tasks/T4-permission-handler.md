# T4: 抽离 permission-handler.js

## 目标
将权限确认处理从 `message-dispatcher.js` 抽到 `src/dispatch/permission-handler.js`，行为不变。

## 要迁移的方法
- `_handlePermissionEvent(session, chatId, agentEvent)`
- `_handlePermissionRepliedEvent(session, chatId, agentEvent)`

## 共享状态
- `dispatcher.permissionCardIds` (Map，当前 lazy init：`if (!this.permissionCardIds) this.permissionCardIds = new Map();`)

## 实现步骤
1. 新建 `src/dispatch/permission-handler.js`，导出 `PermissionHandler` 类，构造接收 `{ dispatcher, feishuApi, sessionService }`。
2. 迁入两个方法。`this.permissionCardIds` 改为 `this.dispatcher.permissionCardIds`，保持 lazy init 行为（若 dispatcher 上没有则创建）。`this._sendFeishu` / `this._callFeishu` → `this.dispatcher._sendFeishu` / `this.dispatcher._callFeishu`。`this.sessionService` → `this.dispatcher.sessionService` 或注入的 `sessionService`。
3. `require('../platform/feishu/cards')` 的 `buildPermissionCard` / `buildPermissionRepliedCard` 调用保持不变（在 handler 内 require）。
4. 主类构造函数实例化 `this.permissionHandler = new PermissionHandler({ dispatcher: this, feishuApi, sessionService })`。
5. 主类保留薄委托：`_handlePermissionEvent(...args) { return this.permissionHandler.handle(...args); }`、`_handlePermissionRepliedEvent(...args) { return this.permissionHandler.handleReplied(...args); }`。
6. `permissionCardIds` 仍挂在 dispatcher 上（lazy init 行为保持），测试未直接访问但保持位置不变最安全。

## 验收
- 全套回归测试通过
- message-dispatcher.test.js 中 "MessageDispatcher permission handling" 套件（7 tests）全部通过

## 风险（最低）
- 仅 2 个方法，调用点明确（仅 `_handleWatchedSessionEvent` 在 message-dispatcher.js:1350/1354 调用）。
- 没有测试直接访问 `permissionCardIds`，兼容压力最小。
- 仍需保证 `require('../platform/feishu/cards')` 路径在 `src/dispatch/permission-handler.js` 中正确（相对路径 `../platform/feishu/cards` 不变，因为新文件也在 `src/dispatch/` 下）。
