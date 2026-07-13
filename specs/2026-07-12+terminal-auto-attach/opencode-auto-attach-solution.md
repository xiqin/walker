# OpenCode 启动自动纳入 Walker 方案（Hook + 1:N Session 路由）

## 1. 核心目标

本方案解决 OpenCode 进程生命周期与 Walker 的自动联动，以及同一工作目录下多个 OpenCode 实例的会话隔离：

- 用户在本机手动启动 `opencode` 时，Walker 自动检测并纳入管理。
- 同一 `cwd` 启动多个 OpenCode 处理不同任务时，消息精准回到对应 session，不串会话。
- OpenCode 关闭后，Walker 自动取消该 session 关联的 turn。
- 全程无感知，不需要任何飞书命令干预即可自动纳入。
- 飞书端可以查看状态、切换焦点 session、继续控制或诊断。
- 关闭 OpenCode 不误删 Walker session。

## 2. 推荐方案

采用"一次安装 OpenCode plugin hook + 1:N session 路由"方案。

核心思路：

- Walker 启动时自动将 hook plugin 写入 `~/.config/opencode/plugins/walker-hook.js`（一次安装永久生效，不覆盖已存在文件）。
- 用户照常启动 `opencode`。
- plugin 监听 `session.created` 事件，上报 OpenCode 会话 ID 和当前 `cwd` 给 Walker。
- Walker 按 `cwd` 找到关联的 routeKey，将该 OpenCode session 加入该 route 的活跃 session 列表。
- 一个 routeKey 持有多个 Walker session（1:N），其中一个是"焦点 session"，普通消息默认发给焦点 session。
- 非焦点 session 的输出也回流到同一个飞书 routeKey，带 session 标识让用户区分。
- OpenCode 进程退出后，Walker 通过心跳轮询检测 detached，取消该 session 的 turn，从 route 列表移除；若是焦点则自动切到下一个活跃 session。

## 3. Plugin 安装机制

### 安装时机

Walker 进程启动时，检查 `~/.config/opencode/plugins/walker-hook.js`：

- 文件不存在 → 自动写入 plugin 文件。
- 文件已存在 → 不覆盖，保留用户现有配置。

### Plugin 文件位置

```text
~/.config/opencode/plugins/walker-hook.js
```

这是 OpenCode 全局插件目录，所有项目启动时自动加载。

### Plugin 内容职责

plugin 使用 OpenCode plugin API，注册 `session.created` 事件 hook：

1. 监听 `session.created` 事件。
2. 获取当前 OpenCode server 的 base URL（通常 `http://127.0.0.1:4096` 或自定义端口）。
3. 获取新创建 session 的 ID。
4. 获取当前 `cwd`（project directory）。
5. 通过 HTTP POST 上报给 Walker 的本地接收端点。
6. Walker 返回是否成功纳入，plugin 不阻塞 OpenCode 正常运行。

### 上报端点

Walker 新增本地 HTTP 端点：

```text
POST http://127.0.0.1:<walker-port>/opencode/hook/session-created
```

请求体：

```json
{
  "opencodeBaseUrl": "http://127.0.0.1:4096",
  "sessionId": "<opencode-session-id>",
  "cwd": "/path/to/project"
}
```

响应：

```json
{
  "ok": true,
  "walkerSessionId": "<walker-session-id>",
  "routeKey": "<绑定的 routeKey，或 null 表示游离 session>"
}
```

如果 Walker 不可达或返回 `ok: false`，plugin 静默忽略，不影响 OpenCode 正常使用。

## 4. 1:N Session 路由模型

### 为什么需要 1:N

现有 Walker 路由模型是 1:1：一个 routeKey 绑定一个 Walker session，一个 Walker session 挂一个 OpenCode session（`agentRef.opencodeSessionId`）。当用户在同一 `cwd` 启动两个 OpenCode 处理不同任务时，两者匹配到同一个 routeKey，第二个会覆盖第一个的绑定，导致消息串会话。

