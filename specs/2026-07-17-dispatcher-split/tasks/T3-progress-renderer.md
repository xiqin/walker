# T3: 抽离 progress-renderer.js

## 目标
将进度卡片渲染和模型辅助方法从 `message-dispatcher.js` 抽到 `src/dispatch/progress-renderer.js`，行为不变。

## 要迁移的方法

### 渲染相关
- `_renderEvents(session, event, events, progressCardId)` (async)
- `_renderCardProgress(session, event, displayEvents, progressCardId)` (async)
- `_renderLegacyProgress(session, event, displayEvents)` (async)
- `_coalesceDisplayEvents(events, promptText)`
- `_pushDisplayEvent(displayEvents, agentEvent)`
- `_stripPromptEcho(text, promptText)`
- `_collapseNumberedSnapshots(text)`
- `_pushTextSnapshot(snapshots, nextText)`
- `_textFromDisplayEvents(displayEvents)`

### 模型辅助（被渲染和命令共用，需谨慎）
- `_appendModelFooter(text, session)`
- `_formatModel(model)`
- `_resolveSessionModel(session)`
- `_resolveInheritedModel(current)`
- `_normalizeDefaultModel()`
- `_resolveModelRef(input, models)`
- `_formatModelListText(models)`

## 共享状态（保留在 dispatcher 实例上）
- `dispatcher.progressStyle`
- `dispatcher.doneEmoji`
- `dispatcher.sessionDeliveredTexts` (Map)
- `dispatcher.sessionWatchBuffers` / `sessionWatchProgressCards` / `sessionWatchProgressPromises` (Map，被 watch 事件路径的渲染用到)
- `dispatcher.turnStates`（_touchTurnState 调用）
- `dispatcher.nonFocusOutput`
- `dispatcher.defaultModel`

## 实现步骤
1. 新建 `src/dispatch/progress-renderer.js`，导出 `ProgressRenderer` 类，构造接收 `{ dispatcher, feishuApi, config }`，config 含 progressStyle/doneEmoji/nonFocusOutput/defaultModel。
2. 迁入渲染方法，所有共享状态通过 `this.dispatcher.xxx` 访问，调用主类方法用 `this.dispatcher._method(...)`（如 `_callFeishu`、`_sendFeishu`、`_rememberDeliveredText`、`_touchTurnState`、`_isTurnSuppressed`、`_isFocusSession`、`_hasDeliveredText`、`_appendModelFooter` 等）。
3. **模型辅助方法**：`_resolveSessionModel` / `_resolveInheritedModel` / `_normalizeDefaultModel` / `_resolveModelRef` / `_formatModelListText` / `_formatModel` / `_appendModelFooter` 被 `_cmdModel` / `_cmdNew` / `_cmdAttach` 等命令处理也用到。两个选择：
   - **方案 A（推荐）**：模型辅助方法迁入 `ProgressRenderer`，主类保留薄委托，命令处理通过 `this.progressRenderer._resolveSessionModel(...)` 调用，或主类保留同名委托转发。
   - **方案 B**：模型辅助方法单独抽到 `model-helper.js`。但这会增加一个文件，与 5 文件目标偏离。
   采用方案 A：模型辅助迁入 renderer，主类保留薄委托（`_resolveSessionModel(...args) { return this.progressRenderer._resolveSessionModel(...args); }` 等），命令处理代码无需改动。
4. 主类构造函数实例化 `this.progressRenderer = new ProgressRenderer({ dispatcher: this, feishuApi, config })`。
5. 主类保留所有被外部（命令处理、watch 事件处理）调用的方法的薄委托。

## 验收
- 全套回归测试通过
- `dispatcher.sessionWatchProgressCards` 仍可直接访问（message-dispatcher.test.js:1396 断言 `.has(session.id)`）
- 所有 `_cmdModel` / `_cmdNew` / `_cmdAttach` 中的 `this._resolveSessionModel` / `this._resolveInheritedModel` / `this._resolveModelRef` / `this._formatModelListText` 调用仍有效

## 风险（最高）
- 模型辅助方法被渲染和命令两条路径共用，迁移后必须保证两条路径都能访问。方案 A 通过主类薄委托解决。
- `_renderCardProgress` 调用 `this._touchTurnState(this.turnStates.get(session.id))`，迁移后改为 `this.dispatcher._touchTurnState(this.dispatcher.turnStates.get(session.id))`，必须保持。
- `_renderEvents` 调用 `this._isTurnSuppressed`、`this._rememberDeliveredText`、`this._appendModelFooter`、`this._textFromDisplayEvents`，迁移后全部改为 `this.dispatcher._xxx`。
- 这是最大的子任务（约 180 行），需格外小心委托方法的完整性。
