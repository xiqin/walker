# Walker 飞书多 Agent CLI 桥接器 — 需求规格

## 1. 概述

**需求来源**：用户澄清后的需求 — 不依赖 opendray，按 opendray 和 cc-connect 的设计思路重新实现一套可从飞书操控电脑端 AI Agent CLI 会话的桥接器。  
**需求类型**：新增 + 重构（将当前 MVP 从 opendray bridge adapter 改造为独立 Walker Agent Hub）  
**选定方案**：方案 A — 单进程本地 Agent Hub + 可插拔 Agent Driver + 飞书长连接入口

### 1.1 背景

现有 MVP 是 `feishu-opendray-bridge`：飞书长连接收到消息后转发到 opendray bridge channel，再由 opendray 管理 session 和 PTY。用户明确表示不需要 opendray 那么复杂的功能，希望借鉴其思想，重新实现一套更轻量、直接、可扩展的系统。

因此本项目不再使用：

- opendray bridge WebSocket
- opendray REST `/api/v1/sessions`
- opendray Hub 的 `/select` / `activeSess` 路由
- opendray 的 PTY session 管理

本项目需要自行实现：

- 飞书会话线索与本地 Agent session 的精准绑定
- Agent CLI 子进程或本地 server 生命周期管理
- 多 Agent 类型扩展（opencode、Claude Code、Codex 等）
- 卡片、按钮、进度更新、附件、命令系统
- Windows 原生与 WSL 双运行环境兼容

### 1.2 产品定位

Walker — IM 工具与 AI agent CLI 的多路复用。核心价值是打通 IM 与本机 AI Agent 的调用链，让个人开发者随时随地通过飞书操控电脑上的 agent。

### 1.3 核心架构

```text
飞书开放平台
  ├─ WebSocket 长连接事件：im.message.receive_v1 / card.action.trigger
  └─ REST OpenAPI：发消息 / 发卡片 / Patch卡片 / 上传附件 / 表情
        ▲
        │
        ▼
Walker 本地 Agent Hub（Node.js 单进程）
  ├─ Platform 层：FeishuPlatform
  ├─ Router 层：routeKey → walkerSessionId 精准绑定
  ├─ Session 层：WalkerSession 生命周期、历史、状态、持久化
  ├─ Agent Driver 层：OpencodeDriver / ClaudeCodeDriver / CodexDriver
  ├─ Runtime 层：WindowsRuntime / WslRuntime
  └─ UI 层：飞书卡片渲染、按钮、进度更新、附件
        │
        ├─ opencode：opencode serve + HTTP API/SSE（推荐）
        ├─ Claude Code：stream-json stdio（后续）
        └─ Codex：按其 CLI 协议实现 driver（后续）
```

### 1.4 关键结论

1. **直连方式能解决多会话精准匹配**：由 Walker Hub 自己维护 `routeKey -> walkerSessionId` 映射，不依赖外部 Hub。
2. **直连方式能扩展多 CLI**：定义统一 `AgentDriver` 接口，不同 CLI 的协议差异封装在 driver 内。
3. **opencode 推荐接入方式是 HTTP/SSE，不是 PTY**：opencode 没有 Claude Code 那种双向 stream-json stdio；`opencode run --format json` 是 one-shot 单向 NDJSON。多轮会话首选 `opencode serve` + HTTP API + SSE。
4. **Claude Code 推荐接入方式是 stream-json stdio**：后续 Claude driver 可复用 cc-connect 的思路。
5. **PTY 作为最后兜底**：仅当某个 CLI 无结构化协议时使用 PTY，避免默认依赖 ANSI 解析。

## 2. 方案对比

### 方案 A：单进程本地 Agent Hub + 可插拔 Driver（推荐）

**架构思路**：Node.js 进程同时承担飞书平台入口、会话路由、Agent session 管理和 Agent driver 调度。opencode driver 启动/连接本机 `opencode serve`，通过 HTTP API 发送 prompt，通过 SSE 获取事件。

**数据流**：

```text
飞书消息 → FeishuPlatform → Router(routeKey) → WalkerSession → AgentDriver.prompt()
Agent事件 → WalkerSession聚合 → FeishuRenderer → 飞书卡片 Patch/消息回复
```

**优点**：

