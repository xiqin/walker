# 飞书 `/clear` 当前 TUI 清空上下文 — 需求规格

## 1. 概述

**需求来源**：用户提出从飞书清空当前 OpenCode 上下文，同时保持当前终端窗口和 TUI 进程。
**需求类型**：新增
**选定方案**：TUI bridge 控制消息。Walker 向当前 TUI runtime 投递 `clear` 控制请求，插件通过本地 OpenCode SDK 创建顶层 session，导航到新 session，并沿用现有注册链路将新会话设为飞书 route 焦点。

### 方案比较

| 方案 | 思路 | 优点 | 缺点 | 结论 |
| ---- | ---- | ---- | ---- | ---- |
| A. TUI bridge 控制消息 | 插件调用 `api.client.session.create()`，再调用 `api.route.navigate()` | 保持当前窗口；不依赖键盘模拟；可确认创建结果；复用现有 runtime 注册机制 | 需要扩展 bridge 协议并处理注册竞态 | 采用 |
| B. 向 TUI 注入 `/new` 文本 | 将 `/new` 放入当前 prompt 或输入框 | 改动表面较小 | `promptAsync` 会把它当模型输入；输入框注入依赖 TUI 命令解析和焦点状态 | 不采用 |
| C. Walker 服务端创建后让 TUI attach | 继续 `POST /session`，再远程要求 TUI 导航 | 服务端创建逻辑可复用 | TUI 与服务端实例、目录上下文可能不一致；仍需控制协议；更容易产生孤立 session | 不采用 |

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | 识别飞书 `/clear` 命令 | P0 | 给定文本 `/clear`，命令解析结果为 `name=clear`，且 `/help` 包含该命令 |
| REQ-002 | 在当前 TUI 创建空上下文 | P0 | 给定当前焦点 session 使用 `transport=tui-bridge` 且空闲，执行 `/clear` 后插件调用本地 SDK 创建新的顶层 OpenCode session |
| REQ-003 | 保持当前终端和 TUI runtime | P0 | 执行 `/clear` 不调用 Walker runtime 的 `openTerminal()`；新旧 OpenCode session 使用同一个 `runtimeId` |
| REQ-004 | 将当前 TUI 导航到新 session | P0 | SDK 创建成功后，插件调用 `api.route.navigate('session', { sessionID: newId })` |
| REQ-005 | 原子更新 Walker route 焦点 | P0 | 关联 register 与 control success 都完成前旧焦点不变；两者完成后 Walker 将新 session 加入原 route 并设为焦点 |
| REQ-006 | 保留旧会话 | P0 | `/clear` 成功后旧 Walker/OpenCode session 不被 stop、delete 或移出 route，可通过 `/list` 和 `/use` 恢复 |
| REQ-007 | 继承会话设置 | P1 | 新 Walker session 继承旧 session 的 `model`，保证后续飞书 prompt 继续使用该模型；工作目录使用 clear 关联 register 上报的当前 TUI `cwd` |
| REQ-008 | 明确拒绝不支持场景 | P0 | 无绑定、非 `tui-bridge`、runtime 失联或当前 turn 正在运行时，不创建 session，并回复明确提示 |
| REQ-009 | 创建失败可恢复 | P0 | SDK 创建、导航、注册、控制上报或请求超时时，Walker route 的旧 session 保持焦点，飞书收到错误信息，pending 被清理；插件对已发生的 TUI 导航执行最佳努力回滚 |
| REQ-010 | 文档与回归测试 | P0 | README 命令表说明 `/clear` 语义；命令、dispatcher、bridge、插件测试通过 |

## 3. 接口/API 设计

### 3.1 飞书命令

- **调用方式**：发送文本 `/clear`
- **参数**：无
- **成功回复**：包含旧 Walker session ID、新 Walker session ID，并说明当前 TUI 窗口保持不变
- **失败回复**：使用现有文本回复或错误卡片机制，说明不可执行原因

### 3.2 Walker 到 TUI 的轮询投递

复用现有 `POST /opencode/tui-bridge/poll`，扩展 delivery：

