# Claude 外部原生 TUI — 需求规格

## 1. 概述

**需求来源**：用户明确要求同时在外部 Claude TUI 与飞书中操作同一会话
**需求类型**：Claude provider 架构修改
**选定方案**：Walker 持有长期 ConPTY，外部终端通过本地 attach 客户端连接；飞书和终端输入共享同一个 Claude 进程

当前 Claude driver 为每条飞书消息启动独立的 `kscc --print` 进程，并另开一个不受 Walker 控制的终端进程。这会造成 `--session-id` 创建权冲突、多个进程并发恢复同一 conversation，以及终端与飞书状态不一致。

本次改造后，一个 Walker Claude 会话只对应一个长期 `kscc` TUI 进程。Walker 持有该进程的 ConPTY，外部 Windows 终端运行轻量 attach 客户端，原样显示并操作 Claude TUI；飞书消息通过同一个输入仲裁器写入该 ConPTY。不得修改 OpenCode driver、OpenCode 会话链路、OpenCode 测试或 OpenCode 行为。

### 1.1 方案比较

| 方案 | 说明 | 优点 | 代价 | 结论 |
| ---- | ---- | ---- | ---- | ---- |
| Walker 持有 ConPTY + 外部 attach | `kscc` 由 Walker 托管，外部终端仅转发原始终端字节 | 同一进程、可重连、可仲裁飞书与键盘输入 | 需要 PTY broker、attach 协议和 JSONL观察 | 采用 |
| 外部终端直接持有 `kscc` | Windows Terminal直接执行 Claude | 实现简单 | Walker无法可靠读写同一 TUI，仍需第二进程 | 拒绝 |
| 长期 `stream-json` worker | 飞书与自制 UI共用结构化协议 | turn和权限事件可靠 | 无法显示并操作原生 Claude TUI | 拒绝，违反硬要求 |

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | 长期 Claude ConPTY 会话 | P0 | `/new claude` 立即启动且仅启动一个长期 `kscc` TUI进程 |
| REQ-002 | 外部终端 attach | P0 | 外部窗口原样显示 Claude TUI，可输入、resize、detach和重新 attach |
| REQ-003 | 飞书与本地输入仲裁 | P0 | 两个来源的输入不会字符交错，忙碌或本地编辑时飞书消息有界排队 |
| REQ-004 | 双向轮次观察与回复 | P0 | 飞书提交及本地TUI提交的轮次均按精确Claude UUID观察，飞书收到对应assistant回复 |
| REQ-005 | 停止、退出和恢复 | P0 | detach不杀进程；停止清理进程树；Walker重启后以精确ID `--resume` 新建进程恢复 |
| REQ-006 | 本地attach安全与诊断 | P1 | attach仅允许本机授权连接，错误与状态可诊断且不泄露凭据 |
| REQ-007 | OpenCode零变更 | P0 | OpenCode源码、测试和行为不变，现有OpenCode测试全部通过 |

## 3. 接口与组件设计

### 3.1 Claude PTY broker

- 每个活动 Claude session维护一个 runtime：`runtimeId`、`claudeSessionId`、`cwd`、`processGeneration`、PTY句柄、输入队列、attach连接和输出缓冲。
- 新会话启动 `kscc --session-id <uuid>`；恢复会话启动 `kscc --resume <uuid>`。
- 禁止为飞书 prompt再启动 `kscc --print`。
- PTY输出同时发送给所有attach客户端并进入有限大小的回放缓冲。
- PTY进程退出时更新持久化状态并结束等待中的prompt，不静默吞掉错误。

### 3.2 本地 attach 协议

- 新增 `walker claude attach <runtime-id>` CLI子命令。
- attach客户端在外部 Windows Terminal中运行，stdin进入raw mode，stdout原样写入PTY输出。
- 客户端发送键盘字节和终端resize；broker发送PTY字节、运行状态和关闭原因。
- 连接仅监听 `127.0.0.1` 或使用Windows本地命名管道，并要求高熵一次性或会话级凭据。
- attach断开只移除客户端，不关闭PTY或Claude进程。

### 3.3 输入事务

- 输入操作分为 `submit_prompt`、`terminal_input`、`resize`、`interrupt`、`attach` 和 `detach`。
- 飞书 `submit_prompt` 必须作为不可交错事务写入完整文本并提交Enter。
- attach客户端开始普通文本编辑后持有本地writer lease，直到提交、取消、detach或租约超时；期间飞书prompt排队。
- Claude正在执行一个已知轮次时，后续飞书prompt进入有界FIFO；队列满时明确拒绝。
- `Ctrl+C` 等中断控制允许走高优先级控制路径，但必须记录来源。

