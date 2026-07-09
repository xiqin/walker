# Walker

飞书多 Agent CLI 桥接器 — 通过飞书长连接操控本机 opencode/opendray agent 会话。

不依赖 opendray bridge，独立实现 Walker 本地 Agent Hub。

## 运行

先配置 `.env`，然后：

```powershell
npm start
```

后台启动/停止/查看状态：

```powershell
.\scripts\start.ps1
.\scripts\status.ps1
.\scripts\logs.ps1
.\scripts\stop.ps1
```

后台日志写入 `logs\walker.out.log` 和 `logs\walker.err.log`。

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
```

飞书凭据也可从 `~/.cc-connect/config.toml` 自动读取（兼容 cc-connect 配置）。

### 环境变量说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FEISHU_APP_ID` | 空 | 飞书应用 App ID（必填） |
| `FEISHU_APP_SECRET` | 空 | 飞书应用 App Secret（必填） |
| `FEISHU_ROUTE_MODE` | `thread` | 路由模式：`thread`（按消息线程）、`user`（按用户）、`channel`（按群） |
| `FEISHU_PROGRESS_STYLE` | `card` | 进度样式：`card`（结构化卡片）或 `legacy`（逐条文本） |
| `FEISHU_REACTION_EMOJI` | `OnIt` | 收到消息时表情回复，`none` 禁用 |
| `FEISHU_DONE_EMOJI` | `none` | Agent 完成时表情回复，`none` 禁用 |
| `WALKER_DEFAULT_AGENT` | `opencode` | 默认 Agent 类型 |
| `WALKER_DEFAULT_RUNTIME` | `windows` | 运行时：`windows` 或 `wsl` |
| `WALKER_DEFAULT_CWD` | 当前目录 | Agent 工作目录 |
| `WALKER_DATA_DIR` | `~/.walker` | 数据存储目录 |
| `WALKER_WSL_DISTRO` | `Ubuntu-24.04` | WSL 发行版名称 |
| `OPENCODE_SERVER_URL` | 空 | opencode serve 地址，WSL 模式自动探测 IP |
| `OPENCODE_SERVER_AUTOSTART` | `true` | opencode serve 未启动时自动启动 |
| `OPENCODE_CMD` | `opencode` | opencode CLI 命令名 |
| `OPENCODE_MODEL` | 空 | 指定模型 |
| `OPENCODE_AGENT` | 空 | 指定 agent |

## 飞书后台要求

- 应用类型：自建应用
- 已开启机器人能力
- 事件订阅方式：`使用长连接接收事件/回调`
- 已订阅 `im.message.receive_v1`
- 权限包含单聊或群聊消息读取能力
- 发布应用版本后生效
- 机器人被拉进目标群或用户直接单聊

## 命令

| 命令 | 说明 |
|------|------|
| `/new [agent] [title]` | 创建新 Walker session 并绑定当前会话 |
| `/list` | 查看所有 session（含卡片按钮） |
| `/use <session_id>` | 绑定当前会话到指定 session |
| `/use off` | 清除当前会话绑定 |
| `/current` | 查看当前绑定的 session |
| `/stop` | 停止当前 session |
| `/delete <session_id>` | 删除指定 session |
| `/agents` | 列出可用 Agent 类型 |
| `/help` | 命令帮助 |

## Agent 扩展

| Agent | 状态 | 说明 |
|-------|------|------|
| `opencode` | P0 已实现 | 通过 `opencode serve` HTTP API/SSE 控制 |
| `claude` | 预留扩展点 | Claude Code CLI，未来实现 |
| `codex` | 预留扩展点 | Codex CLI，未来实现 |

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
- AgentDriver 抽象支持多 CLI 扩展
- ProgressCard 结构化卡片实时更新