1:N 方案让一个 routeKey 持有多个活跃 session，通过"焦点 session"机制保证消息精准路由，非焦点 session 的输出也回群但带标识区分。

### 数据结构升级

`state.routes` 从 `{ routeKey: sessionId }`（单值）升级为：

```js
state.routes = {
  "feishu:oc_abc:root:om_x": {
    focusSessionId: "wks_1",          // 当前焦点 session，普通消息默认发这里
    sessions: ["wks_1", "wks_2"],     // 该 routeKey 下所有活跃 session（有序，最近活跃在前）
    cwd: "H:\\walker",                // routeKey 关联的工作目录（用户建联时写入）
  }
}
```

Walker session 本身结构不变，仍是 1 session : 1 agentRef：

```js
session = { id, agent: 'opencode', cwd, agentRef: { opencodeSessionId }, status, ... }
```

不把多个 OpenCode 塞进一个 session，避免 SSE 流和心跳混在一起。driver 层（`opencode-driver.js`）完全不改，仍 1:1。

### 群 ↔ cwd 映射建立

用户在某群发起任务时建立 routeKey ↔ cwd 关联：

- 用户在飞书群发消息触发 Walker 创建 session 时，Walker 记录该 routeKey 对应的 `cwd`（来自 session 的 `cwd` 字段）。
- 后续同 `cwd` 的 OpenCode 启动上报时，Walker 按已有 route 的 `cwd` 字段匹配，自动归到对应 routeKey。
- 无需用户手动配置群 ↔ cwd 映射表，靠用户首次在群里发消息自然建立。

### 消息路由规则

普通消息进到 routeKey，取 `focusSessionId` 对应的 session 发 prompt。这是"一个群通常一个 session"的默认路径，零改动体验。

多 session 时：

- 用 `/use <id>` 切焦点到指定 session。
- `/list` 列出该 routeKey 下所有 session，标记焦点，卡片加"设为焦点"按钮。
- 切焦点只改 `focusSessionId`，不影响其他 session 的运行。

### 输出回流不串

`_enqueuePrompt`（`message-dispatcher.js:127`）里 `driver.prompt(agentRef, text)` 的结果通过 `_renderEvents` 回流。回流的 reply 上下文（`_replyCtx(event)`）带着原消息的 chatId/rootId，所以输出只会回到发起消息的那个 routeKey，不会跑到别的群。

同一 routeKey 内多 session 的输出都往这个 routeKey 发卡片，靠 session 标识区分：

- 焦点 session 的 prompt 输出：正常卡片，无额外标识（默认路径）。
- 非焦点 session 的 `watchSession` SSE 事件：主动回卡片到群里，卡片标题或内容带 `[session: wks_2]` 标识，让用户区分来源。

### SessionService 新增方法

```js
// 在 route 的 sessions 列表新增 session，不动 focusSessionId（除非是第一个）
addSessionToRoute(routeKey, sessionId, cwd)

// 切焦点 session
setFocus(routeKey, sessionId)

// 从 route 移除 session；若是焦点，自动切到下一个活跃 session
removeSessionFromRoute(routeKey, sessionId)

// 列出 route 下所有 session
listSessionsInRoute(routeKey)

// 返回焦点 session（替代原 getCurrent 的单值语义）
getCurrent(routeKey) // 返回 focusSessionId 对应的 session
```

`getCurrent` 语义从"返回唯一绑定的 session"改为"返回焦点 session"，调用方零改动。

## 5. 自动绑定规则

OpenCode 上报 `session.created` 后，Walker 按以下规则决定绑定方式：

### 匹配规则

按 `cwd` 匹配已存在的 route：

