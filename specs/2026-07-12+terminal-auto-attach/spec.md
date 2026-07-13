# OpenCode 启动自动纳入 Walker 规格（Hook + 1:N Session 路由）

## 背景

Walker 当前支持两类 OpenCode 接入：

- 飞书 `/new` 创建 Walker session 后，Walker 自动打开终端并执行 `opencode attach <server> -s <session_id>`。
- 用户手动在终端启动 OpenCode 时，需要回到飞书使用 `/attach` 手动纳入 Walker。

用户需求：在 OpenCode 启动时自动纳入 Walker，无需飞书命令干预；OpenCode 关闭时自动取消当前关联 turn。核心难点：

1. Walker 必须可靠知道该 OpenCode 进程应绑定到哪个飞书会话。
2. 同一 `cwd` 启动多个 OpenCode 处理不同任务时，消息要精准回到对应 session，不能串会话。
3. OpenCode 退出时不能误删仍需由飞书继续控制的 session。

## 产品目标

- Walker 启动时自动安装 OpenCode plugin（一次安装永久生效），后续用户照常启动 `opencode` 即可自动纳入。
- 支持 1:N session 路由：同一 routeKey 下可绑定多个 OpenCode session，通过"焦点 session"机制保证消息精准路由。
- 非焦点 session 的输出也回流到飞书群，带 session 标识区分。
- OpenCode 退出时自动取消该 session 的 turn，从 route 移除，若是焦点则自动切换。
- 全程无飞书命令干预即可自动纳入；飞书端可查看状态、切换焦点、继续控制。

## Requirement IDs

| ID | 需求 |
| --- | --- |
| REQ-001 | Walker 启动时自动写入 hook plugin 到 `~/.config/opencode/plugins/walker-hook.js`（不覆盖已存在文件）。 |
| REQ-002 | 新增 HTTP 端点接收 plugin 上报 `{ opencodeBaseUrl, sessionId, cwd }`，按 cwd 找 routeKey 创建 Walker session 并加入 route 的 1:N sessions 列表。 |
| REQ-003 | SessionService routes 结构从 `{ routeKey: sessionId }` 升级为 `{ focusSessionId, sessions[], cwd }`，新增 addSessionToRoute/setFocus/removeSessionFromRoute/listSessionsInRoute，getCurrent 返回焦点 session，旧格式自动迁移。 |
| REQ-004 | message-dispatcher 的 `/use` 改切焦点、`/list` 列 route 下所有 session、非焦点 session 输出回群带标识。 |
| REQ-005 | 每 session 独立心跳轮询 `/global/health` 检测 OpenCode detached，取消该 session turn 并从 route 移除，自动切焦点。 |
| REQ-006 | 飞书卡片 `/list` 加"设为焦点"按钮。 |
| REQ-007 | 新增配置：WALKER_OPENCODE_HOOK_ENABLED、WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS、WALKER_OPENCODE_EXIT_ACTION、WALKER_OPENCODE_NON_FOCUS_OUTPUT。 |
| REQ-008 | `/status` 显示 route 下多 session 状态、focus、attached/detached。 |
| REQ-009 | 安全约束：只接受本机 loopback 请求，复用 admin token 保护。 |
| REQ-010 | README 更新 1:N session 路由说明、hook plugin 说明、退出行为和配置说明。 |

## 推荐方案：Hook Plugin + 1:N Session 路由

### 用户流程

1. Walker 启动时自动将 hook plugin 写入 `~/.config/opencode/plugins/walker-hook.js`（不存在时写入，已存在不覆盖）。
2. 用户在飞书群正常发消息，Walker 创建 Walker session，记录 routeKey ↔ cwd 关联。
3. 用户在本机终端照常启动 `opencode`。
4. OpenCode 加载全局 plugin，触发 `session.created` 事件。
5. plugin 上报 `{ opencodeBaseUrl, sessionId, cwd }` 给 Walker。
6. Walker 按 `cwd` 找到 routeKey，创建 Walker session，`addSessionToRoute` 加入 route 的 sessions 列表（不动 focusSessionId，除非是第一个）。
7. 同 `cwd` 启动第二个 OpenCode → 新建 Walker session，加入同一 routeKey 的 sessions 列表。
8. 普通消息发给焦点 session，输出回到原 routeKey。
9. 非焦点 session 的 SSE 事件主动回卡片到群里，带 `[session: wks_N]` 标识。
10. 用户用 `/use <id>` 或 `/list` 卡片"设为焦点"按钮切换焦点。
11. OpenCode 退出 → 心跳检测 detached → 取消该 session turn，从 route 移除，若是焦点自动切到下一个活跃 session。