```json
{
  "deliveryId": "del_xxx",
  "type": "clear",
  "sessionId": "ses_old"
}
```

现有 prompt delivery 增加显式 `type: "prompt"`。插件为兼容当前进程中已排队的旧格式，缺少 `type` 时仍按 prompt 处理。

### 3.3 Clear 关联注册

插件取得新 session ID 并导航成功后，显式调用现有 register endpoint，并携带 clear delivery 的关联 ID：

```json
{
  "runtimeId": "runtime_xxx",
  "sessionId": "ses_new",
  "cwd": "/current/project",
  "opencodeVersion": "1.17.20",
  "controlDeliveryId": "del_xxx"
}
```

带 `controlDeliveryId` 的 register 是 clear 专用的暂存注册：Bridge 只在 pending 中记录新 OpenCode session ID、cwd 和版本信息，不得提前创建持久化 Walker session、不得修改 `runtime.currentSessionId`、不得按 cwd 自动选择 route、不得设置 route 焦点，也不得触发普通 enrollment 完成回调。未知、已失败或已超时的 `controlDeliveryId` 必须被拒绝，且不得回退为普通 register。

插件在每个 runtime 内维护单一 active clear 状态。调用 `create()` 前即开始缓冲 `session.created` 和 `tui.session.select` 事件；取得 SDK 返回的新 ID 后，只抑制与该 ID 对应的自动注册，并对其他事件按最新 TUI 路由重新判断。这样即使 `session.created` 早于 `create()` Promise 返回，也不会通过普通路径提前聚焦。clear 成功后由 clear handler 更新 `activeSessionId` 和普通注册缓存；失败并回滚后恢复旧 session，再处理仍然有效的非 clear 事件。普通手工切换在没有 active clear 时继续使用不带 `controlDeliveryId` 的 register，行为不变。

### 3.4 TUI 到 Walker 的控制结果

复用 `POST /opencode/tui-bridge/events`：

```json
{
  "runtimeId": "runtime_xxx",
  "sessionId": "ses_old",
  "deliveryId": "del_xxx",
  "control": {
    "type": "clear",
    "newSessionId": "ses_new"
  }
}
```

失败时继续使用现有 `error` 字段。控制结果不转换为 AgentEvent。

### 3.5 Bridge 内部接口

新增：

```javascript
clearSession(sessionRef)
```

返回：

```javascript
{
  runtimeId,
  oldSessionId,
  newSessionId,
  walkerSessionId
}
```

完成条件是插件已返回 `newSessionId`，且相同 `deliveryId + runtimeId + newSessionId` 的 clear 关联 register 已完成暂存。control result 和关联 register 允许任意顺序到达。Bridge 在单一完成函数中校验二者一致后，才创建或复用新 Walker session、提交 runtime 当前 session、将新 Walker session 加入原 route、继承模型、设置焦点并触发 enrollment 回调。

## 4. 数据设计

不修改持久化 schema。继续使用现有结构：

```javascript
session.agentRef = {
  opencodeSessionId,
  transport: 'tui-bridge',
  runtimeId
}
```

Bridge 内存增加待处理 clear 请求，按 `deliveryId` 保存：

```javascript
{
  runtimeId,
  oldSessionId,
  oldWalkerSessionId,
  routeKey,
  oldModel,
  newSessionId,
  registeredCwd,
  registeredOpencodeVersion,
  registerCompleted,
  controlCompleted,
  resolve,
  reject,
  timer
}
```

该状态不持久化；Walker 重启时请求失败，旧 session 和 route 数据保持不变。

## 5. 业务规则