1. 遍历所有 route，找 `cwd` 精确匹配的 routeKey。
2. 无精确匹配 → 找 `cwd` 是某个 route.cwd 子目录的 routeKey。
3. 多个候选 routeKey → 取最近活跃的（`focusSessionId` 对应 session 的 `updatedAt` 最大）。
4. 找到 routeKey → 创建 Walker session，`addSessionToRoute(routeKey, sessionId, cwd)`。不动 `focusSessionId`（除非这是该 routeKey 第一个 session）。
5. 没找到 routeKey → 创建游离 Walker session（有 `cwd` 但不绑 route），等用户建联时再归入 route。

### 游离 session 的后续归入

用户在飞书群发消息触发 Walker 创建/绑定 session 时，如果该群对应的 routeKey 已有 `cwd`，Walker 检查是否有 `cwd` 匹配的游离 session，有则归入该 route 的 `sessions` 列表，而不是新建。

### 不可绑定的情况

- Walker 不可达：plugin 静默忽略，OpenCode 正常使用。
- 上报失败：plugin 不重试，OpenCode 正常使用。
- Walker 内部错误：Walker 端记录错误日志，不影响 OpenCode。

### 不需要处理的逻辑

- ~~最近激活 route~~（1:N 模型下 route 直接持有 sessions 列表）
- ~~TTL 过期判断~~
- ~~`/opencode on/off/setup` 开关~~

## 6. OpenCode 退出检测与行为

### 退出检测机制

Walker 对每个已绑定的 OpenCode session 独立心跳轮询 `/global/health` 端点：

- `GET <opencodeBaseUrl>/global/health` 返回正常 → OpenCode 仍在线。
- 请求超时或连接拒绝 → 判定该 OpenCode 已退出（detached）。

轮询间隔默认 5 秒，可通过配置调整。每个 session 独立心跳，互不影响。

### 退出后的行为

某个 OpenCode 进程退出后，Walker 对**该 session**执行：

- 取消该 session 的 turn（如果有 running turn）。
- 标记该 session 的 OpenCode connection 为 detached。
- 记录最近 detached 时间。
- 从 route 的 `sessions` 列表移除该 session。
- 如果该 session 是 `focusSessionId`，自动切到 `sessions` 列表里下一个活跃 session。
- 不 stop session。
- 不 delete session。
- 不解绑飞书 route（route 本身保留，只是 sessions 列表少了一个）。

这样做的原因：

- 关闭某个 OpenCode 不等于用户想删除 Walker session。
- 其他 session 可能仍在运行，不应影响。
- 飞书端可能还要继续查看状态。
- 只取消该 session 的 turn，风险最小。

如果该 session 当时没有 running turn：

- 只记录 detached，从 route 移除。
- 不报错。

## 7. 飞书命令调整

### `/list`

列出该 routeKey 下所有 session，标记焦点：

```text
Sessions in this route (cwd: H:\walker):
  * wks_1  [focus]  opencode:oc_a1b2  status: idle
    wks_2           opencode:oc_c3d4  status: running
    wks_3           opencode:oc_e5f6  status: idle
```

卡片每个 session 行加"设为焦点"按钮（复用 `buildButtonValue` 携带 routeKey 机制，`feishu/cards.js:30`）。

### `/use <id>`

改为切焦点（而非原来的覆盖式 `bindRoute`）：

- `/use wks_2` → `setFocus(routeKey, "wks_2")`
- `/use off` → 清除 focusSessionId，普通消息不自动发 prompt（等用户重新选焦点）

### `/current`

显示当前焦点 session 信息，包括所属 routeKey、cwd、route 下 session 数量。

### `/status` 或 `/ps`

增加 OpenCode 连接状态：

```text
Route: feishu:oc_abc:root:om_x (cwd: H:\walker)
  Active sessions: 2
  Focus: wks_1 (opencode:oc_a1b2, idle, attached)
  Other: wks_2 (opencode:oc_c3d4, running, attached)
```

### 不新增的命令

