# OpenCode 原生提问同步到飞书实现计划

**目标：** 将 OpenCode 原生 `question` 请求完整同步到飞书，逐题收集答案后通过 TUI bridge protocol v4 一次性回复 `answers: string[][]`，并在并发、失败和本地抢答场景下安全收敛。

**架构：** 新链路按“原生事件契约 → Bridge 控制型 delivery → 插件执行 → Driver 接口 → 飞书卡片 → Dispatcher 状态机”分层实现，保持 permission 链路独立。飞书问题状态集中在新的 `QuestionHandler`，MessageDispatcher 只负责事件和命令路由；跨层接口在任务中固定，最终由端到端测试验证完整数据流。

**技术栈：** Node.js 22、CommonJS、OpenCode SDK、飞书交互卡片、`node:test`、ESLint。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 定义原生 question AgentEvent 契约 | Driver 契约 | 低 | 无 | `tasks/T1.md` |
| T2 | 升级 TUI Bridge protocol v4 | Bridge 核心 | 高 | 无 | `tasks/T2.md` |
| T3 | 插件转发原生事件并执行控制 delivery | OpenCode 插件 | 高 | T1、T2 | `tasks/T3.md` |
| T4 | 增加 Driver 原生 question 回复接口 | Driver 实现 | 中 | T2 | `tasks/T4.md` |
| T5 | 构建原生 question 飞书卡片 | 飞书展示 | 中 | 无 | `tasks/T5.md` |
| T6 | 实现 question 状态机与 Dispatcher 路由 | 业务编排 | 高 | T1、T4、T5 | `tasks/T6.md` |
| T7 | 完成原生 question 端到端回归 | 集成验证 | 高 | T1、T2、T3、T4、T5、T6 | `tasks/T7.md` |

## 依赖关系

```text
T1 ───────┐
           ├─→ T3 ───────────────┐
T2 ───┬───┘                      │
      └─→ T4 ──┐                 │
T5 ────────────┼─→ T6 ──────────┼─→ T7
T1 ────────────┘                 │
T2、T4、T5 ──────────────────────┘
```

首批可并行执行 T1、T2、T5；随后 T3 与 T4 可并行；T6 在 T1、T4、T5 完成后执行；T7 在所有实现任务完成后执行。

## 固定接口

- AgentEvent 新增 `question_asked`、`question_replied`、`question_rejected`，字段与 `spec.md` 第 3.1 至 3.3 节一致。
- Bridge 对外提供 `replyQuestion(sessionRef, requestID, answers)`，仅向 protocol v4 runtime 入队 `{ type: 'question_reply', requestID, answers }`。
- Bridge 所有 question reply 失败均以带 `code`、`deliveryPhase`、`sdkInvoked`、`safeToRetry` 属性的 `Error` 拒绝 Promise；Driver 不得丢失这些属性。
- Driver 对外提供 `replyQuestion(agentRef, requestID, answers)`；现有 `replyPermission(agentRef, permissionID, answer, always)` 不改变。
- 插件注册 `bridgeProtocolVersion: 4`，poll 使用 `acceptedTypes`；`question_reply` 只调用 `api.client.question.reply({ requestID, answers })`。
- 飞书卡片新增 `buildNativeQuestionCard(options)` 与 `buildNativeQuestionStatusCard(options)`，不复用旧 permission-question 卡片语义。
- `buildNativeQuestionCard` 接收 `requestID`、`questionIndex`、`questionCount`、`question`、`walkerSessionId`、`routeKey`，生成 `question_selected`、`question_custom` 及 `/answer` 表单动作。
- `buildNativeQuestionStatusCard` 接收请求及题目上下文、`status`、`answers`、`retryable`，生成处理中、已处理、已取消、结果待确认、降级、过期和重试状态卡片。
- 新建 `QuestionHandler` 独占原生 question 请求状态；内部唯一键为 `agentRef + requestID`，MessageDispatcher 不再把 question 事件交给 PermissionHandler。
- `/answer` 不使用 MessageDispatcher 的通用消息去重，由 QuestionHandler 根据请求状态、卡片 messageId 和提交权处理重复及并发回调。

## 实施约束

- 当前工作树在多个目标文件中已有未提交改动。执行者必须读取并适配现状，只修改任务 `owns` 声明的文件，不得回滚、覆盖或清理其他改动。
- 不增加旧 `{ questionId, answer }` 到新 `{ requestID, answers }` 的兼容层，不把 `question_reply` 降级为普通 prompt。
- 本次原生 question 事件和回复通道仅覆盖生成插件与 TUI Bridge transport；OpenCode SSE transport 的 question 事件映射和回复能力不在本次范围。
- QuestionHandler 每题最多直接调用底层 `feishuApi.replyCard` 2 次；不得使用会自动尝试 3 次的通用发送封装来实现该上限。卡片 patch 可继续使用现有封装。
- 新增或修改函数按项目规则提供简洁中文注释，并保持 CommonJS 风格。
- 各任务先运行所属测试；T7 完成后运行完整 `npm test`。

## 最终验证

- `node --test test/agent-driver-schema.test.js test/opencode-tui-bridge.test.js test/opencode-hook-installer.test.js test/opencode-driver.test.js test/feishu-cards.test.js test/feishu-commands.test.js test/question-handler.test.js test/message-dispatcher.test.js test/permission-handler.test.js test/integration-feishu-question.test.js`
- `npm test`