### 3.4 轮次与 transcript 观察

- Claude JSONL路径必须由 canonical `cwd`、Claude配置根目录和精确 `claudeSessionId`确定，禁止按最新mtime猜测。
- 飞书prompt提交前记录turn边界，仅返回边界之后对应的assistant文本。
- 本地TUI提交的用户轮次也通过同一个精确JSONL watcher发现，并交给现有session watch分发链路。
- JSONL暂不可用时允许PTY状态作为诊断信号，但不得把其他Claude session的输出作为回复。

### 3.5 持久化引用

Claude `agentRef` 至少保存：

```json
{
  "provider": "claude",
  "transport": "pty-attach",
  "claudeSessionId": "uuid",
  "cwd": "canonical path",
  "runtimeId": "walker runtime id",
  "processGeneration": 1,
  "terminal": {
    "status": "active"
  }
}
```

PTY句柄和PID不视为可跨Walker进程恢复的持久资源。Walker重启后应启动新PTY和新进程，并使用精确 `--resume <claudeSessionId>`。

## 4. 业务规则

- 一个活动的Walker Claude session最多有一个主 `kscc` TUI进程。
- 外部终端是attach视图，不是Claude进程所有者。
- 外部终端关闭后Claude继续运行；显式停止或删除才关闭Claude进程树。
- 本地TUI与飞书共享同一Claude上下文和同一输入队列。
- 没有精确Claude session ID时只能创建fresh会话，禁止使用裸 `--continue`。
- 恢复前必须确认session绑定的canonical workspace未变化；不允许跨workspace静默resume。
- 队列、PTY输出回放和等待中的turn都必须有上限。
- 所有新增能力仅接入Claude provider。

## 5. 异常与边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| `node-pty`/ConPTY不可用 | `/new claude`失败并返回可诊断错误，不回退到双进程模式 |
| `kscc`启动失败 | 清理PTY和attach端点，session标记错误 |
| 外部终端启动失败 | Claude进程可继续运行，飞书返回窗口启动失败及可重试attach信息 |
| attach客户端断线 | Claude不退出，后续客户端可重新attach并接收有限回放 |
| 本地用户输入半行时收到飞书消息 | 飞书消息排队，不插入当前编辑行 |
| Claude忙碌时连续收到多条飞书消息 | 有界FIFO串行处理；队列满时明确拒绝 |
| Claude处于权限选择界面 | 普通飞书文本不得作为选择按键注入 |
| JSONL不存在或写入延迟 | 等待到超时并给出明确错误，不读取其他session文件 |
| Claude进程异常退出 | 所有等待者收到失败，runtime状态持久化为错误 |
| Walker重启 | 旧PTY不可重连；按持久化UUID启动新PTY并 `--resume` |
| session ID与workspace不匹配 | fail closed，不恢复其他workspace上下文 |
| OpenCode会话运行 | 不受Claude PTY broker、CLI子命令或runtime改动影响 |

## 6. 可观测性与性能

- 日志记录runtime ID、Claude session ID脱敏摘要、process generation、输入来源、队列深度、attach/detach和退出原因。
- 日志不得记录attach凭据、完整飞书prompt或敏感环境变量。
- attach建立后应立即回放有限终端缓冲，默认目标不超过1 MiB。
- 单个Claude session的飞书消息队列必须有固定上限，默认目标5条。
- 不使用固定sleep判断turn完成；以精确JSONL消息边界为主，超时为失败保护。

## 7. 兼容性与迁移

- 已持久化、没有 `transport: pty-attach` 的Claude引用在下一次恢复时迁移为新PTY进程，并使用其精确 `claudeSessionId`。
- 如果旧引用缺少可验证的Claude UUID，不得使用最近会话猜测恢复。
- 保持现有飞书命令和Claude provider选择方式。
- 不修改 `src/drivers/opencode-driver.js`、OpenCode专属模块或OpenCode测试。
- `WindowsRuntime.openTerminal()`保持现有语义，避免影响OpenCode；Claude使用新增的专用attach窗口方法。

## 8. 非目标

- 不修改或重构OpenCode实现。
- 不让同一个Claude进程同时运行TUI协议和`stream-json`协议。
- 不实现浏览器版终端或xterm.js界面。
- 不支持远程网络attach。
- 不保证Walker崩溃后原PTY中的正在执行工具原地继续；只能恢复Claude conversation。
- 不通过按mtime选择Claude JSONL。
- 不增加多用户协同编辑或多个writer同时输入。