- 不新增 `/opencode setup`、`/opencode on`、`/opencode off`（原 wrapper 方案的命令，已废弃）。

## 8. 新增配置

新增配置从 `src/config/env.js` 解析，加入 `EDITABLE_ENV_KEYS` 白名单。

### `WALKER_OPENCODE_HOOK_ENABLED`

```env
WALKER_OPENCODE_HOOK_ENABLED=true
```

含义：是否启用 plugin 自动安装和 hook 接收。

默认值：`true`。

设为 `false` 时：

- Walker 不自动安装 plugin。
- Walker 不接收 hook 上报。
- 退回手动 `/attach` 模式。

### `WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS`

```env
WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS=5000
```

含义：心跳轮询 `/global/health` 的间隔。

默认值：`5000` 毫秒，即 5 秒。

### `WALKER_OPENCODE_EXIT_ACTION`

```env
WALKER_OPENCODE_EXIT_ACTION=cancel
```

含义：OpenCode 退出后的动作。

支持值：

```text
cancel
none
```

`cancel` 表示：

- OpenCode 退出后自动取消该 session 的 turn。
- 标记 detached。
- 从 route 移除。

`none` 表示：

- OpenCode 退出后只记录 detached。
- 不取消 turn。
- 不从 route 移除（等用户手动处理）。

### `WALKER_OPENCODE_NON_FOCUS_OUTPUT`

```env
WALKER_OPENCODE_NON_FOCUS_OUTPUT=true
```

含义：非焦点 session 的 `watchSession` SSE 事件是否主动回卡片到群里。

默认值：`true`。

设为 `false` 时：非焦点 session 的输出静默，只存日志，不回群。

## 9. 安全约束

自动纳入必须满足以下约束：

- 只接受本机 loopback 请求。
- 不支持公网远程机器直接调用 Walker hook 接口。
- API 复用现有 admin token 保护（`src/admin/auth.js`）。
- 如果 admin token 未配置，仍限制 host 为 `127.0.0.1`。
- Plugin 文件不包含任何敏感信息（Walker 地址、token 等在 plugin 中硬编码为 loopback，不写入飞书凭证）。
- CLI 输出不得打印飞书 token、app secret 或 admin token。

## 10. 涉及的代码改动

### 新增文件

- `src/opencode/hook-plugin.js`：plugin 文件内容模板，Walker 启动时写入 `~/.config/opencode/plugins/walker-hook.js`。
- `src/opencode/hook-receiver.js`：接收 plugin 上报的 HTTP handler，注册到 Walker 的 HTTP server，按 `cwd` 找 routeKey，调用 `addSessionToRoute`。
- `src/opencode/health-poller.js`：每 session 独立心跳轮询 `/global/health`，detected detached 时触发 `_cancelTurn` 并从 route 移除。
- `src/opencode/non-focus-output.js`：非焦点 session 的 SSE 事件回流到飞书 routeKey 的逻辑，带 session 标识。

### 修改文件

| 文件 | 改动 |
|---|---|
| `src/config/env.js` | 新增 `WALKER_OPENCODE_HOOK_ENABLED`、`WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS`、`WALKER_OPENCODE_EXIT_ACTION`、`WALKER_OPENCODE_NON_FOCUS_OUTPUT` 四个配置解析 |
| `src/admin/config.js` | 将新增配置键加入 `EDITABLE_ENV_KEYS` 白名单 |
| `src/index.js` 或启动入口 | Walker 启动时调用 plugin 安装逻辑 |
| `src/core/session-service.js` | `routes` 结构升级为 `{ focusSessionId, sessions[], cwd }`；`getCurrent` 返回焦点 session；新增 `addSessionToRoute`、`setFocus`、`removeSessionFromRoute`、`listSessionsInRoute`；`createSession` 时写入 route.cwd；兼容已有单值 routes 的迁移 |
| `src/dispatch/message-dispatcher.js` | `handleIncomingMessage` 用焦点 session（`getCurrent` 语义不变，调用方零改动）；`/use` 改为 `setFocus`；`/list` 列 route 下所有 session；`/current`、`/stop`、`/cancel` 等命令适配多 session 场景 |
| `src/drivers/opencode-driver.js` | 不变，仍 1 session : 1 agentRef；可选集成 health poller 触发点 |
| `src/platform/feishu/cards.js` | `/list` 卡片加"设为焦点"按钮，复用 `buildButtonValue` 携带 routeKey |
| `src/admin/session-admin.js` | `createSession` 适配新 routes 结构；`stopSession`/`deleteSession` 从 route 移除 session |
| 飞书 `/status` 或 `/ps` 命令处理 | 展示 route 下多 session 状态、focus、attached/detached |

