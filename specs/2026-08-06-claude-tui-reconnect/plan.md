# Claude TUI 重启续接实现计划

**目标：** 为 Claude attach/TUI 增加可跨 Walker 主进程重启续接的本地持久控制面，使飞书消息在旧 TUI 仍可用时继续写入同一 runtime。

**架构：** 新增 Claude bridge/sidecar 控制面，承载 runtime registry、attach/control 连接、输入输出转发、本地认证与状态快照。`ClaudeDriver` 通过该控制面优先续接旧 runtime；旧控制面不可用时才走现有 `claude --resume` fallback。`walker claude attach` 增加断线恢复窗口，连接断开后重新解析本地控制面并重连。

**技术栈：** Node.js、`ws` WebSocket、现有 `ClaudePtyBroker`/`ClaudeAttachServer`/`ClaudeDriver`、node:test。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | Claude bridge/sidecar 控制面基础 | 基础设施 | high | 无 | REQ-001, REQ-003, REQ-005, REQ-006 | REQ-001-B01, REQ-001-B04, REQ-003-B03, REQ-003-B04, REQ-005-B01, REQ-006-B01, REQ-006-B02, REQ-006-B03, REQ-006-B04 | `tasks/T1.md` |
| T2 | Driver 续接与 fallback 决策 | 业务逻辑 | high | T1 | REQ-001, REQ-002, REQ-003, REQ-005 | REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B05, REQ-001-B06, REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04, REQ-002-B05, REQ-005-B01, REQ-005-B02, REQ-005-B03 | `tasks/T2.md` |
| T3 | Dispatcher 消息路径原子续接 | 集成逻辑 | medium | T2 | REQ-001, REQ-002, REQ-005 | REQ-001-B02, REQ-001-B03, REQ-001-B05, REQ-002-B01, REQ-002-B04, REQ-005-B02, REQ-005-B03 | `tasks/T3.md` |
| T4 | attach CLI 断线重连 | CLI | medium | T1 | REQ-004, REQ-006 | REQ-004-B01, REQ-004-B02, REQ-004-B03, REQ-004-B04, REQ-006-B02, REQ-006-B04 | `tasks/T4.md` |
| T5 | Walker shutdown 生命周期调整 | 应用生命周期 | medium | T1, T2 | REQ-003, REQ-001 | REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-003-B05, REQ-001-B06 | `tasks/T5.md` |
| T6 | 端到端回归与结构化证据 | 验证 | medium | T2, T3, T4, T5 | REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006 | REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B04, REQ-001-B05, REQ-001-B06, REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04, REQ-002-B05, REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-003-B04, REQ-003-B05, REQ-004-B01, REQ-004-B02, REQ-004-B03, REQ-004-B04, REQ-005-B01, REQ-005-B02, REQ-005-B03, REQ-006-B01, REQ-006-B02, REQ-006-B03, REQ-006-B04 | `tasks/T6.md` |

## 依赖关系

T1 → T2 → T3 → T6

T1 → T4 → T6

T1 → T2 → T5 → T6

## 文件结构计划

| 区域 | 计划 |
| ---- | ---- |
| `src/drivers/claude-bridge-sidecar.js` | 新增本地 bridge/sidecar，提供 runtime 注册、发现、attach/control WebSocket、本地认证、状态快照。 |
| `src/drivers/claude-pty-broker.js` | 接入 bridge runtime registry，支持 detach-only 后 runtime 仍可由 sidecar 持有和发现。 |
| `src/drivers/claude-attach-server.js` | 将现有 attach server 能力迁移或委托给 sidecar 控制面，保持本地 token 校验。 |
| `src/drivers/claude-driver.js` | 实现优先 reconnect 旧 sidecar runtime、不可用时 fallback、新状态持久化字段、shutdown detach 语义。 |
| `src/dispatch/message-dispatcher.js` | 保证准备 agentRef、持久化 ref、prompt 写入顺序原子化，不向 stale runtime 写入。 |
| `src/cli/claude-attach-command.js` | 增加断线恢复窗口、重试 resolve/connect、raw mode 释放和超时退出。 |
| `src/app/bootstrap.js` | stop 时只断开 Walker 主进程连接，不把可续接 runtime 交接成不可控独立终端。 |
| `test/*` | 为 sidecar、driver、dispatcher、attach CLI、bootstrap 和集成路径补红绿测试。 |

## Traceability 初始映射

planning 阶段已在同目录 `traceability.json` 覆盖每个 `REQ-xxx` 及其 behaviors。`tests` 与 `evidence` 在 executing 阶段补齐真实文件与证据引用。

## 并行策略

本计划默认串行执行关键实现任务，因为 T1 定义的 bridge 接口会影响 T2、T4、T5。T3 依赖 T2 的 agentRef 语义。T6 汇总所有测试与证据。若执行阶段需要 subagent，只能在 T1 接口稳定后并行处理 T3 与 T4，且必须先确认 `owns` 无交集。

## 风险与约束

- sidecar 只能绑定 loopback 或等价本地连接，不能暴露远程控制面。
- token、API key、authorization、secret、password 不得持久化或进入日志、飞书错误消息。
- 用户主动 stop/delete 必须继续关闭对应 runtime；Walker stop/restart 不等同于 stop session。
- 旧 runtime 可用时不得创建第二个 Claude PTY/TUI。
- 旧 runtime 不可用时必须明确 fallback，并持久化新 `agentRef`。