- `/clear` 仅作用于当前 route 的焦点 session。
- 同一 `runtimeId` 同时只允许一个 clear pending；已有 clear 未结束时立即拒绝后续 clear，避免同一 TUI 的创建、导航和回滚互相覆盖。
- 当前 session 必须是 `transport=tui-bridge`，不得回退到普通 HTTP session 的新开终端行为。
- 当前 session 状态为 `running`、dispatcher 存在活动 turn 或存在未完成 prompt queue 时拒绝执行，并提示先执行 `/cancel`。
- dispatcher 在进入 route 锁前做一次快速空闲检查，以便运行中立即拒绝；获得锁后重新读取当前焦点并再次校验，避免检查与执行之间的竞态。
- clear 请求与同 route 的 prompt、`/new`、`/attach` 使用同一 route 锁串行化，但不得仅依赖锁内检查，否则运行中的 clear 会排队后自动执行。
- 插件调用 `api.client.session.create({ title })` 创建独立顶层 session，不 fork、summarize、revert 或删除旧消息。
- SDK 返回值同时兼容 `result.data.id`、`result.id`、`result.sessionID` 和 `result.sessionId`。
- 新 session 创建后立即导航；clear handler 使用同一个 `runtimeId` 和 `controlDeliveryId` 显式注册，随后并发发送关联 register 与 control success，使 Bridge 支持任意到达顺序。
- clear 关联 register 仅暂存新 OpenCode session 元数据；control success 与关联 register 都完成后，Bridge 才创建或复用新 Walker session，将其加入旧 session 所在 route 并设为焦点。旧 session 继续保留在 route 的 `sessions` 中。
- 新 Walker session 继承旧 session 的 `model` 字段，保证飞书侧后续 prompt 沿用模型；本需求不承诺 OpenCode TUI 本地手工输入继承 session 级模型，也不修改 OpenCode 全局模型配置。
- create 后任一步骤失败时，插件若已导航到新 session，则最佳努力导航回旧 session。回滚失败时错误信息必须包含需在 TUI 手工切回旧 session；Walker route 焦点仍保持旧 session。
- clear 超时使用 bridge 的 `promptTimeoutMs`；超时后拒绝请求并清理 pending 状态。

## 6. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| 当前 route 无绑定 session | 回复 `No session bound. Start OpenCode TUI first.`，不投递控制消息 |
| 当前 session 不是 TUI bridge | 回复仅支持当前已连接的 OpenCode TUI，不调用 `createSession()` |
| 当前 turn 正在运行 | 回复先执行 `/cancel`，不自动中断任务 |
| TUI runtime 不存在或心跳过期 | 返回连接失效错误，旧焦点不变 |
| TUI 已切换到其他 session | 拒绝向旧 session 投递，避免误清空其他窗口上下文 |
| SDK 创建失败 | 插件通过 `error` 上报，旧焦点不变 |
| SDK 成功但未返回 session ID | 作为创建失败上报 |
| 导航失败 | 上报错误；已创建的 OpenCode session 可能存在，但 Walker 不切换焦点 |
| 导航后注册或控制上报失败 | 插件最佳努力导航回旧 session；Walker 不提交暂存注册、不切换焦点 |
| TUI 回滚失败 | 错误信息提示用户在 TUI 手工切回；Walker 旧焦点保持不变 |
| 注册先于控制结果到达 | Bridge 按 `controlDeliveryId` 暂存注册结果，不修改 runtime 或 route 焦点；控制结果到达后完成请求 |
| 控制结果先于注册到达 | Bridge 记录新 ID，等待对应 register 后完成请求 |
| 请求超时后迟到 control | 拒绝或忽略迟到控制完成信号，不修改 runtime 或 route 焦点 |
| 请求超时后迟到关联 register | 以未知或过期 `controlDeliveryId` 拒绝，且不得按普通 register 处理 |
| clear 期间用户手工创建或切换 session | 无匹配 `controlDeliveryId` 的事件不得完成 clear；clear handler 只关联自身 SDK create 返回的 session ID |
| 同一 runtime 并发 clear | 第二个请求在投递前被拒绝，不创建第二个 OpenCode session |
| 重复飞书事件 | 复用现有 command dedup，不重复创建 session |

## 7. 非目标

- 不改变现有 `/new [agent] [title]` 新建独立 Walker/OpenCode session 并打开终端的行为。
- 不删除、停止或压缩旧 session。
- 不支持 `/clear --delete-old`、标题参数或批量清理。
- 不对普通 HTTP/serve session 模拟“保持当前 TUI”。
- 不修改 OpenCode 自身 `/new` 命令实现。