- 架构最轻，适合个人开发者本机使用。
- 多会话匹配完全由本项目掌控，精准且可持久化。
- Driver 抽象后可扩展 opencode、Claude Code、Codex。
- 不需要维护额外后端服务或 DB 依赖，初期 JSON 文件即可。
- 保留后续演进为 HTTP 服务的空间。

**缺点**：

- 当前进程同时承担平台和 session 管理，未来多平台/多用户规模扩大时需要拆分。
- 若多个飞书 bot 或多个平台同时接入，需要加强并发与锁。

**适用性**：当前个人开发者 + 飞书 + 本机 agent 场景最匹配。

### 方案 B：自建轻量 session 服务 + 飞书 adapter

**架构思路**：拆成本地 Walker Core 服务和 Feishu Adapter。Core 提供 REST/WS 管理 session，adapter 只负责飞书协议翻译。

**优点**：

- 更像迷你 opendray，边界清晰。
- 后续多平台、多前端复用同一个 Core 更方便。
- 可提供 Web UI 或本地 API。

**缺点**：

- 对当前目标过度设计。
- 需要处理服务发现、鉴权、端口、进程守护、协议版本。
- 实现成本接近重新造一个 opendray 子集。

**适用性**：后续要支持多个 IM 平台、Web 控制台或团队使用时再演进。

### 方案 C：纯 PTY 桥接

**架构思路**：每个 session 启动一个 PTY，运行 `opencode` / `claude` / `codex` TUI，解析输出并向飞书转发。

**优点**：

- 通用性强，任何 CLI 都能跑。
- 看起来最接近“电脑端终端会话”。

**缺点**：

- ANSI/TUI 输出解析困难，交互状态不稳定。
- 难以可靠识别工具调用、完成状态、token、错误。
- Windows/WSL PTY 兼容成本高。

**适用性**：仅作为无结构化 API 的 Agent driver 兜底方案。

### 推荐决策

采用**方案 A**。当前系统先做单进程 Agent Hub，但内部边界按 Core/Platform/Driver/Runtime 划分，避免未来无法演进。

## 3. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | 移除 opendray 依赖 | P0 | 给定项目启动，当运行适配器时，不连接 opendray bridge WS，不调用 opendray REST API |
| REQ-002 | 飞书长连接入口 | P0 | 给定飞书应用配置正确，当用户发文本消息，则本地进程收到 `im.message.receive_v1` 并解析 chatId/messageId/openId/text |
| REQ-003 | routeKey 生成 | P0 | 给定飞书消息，当 `FEISHU_ROUTE_MODE=thread/user/channel`，则分别生成 thread/user/channel 隔离的 routeKey |
| REQ-004 | 多会话精准绑定 | P0 | 给定多个 Walker session，当不同 routeKey 绑定不同 session，则后续消息分别进入对应 Agent session，不串线 |
| REQ-005 | `/new` 创建 Walker session | P0 | 给定飞书发送 `/new [agent] [name]`，则创建新的 Walker session 并自动绑定当前 routeKey |
| REQ-006 | `/list` 会话卡片 | P0 | 给定飞书发送 `/list`，则返回飞书交互卡片列出 session，包含绑定、继续、停止、删除按钮 |
| REQ-007 | 卡片按钮回调 | P0 | 给定用户点击 `/list` 卡片按钮，则 `card.action.trigger` 被处理并执行对应命令 |
| REQ-008 | `/use <session>` 绑定 | P0 | 给定飞书发送 `/use <id>`，当 session 存在，则当前 routeKey 绑定该 session |
| REQ-009 | `/current` 查看绑定 | P0 | 给定飞书发送 `/current`，则返回当前 routeKey 绑定的 session、agent、cwd、状态 |
| REQ-010 | opencode driver | P0 | 给定创建 opencode session，当发送 prompt，则通过 opencode HTTP API 投递到指定 opencode session，并接收 SSE 事件 |
| REQ-011 | opencode server 管理 | P0 | 给定 `opencode serve` 未启动，当首次使用 opencode driver，则自动启动或提示启动；给定已启动，则复用 server |
| REQ-012 | opencode session 持久化 | P0 | 给定 Walker session 关联 opencode sessionID，当进程重启后，仍可用 `--session`/HTTP API 恢复同一 opencode session |
| REQ-013 | 飞书 reply 线程回复 | P0 | 给定 Agent 输出文本，当回复飞书时，使用原消息 message_id 的 reply API 挂到线程下 |
| REQ-014 | card 进度样式 | P1 | 给定 Agent 运行中产生多段事件，则飞书端显示一张持续 Patch 更新的进度卡片 |
| REQ-015 | AgentDriver 抽象 | P1 | 给定新增 Agent 类型，只需实现统一 Driver 接口，不改 FeishuPlatform 和 Router 核心逻辑 |
| REQ-016 | Runtime 抽象 | P1 | 给定 session 配置 runtime=windows/wsl，则分别用 Windows 原生命令或 `wsl.exe -d <distro>` 启动 Agent |
| REQ-017 | 会话状态管理 | P1 | session 状态支持 created/running/idle/stopped/error/deleted，并在 `/list` 中展示 |
| REQ-018 | 会话持久化 | P1 | route 绑定、Walker session、Agent session 元数据保存到本地 JSON 文件，进程重启后恢复 |
| REQ-019 | 消息去重 | P1 | 飞书 5 分钟内重投同 message_id 时，适配器不重复投递给 Agent |
| REQ-020 | `/stop` 停止当前 turn/session | P1 | 给定飞书发送 `/stop`，则停止当前 session 的进行中任务或关闭 driver 会话 |
| REQ-021 | `/delete <id>` 删除会话 | P1 | 给定飞书发送 `/delete <id>`，则删除 Walker session 记录，并按 driver 能力删除/归档底层 session |
| REQ-022 | `/help` 命令说明 | P1 | 给定飞书发送 `/help`，则返回支持的命令与示例 |
| REQ-023 | 文件/图片入站 | P2 | 给定飞书图片/文件消息，则下载到 session attachments 目录，并作为 prompt 附件或路径传给 driver |
| REQ-024 | 文件/图片出站 | P2 | 给定 driver 产生图片/文件路径，则上传到飞书并发送给用户 |
| REQ-025 | reaction/done emoji | P2 | 给定配置表情，收到消息时加处理中表情，Agent 完成时加完成表情 |
| REQ-026 | Claude Code driver 预留 | P2 | 架构中保留 ClaudeCodeDriver 接口与配置位，后续可用 stream-json stdio 实现 |
| REQ-027 | Codex driver 预留 | P2 | 架构中保留 CodexDriver 接口与配置位，后续可按 Codex CLI 协议实现 |
| REQ-028 | README 与配置文档 | P1 | README 描述安装、飞书配置、Windows/WSL runtime、opencode server、命令清单 |

