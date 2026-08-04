# Claude 外部原生 TUI 实现计划

**目标：** 将 Claude provider 改为 Walker 托管唯一长期 ConPTY/kscc TUI 进程，并让外部原生窗口与飞书通过同一输入仲裁器操作同一会话。

**架构：** 新增 Claude PTY broker，负责长期 PTY 生命周期、attach 连接、输出回放、输入事务和恢复状态。`ClaudeDriver` 不再为飞书 prompt 启动 `kscc --print`，而是把 prompt 写入 broker 托管的 PTY，并通过精确 Claude UUID JSONL 观察回复。外部 Windows Terminal 只运行 `walker claude attach <runtime-id>` 客户端，不直接启动 `kscc`。

**技术栈：** Node.js CommonJS、`node-pty`/ConPTY、`ws` 本机 attach 通道、现有 JSON store/session service、Node test runner。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | Claude PTY broker 与 runtime 生命周期 | 运行时基础设施 | 高 | 无 | REQ-001, REQ-005, REQ-006 | REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B04, REQ-005-B01, REQ-005-B02, REQ-005-B03, REQ-005-B04, REQ-006-B02, REQ-006-B03 | `tasks/T1.md` |
| T2 | 本机 attach 协议、CLI 与外部窗口入口 | CLI/本机端点 | 高 | T1 | REQ-002, REQ-006 | REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04, REQ-002-B05, REQ-002-B06, REQ-006-B01, REQ-006-B04, REQ-006-B05 | `tasks/T2.md` |
| T3 | 输入仲裁与 ClaudeDriver PTY prompt 改造 | Provider 业务逻辑 | 高 | T1, T2 | REQ-001, REQ-003 | REQ-001-B05, REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-003-B04, REQ-003-B05, REQ-003-B06, REQ-003-B07 | `tasks/T3.md` |
| T4 | 精确 UUID JSONL 观察与轮次回复 | Transcript/观察链路 | 高 | T1, T3 | REQ-004 | REQ-004-B01, REQ-004-B02, REQ-004-B03, REQ-004-B04, REQ-004-B05 | `tasks/T4.md` |
| T5 | Dispatcher 持久化、停止删除与旧引用迁移 | 会话集成 | 中 | T3, T4 | REQ-005 | REQ-005-B05 | `tasks/T5.md` |
| T6 | OpenCode 零变更与最终回归 | 兼容性验证 | 中 | T1, T2, T3, T4, T5 | REQ-007 | REQ-007-B01, REQ-007-B02, REQ-007-B03 | `tasks/T6.md` |

## 依赖关系

T1 → T2 → T3 → T4 → T5 → T6

T3 依赖 T1 的 broker API 和 T2 的 attach 元数据；T4 依赖 T3 的 prompt 边界记录；T5 依赖 T3/T4 的 agentRef 与 watcher 形态；T6 在所有代码变更完成后执行边界验证。

## 文件结构规划

| 路径 | 责任 | 所属 Task |
| ---- | ---- | --------- |
| `src/drivers/claude-pty-broker.js` | 长期 PTY runtime、输入队列、输出回放、stop/delete/recover | T1 |
| `src/drivers/claude-pty-runtime.js` | PTY spawn 适配、node-pty 可用性诊断、进程树关闭封装 | T1 |
| `src/drivers/claude-attach-server.js` | 本机 attach WebSocket/认证/协议处理 | T2 |
| `src/cli/claude-attach-command.js` | `walker claude attach <runtime-id>` 客户端 | T2 |
| `src/runtime/windows-runtime.js` | 新增 Claude 专用 attach 窗口方法，保持 `openTerminal()` 旧语义 | T2 |
| `src/index.js` | 注册 `claude attach` 子命令 | T2 |
| `src/drivers/claude-driver.js` | Claude provider 改为 broker prompt、恢复、stop/delete/watch 接口 | T3 |
| `src/drivers/claude-transcript.js` | 精确 UUID JSONL 路径、边界读取、watcher | T4 |
| `src/dispatch/message-dispatcher.js` | agentRef 持久化、旧引用迁移、停止删除集成 | T5 |
| `package.json`, `package-lock.json` | 增加 PTY 依赖与安装锁定 | T1 |

## Traceability 初始映射

`traceability.json` 已按每个 REQ 和 behavior 映射到负责 task。planning 阶段的 `tests` 与 `evidence` 保持空数组，executing 阶段必须补齐真实测试文件和证据引用。

## 并行策略

本计划默认串行执行。T1-T5 涉及同一个 Claude provider 状态机，存在接口耦合和行为顺序依赖，不拆并行。T6 是最终边界验证任务，只在所有实现任务完成后执行。

## 风险与约束

- `node-pty` 在 Windows 安装失败时必须以可诊断错误失败，不能回退到旧双进程模式。
- 外部窗口必须是 attach 客户端，不能直接运行 `kscc`。
- 不修改 `src/drivers/opencode-driver.js`、`src/opencode-*`、`test/opencode-*` 或 OpenCode 专属测试。
- `WindowsRuntime.openTerminal()` 保持原有签名和语义，只新增 Claude 专用方法。
- 禁止使用裸 `--continue`，恢复只能使用精确 `claudeSessionId`。

## 验证计划

- 定向测试：`node --test test/claude-pty-broker.test.js test/claude-attach.test.js test/claude-driver.test.js test/claude-transcript.test.js test/message-dispatcher.test.js test/runtime.test.js`
- OpenCode 边界测试：`node --test test/opencode-driver.test.js test/opencode-tui-bridge.test.js test/opencode-http-client.test.js test/runtime.test.js`
- 全量验证：`npm test`
- 机械检查：`git diff --name-only` 不包含 OpenCode 专属路径；`git diff --check` 无输出。