### 数据流

```text
Walker 启动
  -> 检查 ~/.config/opencode/plugins/walker-hook.js
  -> 不存在则写入 plugin 文件

飞书用户发消息
  -> Walker 创建 session，记录 routeKey ↔ cwd 关联

用户启动 opencode
  -> OpenCode 加载 plugin
  -> plugin 监听 session.created
  -> POST /opencode/hook/session-created { opencodeBaseUrl, sessionId, cwd }
  -> Walker 按 cwd 找 routeKey
  -> 找到：创建 Walker session，addSessionToRoute
  -> 未找到：创建游离 session（等用户建联）

普通消息
  -> getCurrent(routeKey) 返回焦点 session
  -> driver.prompt(agentRef, text)
  -> 输出经 _renderEvents 回原 routeKey

非焦点 session SSE 事件
  -> watchSession 监听到事件
  -> 回卡片到同一 routeKey，带 [session: wks_N] 标识

OpenCode 退出
  -> 心跳轮询 /global/health 超时
  -> 取消该 session turn
  -> removeSessionFromRoute
  -> 若是焦点，setFocus 到下一个活跃 session
```

### 为什么选择该方案

- OpenCode 原生支持 plugin，启动自动加载，无需劫持 PATH 或安装 wrapper。
- Walker 启动时自动安装 plugin，用户无感知。
- 1:N session 路由解决同 cwd 多 OpenCode 串会话问题，session 本身不变，driver 层不改。
- 焦点机制保证默认消息路由零改动，多 session 时用户主动切换。
- 非焦点 session 输出回群带标识，用户可区分来源。
- 每个 OpenCode 独立 SSE 流和心跳，互不影响。
- OpenCode 退出只取消该 session turn，不影响其他 session 和飞书 route。

## 备选方案

### 方案 B：Wrapper/Shim 劫持 PATH

一次安装 wrapper 包装 `opencode` 命令。

Trade-off：需劫持 PATH，跨平台风险高；依赖 Walker 源码在本机；进程生命周期管理脆弱；需用户手动安装。不采用。

### 方案 C：飞书生成一次性绑定票据

用户每次在飞书发送 `/opencode attach`，复制命令到手动终端执行。

Trade-off：route 绑定最精确，但每次都要复制命令，操作比 `/attach` 更复杂。保留为调试兜底方案。

### 方案 D：扫描 OpenCode session 并自动匹配 cwd

Walker 后台定期扫描 OpenCode session，根据 cwd 自动纳入。

Trade-off：实现简单，但无法可靠判断绑定到哪个飞书会话；多个飞书会话或多个项目同时使用时容易误绑定。不采用。

### 方案 E：强制 1:1（第二个 OpenCode 新建 Walker session + 新 routeKey）

Trade-off：同 cwd 的两个 OpenCode 会匹配到同一 routeKey，无法自动新建 routeKey；强行新建导致两个 session 无法通过同一飞书群管理。不采用。

### 方案 F：agentRef 升级为数组（一个 session 挂多个 OpenCode）

Trade-off：SSE 流混在一起无法区分；心跳无法独立判断单个 OpenCode 存活；driver 层改动大。不采用。

## 功能范围

### Plugin 安装

- Walker 启动时检查 `~/.config/opencode/plugins/walker-hook.js`，不存在时自动写入。
- 已存在不覆盖，保留用户现有配置。
- Plugin 监听 `session.created` 事件，上报 `{ opencodeBaseUrl, sessionId, cwd }`。
- Walker 不可达时 plugin 静默忽略，不影响 OpenCode 正常使用。

### Hook Receiver

- 新增 HTTP 端点 `POST /opencode/hook/session-created`。
- 按 `cwd` 找 routeKey（精确匹配优先，子目录次之，多候选取最近活跃）。
- 找到 routeKey → 创建 Walker session，`addSessionToRoute`。
- 未找到 → 创建游离 session（有 cwd 无 route），等用户建联时归入。
- 游离 session 归入：用户在飞书群发消息触发 session 创建时，检查是否有 cwd 匹配的游离 session，有则归入。

### 1:N Session 路由

- route 从 `{ routeKey: sessionId }` 升级为 `{ focusSessionId, sessions[], cwd }`。
- session 本身不变，仍 1 session : 1 agentRef: { opencodeSessionId }。
- `getCurrent(routeKey)` 返回焦点 session。
- 普通消息发给焦点 session，零改动体验。
- 多 session 时 `/use <id>` 切焦点，`/list` 列出所有 session + "设为焦点"按钮。
- 非焦点 session 的 watchSession SSE 事件主动回卡片到群里，带 `[session: wks_N]` 标识。

