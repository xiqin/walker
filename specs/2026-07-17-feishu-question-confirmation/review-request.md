# 代码审查请求

**功能：** 飞书交互式问题确认（多选/确认/自由文本）
**分支：** main（未创建独立分支）

## 变更统计

```
 src/app/bootstrap.js               |   1 +
 src/dispatch/message-dispatcher.js |  88 +++++++++++
 src/dispatch/permission-handler.js |  41 ++++-
 src/drivers/agent-driver.js        |   3 +-
 src/drivers/opencode-driver.js     |   7 +-
 src/opencode-tui-bridge/bridge.js  |  38 +++++
 src/platform/feishu/cards.js       |  91 +++++++++++
 src/platform/feishu/commands.js    |   1 +
 src/platform/feishu/platform.js    |   1 +
 test/bootstrap.test.js             |  48 ++++++
 test/feishu-cards.test.js          | 134 +++++++++++++++++
 test/feishu-commands.test.js       |  35 +++++
 test/feishu-platform.test.js       |  21 +++
 test/message-dispatcher.test.js    | 301 +++++++++++++++++++++++++++++
 test/opencode-driver.test.js       |  62 ++++++++
 test/opencode-tui-bridge.test.js   | 188 +++++++++++++++++++++
16 files changed, 1056 insertions(+), 4 deletions(-)
```

## 主要变更

1. **AgentEvent schema 扩展**：`permission_replied.response` 类型从 `string` 扩展为 `string|string[]`，metadata 注释补充 `inputMode`/`options`/`required`
2. **TUI bridge replyQuestion**：新增 `DELIVERY_TYPE_QUESTION_REPLY` 常量和 `replyQuestion(sessionRef, questionId, answer)` 方法，复用 pending/lease/tombstone 机制
3. **OpencodeDriver TUI bridge 转发**：`replyPermission` 对 TUI bridge transport 从抛错改为转发到 `tuiBridge.replyQuestion`
4. **飞书 Question 卡片**：`buildQuestionCard` 支持 4 种 inputMode（confirm/single_select/multi_select/text）+ 未知降级 + 缺 options 错误态；`buildQuestionRepliedCard` 格式化 string/string[] 回答
5. **formValue 全链路传递**：`_handleCardAction` 和 `onCardAction` 传递 `formValue`
6. **/answer 命令**：commands.js 新增 `answer` 条目，`parseCommand` 识别 `/answer <id> <value>` 和 `/answer <id> --form`
7. **全链路分发**：`_cmdAnswer` 处理 4 种模式 + required 校验 + 幂等保护 + HTTP/TUI patch 策略区分 + 失败回滚；`_handlePermissionEvent` 对 `data.type=question` 走 question 分支；`_handlePermissionRepliedEvent` 按 `questionReplyStates` 有无分发
8. **PermissionHandler**：`handleQuestion`/`handleQuestionReplied` 分别用 `buildQuestionCard`/`buildQuestionRepliedCard`

## 自测情况

- [x] lint 通过（0 error）
- [x] 测试通过（1004/1004）
- [x] 代码符合编码红线
- [x] 图后端已跳过（未启用 graph sync）

## 变更详情

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/drivers/agent-driver.js` | 修改 | response schema `string` → `string|string[]`；metadata 注释补充 |
| `src/opencode-tui-bridge/bridge.js` | 修改 | 新增 `DELIVERY_TYPE_QUESTION_REPLY` + `replyQuestion` 方法 |
| `src/drivers/opencode-driver.js` | 修改 | TUI bridge 转发 `replyQuestion` 而非抛错 |
| `src/platform/feishu/cards.js` | 修改 | 新增 `buildQuestionCard` + `buildQuestionRepliedCard` |
| `src/platform/feishu/commands.js` | 修改 | 新增 `answer` 命令条目 |
| `src/platform/feishu/platform.js` | 修改 | `_handleCardAction` 传递 `formValue` |
| `src/app/bootstrap.js` | 修改 | `onCardAction` 传递 `formValue` |
| `src/dispatch/message-dispatcher.js` | 修改 | `questionReplyStates` 3 态机 + `_cmdAnswer` + question 分发分支 |
| `src/dispatch/permission-handler.js` | 修改 | `handleQuestion`/`handleQuestionReplied` |
| `test/agent-driver-schema.test.js` | 新增 | 7 个 schema 测试 |
| `test/opencode-tui-bridge.test.js` | 修改 | 8 个 replyQuestion 测试 |
| `test/opencode-driver.test.js` | 修改 | 4 个 TUI bridge 转发测试 |
| `test/feishu-cards.test.js` | 修改 | 10 个 question 卡片测试 |
| `test/feishu-commands.test.js` | 修改 | 5 个 answer 命令测试 |
| `test/bootstrap.test.js` | 修改 | 1 个 formValue 传递测试 |
| `test/feishu-platform.test.js` | 修改 | 1 个 formValue 传递测试 |
| `test/message-dispatcher.test.js` | 修改 | 14 个 _cmdAnswer + 4 个分发 + 2 个状态机测试 |
| `test/permission-handler.test.js` | 新增 | 8 个 PermissionHandler 单元测试 |
| `test/integration-feishu-question.test.js` | 新增 | 33 个集成测试覆盖全部 13 REQ |

## 审查重点

- [ ] question 与 permission 路由隔离：`data.type=question` 分支是否与传统 permission 完全分离
- [ ] `_cmdAnswer` 幂等保护：replied/submitting 状态拒绝 + 失败回滚 pending
- [ ] HTTP/TUI patch 策略区分：HTTP 直接 patch，TUI bridge 等 `permission_replied` 事件驱动
- [ ] `questionReplyStates` 生命周期：是否随 session 销毁清理，避免内存泄漏
- [ ] 飞书卡片 `multi_select_static`/`input` 组件实际渲染效果（需卡片预览工具验证）

## 预审查

### Standards

- `_cmdAnswer` 中 `required` 判断 `stateEntry.required !== false` 在 `stateEntry` 为 null 时回退 `true`，逻辑合理
- `buildQuestionCard` 缺少 `options.value` 非空校验（spec 规则 3），由 dispatcher `_cmdAnswer` 的 required 校验兜底
- `replyQuestion` 的 `answer: answer !== undefined && answer !== null ? answer : ''` 保持 string[] 类型不被拍平，与 spec 一致
- 所有新增方法有 JSDoc 注释，符合 constitution 规则 5
- 代码遵循现有分层：cards→commands→platform→bootstrap→dispatcher→handler，未引入额外架构层

### Spec

- REQ-001~013 全部在集成测试中有对应用例覆盖
- `permission_replied.response` 类型 `string|string[]` 已扩展
- `buildQuestionRepliedCard` 2 参数（questionId, answer）与 plan 一致
- 传统 permission 路径不受影响（`/permit` 仅接受 allow/deny，`handleReplied` 仍用 `buildPermissionRepliedCard`）
- 飞书卡片 header template 区分：question 用 `blue`，permission 用 `red`，replied 用 `green`

### 预审查摘要

- Standards findings: 1，worst: 建议（options.value 非空校验由 dispatcher 兜底，卡片层未单独校验）
- Spec findings: 0，worst: none
