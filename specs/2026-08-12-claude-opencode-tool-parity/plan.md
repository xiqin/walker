# Claude 工具接入向 OpenCode 对齐实现计划

**目标：** 在不改变 Claude 长期 TUI、sidecar 和单进程架构的前提下，补齐启动配置、结构化事件、真实能力诊断与集中配置管理。

**架构：** 先扩展向后兼容的 `AgentEvent` 工具生命周期契约和 Claude transcript 解析，再统一 ClaudeDriver 与 PTY broker 的启动参数和失败原子性；配置层、bootstrap、provider catalog 与管理配置并行完成。最后使用独立集成测试验证 sidecar 重连、输入仲裁、历史会话、敏感信息保护以及 OpenCode 零语义回归。

**技术栈：** Node.js、node-pty、JSONL transcript watcher、现有 provider/admin 配置系统、Node 内置测试框架。

---

## 固定配置契约

新增环境变量采用现有 `CLAUDE_*` 命名：

| 环境变量 | Driver 字段 | 类型 |
| -------- | ----------- | ---- |
| `CLAUDE_TOOLS` | `tools` | 可区分未配置与显式空集合的字符串列表 |
| `CLAUDE_AGENTS` | `agents` | JSON object |
| `CLAUDE_MCP_CONFIGS` | `mcpConfigs` | 路径或 JSON 列表 |
| `CLAUDE_STRICT_MCP_CONFIG` | `strictMcpConfig` | boolean |
| `CLAUDE_SETTINGS_FILE` | `settingsFile` | 文件路径或内联 JSON |
| `CLAUDE_SETTING_SOURCES` | `settingSources` | `user,project,local` 子集 |
| `CLAUDE_PLUGIN_DIRS` | `pluginDirs` | 本地目录列表 |
| `CLAUDE_BARE` | `bare` | boolean |
| `CLAUDE_SAFE_MODE` | `safeMode` | boolean |
| `CLAUDE_DISABLE_SLASH_COMMANDS` | `disableSlashCommands` | boolean |
| `CLAUDE_ALLOW_BYPASS_PERMISSIONS` | `allowBypassPermissions` | boolean 危险确认 |

既有 `CLAUDE_ADD_DIRS`、`CLAUDE_ALLOWED_TOOLS`、`CLAUDE_DISALLOWED_TOOLS` 继续使用。`CLAUDE_CONFIG_DIR` 只用于 transcript 根目录。`CLAUDE_PERMISSION_MODE=default` 仅作为兼容迁移输入，规范化为未配置并产生一次脱敏告警。

## 固定事件契约

`tool_use` 事件在保留既有 `name/input/output/status` 字段的同时，可选增加 `callID`、`phase`、`result`、`isError`、`orphan`。`phase` 仅为 `start` 或 `result`。OpenCode 生产者无需填写新字段，现有消费者继续兼容旧形状。

Claude 无可靠结构化回复通路时，driver 使用固定错误码 `CLAUDE_PERMISSION_REPLY_UNSUPPORTED` 和 `CLAUDE_QUESTION_REPLY_UNSUPPORTED`，且不得向 PTY 写入文本或按键。

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | 统一 Claude 启动与 PTY 安全边界 | driver/runtime | 高 | T2, T3 | REQ-001, REQ-002, REQ-003, REQ-005, REQ-007, REQ-008 | 26 条 | `tasks/T1.md` |
| T2 | 完整解析 transcript 与工具生命周期 | event/transcript | 高 | 无 | REQ-004, REQ-005, REQ-007, REQ-008 | 11 条 | `tasks/T2.md` |
| T3 | 集中配置与 provider 能力面 | config/admin | 高 | 无 | REQ-003, REQ-005, REQ-006 | 7 条 | `tasks/T3.md` |
| T4 | 跨链路回归与安全验收 | integration | 高 | T1, T2, T3 | REQ-001 至 REQ-008 | 17 条 | `tasks/T4.md` |

## 依赖关系

`T2` 与 `T3` 可并行执行，完成后执行 `T1`，最后执行 `T4`。

```text
T2 ─┐
    ├─> T1 ─> T4
T3 ─┘
```

## 文件所有权

- T1 独占 Claude driver、PTY broker 及其单元测试。
- T2 独占 AgentEvent 契约、Claude transcript 及其测试。
- T3 独占环境配置、bootstrap、admin/provider catalog、示例配置及对应测试。
- T4 只创建独立集成测试文件，不修改 T1-T3 的生产文件或现有测试文件。
- 不修改 OpenCode 专属生产代码、飞书卡片/命令或 dispatcher；当前工作区中的相关未提交改动保持原样。

## 验证策略

1. 每个 task 先写失败测试，再实现最小改动。
2. T1-T3 分别运行定向测试；T4 运行 Claude 全链路和 OpenCode 回归。
3. 最终运行 `npm test`，并检查 `git diff --check` 与敏感哨兵扫描。
4. executing 阶段为每条 behavior 补齐 `traceability.json` 的真实 `tests` 和 `evidence`。

## Traceability 初始映射

同目录 `traceability.json` 已覆盖全部 8 个 Requirement 和 45 条 Behavior；planning 阶段的 `tests`、`evidence` 为空，由 executing 阶段基于真实测试结果补齐。
