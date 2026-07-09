# feishu-opendray-bridge

本机飞书长连接到 opendray bridge channel 的适配器。

目标：不需要公网域名，让飞书消息通过长连接进入本机 opendray session。

## 运行

先在 opendray 中创建 `kind=bridge` channel，并拿到 token，然后运行：

```powershell
$env:OPENDRAY_BRIDGE_TOKEN="你的 bridge token"
npm start
```

后台启动/停止/查看状态：

```powershell
.\scripts\start.ps1
.\scripts\status.ps1
.\scripts\logs.ps1
.\scripts\stop.ps1
```

后台日志写入 `logs\adapter.out.log` 和 `logs\adapter.err.log`。

也可以在项目根目录创建 `.env`：

```text
OPENDRAY_BRIDGE_TOKEN=你的 bridge token
```

默认配置：

- cc-connect 配置：`C:\Users\tianxiqin\.cc-connect\config.toml`
- opendray bridge WebSocket：默认自动读取 `Ubuntu-24.04` 的 WSL IP 并连接 `:8770`
- 飞书凭据字段：读取第一个 `app_id` / `app_secret`

可选环境变量：

- `CC_CONNECT_CONFIG`：指定 cc-connect 配置路径
- `OPENDRAY_WSL_DISTRO`：指定运行 opendray 的 WSL 发行版，默认 `Ubuntu-24.04`
- `OPENDRAY_BRIDGE_URL`：指定 opendray bridge WebSocket 地址
- `OPENDRAY_API_BASE`：指定 opendray HTTP API 地址，默认由 bridge WebSocket 地址推导
- `OPENDRAY_ADMIN_USER` / `OPENDRAY_ADMIN_PASSWORD`：用于查询 session 列表
- `OPENDRAY_BRIDGE_TOKEN`：opendray bridge channel token，必填
- `FEISHU_ROUTE_MODE`：`thread` 或 `user`，默认 `thread`

## 当前本机配置

- opendray bridge channel：`ch_pENUsahukU5d`
- bridge 名称：`feishu-long-connection`
- 当前用户登录自启：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\feishu-opendray-bridge.cmd`

## 飞书后台要求

需要在飞书开放平台确认：

- 应用类型是自建应用。
- 已开启机器人能力。
- `事件与回调` 的订阅方式选择 `使用长连接接收事件/回调`。
- 已订阅 `消息与群组 -> 接收消息 v2.0`，事件名是 `im.message.receive_v1`。
- 权限至少包含单聊消息或群聊消息读取能力；如果只允许群里 @ 机器人，则群聊里需要 @ 机器人。
- 修改事件或权限后需要发布应用版本。
- 机器人需要被拉进目标群，或用户直接和机器人单聊。

如果适配器日志只有 `ws client ready`，但发飞书消息没有 `forwarded feishu message to opendray`，优先检查以上飞书后台配置。

## 当前 MVP 能力

- 飞书长连接接收 `im.message.receive_v1`
- 文本消息转发到 opendray bridge
- opendray 文本回复发送回飞书原消息线程
- 自动重连 opendray bridge WebSocket

当前按线程隔离会话：同一条飞书消息线程的回复会进入同一个 opendray session，不同线程不会串。修改 `.env` 的 `FEISHU_ROUTE_MODE=user` 可改成按用户隔离。

飞书内置命令：

- `/sessions`：查看当前 opendray session 列表。
- `/use <session_id>`：把当前飞书线程绑定到指定 opendray session。
- `/use off`：清除当前飞书线程绑定。

如果当前只有一个未结束的 opendray session，普通消息会自动绑定到它；如果有多个 session，请先用 `/use <session_id>` 明确选择，避免串线。

后续可扩展：卡片按钮、消息更新、图片、文件、多项目路由。