## 4. 接口/API 设计

### 4.1 AgentDriver 接口

```typescript
interface AgentDriver {
  id: string
  displayName: string

  ensureReady(config: AgentConfig): Promise<void>

  createSession(input: CreateAgentSessionInput): Promise<AgentSessionRef>

  resumeSession(ref: AgentSessionRef): Promise<void>

  prompt(input: AgentPromptInput): AsyncIterable<AgentEvent>

  stop(ref: AgentSessionRef): Promise<void>

  delete(ref: AgentSessionRef): Promise<void>
}
```

### 4.2 AgentEvent

```typescript
type AgentEvent =
  | { type: 'status'; status: 'running' | 'idle' | 'error'; message?: string }
  | { type: 'text'; text: string; delta?: boolean }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; name: string; input?: unknown; output?: unknown; status: 'running' | 'done' | 'error' }
  | { type: 'file'; path: string; filename?: string; mime?: string }
  | { type: 'image'; path: string; caption?: string }
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'done'; usage?: AgentUsage }
```

### 4.3 WalkerSession

```typescript
interface WalkerSession {
  id: string
  title: string
  agent: 'opencode' | 'claude' | 'codex'
  status: 'created' | 'running' | 'idle' | 'stopped' | 'error' | 'deleted'
  runtime: 'windows' | 'wsl'
  cwd: string
  routeKeys: string[]
  agentRef: AgentSessionRef
  createdAt: string
  updatedAt: string
  lastMessageAt?: string
}
```

### 4.4 RouteBinding

```typescript
interface RouteBinding {
  routeKey: string
  platform: 'feishu'
  chatId: string
  openId?: string
  rootId?: string
  walkerSessionId: string
  updatedAt: string
}
```

### 4.5 OpencodeDriver 接入方式

opencode 不提供双向 stream-json stdio。推荐使用：

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Driver 通过 HTTP API 完成：

- 创建 session
- 对指定 session 发送 prompt
- 订阅 SSE 事件
- 查询消息历史
- 停止/删除 session（按 opencode API 能力）

若 server 未启动，Driver 行为由配置控制：