### OpenCode 退出检测

- 每 session 独立心跳轮询 `/global/health`。
- detached → 取消该 session turn，从 route 移除。
- 若是焦点，自动切到下一个活跃 session。
- 不 stop/delete session，不解绑 route。

### 状态展示

`/status` 或 `/ps` 显示 route 下多 session 状态：

```text
Route: feishu:oc_abc:root:om_x (cwd: H:\walker)
  Active sessions: 2
  Focus: wks_1 (opencode:oc_a1b2, idle, attached)
  Other: wks_2 (opencode:oc_c3d4, running, attached)
```

### 配置

新增配置从 `src/config/env.js` 解析，加入 `EDITABLE_ENV_KEYS` 白名单：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WALKER_OPENCODE_HOOK_ENABLED` | `true` | 是否启用 plugin 自动安装和 hook 接收。设为 `false` 退回手动 `/attach` 模式。 |
| `WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS` | `5000` | 心跳轮询 `/global/health` 间隔，单位毫秒。 |
| `WALKER_OPENCODE_EXIT_ACTION` | `cancel` | OpenCode 退出动作。`cancel` 取消该 session turn 并从 route 移除；`none` 只记录 detached。 |
| `WALKER_OPENCODE_NON_FOCUS_OUTPUT` | `true` | 非焦点 session SSE 事件是否主动回卡片到群里。`false` 时静默。 |

## 不做范围

- 不实现系统级终端进程扫描。
- 不默认 stop/delete Walker session。
- 不实现多人权限系统和审计日志。
- 不扩展到飞书以外平台。
- 不实现 ACP Driver。
- 不支持任意远程机器通过公网调用 Walker。
- 不做 plugin 上报失败的重试机制（静默忽略）。
- 不做同 routeKey 内 session 间消息合并或去重。
- 不做跨 routeKey 的 session 迁移。
- 不改 `opencode-driver.js` 的 1:1 模型。

## 安全与兼容约束

- 自动绑定只接受本机 loopback 请求。
- API 复用现有 admin token 保护（`src/admin/auth.js`）。
- admin token 未配置时仍限制 host 为 `127.0.0.1`。
- Plugin 文件不包含敏感信息（Walker 地址、token 硬编码为 loopback）。
- CLI 输出不得打印飞书 token、app secret 或 admin token。

## 验收标准

1. Walker 启动时自动写入 `~/.config/opencode/plugins/walker-hook.js`（不存在时）。
2. 已存在 plugin 文件时不覆盖。
3. 用户启动 OpenCode，plugin 上报 `session.created` + `cwd` 给 Walker。
4. Walker 按 `cwd` 找到 routeKey，创建 Walker session，加入 route 的 sessions 列表。
5. 同 `cwd` 启动第二个 OpenCode，新建 Walker session，加入同一 routeKey 的 sessions 列表，不动 focusSessionId。
6. 普通消息发给焦点 session，输出回到原 routeKey。
7. 非焦点 session 的 SSE 事件主动回卡片到群里，带 `[session: wks_N]` 标识。
8. `/list` 列出 route 下所有 session，标记焦点，卡片有"设为焦点"按钮。
9. `/use <id>` 切焦点成功，普通消息改发新焦点 session。
10. OpenCode 退出后，心跳检测到 detached，取消该 session turn，从 route 移除；若是焦点则自动切到下一个活跃 session。
11. 没有 running turn 时，OpenCode 退出只记录 detached，不报错。
12. `/status` 显示 route 下多 session 状态、focus、attached/detached。
13. Walker 不可达时，plugin 静默忽略，不影响 OpenCode 正常使用。
14. `WALKER_OPENCODE_HOOK_ENABLED=false` 时，Walker 不安装 plugin，退回手动 `/attach` 模式。
15. `WALKER_OPENCODE_EXIT_ACTION=none` 时，OpenCode 退出只记录 detached，不取消 turn。
16. `WALKER_OPENCODE_NON_FOCUS_OUTPUT=false` 时，非焦点 session 输出静默，不回群。
17. 旧 routes 单值格式自动迁移为新 `{ focusSessionId, sessions[], cwd }` 格式。
18. `npm test` 通过。
19. README 包含 1:N session 路由说明、hook plugin 说明、退出行为和配置说明。

## 开放问题

无阻塞开放问题。方案已确认：

- 群 ↔ cwd 映射靠用户建联（用户在群里发消息自然建立）。
- 非焦点 session 输出回群带标识（不静默）。
- session 本身不变，driver 层不改，改动集中在 SessionService 和 Dispatcher。
