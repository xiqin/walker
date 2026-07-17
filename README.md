# Walker

飞书多 Agent CLI 桥接器 — 通过飞书长连接操控本机 opencode agent 会话（架构保留 Claude Code、Codex 等扩展点）。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.11.0-brightgreen.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-907%20passed-brightgreen.svg)](test/)

## 文档

- [配置与环境变量](#配置) — 飞书凭据、Agent、运行时、超时等配置
- [命令列表](#命令) — 飞书交互命令
- [架构概览](#architecture) — 分层设计与数据流
- [贡献指南](CONTRIBUTING.md) — 开发环境、编码约定、提交流程
- [变更日志](CHANGELOG.md) — 版本历史与显著变更
- [许可证](LICENSE) — MIT

## 运行

### 全局安装（推荐）

```bash
npm install -g walker-bridge
walker
```

`walker` 命令前台运行，Ctrl+C / 关闭终端即停止。

### 从源码运行

```bash
git clone <repo>
cd walker
npm install
npm start
```

### 子命令

| 命令 | 说明 |
| --- | --- |
| `walker` | 前台运行（默认） |
| `walker start` | 后台守护进程启动 |
| `walker stop` | 停止后台进程 |
| `walker status` | 查看后台进程状态和最近日志 |
| `walker logs [N]` | 查看最近 N 行日志（默认 80） |
| `walker help` | 显示帮助 |

运行前先配置 `.env`。日志同时输出到终端和 `logs/walker.log`（后台模式额外写 `logs/walker.out.log` / `logs/walker.err.log`）。

## 配置

在项目根目录创建 `.env`：

```text
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=你的飞书应用密钥
WALKER_DEFAULT_AGENT=opencode
WALKER_DEFAULT_RUNTIME=windows
WALKER_DEFAULT_CWD=H:\walker
OPENCODE_SERVER_URL=http://localhost:4096
OPENCODE_SERVER_AUTOSTART=true
OPENCODE_CMD=opencode
FEISHU_ROUTE_MODE=thread
FEISHU_PROGRESS_STYLE=card
FEISHU_REACTION_EMOJI=OnIt
FEISHU_DONE_EMOJI=none
WALKER_PROMPT_HEARTBEAT_INITIAL_MS=30000
WALKER_PROMPT_HEARTBEAT_INTERVAL_MS=60000
WALKER_PROMPT_HEARTBEAT_STUCK_MS=300000
WALKER_MAX_TURN_TIME_MINS=0
WALKER_OPENCODE_HOOK_ENABLED=true
WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS=5000
WALKER_OPENCODE_EXIT_ACTION=cancel
WALKER_OPENCODE_NON_FOCUS_OUTPUT=true
```

飞书凭据通过环境变量或项目根目录的 `.env` 文件配置。

### 环境变量说明

| 变量                                      | 默认值         | 说明                                                                                                             |
| ----------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `FEISHU_APP_ID`                           | 空             | 飞书应用 App ID（必填）                                                                                          |
| `FEISHU_APP_SECRET`                       | 空             | 飞书应用 App Secret（必填）                                                                                      |
| `FEISHU_ROUTE_MODE`                       | `thread`       | 路由模式：`thread`（按消息线程）、`user`（按用户）、`channel`（按群）                                            |
| `FEISHU_PROGRESS_STYLE`                   | `card`         | 进度样式：`card`（结构化卡片）或 `legacy`（逐条文本）                                                            |
| `FEISHU_REACTION_EMOJI`                   | `OnIt`         | 收到消息时表情回复，`none` 禁用                                                                                  |
| `FEISHU_DONE_EMOJI`                       | 空             | Agent 完成时表情回复，`none` 禁用                                                                                |
| `WALKER_DEFAULT_AGENT`                    | `opencode`     | 默认 Agent 类型                                                                                                  |
| `WALKER_DEFAULT_RUNTIME`                  | `windows`      | 运行时：`windows` 或 `wsl`                                                                                       |
| `WALKER_DEFAULT_CWD`                      | 当前目录       | Agent 工作目录                                                                                                   |
| `WALKER_DATA_DIR`                         | `~/.walker`    | 数据存储目录                                                                                                     |
| `WALKER_WSL_DISTRO`                       | `Ubuntu-24.04` | WSL 发行版名称                                                                                                   |
| `WALKER_PROMPT_HEARTBEAT_INITIAL_MS`      | `30000`        | prompt 开始后多久无事件时首次更新原进度卡片，单位毫秒；仅 `FEISHU_PROGRESS_STYLE=card` 时启用                    |
| `WALKER_PROMPT_HEARTBEAT_INTERVAL_MS`     | `60000`        | 首次心跳后的重复更新间隔，单位毫秒；心跳只更新原进度卡片，不发送普通群消息                                       |
| `WALKER_PROMPT_HEARTBEAT_STUCK_MS`        | `300000`       | 达到该时长后在原进度卡片提示任务可能卡住，单位毫秒                                                               |
| `WALKER_MAX_TURN_TIME_MINS`               | `0`            | 单轮 prompt 唯一硬截止时长，单位分钟；`0` 默认关闭，`>0` 时超时自动取消当前 turn，并抑制已取消或超时后的残留输出 |
| `OPENCODE_SERVER_URL`                     | 空             | opencode serve 地址，WSL 模式自动探测 IP                                                                         |
| `OPENCODE_SERVER_AUTOSTART`               | `true`         | opencode serve 未启动时自动启动                                                                                  |
| `OPENCODE_CMD`                            | `opencode`     | opencode CLI 命令名                                                                                              |
| `OPENCODE_MODEL`                          | 空             | 指定模型                                                                                                         |
| `OPENCODE_AGENT`                          | 空             | 指定 agent                                                                                                       |
| `OPENCODE_PROMPT_REQUEST_TIMEOUT_MS`      | `30000`        | HTTP prompt 提交超时，单位毫秒；`0` 关闭                                                                         |
| `OPENCODE_SSE_IDLE_TIMEOUT_MS`            | `300000`       | SSE 事件流空闲超时，收到任意 chunk 自动续期；`0` 关闭。未设置时以 `OPENCODE_PROMPT_TIMEOUT_MS` 为兼容输入        |
| `OPENCODE_RECOVERY_WINDOW_MS`             | `300000`       | SSE 断流后 polling 恢复的最长时间窗口，单位毫秒；`0` 禁用恢复直接失败                                            |
| `OPENCODE_SSE_OPEN_TIMEOUT_MS`            | `1000`         | SSE 建连超时，单位毫秒；`0` 关闭                                                                                 |
| `OPENCODE_TUI_LEASE_TIMEOUT_MS`           | `90000`        | TUI Bridge 租约超时，活跃 heartbeat 自动续期；`0` 关闭                                                           |
| `OPENCODE_TUI_HEARTBEAT_INTERVAL_MS`      | `30000`        | TUI plugin 心跳上报间隔，须小于 lease timeout                                                                    |
| `WALKER_OPENCODE_HOOK_ENABLED`            | `true`         | 是否启用 OpenCode plugin 自动安装和 hook 接收。设为 `false` 退回手动 `/attach` 模式                              |
| `WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS` | `5000`         | 心跳轮询 `/global/health` 间隔，单位毫秒                                                                         |
| `WALKER_OPENCODE_EXIT_ACTION`             | `cancel`       | OpenCode 退出动作。`cancel` 取消该 session turn 并从 route 移除；`none` 只记录 detached                          |
| `WALKER_OPENCODE_NON_FOCUS_OUTPUT`        | `true`         | 非焦点 session SSE 事件是否主动回卡片到群里。`false` 时静默                                                      |

## OpenCode 自动纳入

Walker 启动时自动安装 TUI bridge plugin 到 `~/.config/opencode/walker-tui-plugin.js`，并注册到 `~/.config/opencode/tui.json` 的 `plugin` 数组；已存在且内容一致则跳过，内容变化时更新。

工作流程：

1. Walker 启动时写入 plugin 文件并更新 `tui.json`（内容一致则跳过，避免无谓写盘）；同时清理旧版 hook plugin。
2. 用户在本机终端照常启动 `opencode`。
3. OpenCode 加载全局 plugin，触发 `session.created` 事件。
4. plugin 上报 `{ opencodeBaseUrl, sessionId, cwd }` 给 Walker 的 `POST /opencode/hook/session-created` 端点。
5. Walker 按 `cwd` 找到 routeKey，创建 Walker session，加入 route 的 sessions 列表。
6. 全程无飞书命令干预，用户照常启动 opencode 即可自动纳入。

安全约束：

- 只接受本机 loopback 请求（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`），非本机请求返回 403。
- 复用现有 admin token 保护（`WALKER_ADMIN_TOKEN`）；未配置 token 时仍限制 loopback。
- plugin 文件内置 admin token（`WALKER_ADMIN_TOKEN`）用于鉴权，Walker 地址硬编码为 `127.0.0.1:<port>`。
- Walker 不可达时 plugin 静默忽略，不影响 OpenCode 正常使用。

`WALKER_OPENCODE_HOOK_ENABLED=false` 时，Walker 不安装 plugin，退回手动 `/attach` 模式。

## 1:N Session 路由

同一 `cwd` 启动多个 OpenCode 处理不同任务时，一个飞书群（routeKey）可绑定多个 session，通过"焦点 session"机制保证消息精准路由。

路由结构：

- route 从 `{ routeKey: sessionId }` 升级为 `{ focusSessionId, sessions[], cwd, updatedAt }`，旧格式自动迁移。
- session 本身不变，仍 1 session : 1 agentRef `{ opencodeSessionId, serverUrl }`。
- `getCurrent(routeKey)` 返回焦点 session。

消息路由：

- 普通消息发给焦点 session，输出回到原 routeKey。
- 非焦点 session 的 SSE 事件主动回卡片到群里，带 `[session: wks_N]` 标识区分来源。
- `WALKER_OPENCODE_NON_FOCUS_OUTPUT=false` 时，非焦点 session 输出静默不回群。

焦点切换：

- `/use <id>` 切换焦点（session 必须在当前 route 的 sessions 列表中）。
- `/use off` 移除焦点 session（保留 route 中其他 session）。
- `/list` 卡片的"设为焦点"按钮也可切换焦点。

## OpenCode 退出行为

每个 hook 纳入的 session 独立心跳轮询 OpenCode 的 `/global/health` 端点检测存活。连续 2 次检查失败判定该 session detached。

detached 后的处理：

- `WALKER_OPENCODE_EXIT_ACTION=cancel`（默认）：取消该 session 的 running turn，从 route 移除该 session，停止 SSE watch 和心跳轮询。
- `WALKER_OPENCODE_EXIT_ACTION=none`：只记录 detached，不取消 turn，不主动移除。
- 若 detached 的 session 是焦点，自动切换焦点到 route 中下一个活跃 session。
- 没有 running turn 时，退出只记录 detached，不报错。
- 不 stop/delete Walker session，不解绑 route。

心跳间隔由 `WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS` 控制，退出动作由 `WALKER_OPENCODE_EXIT_ACTION` 控制。

## 飞书后台要求

- 应用类型：自建应用
- 已开启机器人能力
- 事件订阅方式：`使用长连接接收事件/回调`
- 已订阅 `im.message.receive_v1`
- 权限包含单聊或群聊消息读取能力
- 发布应用版本后生效
- 机器人被拉进目标群或用户直接单聊

## 命令

| 命令                   | 说明                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/new [agent] [title]` | 创建新 Walker session 并绑定当前会话                                                                                                                       |
| `/list`                | 列出当前 route 下所有 session（含卡片"设为焦点"按钮）                                                                                                      |
| `/use <session_id>`    | 切换当前 route 的焦点到指定 session                                                                                                                        |
| `/use off`             | 移除当前会话的焦点 session（保留 route 中其他 session）                                                                                                    |
| `/current`             | 查看当前绑定的 session                                                                                                                                     |
| `/status`              | 查看当前会话绑定的 Walker session、Agent、状态、OpenCode session、模型、工作目录、当前 turn 运行状态、运行时长、最近事件时间和后台 watch 状态              |
| `/ps`                  | `/status` 的等价别名                                                                                                                                       |
| `/cancel`              | 取消当前正在执行的 turn，保留 Walker session 并回到 `idle`                                                                                                 |
| `/clear`               | 在当前 OpenCode TUI 会话新建空上下文并保留旧会话（仅适用于已连接且空闲的 OpenCode TUI；运行中请先 `/cancel`；旧会话可通过 `/list` 查看、`/use <id>` 恢复） |
| `/stop`                | 停止当前 session                                                                                                                                           |
| `/delete <session_id>` | 删除指定 session                                                                                                                                           |
| `/agents`              | 列出可用 Agent 类型                                                                                                                                        |
| `/help`                | 命令帮助                                                                                                                                                   |

Walker 启动时会更新 OpenCode TUI plugin。若更新涉及 `/clear` 等桥接协议，已运行的 OpenCode TUI 不会热加载新 plugin，必须退出并重新启动该 TUI；仅重启 Walker 不足以使旧 TUI 获得新能力。

## 长任务控制

- 进度卡片心跳由 `WALKER_PROMPT_HEARTBEAT_INITIAL_MS`、`WALKER_PROMPT_HEARTBEAT_INTERVAL_MS` 和 `WALKER_PROMPT_HEARTBEAT_STUCK_MS` 控制；心跳只更新原进度卡片，不发送普通群消息。
- 非 card 进度模式不启用卡片心跳；例如 `FEISHU_PROGRESS_STYLE=legacy` 时不会发送卡片心跳更新。
- `/cancel` 用于取消当前绑定 session 的正在执行 turn。第一版对 OpenCode 可复用 driver stop 能力，但 Walker session 会保留并回到 `idle`，不同于 `/stop` 停止整个 session。
- `WALKER_MAX_TURN_TIME_MINS` 是单轮唯一硬截止；`0` 默认关闭，`>0` 时超时自动取消该 turn，并抑制已取消或超时后的残留输出。
- HTTP/SSE transport 使用独立超时：`OPENCODE_SSE_OPEN_TIMEOUT_MS`（建连）、`OPENCODE_PROMPT_REQUEST_TIMEOUT_MS`（提交）、`OPENCODE_SSE_IDLE_TIMEOUT_MS`（空闲，收到 chunk 自动续期）；均可设为 `0` 关闭。SSE 断流后自动 polling 恢复最终结果。
- TUI Bridge 使用租约协议：`OPENCODE_TUI_LEASE_TIMEOUT_MS`（租约，heartbeat 续期）、`OPENCODE_TUI_HEARTBEAT_INTERVAL_MS`（心跳间隔）。旧 `OPENCODE_PROMPT_TIMEOUT_MS` 已废弃，仅作为 `OPENCODE_SSE_IDLE_TIMEOUT_MS` 的兼容输入。

## Agent 扩展

| Agent      | 状态       | 说明                                    |
| ---------- | ---------- | --------------------------------------- |
| `opencode` | P0 已实现  | 通过 `opencode serve` HTTP API/SSE 控制 |
| `claude`   | 预留扩展点 | Claude Code CLI，未来实现               |
| `codex`    | 预留扩展点 | Codex CLI，未来实现                     |

## Runtime

- `windows`：本机直接运行 Agent CLI
- `wsl`：通过 `wsl.exe -d <distro>` 在 WSL 中运行 Agent CLI

WSL 模式下自动探测 WSL IP 构建 server URL，也可通过 `OPENCODE_SERVER_URL` 手动指定。

## 数据存储

Walker 数据存储在 `.walker/` 目录下：

- `sessions.json`：Walker session 信息
- `routes.json`：飞书 routeKey 到 session 的绑定
- `attachments/`：入站附件文件

## Architecture

飞书开放平台 → Walker Agent Hub（Node.js 单进程）→ Agent Driver → Runtime → Agent CLI

- 飞书长连接（WSClient）接收消息和卡片回调
- MessageDedup 5 分钟去重窗口
- routeKey 三种模式精准路由到 Walker session
- 1:N session 路由：同一 routeKey 绑定多 session，焦点 session 接收普通消息
- OpenCode hook plugin：自动安装，启动即纳入，无需飞书命令干预
- 心跳轮询检测 OpenCode detached，自动取消 turn 并切焦点
- AgentDriver 抽象支持多 CLI 扩展
- ProgressCard 结构化卡片实时更新

## 贡献

欢迎参与本项目！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境、编码约定和提交流程。

## 变更日志

详见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE) © 2026 Walker Contributors