| 配置 | 行为 |
| ---- | ---- |
| `OPENCODE_SERVER_AUTOSTART=true` | 自动 spawn `opencode serve` |
| `OPENCODE_SERVER_AUTOSTART=false` | 返回明确错误，提示用户手动启动 |

## 5. 数据设计

### 5.1 本地数据目录

默认目录：`%USERPROFILE%\.walker` 或 `$HOME/.walker`

```text
.walker/
  sessions.json
  routes.json
  messages/
    <walkerSessionId>.jsonl
  attachments/
    <walkerSessionId>/
  logs/
    adapter.log
```

### 5.2 sessions.json

```json
{
  "sessions": [
    {
      "id": "wks_...",
      "title": "修复登录bug",
      "agent": "opencode",
      "status": "idle",
      "runtime": "wsl",
      "cwd": "/home/user/project",
      "routeKeys": ["feishu:oc_xxx:root:om_xxx"],
      "agentRef": {
        "driver": "opencode",
        "sessionId": "ses_0bb...",
        "serverUrl": "http://127.0.0.1:4096"
      },
      "createdAt": "2026-07-09T00:00:00.000Z",
      "updatedAt": "2026-07-09T00:10:00.000Z"
    }
  ]
}
```

### 5.3 routes.json

```json
{
  "bindings": [
    {
      "routeKey": "feishu:oc_xxx:root:om_xxx",
      "platform": "feishu",
      "chatId": "oc_xxx",
      "openId": "ou_xxx",
      "rootId": "om_xxx",
      "walkerSessionId": "wks_...",
      "updatedAt": "2026-07-09T00:10:00.000Z"
    }
  ]
}
```

## 6. 配置设计

### 6.1 .env

```text
# 飞书凭据；未配置时可继续从 ~/.cc-connect/config.toml 读取
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
CC_CONNECT_CONFIG=C:\Users\tianxiqin\.cc-connect\config.toml

# routeKey 模式：thread | user | channel
FEISHU_ROUTE_MODE=thread

# 默认 Agent
WALKER_DEFAULT_AGENT=opencode
WALKER_DEFAULT_RUNTIME=wsl
WALKER_DEFAULT_CWD=/home/user/project

# 数据目录
WALKER_DATA_DIR=C:\Users\tianxiqin\.walker

# WSL runtime
WALKER_WSL_DISTRO=Ubuntu-24.04

# opencode driver
OPENCODE_SERVER_URL=http://127.0.0.1:4096
OPENCODE_SERVER_AUTOSTART=true
OPENCODE_CMD=opencode
OPENCODE_MODEL=
OPENCODE_AGENT=

# 飞书体验
FEISHU_PROGRESS_STYLE=card
FEISHU_REACTION_EMOJI=OnIt
FEISHU_DONE_EMOJI=Done
```

### 6.2 Windows / WSL runtime

`runtime=windows`：

```text
opencode serve --hostname 127.0.0.1 --port 4096
```

`runtime=wsl`：

```text
wsl.exe -d Ubuntu-24.04 -- opencode serve --hostname 127.0.0.1 --port 4096
```

WSL server 暴露给 Windows 侧 Node.js 的访问方式需实测：

- 优先尝试 `http://127.0.0.1:4096`
- 若失败，通过 `wsl.exe -d <distro> hostname -I` 获取 WSL IP，使用 `http://<wsl-ip>:4096`

## 7. 命令系统

| 命令 | 处理方 | 说明 |
| ---- | ------ | ---- |
| `/new [agent] [title]` | Walker | 新建 session 并绑定当前飞书 routeKey |
| `/list` | Walker | 展示 session 卡片列表 |
| `/use <sessionId>` | Walker | 当前 routeKey 绑定已有 session |
| `/use off` | Walker | 解除当前 routeKey 绑定 |
| `/current` | Walker | 查看当前绑定 session |
| `/stop [sessionId]` | Walker/Driver | 停止当前任务或 session |
| `/delete <sessionId>` | Walker/Driver | 删除 session |
| `/agents` | Walker | 查看可用 Agent driver |
| `/runtime` | Walker | 查看当前 runtime 配置 |
| `/help` | Walker | 帮助 |

## 8. 业务规则

