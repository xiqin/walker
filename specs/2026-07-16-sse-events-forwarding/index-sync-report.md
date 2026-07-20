# 索引同步报告

**功能：** OpenCode 原生 question 飞书同步（完整原生映射）
**分支：** 工作树未提交（HEAD 基线）
**阶段：** synced

## 变更范围

本次 spec owns 9 个源文件 + 9 个测试文件（18 文件 / +1859 / -34）：

| 文件 | 变更类型 |
| --- | --- |
| src/drivers/agent-driver.js | 修改：新增 question_asked/replied/rejected 常量与 schema |
| src/opencode-tui-bridge/bridge.js | 修改：protocol v4、replyQuestion、acceptedTypes、控制 delivery、accepted 超时、结构化错误 |
| src/opencode-hook/plugin-template.js | 修改：版本 9、protocol 4、原生 question 事件转发、父/控制 delivery 分离、SDK question.reply 能力探测与安全降级 |
| src/drivers/opencode-driver.js | 修改：新增 replyQuestion(agentRef, requestID, answers) |
| src/dispatch/question-handler.js | 新增：原生 question 状态机与卡片回调校验 |
| src/dispatch/message-dispatcher.js | 修改：独立路由 question 事件，/answer 跳过通用 dedup |
| src/dispatch/permission-handler.js | 修改：移除原生 question 复用，仅保留 permission |
| src/platform/feishu/cards.js | 修改：新增 buildNativeQuestionCard/buildNativeQuestionStatusCard；旧 question 预览卡片隔离为 preview 动作 |
| src/platform/feishu/commands.js | 修改：/answer 帮助更新为 questionKey --form|--retry |
| test/agent-driver-schema.test.js | 新增：question 事件 schema 契约测试 |
| test/opencode-tui-bridge.test.js | 修改：v4 队列、accepted 超时、控制 delivery、结构化错误测试 |
| test/opencode-hook-installer.test.js | 修改：插件 v4、原生事件转发、控制 delivery、SDK 失败和 SDK 缺失降级测试 |
| test/opencode-driver.test.js | 修改：replyQuestion 与 permission 回归测试 |
| test/question-handler.test.js | 新增：状态机、并发、终态竞态、容量淘汰测试 |
| test/message-dispatcher.test.js | 修改：question 事件路由、/answer dedup 测试 |
| test/permission-handler.test.js | 修改：permission 独立回归测试 |
| test/feishu-cards.test.js | 修改：原生 question 卡片 builder 测试 |
| test/feishu-commands.test.js | 修改：/answer 新协议解析测试 |
| test/integration-feishu-question.test.js | 新增：跨层端到端集成测试 6/6 |

工作树前序脏改动（admin/card-preview.js、bootstrap.js、platform.js、admin-tools.test.js、bootstrap.test.js、feishu-platform.test.js）与旧 spec `specs/2026-07-17-feishu-question-confirmation/` 不在本次 owns 范围，未纳入同步。

## 图后端同步

- 后端：codegraph（`.loom/graph.config.json`）
- `loom index --check`：Index is up to date（108 files / 1,208 nodes / 7,077 edges）
- `loom index`：Already up to date / Done
- 本次新增/修改的 9 个源文件均已由 file watcher 同步入索引；无需额外手动重建

## 结构化记忆

通过 `loom memory add` 写入 `.loom/memory/store.json`：

- `[fef1a65d]` 类型=决策：原生 question 飞书映射架构（独立事件、protocol v4、控制 delivery、accepted 超时、retryable/processed_unknown 分类、24h/1000 有界保留）
- `[2d6702f0]` 类型=踩坑：node:test 父套件 pending Promise 被标记 cancelledByParent 导致子测试假失败；独立运行可确认子测试本身通过

`loom memory export` 已刷新 `.loom/memory/MEMORY.md` 只读视图。

## 入口文件

本次未引入新约定、新命令、入口程序变化或开发流程调整，不更新入口文件。

## 验证状态

- `npm test`：995/995 PASS，fail 0，cancelled 0
- 插件 SDK 能力探测：`test/opencode-hook-installer.test.js` 40/40 PASS
- `test-report.md`、`verify-report.md` 已刷新为最新全绿证据

## 完成状态

- 图后端：已同步（codegraph fresh）
- 记忆：已写入 2 条并导出
- 入口文件：无需更新
- 阶段产物：`specs/2026-07-16-sse-events-forwarding/index-sync-report.md`
