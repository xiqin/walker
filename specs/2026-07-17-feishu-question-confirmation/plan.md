# 飞书交互式问题确认 实现计划

**目标：** 让 opencode 交互式 TUI 中的多选/确认/单选/自由文本问题通知到飞书卡片，用户在飞书内完成选择后回传给 Agent 继续执行。

**架构：** 复用底层 `permission` 事件通道承载交互式 question（通过 `data.type='question'` 区分），新增 `/answer` 命令、TUI bridge `replyQuestion` delivery、`buildQuestionCard` 卡片渲染、`questionReplyStates` 3 态机（pending/submitting/replied，失败回滚 pending，含 inputMode/required），与传统 `/permit allow|deny` 权限确认分离。TUI bridge 回复 delivery 复用现有 prompt 的 lease/heartbeat/final 可靠性模型。

**技术栈：** Node.js (CommonJS)、`@larksuiteoapi/node-sdk`、`node:test` + `assert`、`eslint`、`node --check` 语法检查。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 扩展 AgentEvent schema 支持 question metadata 和 string[] response | 数据 | 低 | 无 | `tasks/T1.md` |
| T2 | OpencodeTuiBridge 新增 replyQuestion delivery | 基础设施 | 高 | 无 | `tasks/T2.md` |
| T3 | OpencodeDriver.replyPermission 对 TUI bridge 转发 | Driver | 中 | T2 | `tasks/T3.md` |
| T4 | 新增 buildQuestionCard 和 buildQuestionRepliedCard | 卡片渲染 | 高 | 无 | `tasks/T4.md` |
| T5 | formValue 全链路传递（platform.js + bootstrap.js） | 事件传递 | 低 | 无 | `tasks/T5.md` |
| T6 | commands.js 新增 answer 条目 | 命令 | 低 | 无 | `tasks/T6.md` |
| T7 | Dispatcher + PermissionHandler question 分发与回复全链路 | 分发+渲染 | 高 | T1, T2, T3, T4, T5, T6 | `tasks/T7.md` |
| T8 | 端到端集成测试与向后兼容验证 | 集成 | 高 | T1-T7 | `tasks/T8.md` |

## 依赖关系

```
T1 (schema) ──┐
T2 (bridge) ──┼── T3 (driver) ──┐
T4 (cards) ───┤                ├── T7 (dispatcher+handler) ── T8 (e2e)
T5 (formValue)┤                │
T6 (commands) ┘                │
                               └───────────────────────────┘
```

**并行边界：** T1、T2、T4、T5、T6 互不冲突（owns 集合无交集），可并行执行。T3 依赖 T2。T7 依赖 T1-T6 全部，合并了 dispatcher 分发和 PermissionHandler 渲染（避免中间态 TypeError 循环依赖）。T8 依赖全部。

**串行边界：** T7 → T8 必须串行，因为 T7 定义 questionReplyStates 4 态机（含 inputMode/required）和 _cmdAnswer 的接口契约，T8 验证全链路。

## 关键接口契约

- `questionReplyStates: Map<string, { state, answer, repliedAt, inputMode, required }>` — 3 态机（pending/submitting/replied）在 `_handlePermissionEvent` 分发时初始化，`_cmdAnswer` 和 `handleQuestionReplied` 都从中反查 inputMode/required。失败回滚 pending（spec 规则 8），不保留 failed 终态。
- `buildQuestionRepliedCard(questionId, answer)` — 2 参数，T4 定义，T7 调用时传 2 参数（inputMode 在 replied 卡片无展示用途）。
- `permissionCardIds` 继续用于 id→cardId 映射，question 和 permission 共用（spec §4.2）。
