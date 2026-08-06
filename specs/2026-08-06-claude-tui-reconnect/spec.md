# Claude TUI 重启续接 — 需求规格

## 1. 概述

**需求来源**：用户反馈“Walker 重启后（此时没有关闭 Claude TUI），从飞书向 Claude 发送消息，没有推送到上次启动的 TUI 里”。
**需求类型**：修改 / 架构增强 / bug 修复。
**选定方案**：方案 A — Claude 持久 bridge/sidecar 控制面。

当前 Claude TUI 由 `walker claude attach <runtimeId>` 连接到 Walker 主进程内的 `ClaudeAttachServer` 与 `ClaudePtyBroker`。Walker 主进程重启后，旧 attach 通道断开；前一次修复为了避免关闭 Walker 时直接杀掉 Claude，改为打开独立 `claude --resume <claudeSessionId>` 终端，但该独立终端不再受 Walker 控制，飞书消息无法注入旧 TUI。

本次目标是让已绑定聊天会话的 Claude TUI 在仍然存在时可被 Walker 重启后续接，语义对齐 OpenCode TUI bridge：旧 TUI 仍存在时，飞书消息应进入同一个 TUI/PTY；只有旧 TUI 或其控制面不可用时，才退化为新建/恢复 Claude runtime。

## 2. 方案比较

### 方案 A：Claude 持久 bridge/sidecar 控制面（推荐）

架构思路：
- 把 Claude PTY runtime 的控制面从 Walker 主进程拆到可跨 Walker 重启存活的本地 bridge/sidecar。
- `walker claude attach` 终端连接到 bridge/sidecar，而不是只连接当前 Walker 主进程。
- Walker 主进程通过持久化的 `runtimeId` / `claudeSessionId` 重连 bridge/sidecar，并向同一 PTY 写入飞书消息。

数据流：
- 创建 Claude 会话：Walker 启动或连接 sidecar runtime，打开 attach TUI，持久化 `agentRef`。
- Walker 停止：Walker 断开自身连接，不 kill sidecar runtime，不关闭 attach TUI。
- Walker 重启：dispatcher 准备 Claude agentRef 时，driver 优先重连 sidecar runtime；成功后飞书输入写入同一 runtime。
- 旧 runtime 不可用：driver 明确判定不可续接，才使用 `claude --resume <claudeSessionId>` 创建新的受控 runtime。

Trade-off：
- 优点：满足“旧 TUI 仍存在则续接旧 TUI”的核心语义；和 OpenCode TUI bridge 模型一致；后续可扩展心跳、诊断和管理接口。
- 缺点：改动跨 CLI、driver、attach server、broker 生命周期；需要新增持久连接/发现机制和更多测试。

### 方案 B：保留当前 `claude --resume` fallback，重启后总是打开新受控 TUI

架构思路：
- Walker 重启后发现旧 `runtimeId` 不可用，就调用 `resumeSession()` 创建新 runtime 和新 TUI。

Trade-off：
- 优点：改动最小，已经接近当前实现。
- 缺点：不满足用户要求；飞书消息不会进入旧 TUI，会造成同一个 Claude 会话出现多个可见终端。

### 方案 C：尝试向旧独立终端注入输入

架构思路：
- Walker 重启后查找旧终端进程并尝试写入其 stdin 或控制台输入。

Trade-off：
- 优点：理论上可避免新增 sidecar。
- 缺点：Windows/WSL 进程和终端句柄不可可靠发现；安全性、权限和稳定性不可控；无法提供可测试的跨平台语义。本次不采用。

## 3. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | 旧 Claude TUI 存活时跨 Walker 重启续接同一 runtime | P0 | 给定已绑定 Claude 会话和仍存活的旧 TUI，当 Walker 重启后从飞书发送消息，则消息写入同一 runtime，旧 TUI 可观察到输入/输出 |
| REQ-002 | 旧 runtime 不可用时明确 fallback 到新受控 runtime | P0 | 给定旧 sidecar/runtime 不存在或不可连接，当飞书发送消息，则 Walker 使用 `claude --resume <claudeSessionId>` 创建新受控 runtime 并持久化新 `agentRef` |
| REQ-003 | Walker 停止不破坏可续接 Claude runtime | P0 | 给定活跃 Claude attach TUI，当 Walker 正常停止，则不 kill Claude PTY，不丢失可被新 Walker 发现的控制面 |
| REQ-004 | attach CLI 支持断线后的可恢复连接语义 | P1 | 给定 Walker 主进程重启导致连接断开，当 bridge/sidecar 仍存活或新 Walker 控制面可用，则 attach TUI 可继续连接而不是立即永久退出 |
| REQ-005 | 运行状态与错误可观测 | P1 | 给定续接、fallback、失败等路径，日志和 session runtime 字段能区分 reused、resumed、unavailable、fallback |
| REQ-006 | 安全边界保持本地、token 不泄露 | P0 | bridge/sidecar 仅接受 loopback 或等价本地连接；日志、session 持久化和错误信息不包含 attach token、API key 或敏感环境变量 |

