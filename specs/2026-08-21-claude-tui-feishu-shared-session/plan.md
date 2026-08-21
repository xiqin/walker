# Claude TUI 与飞书共享会话实现计划

**目标：** 让由 Walker 托管启动的 Claude TUI 与飞书同时操作同一个 Claude runtime，并以真实 `tool_result` 确认飞书问题答案，同时保持 OpenCode 现有能力不回归。

**架构：** 本计划采用串行分层实现：先固化 Claude runtime 归属与 attach 能力，再实现 Claude driver 的可写判断和输入序列，再补齐 hook/transcript 问题事件，随后在 dispatch/question 层建立 route 绑定、状态机、ACK 与只读降级，最后用 OpenCode 回归与跨模块验收保护兼容性。外部裸 Claude 只保留 transcript 观察，不允许飞书写入或 `--resume` 伪装成功。

**技术栈：** Node.js、Claude PTY broker、Claude bridge sidecar、Claude transcript watcher、Feishu card APIs、`node --test`、loom traceability。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | Claude 托管 runtime 与本地 attach 基座 | driver/runtime | high | 无 | REQ-001, REQ-002 | REQ-001-B01..B06, REQ-002-B01..B06 | `tasks/T1.md` |
| T2 | Claude driver 问题答案写入与输入仲裁 | driver/input | high | T1 | REQ-001, REQ-005, REQ-007 | REQ-001-B03, REQ-005-B01, REQ-005-B04..B06, REQ-007-B01, REQ-007-B02, REQ-007-B05 | `tasks/T2.md` |
| T3 | AskUserQuestion hook/transcript 捕获与 tool_result 归一化 | driver/events | medium | T1 | REQ-004, REQ-006, REQ-010 | REQ-004-B01..B05, REQ-006-B01, REQ-006-B03, REQ-010-B01 | `tasks/T3.md` |
| T4 | 飞书 route 绑定、问题状态机与只读降级 | dispatch/state | high | T1, T2, T3 | REQ-003, REQ-005, REQ-006, REQ-007, REQ-009, REQ-010 | REQ-003-B01..B05, REQ-005-B02, REQ-005-B03, REQ-006-B02, REQ-006-B04, REQ-006-B05, REQ-007-B03, REQ-007-B04, REQ-009-B01..B03, REQ-010-B02..B05 | `tasks/T4.md` |
| T5 | OpenCode 不回归保护 | compatibility | medium | T4 | REQ-008 | REQ-008-B01..B04 | `tasks/T5.md` |
| T6 | 端到端验收、traceability 证据与索引同步 | verification | medium | T1, T2, T3, T4, T5 | REQ-001..REQ-010 | 关键集成路径与全部回归命令 | `tasks/T6.md` |

## 依赖关系

T1 → T2 → T4 → T5 → T6

T1 → T3 → T4


## 实施边界

- T1 和 T2 只改 Claude runtime/driver 层，不接触 OpenCode bridge。
- T3 只负责把 Claude hook/transcript 事件归一化，不负责飞书卡片状态。
- T4 是唯一修改 `MessageDispatcher` 与 `QuestionHandler` 的任务，用于集中处理 route、卡片、状态机、只读降级与日志。
- T5 只做 OpenCode 兼容测试和必要的非侵入修复，不把 OpenCode agentRef 改造成 Claude 结构。
- T6 不新增业务行为，只补齐验证报告、traceability evidence 和索引同步。

## Traceability 初始映射

planning 阶段已在 `traceability.json` 中为每个 `REQ-xxx` 与每个 `REQ-xxx-Bnn` 填写负责 task。`tests` 与 `evidence` 在 executing/verification 阶段补齐真实文件引用。

## 验证策略

- Driver 层：`node --test "test/claude-pty-broker.test.js" "test/claude-bridge-sidecar.test.js" "test/claude-driver.test.js"`
- Event 层：`node --test "test/claude-transcript.test.js" "test/claude-tool-parity.integration.test.js"`
- Dispatch 层：`node --test "test/question-handler.test.js" "test/integration-feishu-tui-sync.test.js" "test/message-dispatcher.test.js"`
- OpenCode 回归：`node --test "test/progress-card.test.js" "test/integration-feishu-tui-sync.test.js" "test/message-dispatcher.test.js"`
- 计划/账本：`loom_validate_plan`、`loom_converge`、`loom_verify_artifacts`。
