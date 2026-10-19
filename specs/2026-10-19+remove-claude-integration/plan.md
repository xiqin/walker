# 移除 Claude 集成 实现计划

**目标：** 从当前运行时、CLI、配置、飞书命令、管理端和测试中删除 Claude 接入，并对精确 `claude` 请求失败关闭。

**架构：** 删除 Claude 专用模块后，在调用 driver 之前用统一错误码 `claude_removed` 拒绝新接入。已有 `agent=claude` 记录只保留本地读取、本地停止和本地删除。OpenCode 与 Codex 的注册和命令路径不改协议。

**技术栈：** Node.js CommonJS、现有 `node:test`、ESLint、`npm run check`。不新增依赖。

统一契约：

- 错误码：`claude_removed`
- 消息：`Claude integration has been removed.`
- 只把精确小写 `claude` 当作已移除接入。
- 不改写用户 `.env`，不删除历史 `specs/`、合规记录和记忆。
- 不调用注入的名为 `claude` 的 driver 来 prompt、resume、watch、question、cancel、stop 或 delete。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | 删除运行时模块并拆除启动接线 | 运行时 | high | 无 | REQ-001, REQ-002, REQ-005, REQ-006, REQ-008 | REQ-001-B01 至 B06, REQ-002-B02, B05, B06, REQ-005-B02, REQ-006-B02, REQ-008-B04 | `tasks/T1.md` |
| T2 | 从 provider 目录移除 Claude | provider | medium | 无 | REQ-002 | REQ-002-B01, B03, B04 | `tasks/T2.md` |
| T3 | 停止解析和编辑 Claude 配置 | 配置 | medium | 无 | REQ-003 | REQ-003-B01 至 B07 | `tasks/T3.md` |
| T4 | 飞书命令和消息失败关闭 | 调度 | high | 无 | REQ-004, REQ-005, REQ-006 | REQ-004-B01 至 B09, REQ-005-B01, B04, B07, REQ-006-B01 | `tasks/T4.md` |
| T5 | Admin 会话本地生命周期与连接页 | 管理端 | medium | 无 | REQ-005, REQ-007 | REQ-005-B01, B03, B05, B06, B07, REQ-007-B01, B03 | `tasks/T5.md` |
| T6 | 更新现行文档和原型 | 文档 | low | 无 | REQ-007 | REQ-007-B01, B02, B03 | `tasks/T6.md` |
| T7 | 全量回归与保护路径证据 | 验证 | medium | T1, T2, T3, T4, T5, T6 | REQ-006, REQ-008 | REQ-006-B03, REQ-008-B01, B02, B03, B04 | `tasks/T7.md` |

## 依赖关系

T1、T2、T3、T4、T5、T6 没有共享写入文件，可以并行。

T7 在上述任务完成后运行全量检查，并确认历史规格和 OpenCode 协议文件未被改写。

## 文件所有权

每个任务的 `owns` 不交叉。专用 Claude 测试随被删模块删除；新的移除行为断言写入拥有该行为的任务所独占的测试文件。未列入 `owns` 的失败测试不得由其他任务顺手修改，必须先调整所有权。

## Traceability 初始映射

同目录 `traceability.json` 覆盖 REQ-001 至 REQ-008 的全部 45 个 behavior。planning 阶段只填 `tasks`，`tests` 与 `evidence` 留空，由 executing 补齐。