## 4. 接口/API 设计

### 4.1 Claude bridge/sidecar 本地控制接口

- **调用方式**：本地 loopback WebSocket 或 HTTP + WebSocket，具体端口/路径由实现阶段按现有 `ClaudeAttachServer` 约定最小扩展。
- **描述**：提供 runtime 发现、attach 连接、Walker 控制连接和输入输出转发。
- **输入**：

| 参数 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| runtimeId | string | 是 | Walker 持久化的 Claude runtime 标识 |
| claudeSessionId | UUID string | 是 | Claude Code 可 resume 的会话 ID |
| token | string | 是 | 本地 attach/control 连接凭据，不得持久化到 session agentRef |

- **输出**：runtime 快照，包含 `runtimeId`、`claudeSessionId`、`status`、`processGeneration`、`cwd`、`reconnectable` 等非敏感字段。

### 4.2 `ClaudeDriver` 续接接口

- `isSessionRefActive(agentRef)`：应能区分当前进程 runtime、可重连 sidecar runtime、不可用 stale runtime。
- `resumeSession(agentRef)`：应优先重连可续接 runtime；不可续接时才创建新的 `claude --resume` runtime。
- `prompt(agentRef, text)`：应写入已续接的旧 runtime，不应在旧 runtime 可用时隐式新建 runtime。

## 5. 数据设计

### 5.1 `agentRef` 持久化字段

继续使用现有 Claude `agentRef`，并允许添加非敏感字段：

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| provider | string | 固定为 `claude` |
| transport | string | 目标仍为 `pty-attach` 或升级为明确的 bridge transport |
| runtimeId | string | 跨 Walker 重启稳定的 runtime 标识 |
| claudeSessionId | UUID string | Claude 会话 ID |
| processGeneration | number | runtime 进程代际 |
| bridge | object | 可选，非敏感连接定位信息，不包含 token |
| terminal | object | 终端状态快照，不作为唯一活性依据 |

### 5.2 禁止持久化字段

- attach token。
- API key、authorization、secret、password。
- 可直接远程控制用户终端的非本地地址。

## 6. 业务规则

- 旧 Claude TUI 仍存在且其 runtime/control 面可用时，飞书消息必须进入旧 TUI 对应 runtime。
- 不得仅凭持久化 `terminal.status === 'active'` 判定旧 TUI 可用。
- 不得在旧 runtime 可用时创建第二个 Claude TUI 或第二个 Claude PTY。
- 用户主动停止或删除 session 时，仍应关闭对应 Claude runtime，不保留孤儿 sidecar。
- Walker 正常停止、重启、平台重连不等同于用户主动停止 Claude session。
- 续接失败必须有可观测错误或 fallback 记录，不能静默丢消息。

## 7. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| 旧 TUI 存活且 bridge 可用 | Walker 重启后复用旧 runtime，飞书输入进入旧 TUI |
| 旧 TUI 关闭但 sidecar 仍残留 | runtime 被标记不可用或清理，后续按 fallback 新建受控 runtime |
| sidecar 不存在 | 使用 `claude --resume <claudeSessionId>` 新建受控 runtime，并持久化新 ref |
| attach token 过期或错误 | 拒绝连接，记录脱敏错误，不泄露 token |
| Walker 重启期间飞书消息到达 | 消息要么等待续接完成后写入，要么返回明确错误；不得写入错误 runtime |
| 多个 Walker 实例同时连接同一 runtime | 必须避免双写或竞争；至少要有本地租约/排他控制，失败时明确报错 |

## 8. 非目标

- 不实现跨机器远程控制 Claude TUI。
- 不通过系统级终端句柄注入输入。
- 不改变用户主动 stop/delete session 的关闭语义。
- 不把敏感 token 或环境变量写入 `state.json`、日志或飞书消息。
- 不重写 OpenCode TUI bridge。
