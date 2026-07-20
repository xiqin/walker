# 代码审查请求

**功能：** OpenCode 原生 question 同步飞书交互卡片（完整原生映射）
**分支：** 工作树未提交（fixed point = HEAD）
**spec 来源：** `specs/2026-07-16-sse-events-forwarding/spec.md`

## 变更统计

本次 spec owns 范围（18 个文件，1859 insertions / 34 deletions）：

| 文件 | 变更 |
|---|---|
| src/dispatch/message-dispatcher.js | +25 -? |
| src/dispatch/permission-handler.js | -6 |
| src/dispatch/question-handler.js | 新增（untracked） |
| src/drivers/agent-driver.js | +27 |
| src/drivers/opencode-driver.js | +34 |
| src/opencode-hook/plugin-template.js | +170 |
| src/opencode-tui-bridge/bridge.js | +182 |
| src/platform/feishu/cards.js | +196 |
| src/platform/feishu/commands.js | +1 |
| test/agent-driver-schema.test.js | 新增 |
| test/feishu-cards.test.js | +279 |
| test/feishu-commands.test.js | +33 |
| test/integration-feishu-question.test.js | 新增 |
| test/message-dispatcher.test.js | +33 |
| test/opencode-driver.test.js | +157 |
| test/opencode-hook-installer.test.js | +396 |
| test/opencode-tui-bridge.test.js | +354 |
| test/permission-handler.test.js | 新增 |
| test/question-handler.test.js | 新增 |

## 主要变更

1. 新增独立原生 question AgentEvent（`question_asked`/`question_replied`/`question_rejected`）和 schema 元数据，不再复用 permission 事件。
2. Bridge 升级 protocol v4：`replyQuestion(sessionRef, requestID, answers)`、`acceptedTypes` 保序 poll、控制 delivery 主动 accepted 超时收敛、accepted 幂等、结构化四属性 Error。
3. OpenCode 插件升级版本 9 / protocol 4：转发三类原生事件，父/控制 delivery 分离，`awaitingAccepted→executingSdk→finalizing` 状态机，accepted 后才调 `api.client.question.reply`。
4. Driver 新增独立 `replyQuestion(agentRef, requestID, answers)`，Bridge 四属性错误无损透传，`replyPermission` 不变。
5. 飞书卡片新增 `buildNativeQuestionCard` / `buildNativeQuestionStatusCard`，支持 `question_selected`/`question_custom`、稳定 `option_N`、`--form`/`--retry`。
6. 新建 `QuestionHandler` 独占原生 question 状态机：多题逐题收集、整组一次提交、终态竞态收敛、24h/1000 有界保留、每题最多 2 次底层发送。
7. `MessageDispatcher` 路由三类 question 事件，`/answer` 绕过通用 dedup；`PermissionHandler` 移除旧 question 复用。
8. 集成测试重写为真实 `FeishuPlatform._handleCardAction → parseCardAction → onCardAction → parseCommand → Dispatcher → QuestionHandler → Driver → Bridge → 插件 → SDK question.reply` 全链路。

## 重点关注

1. **架构设计**：原生 question 与 permission 完全分离，无兼容层；Bridge protocol v4 门禁确保旧 runtime 不入队 `question_reply`；QuestionHandler 状态键 `agentRef + requestID`。
2. **并发安全**：父 prompt leased 且 session busy 时控制 delivery 并行；同 session 最多一个控制 delivery；accepted 超时主动收敛；终态竞态"最先明确终态生效，不可反转"。
3. **失败收敛**：retryable（`safeToRetry:true && sdkInvoked:false`）才回 collecting；SDK 已调用或结果不明进 `processed_unknown` 禁止重放；request not found 不重试。
4. **SDK 兼容性**：生成插件在调用 `api.client.question.reply` 前做运行时能力探测；缺失时以结构化 `QUESTION_REPLY_UNSUPPORTED` 安全降级。

## 自测情况

- [x] 编译通过（`node --check` 对 9 个源文件全部通过）
- [x] 静态分析通过（`npx eslint` 对 9 个源文件无错误）
- [x] 测试通过（`npm test` 995/995 PASS；集成 6/6；spec 18/18 REQ 覆盖）
- [x] 代码符合编码红线（预审查注释建议已处理并验证）
- [x] 图后端索引查询跳过（未启用图后端）

## 已知风险（不阻断）

无。此前旧 plugin-template 断言与 Bridge pending/cancelled 测试信号已修复；最新 `npm test` 为 995/995 PASS、fail 0、cancelled 0。

## 变更详情

| 文件 | 变更类型 | 说明 |
|---|---|---|
| src/drivers/agent-driver.js | 修改 | 新增三类 question 事件常量和 DATA_SCHEMAS |
| src/opencode-tui-bridge/bridge.js | 修改 | protocol v4 队列、控制 delivery 生命周期、accepted 超时、结构化错误 |
| src/opencode-hook/plugin-template.js | 修改 | 插件 v9/protocol4，事件转发，父/控制 delivery 分离，SDK question.reply 能力探测 |
| src/drivers/opencode-driver.js | 修改 | 新增 replyQuestion，Bridge 错误透传，replyPermission 不变 |
| src/dispatch/question-handler.js | 新增 | 原生 question 状态机、卡片发送、答案收集、终态收敛、有界保留 |
| src/dispatch/message-dispatcher.js | 修改 | 路由三类 question 事件，/answer 跳过 dedup |
| src/dispatch/permission-handler.js | 修改 | 移除旧 question 复用 |
| src/platform/feishu/cards.js | 修改 | 新增 buildNativeQuestionCard / buildNativeQuestionStatusCard |
| src/platform/feishu/commands.js | 修改 | /answer 帮助改为 questionKey --form|--retry |

## 审查重点

- [ ] 架构合规性（question/permission 分离，protocol v4 门禁）
- [ ] 代码质量（新增公共方法中文注释、状态机可读性）
- [ ] 并发安全（父/控制 delivery 隔离、终态竞态）
- [ ] 失败收敛（retryable/processed_unknown 分类）
- [ ] 性能影响（24h TTL、1000 容量、每题 2 次发送上限）

## 验证证据

- `specs/2026-07-16-sse-events-forwarding/test-report.md`（verdict PASS，18/18 REQ）
- `specs/2026-07-16-sse-events-forwarding/verify-report.md`（verdict PASS）
- `specs/2026-07-16-sse-events-forwarding/evidence/test.log`（SHA-256 `362b734f...`）
- `specs/2026-07-16-sse-events-forwarding/evidence/verification.log`（SHA-256 `f780877a...`）
