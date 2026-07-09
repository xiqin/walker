# Walker 飞书多 Agent CLI 桥接器设计方案

> 状态：新方向设计稿  
> 核心决策：不依赖 opendray，独立实现本地 Agent Hub  
> 规格文档：`specs/2026-07-09-feishu-opendray-bridge/spec.md`

## 1. 方向调整

原方案基于 opendray bridge channel 和 opendray REST sessions API：飞书适配器只做平台协议翻译，session 路由、PTY 管理、`/select`、`/list` 等能力由 opendray Hub 提供。

用户已明确否定该方向：不需要 opendray 的复杂能力，目标是**借鉴 opendray 和 cc-connect 的思路，重新实现一套更轻量、更直接、可扩展到多个 Agent CLI 的系统**。

因此新方案中不再使用：

- opendray bridge WebSocket
- opendray REST API
- opendray Hub 路由
- opendray PTY session 管理

新方案自行实现：

- 飞书 routeKey 与本地 Agent session 的精准绑定
- Walker session 生命周期和持久化
- opencode / Claude Code / Codex 等 Agent Driver 扩展接口
- Windows 原生与 WSL runtime
- 飞书卡片、按钮、进度更新、附件、表情

## 2. 推荐架构

采用**单进程本地 Agent Hub + 可插拔 Agent Driver**。

```text
飞书开放平台
  ├─ WebSocket 长连接：im.message.receive_v1 / card.action.trigger
  └─ REST OpenAPI：send/reply/card/patch/upload/reaction
        ▲
        │
        ▼
Walker 本地 Agent Hub（Node.js）
  ├─ Platform：FeishuPlatform
  ├─ Router：routeKey → walkerSessionId
  ├─ Session：WalkerSession 生命周期、状态、持久化
  ├─ Driver：OpencodeDriver / ClaudeCodeDriver / CodexDriver
  ├─ Runtime：WindowsRuntime / WslRuntime
  └─ UI：飞书卡片渲染、按钮回调、进度卡片 Patch
        │
        ├─ opencode：opencode serve + HTTP API/SSE
        ├─ Claude Code：stream-json stdio（后续）
        └─ Codex：按 Codex CLI 协议实现（后续）
```

## 3. 为什么直连方式可行

### 3.1 多会话精准匹配

直连并不意味着会话会串。Walker Hub 自己维护：

```text
routeKey → walkerSessionId → agentRef
```

routeKey 可按三种模式生成：

- `thread`：`feishu:{chatId}:root:{rootId}`
- `user`：`feishu:{chatId}:{openId}`
- `channel`：`feishu:{chatId}`

每条飞书线索最多绑定一个 Walker session；一个 Walker session 可被多个 routeKey 绑定。`/new` 创建后自动绑定当前 routeKey，`/use <id>` 可手动切换绑定，`/list` 卡片按钮可完成同样操作。

### 3.2 多 CLI 扩展

通过 `AgentDriver` 隔离不同 CLI 协议：

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

平台层只消费统一的 `AgentEvent`，不关心底层是 HTTP、stdio、SSE 还是 PTY。

## 4. opencode 接入方式

研究结论：opencode 不支持 Claude Code 那种双向 `--input-format stream-json --output-format stream-json` stdio 协议。

opencode 的可用方式：

- `opencode run "prompt" --format json`：one-shot 单向 NDJSON 输出，不适合长期多轮桥接。
- `opencode acp`：ACP JSON-RPC over stdio，主要供 IDE 集成。
- `opencode serve`：无头 HTTP server + SSE，最适合程序化多轮控制。

因此 P0 采用：

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Walker 的 `OpencodeDriver` 负责：

- 检测 server 是否可用
- 按配置自动启动 server 或提示用户启动
- 创建 / 恢复 opencode session
- 发送 prompt 到指定 session
- 订阅 SSE 并转换为统一 `AgentEvent`
- 记录 opencode sessionID 到 `WalkerSession.agentRef`

## 5. Runtime 兼容

支持两种 runtime：

### Windows 原生

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

适合 opencode 已通过 `npm install -g opencode-ai`、Scoop 或 Chocolatey 安装在 Windows 的场景。

### WSL

```bash
wsl.exe -d Ubuntu-24.04 -- opencode serve --hostname 0.0.0.0 --port 4096
```

Walker 先尝试访问 `127.0.0.1:4096`，失败时通过 `wsl.exe -d <distro> hostname -I` 获取 WSL IP，再访问 `http://<wsl-ip>:4096`。

## 6. 本地数据

默认目录：`%USERPROFILE%\.walker` 或 `$HOME/.walker`。

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

### sessions.json

保存 Walker session 与底层 Agent session 的映射：

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
      }
    }
  ]
}
```

### routes.json

保存飞书线索到 Walker session 的绑定：

```json
{
  "bindings": [
    {
      "routeKey": "feishu:oc_xxx:root:om_xxx",
      "platform": "feishu",
      "chatId": "oc_xxx",
      "openId": "ou_xxx",
      "rootId": "om_xxx",
      "walkerSessionId": "wks_..."
    }
  ]
}
```

## 7. 命令系统

| 命令 | 说明 |
| ---- | ---- |
| `/new [agent] [title]` | 新建 session 并绑定当前飞书线索 |
| `/list` | 展示 session 卡片列表 |
| `/use <sessionId>` | 当前飞书线索绑定已有 session |
| `/use off` | 解除当前飞书线索绑定 |
| `/current` | 查看当前绑定 session |
| `/stop [sessionId]` | 停止当前任务或 session |
| `/delete <sessionId>` | 删除 session |
| `/agents` | 查看可用 Agent driver |
| `/runtime` | 查看 runtime 配置 |
| `/help` | 命令说明 |

未绑定 routeKey 收到普通消息时，不自动投递到任意 session；返回引导卡片，让用户选择 `/new` 或 `/use`，避免串线。

## 8. 实施阶段

1. **去 opendray 化 + Core 骨架**：删除 bridge/REST 假设，建立配置、日志、持久化、route/session 模型。
2. **多会话与飞书卡片**：实现 `/new`、`/list`、`/use`、按钮回调和绑定持久化。
3. **OpencodeDriver**：实现 `opencode serve` 检测/自启、HTTP client、SSE→AgentEvent、进度卡片 Patch。
4. **Runtime 兼容**：WindowsRuntime、WslRuntime、WSL IP 探测。
5. **功能完善**：去重、附件、reaction/done emoji、Claude/Codex driver 骨架、README 与测试。

## 9. 风险

- opencode HTTP API 的具体 SDK/endpoint 需要在实现阶段以当前安装版本验证。
- WSL server 暴露到 Windows 的地址在不同网络配置下可能不同，需要自动探测和清晰错误提示。
- 飞书卡片 Patch API 需要保存已发送卡片 message_id；Patch 失败时必须降级新发消息。
- Claude Code 与 Codex driver 只做扩展点，不能让 P0 依赖它们。
