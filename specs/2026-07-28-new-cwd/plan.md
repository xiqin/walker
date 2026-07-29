# /new 支持项目路径实现计划

**目标：** 让飞书 `/new` 命令支持显式 `--cwd <projectPath>` 参数，并把该路径用于底层 agent session 与 Walker session 状态。

**架构：** 复用现有 `parseCommand` 的空白切分结果，不修改通用命令解析器。`MessageDispatcher._cmdNew` 负责解析 `/new` 专属的 `--cwd` 选项、校验缺值、移除选项后继续按原位置参数解析 agent/title。帮助 usage 与静态文档同步更新为兼容语法。

**技术栈：** Node.js CommonJS、`node:test`、现有 Feishu command 与 MessageDispatcher 测试。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | `/new --cwd` 解析与会话创建 | dispatcher / tests | medium | 无 | REQ-001, REQ-002 | REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B04, REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04 | `tasks/T1.md` |
| T2 | 帮助与文档更新 | commands / docs | low | T1 | REQ-003 | REQ-003-B01, REQ-003-B02 | `tasks/T2.md` |

## 依赖关系

T1 → T2

## 文件职责

| 文件 | 变更职责 |
| ---- | -------- |
| `src/dispatch/message-dispatcher.js` | 在 `_cmdNew` 内解析 `--cwd`，缺值时返回错误且阻止创建 session，成功时把解析后的 cwd 传入 driver 与 sessionService。 |
| `test/message-dispatcher.test.js` | 覆盖指定 cwd、默认 cwd 兼容、缺值拒绝和 forbidden behavior。 |
| `src/platform/feishu/commands.js` | 更新 `/new` usage，确保 `/help` 能显示新语法。 |
| `test/feishu-commands.test.js` | 覆盖 `parseCommand` 保持空白 token 传递，以及 `COMMANDS.new.usage` / `formatHelp` 包含 `--cwd <path>`。 |
| `README.md` | 更新命令表中的 `/new` 说明。 |
| `walker-console-v2.html` | 更新管理端调试命令说明。 |

## Traceability 初始映射

planning 阶段已在 `traceability.json` 映射每个需求和 behavior 到负责 task；`tests` 与 `evidence` 在 executing 阶段补齐。

## 验证策略

- 运行 `node C:\Users\tianxiqin\.config\opencode\skills\loom-writing-plans\scripts\validate-plan.mjs --spec-dir specs/2026-07-28-new-cwd` 校验规划产物。
- executing 阶段优先新增失败测试，再实现 `_cmdNew` 行为。
- verification 阶段运行相关测试文件，并视项目脚本可用性运行全量测试或项目默认检查命令。