### routes 结构迁移

已有 `state.routes` 是 `{ routeKey: sessionId }` 单值格式。Walker 启动时检测到旧格式自动迁移：

```js
// 旧: { "feishu:oc_abc:root:om_x": "wks_1" }
// 新: { "feishu:oc_abc:root:om_x": { focusSessionId: "wks_1", sessions: ["wks_1"], cwd: <session.cwd> } }
```

迁移逻辑在 SessionService 初始化时执行，从 session 记录补全 `cwd`。

### 不新增

- 不新增飞书命令 `/opencode setup`、`/opencode on`、`/opencode off`（已废弃）。
- 不新增 wrapper/shim 脚本。
- 不新增 ticket 机制。
- 不改 `opencode-driver.js` 的 1:1 模型。

## 11. 不做范围

本轮不做：

- 不做系统级终端进程扫描。
- 不默认 stop/delete Walker session。
- 不实现多人权限系统和审计日志。
- 不扩展到飞书以外平台。
- 不实现 ACP Driver。
- 不支持任意远程机器通过公网调用 Walker。
- 不保证拦截或重写 OpenCode 的全部高级参数语义。
- 不做 plugin 上报失败的重试机制（静默忽略即可）。
- 不做同 routeKey 内 session 间消息合并或去重。
- 不做跨 routeKey 的 session 迁移。

本轮只保证：

- 普通 OpenCode 启动自动纳入，按 cwd 归入 route。
- 同 routeKey 多 session 的 1:N 路由，焦点 + 切换。
- 非焦点 session 输出回群带标识。
- OpenCode 退出自动取消该 session turn，从 route 移除，切焦点。

## 12. 验收标准

实现完成后，需要满足：

1. Walker 启动时自动写入 `~/.config/opencode/plugins/walker-hook.js`（不存在时）。
2. 已存在 plugin 文件时不覆盖。
3. 用户启动 OpenCode，plugin 上报 `session.created` + `cwd` 给 Walker。
4. Walker 按 `cwd` 找到 routeKey，创建 Walker session，`addSessionToRoute` 加入 route 的 sessions 列表。
5. 同 `cwd` 启动第二个 OpenCode，Walker 新建 Walker session，加入同一 routeKey 的 sessions 列表，不动 focusSessionId。
6. 普通消息发给焦点 session，输出回到原 routeKey。
7. 非焦点 session 的 SSE 事件主动回卡片到群里，带 `[session: wks_N]` 标识。
8. `/list` 列出 route 下所有 session，标记焦点，卡片有"设为焦点"按钮。
9. `/use <id>` 切焦点成功，普通消息改发新焦点 session。
10. OpenCode 退出后，Walker 心跳检测到 detached，取消该 session 的 turn，从 route 移除；若是焦点则自动切到下一个活跃 session。
11. 没有 running turn 时，OpenCode 退出只记录 detached，不报错。
12. `/status` 能显示 route 下多 session 状态、focus、attached/detached。
13. Walker 不可达时，plugin 静默忽略，不影响 OpenCode 正常使用。
14. `WALKER_OPENCODE_HOOK_ENABLED=false` 时，Walker 不安装 plugin，退回手动 `/attach` 模式。
15. `WALKER_OPENCODE_EXIT_ACTION=none` 时，OpenCode 退出只记录 detached，不取消 turn。
16. `WALKER_OPENCODE_NON_FOCUS_OUTPUT=false` 时，非焦点 session 输出静默，不回群。
17. 旧 routes 单值格式自动迁移为新 `{ focusSessionId, sessions[], cwd }` 格式。
18. `npm test` 通过。
19. README 包含 1:N session 路由说明、hook plugin 说明、退出行为和配置说明。

