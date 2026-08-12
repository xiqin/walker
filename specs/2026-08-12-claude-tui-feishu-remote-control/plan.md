# Claude 原生 TUI 与飞书单进程协同实现计划

**目标：** 修复飞书消息恢复 Claude/kscc 会话时自动弹窗和 attach 历史 ANSI 回放错乱，同时保持飞书与原生 TUI 操作同一个长期 PTY runtime。

**架构：** 保留现有 `ClaudeDriver`、`ClaudePtyBroker`、`ClaudeAttachServer` 和 transcript 观察链路，不增加第二个 Claude 进程或新协议层。恢复只负责 runtime 可写性，窗口只由新建会话或显式 attach 打开；飞书输入经现有有界仲裁队列写入唯一 PTY，回复继续按精确 cwd 与 Claude UUID 从 JSONL transcript 获取。

**技术栈：** Node.js CommonJS、`node-pty`、`ws`、Node.js `node:test`。

---

## 文件结构

| 文件 | 职责 | 计划动作 |
| ---- | ---- | -------- |
| `src/drivers/claude-attach-server.js` | attach 鉴权、实时输入输出转发 | 强制新客户端无 replay |
| `src/drivers/claude-bridge-sidecar.js` | bridge sidecar runtime 与 attach 转发 | 强制 sidecar attach 新客户端无 replay |
| `src/drivers/claude-driver.js` | runtime 生命周期、窗口状态、输入仲裁、transcript 收集 | 解耦恢复与窗口，按 runtime 判断活跃性，收紧事务与诊断 |
| `src/drivers/claude-transcript.js` | 精确 transcript cursor 与 assistant 事件读取 | 仅在测试暴露缺口时做最小安全修复 |
| `src/dispatch/message-dispatcher.js` | 飞书消息恢复、持久化和 prompt 调度 | 保持先恢复并原子持久化，再向无窗口 runtime 投递 |
| `test/claude-attach.test.js` | attach 协议测试 | 覆盖无回放、鉴权、边界和实时转发 |
| `test/claude-bridge-sidecar.test.js` | bridge sidecar attach 测试 | 覆盖 sidecar attach 无回放与实时转发 |
| `test/claude-driver.test.js` | Claude driver 单元测试 | 覆盖单 runtime、窗口解耦、输入仲裁、错误和脱敏 |
| `test/claude-transcript.test.js` | transcript fixture 测试 | 覆盖精确 UUID、cursor、超时和路径安全 |
| `test/claude-tui-reconnect.integration.test.js` | 飞书恢复集成测试 | 覆盖失效 runtime 恢复、持久化和零窗口调用 |
| `test/claude-tool-parity.integration.test.js` | CLI 配置和工具语义回归 | 参数化验证 claude/kscc 且不触碰 Remote Control |

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | attach 强制无历史回放 | transport | 中等 | 无 | REQ-003, REQ-007 | 7 | `tasks/T1.md` |
| T2 | 单 runtime 生命周期与安全输入事务 | driver | 高 | T1 | REQ-001, REQ-002, REQ-004, REQ-005, REQ-006 | 27 | `tasks/T2.md` |
| T3 | 飞书无窗口恢复集成闭环 | dispatch/integration | 中等 | T2 | REQ-001, REQ-002, REQ-006 | 5 | `tasks/T3.md` |
| T4 | claude/kscc 与 OpenCode 回归边界 | regression | 中等 | T1, T2, T3 | REQ-003, REQ-007 | 6 | `tasks/T4.md` |

## 依赖关系

```text
T1 ─┐
    ├─> T2 -> T3 ─┐
    └──────────────┴─> T4
```

- T1 先固定 attach 协议边界，使后续 driver 显式开窗不会携带历史输出。
- T2 完成核心 runtime、窗口、队列和 transcript 行为。
- T3 使用真实 dispatcher 路径验证恢复、持久化和 prompt 顺序。
- T4 在核心行为稳定后执行两种 CLI 配置与 OpenCode 非影响回归。
- 所有 task 的 `owns` 均不重叠；T1 可先独立执行，T2 读取其协议结果后串行推进。

## 关键接口约束

- `ClaudeDriver.resumeSession(sessionRef)` 返回可写 agentRef，但不调用 `_ensureTerminal()`。
- `ClaudeDriver.isSessionRefActive(sessionRef)` 以 broker/bridge runtime 状态为准，不以 `_windows` 或 `terminal.status` 作为必要条件。
- `ClaudeAttachServer` 与 `ClaudeBridgeSidecar` 对用户 WebSocket 连接固定使用 `replay: false`，客户端参数不能覆盖。
- `ClaudeDriver.prompt()` 只写 agentRef 的现有 runtimeId，不调用 print/background/额外 resume 路径。
- prompt cursor 必须在写入前由 canonical cwd、配置根目录和精确 UUID 创建。
- dispatcher 仅在新 agentRef 成功持久化后发送 prompt；失败时不向 PTY 写入。
- 日志只记录 runtimeId、脱敏 session 标识、来源、长度、队列深度和错误分类。

## 验证策略

- 定向单元测试：`node --test test/claude-attach.test.js test/claude-bridge-sidecar.test.js test/claude-driver.test.js test/claude-transcript.test.js`
- 定向集成测试：`node --test test/claude-tui-reconnect.integration.test.js test/claude-tool-parity.integration.test.js`
- Claude attach CLI 回归：`node --test test/claude-attach-command.test.js test/cli-claude-attach.test.js`
- OpenCode 非影响回归：`node --test test/opencode-driver.test.js test/opencode-tui-bridge.test.js`
- 完整验证：`npm test`

## Traceability 初始映射

`traceability.json` 覆盖 `requirements.json` 中全部 7 个 requirement 和 39 个 behavior。规划阶段只固定 task 映射；执行阶段为每个 behavior 补齐真实测试与证据引用。