1. **routeKey 是飞书线索唯一键**：thread 模式优先 root_id，其次 parent_id，最后 message_id。
2. **多会话精准匹配由 RouteBinding 保证**：每个 routeKey 同时最多绑定一个 Walker session；一个 Walker session 可绑定多个 routeKey。
3. **未绑定消息处理**：若当前 routeKey 未绑定 session，普通文本不自动创建 session；返回提示卡片，提供“新建 session”和“选择已有 session”按钮。
4. **`/new` 自动绑定**：新建成功后，当前 routeKey 立即绑定新 session。
5. **AgentDriver 不暴露平台细节**：driver 只产出 AgentEvent；飞书卡片由 Platform/UI 层渲染。
6. **平台层不依赖具体 Agent**：FeishuPlatform 不直接调用 opencode，仅调用 WalkerSessionService。
7. **错误必须可诊断**：所有 driver 错误包含 agent、runtime、cwd、command/serverUrl。
8. **card 进度样式默认开启**：一个用户 prompt 对应一张进度卡片，事件到达时 Patch 更新，完成时定稿。

## 9. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| opencode 未安装 | `/new` 返回安装提示：npm i -g opencode-ai 或 choco/scoop |
| opencode serve 启动失败 | 返回命令、exit code、stderr 摘要 |
| WSL 不存在指定 distro | 返回 `wsl.exe -l -v` 排查提示 |
| routeKey 未绑定且用户发普通消息 | 返回引导卡片，不把消息丢给任意 session |
| session 正在运行又收到新消息 | 默认排队；若配置禁止并发，则提示当前 session 忙 |
| 飞书重复投递 message_id | 5 分钟内去重，不重复 prompt |
| 卡片 Patch 失败 | 降级发送新消息，并记录日志 |
| Driver SSE 中断 | 标记 session error，提示用户 `/use` 后重试或 `/new` |
| 进程重启 | 从 sessions.json/routes.json 恢复绑定和 session 元数据 |

## 10. 非目标

- 本次不实现 opendray 兼容层。
- 本次不实现完整 Web 管理后台。
- 本次不实现团队多租户权限系统。
- 本次不实现 cron/timer/heartbeat。
- 本次不实现语音消息处理。
- 本次不保证所有 CLI 的 driver 都完成；P0 只要求 opencode driver 可用，Claude/Codex 先保留扩展点。
- 本次不默认使用 PTY 解析 TUI 输出。

## 11. 实现分阶段

### Phase 1：去 opendray 化 + Walker Core 骨架

- 删除 opendray bridge/REST 依赖路径。
- 建立配置模块、日志模块、状态持久化模块。
- 实现 routeKey、RouteBinding、WalkerSession 数据结构。
- 实现飞书消息入口和基础命令 `/help` `/current`。

### Phase 2：多会话与飞书卡片

- 实现 `/new` `/list` `/use` `/use off` `/delete`。
- 实现飞书 interactive card 渲染。
- 实现 `card.action.trigger` 回调。
- 实现 routeKey → WalkerSession 精准绑定与持久化。

### Phase 3：OpencodeDriver

- 实现 opencode server 检测与 autostart。
- 实现 opencode HTTP API client。
- 实现 opencode session create/resume/prompt。
- 实现 SSE 事件转 AgentEvent。
- 实现 card 进度样式 Patch 更新。

### Phase 4：运行环境兼容

- 实现 WindowsRuntime。
- 实现 WslRuntime。
- 支持 WSL IP 探测与 serverUrl 自动推导。
- README 增加 Windows/WSL 配置说明。

### Phase 5：功能完善与扩展点

- 消息去重。
- 文件/图片入站与出站。
- reaction/done emoji。
- ClaudeCodeDriver/CodexDriver 骨架与文档。
- 测试与验证报告。

## 12. 验收标准

1. 在无 opendray 运行的环境下，`npm start` 可启动 Walker 飞书桥接器。
2. 飞书发送 `/help` 可收到命令说明。
3. 飞书发送 `/new opencode 测试会话` 可创建 Walker session，并创建或恢复 opencode session。
4. 飞书普通消息可进入绑定的 opencode session，并收到 opencode 输出回复。
5. 两个不同飞书 thread 分别 `/new` 后，消息不会串到对方 session。
6. 飞书发送 `/list` 可看到卡片列表，并通过按钮切换绑定。
7. 进程重启后，`/current` 仍能显示之前绑定的 session。
8. Windows 原生 runtime 和 WSL runtime 至少各完成一次冒烟测试，或明确记录未验证原因。
9. `npm run check` 通过。