## 13. 不采用 wrapper 方案的原因

wrapper/shim 方案的问题：

- 需要劫持 PATH，跨平台风险高（Windows / macOS / Linux 差异大）。
- 依赖 Walker 源码在本机（`node src/index.js opencode auto -- ...`），不适合分发给终端用户。
- 与真实 OpenCode 进程的生命周期管理脆弱（信号传递、子进程退出码等）。
- 需要用户手动安装 wrapper，体验差。
- API 定义缺失、竞态未处理。

Hook plugin 方案的优势：

- OpenCode 原生支持 plugin，启动自动加载，无需劫持 PATH。
- Walker 启动时自动安装 plugin，用户无感知。
- plugin 通过标准事件 hook 上报，不依赖 Walker 源码在本机。
- OpenCode 退出检测复用 Walker 已有的 `/global/health` 轮询能力。
- 完全自动，无需飞书命令干预。

## 14. 不采用 ticket 方案的原因

ticket 方案类似：

```bash
node src/index.js opencode attach --ticket <ticket>
```

问题：

- 每次都要从飞书复制命令。
- 操作比现在 `/attach` 还复杂。
- 不符合"启动 OpenCode 自动 attach"的目标。

因此不作为主方案。它可以保留为将来的调试或兜底方案。

## 15. 不采用扫描 OpenCode session 的原因

后台扫描 OpenCode session 的问题：

- 多个项目时容易误判。
- 多个飞书会话时不知道该绑定哪个。
- `cwd` 相同或相近时风险更高。
- 自动误绑比不绑定更危险。

Hook 方案由 OpenCode 主动上报 `session.created` + `cwd`，不存在扫描误判问题。

## 16. 为什么用 1:N 而不是强制 1:1

强制 1:1（第二个 OpenCode 新建 Walker session + 新 routeKey）的问题：

- 同 `cwd` 的两个 OpenCode 会匹配到同一 routeKey，无法自动新建 routeKey（routeKey 是飞书侧标识，不由 cwd 决定）。
- 强行新建 routeKey 会导致两个 session 无法通过同一飞书群管理，用户体验割裂。

升级 agentRef 为数组（一个 session 挂多个 OpenCode）的问题：

- SSE 流混在一起，无法区分哪条消息来自哪个 OpenCode。
- 心跳检测无法独立判断单个 OpenCode 的存活。
- driver 层改动大，破坏现有 1:1 模型的清晰性。

1:N route 方案的优势：

- session 本身不变，driver 层不改，改动集中在 SessionService 和 Dispatcher。
- 每个 OpenCode 独立 SSE 流和心跳，互不影响。
- 焦点机制保证默认消息路由零改动，多 session 时用户主动切换。
- 非焦点 session 输出回群带标识，用户可区分。

## 17. 最终推荐一句话

Walker 启动时自动安装 OpenCode plugin；用户正常启动 `opencode`，plugin 上报 `session.created` + `cwd`，Walker 按 `cwd` 找到 routeKey，创建 Walker session 并加入该 route 的 1:N session 列表；普通消息发给焦点 session，非焦点 session 输出带标识回群，用户可用 `/use` 切焦点；OpenCode 退出时心跳检测到 detached，取消该 session turn 并从 route 移除，若是焦点则自动切换，全程无飞书命令干预即可自动纳入。
