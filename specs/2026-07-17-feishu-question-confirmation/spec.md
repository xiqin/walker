# 飞书交互式问题确认 — 需求规格

## 1. 概述

**需求来源**：用户要求 opencode 交互式 TUI 中的多选/确认问题通知到飞书，并让用户在飞书内完成选择和确认。  
**需求类型**：修改  
**选定方案**：方案 A' — 复用底层 `permission` 事件通道承载交互式问题，新增 question 回复语义（`/answer` 命令、TUI bridge 回复 delivery、专用卡片渲染），与传统权限确认（`/permit allow|deny`）分离。

### 1.1 与现有实现的关键差异

现有 Walker 已具备以下基础能力：

- 飞书平台已监听 `card.action.trigger`，卡片按钮动作可回传给 dispatcher（`src/platform/feishu/platform.js:51-55`）。
- 飞书卡片按钮可通过 `cmd:/permit <permissionId> <response>` 进入 `/permit` 命令处理（`src/app/bootstrap.js:150-171`）。
- dispatcher 已有 `_cmdPermit`，调用 `driver.replyPermission(...)` 回传给 opencode driver（`src/dispatch/message-dispatcher.js:756-787`）。
- Agent 事件模型已有 `permission` 与 `permission_replied`（`src/drivers/agent-driver.js:99-100,119-120`）。
- TUI bridge 已有 `/opencode/tui-bridge/events` 接收本地 opencode TUI runtime 上报事件（`src/opencode-tui-bridge/routes.js:47`），`normalizeEvents` 已允许 `TYPE_PERMISSION` 通过（`src/opencode-tui-bridge/bridge.js:672-691`）。

但现有实现存在以下限制，本 spec 必须解决：

| # | 限制 | 代码位置 | 本 spec 对应修正 |
| - | ---- | -------- | ---------------- |
| L1 | `replyPermission` 对 TUI bridge transport 直接抛错 | `src/drivers/opencode-driver.js:527-529` | 新增 TUI bridge 回复 delivery 通道，`replyPermission` 对 TUI bridge 转发而非抛错 |
| L2 | `_cmdPermit` 只接受 `allow\|deny`，拒绝任意 response | `src/dispatch/message-dispatcher.js:764-767` | 新增 `/answer` 命令处理单选/多选/文本，`/permit` 保持只处理传统权限 |
| L3 | `parseCardAction` 已解析 `formValue`，但 `_handleCardAction` 和 `bootstrap onCardAction` 未传递 | `src/platform/feishu/platform.js:103-113`、`src/app/bootstrap.js:150-171` | 全链路传递 `formValue` 到 dispatcher |
| L4 | 无问题级幂等状态，重复点击会并发提交 | dispatcher 仅有 `permissionCardIds`（id→cardId） | 新增 `questionReplyStates` 记录 pending/submitting/replied/failed |
| L5 | `buildPermissionCard` 只有 allow/deny 两按钮 | `src/platform/feishu/cards.js:476-503` | 新增 `buildQuestionCard` 支持 4 种 inputMode |
| L6 | permission 与 question 语义混用同一卡片和命令 | — | `data.type === 'question'` 走 question 分支，传统 permission 不受影响 |

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | TUI bridge 接收交互式问题事件 | P0 | 给定 TUI runtime 通过 `/opencode/tui-bridge/events` 上报 `type=permission` 且 `data.type=question` 的事件，当事件包含问题 ID、标题和 inputMode，则 Walker 归一化为 `AgentEvent.TYPE_PERMISSION` 并进入现有 watch/prompt 事件流，`normalizeEvents` 不拒绝该事件。 |
| REQ-002 | 飞书发送交互式问题卡片 | P0 | 给定 Agent 事件 `data.type=question`，当 session 绑定到飞书会话，则 Walker 调用 `buildQuestionCard` 在对应飞书会话发送交互卡片，卡片展示标题、说明、inputMode 对应的组件和提交按钮。 |
| REQ-003 | 支持确认/拒绝（confirm） | P0 | 给定 `inputMode=confirm`，当用户点击飞书卡片中的确认或拒绝按钮，则 Walker 调用 `/answer <questionId> allow|deny`，将问题 ID 和 `allow`/`deny` 回传给 opencode；语义与现有权限确认一致，但走 question 分支（`buildQuestionCard` + `/answer`），不走 `/permit`。 |
| REQ-004 | 支持单选（single_select） | P0 | 给定 `inputMode=single_select` 且包含 options，当用户点击某个选项按钮，则 Walker 调用 `/answer <questionId> <value>`，将该选项 `value` 作为回答回传给 opencode，并更新原卡片为已处理。 |
| REQ-005 | 支持多选（multi_select） | P0 | 给定 `inputMode=multi_select` 且包含 options，当用户在飞书卡片中选择多个选项并点击提交，则 Walker 从 `formValue.question_answer` 提取 `string[]` 回传给 opencode，并更新原卡片为已处理。 |
| REQ-006 | 支持自由文本输入（text） | P1 | 给定 `inputMode=text`，当用户在飞书卡片输入框填写文本并提交，则 Walker 从 `formValue.question_answer` 提取 `string` 回传给 opencode；`required !== false` 时空字符串被拒绝并给出飞书提示。 |
| REQ-007 | 回调路由准确性 | P0 | 给定卡片动作包含 `routeKey` 和问题 ID，当用户点击或提交飞书卡片，则 Walker 使用卡片携带的 `routeKey` 定位当前 session，不依赖新消息线程推断。 |
| REQ-008 | 卡片状态更新 | P1 | 给定问题回复成功，当 driver 回传成功或收到 `permission_replied` 事件，则原飞书卡片更新为已处理，展示回答摘要。 |
| REQ-009 | 幂等与重复点击保护 | P1 | 给定同一问题 ID 的飞书卡片被重复点击，当已有 pending/submitting/replied 状态记录，则不会向 opencode 重复提交不同回答；replied 状态返回已处理提示，submitting 状态返回正在处理提示。 |
| REQ-010 | 向后兼容现有权限确认 | P0 | 给定现有 `permission` 事件不包含 `data.type=question` 或不包含 `metadata.inputMode`，当事件进入 Walker，则原有 `buildPermissionCard`、`/permit <permissionId> allow|deny` 和 `driver.replyPermission` 行为保持可用，不受本变更影响。 |
| REQ-011 | TUI bridge 回复通道 | P0 | 给定 opencode session 通过 TUI bridge 连接（`agentRef.transport='tui-bridge'`），当 Walker 需要回传问题答案给 opencode，则 `OpencodeDriver.replyPermission` 转发到 `tuiBridge.replyQuestion(...)`，不再抛错；TUI runtime 通过 `poll` 拉取 `question_reply` delivery 并回传结果。 |
| REQ-012 | `formValue` 全链路传递 | P0 | 给定飞书卡片表单提交，当 `card.action.trigger` 到达，则 `parseCardAction` 解析的 `formValue` 经 `FeishuPlatform._handleCardAction` → `bootstrap onCardAction` → `dispatcher.handleCommand` 全链路传递，dispatcher 能从 `cmd.formValue` 读取表单值。 |
| REQ-013 | 未知 inputMode 降级 | P1 | 给定 `data.type=question` 但 `metadata.inputMode` 为未知值，当事件进入 Walker，则按 `confirm` 降级渲染或返回明确错误并记录 warn 日志，不抛未捕获异常。 |

## 3. 接口/API 设计

### 3.1 TUI bridge 事件上报（复用现有路由）

- **调用方式**：`POST /opencode/tui-bridge/events`
- **描述**：复用现有 TUI bridge 事件上报接口和 envelope，不新增 HTTP 路由。
- **输入字段**：

| 参数 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| runtimeId | string | 是 | TUI runtime ID。 |
| sessionId | string | 是 | opencode session ID。 |
| deliveryId | string | 否 | prompt delivery 的 ID；无 deliveryId 时作为 watch 事件上报。 |
| events | object[] | 是 | Agent 事件列表，其中可包含 `type=permission` 事件。 |

交互式问题事件结构（作为 `events[]` 的一个元素）：

```json
{
  "type": "permission",
  "data": {
    "id": "question_build_target",
    "type": "question",
    "title": "请选择构建目标",
    "metadata": {
      "inputMode": "single_select",
      "description": "选择本次构建要使用的目标环境。",
      "options": [
        { "label": "开发环境", "value": "dev" },
        { "label": "生产环境", "value": "prod" }
      ],
      "multiple": false,
      "required": true
    },
    "sessionID": "opencode-session-id",
    "messageID": "opencode-message-id",
    "callID": "optional-call-id"
  }
}
```

`metadata.inputMode` 支持值：

| inputMode | 说明 | 飞书组件 | 回传值 |
| --------- | ---- | -------- | ------ |
| confirm | 确认/拒绝 | 两个 button（允许/拒绝） | `allow` 或 `deny` |
| single_select | 单选 | N 个 button（每个选项一个） | 选中项 `value` |
| multi_select | 多选 | `multi_select_static` + 提交 button | 选中项 `value[]` |
| text | 自由文本 | `input` + 提交 button | 输入文本 string |

### 3.2 TUI bridge 回复 delivery（新增）

- **调用方式**：TUI runtime 通过现有 `POST /opencode/tui-bridge/poll` 拉取
- **描述**：`tuiBridge.replyQuestion(sessionRef, questionId, answer)` 将回复投递到 runtime 的 queue，runtime poll 时收到如下 delivery：

```json
{
  "deliveryId": "del_reply_001",
  "type": "question_reply",
  "sessionId": "opencode-session-id",
  "questionId": "question_build_target",
  "answer": "dev"
}
```

`answer` 类型规则：

| inputMode | answer 类型 |
| --------- | ----------- |
| confirm | string（`allow`/`deny`） |
| single_select | string |
| multi_select | string[] |
| text | string |

#### 3.2.1 可靠性机制

`question_reply` delivery 复用现有 `prompt` delivery 的 lease/heartbeat/final 确认机制，保证 delivery 可靠完成：

- **lease**：runtime poll 拿到 `question_reply` 后，通过 `POST /opencode/tui-bridge/events` 上报 `deliveryState: 'accepted'`，bridge 将 delivery 状态从 `queued` 改为 `leased`，启动租约超时计时器（复用 `leaseTimeoutMs`）。
- **heartbeat**：runtime 处理期间定期上报 `deliveryState: 'heartbeat'`，重置租约超时。
- **final**：runtime 完成答案回传后上报 `deliveryState: 'final'`（或等价终态），bridge resolve `replyQuestion` 的 Promise，清理 delivery。
- **失败**：租约超时、runtime 断连或 final 上报 error 时，bridge reject `replyQuestion` 的 Promise，`questionReplyStates[questionId]` 回滚为 `pending`，允许用户重新提交。
- **fire-and-forget 不适用**：`question_reply` 不是 fire-and-forget；如果 runtime 在未完成 final 确认前崩溃或断连，Walker 视为回复失败并回滚状态。

runtime 收到 `question_reply` delivery 后，通过本地 opencode 机制把答案回传给 Agent，再通过 `/opencode/tui-bridge/events` 上报 `deliveryState: 'final'` 确认 delivery 完成。同时上报 `permission_replied` 事件，Walker 据此 patch 原飞书卡片。

#### 3.2.2 `permission_replied` 事件上报责任

| transport | `permission_replied` 上报方 | 字段格式 |
| --------- | --------------------------- | -------- |
| HTTP | opencode server SSE 自动推送（`mapSSEEvent` 映射，现有行为不变） | `{ permissionId: string, response: string }` |
| TUI bridge | runtime 在 `question_reply` delivery final 确认时通过 `/opencode/tui-bridge/events` 上报 | `{ permissionId: string, response: string\|string[] }`，其中 `permissionId` 对应 `questionId`，`response` 对应 answer |

TUI bridge transport 下，runtime 的上报义务：

1. runtime poll 拿到 `question_reply` delivery。
2. runtime 通过本地 opencode 机制把答案回传给 Agent。
3. runtime 上报 `deliveryState: 'final'` 确认 delivery 完成。
4. runtime 上报 `type=permission_replied` 事件，`data.permissionId = questionId`，`data.response = answer`。
5. Walker 收到 `permission_replied` 事件后 patch 原飞书卡片为已处理状态。

如果 runtime 未上报 `permission_replied` 事件（例如 opencode 不生成该事件），Walker 在 `replyQuestion` Promise resolve 后（delivery final 成功）也可自行 patch 卡片为已处理。

### 3.3 飞书卡片动作 value（新增 `/answer`，保留 `/permit`）

**传统权限确认（不变）**：

```json
{
  "action": "cmd:/permit permission_id allow",
  "routeKey": "thread:chat_id:root_id"
}
```

**交互式问题 - confirm 与 single_select（按钮直接回传）**：

```json
{
  "action": "cmd:/answer question_build_target dev",
  "routeKey": "thread:chat_id:root_id"
}
```

**交互式问题 - multi_select 与 text（表单提交）**：

```json
{
  "action": "cmd:/answer question_build_target --form",
  "routeKey": "thread:chat_id:root_id",
  "formValue": { "question_answer": ["dev", "staging"] }
}
```

dispatcher 在看到 `--form` 时从 `cmd.formValue.question_answer` 提取回答，而不是把 `--form` 当最终回答。

### 3.4 Driver 回复能力（扩展）

**现有 HTTP transport（不变）**：

```js
driver.replyPermission(agentRef, permissionId, response, remember)
// POST /session/<id>/permissions/<permissionId>  body: { response, remember }
```

`response` 扩展为支持 string 或 string[]，opencode 上游按实际语义消费。

**TUI bridge transport（新增）**：

```js
driver.replyPermission(agentRef, permissionId, response, remember)
// 内部转发到 tuiBridge.replyQuestion(sessionRef, permissionId, response)
// 不再抛 'replyPermission is not supported for tui-bridge transport'
```

`OpencodeDriver.replyPermission` 分支逻辑：

```text
if (_isTuiBridge(sessionRef)) {
  return this.tuiBridge.replyQuestion(sessionRef, permissionId, response);
}
// 否则走现有 HTTP POST
```

### 3.5 Dispatcher 命令处理（新增 `/answer`）

新增 `handleCommand` 中的 `answer` 分支和 `_cmdAnswer(cmd)` 方法：

```js
answer: () => this._withRouteTouch(cmd.routeKey, () => this._cmdAnswer(cmd)),
```

`_cmdAnswer` 逻辑：

1. 从 `cmd.args[0]` 取 `questionId`。
2. 若 `cmd.args[1] === '--form'`，从 `cmd.formValue.question_answer` 提取 answer。
3. 否则从 `cmd.args.slice(1).join(' ')` 提取 answer（confirm/single_select）。
4. 校验 `driver.replyPermission` 是否存在；不存在时回复 `当前 agent 不支持权限回复` 并返回 `{ error: 'driver_not_supported' }`（与现有 `_cmdPermit` 一致）。
5. 校验 `questionReplyStates[questionId]` 是否允许提交（pending/failed 允许，submitting/replied 拒绝）。
6. 设置 `questionReplyStates[questionId] = 'submitting'`，调用 `driver.replyPermission(current.agentRef, questionId, answer, false)`。
7. 成功后更新 `questionReplyStates[questionId] = 'replied'`，patch 卡片为已处理。
8. 失败后更新 `questionReplyStates[questionId] = 'failed'`（允许重试），回复飞书错误提示。

`_cmdPermit` 保持不变，只接受 `allow|deny`。

## 4. 数据设计

### 4.1 AgentEvent 数据结构

继续使用 `AgentEvent.TYPE_PERMISSION`，通过 `data.type` 区分 question 与传统 permission：

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| id | string | 是 | 问题/权限 ID。 |
| type | string | 否 | `question` 表示交互式问题；缺省表示传统权限。 |
| title | string | 是 | 飞书卡片标题。 |
| metadata.inputMode | string | 仅 question 必填 | `confirm`、`single_select`、`multi_select`、`text`。 |
| metadata.description | string | 否 | 问题说明。 |
| metadata.options | object[] | 仅 select 必填 | `[{ label, value }]`。 |
| metadata.required | boolean | 否 | 是否必须提交非空答案，默认 true。 |
| sessionID | string | 否 | opencode session ID。 |
| messageID | string | 否 | opencode message ID。 |
| callID | string | 否 | opencode tool/call ID。 |

### 4.2 问题回复状态（新增内存态）

dispatcher 新增 `questionReplyStates: Map<string, { state, answer, repliedAt }>`

| state | 说明 |
| ----- | ---- |
| pending | 已发送卡片，等待用户回复 |
| submitting | 已收到回复，正在调用 driver |
| replied | driver 回传成功 |
| failed | driver 回传失败，允许重试 |

状态转换：

```text
pending → submitting → replied
                    ↘ failed → pending（允许重试）
```

`permissionCardIds` 继续用于 id→cardId 映射，question 和 permission 共用。

### 4.3 飞书卡片组件字段约定

| inputMode | 飞书组件 | form_value key | answer 提取 |
| --------- | -------- | -------------- | ---------- |
| confirm | 2 个 button | 不使用 formValue | `args[1]`（allow/deny） |
| single_select | N 个 button | 不使用 formValue | `args[1]`（value） |
| multi_select | `multi_select_static` + submit button | `question_answer` | `formValue.question_answer`（string[]） |
| text | `input` + submit button | `question_answer` | `formValue.question_answer`（string） |

飞书卡片组件 `multi_select_static` 和 `input` 属于飞书交互卡片协议标准组件，本 spec 依赖但不验证飞书平台能力；实现时需先用飞书卡片预览工具（`/api/admin/tools/cards/preview`）或飞书开放平台文档验证组件可用性和 `form_value` 回传结构。

## 5. 业务规则

- 规则 1：`data.type === 'question'` 的事件一律走 question 分支（`buildQuestionCard`、`/answer`、`questionReplyStates`），即使 `inputMode=confirm` 也用 `buildQuestionCard` + `/answer`，不混用 `buildPermissionCard` + `/permit`；其余 `permission` 事件（无 `data.type=question`）走传统权限分支（`buildPermissionCard`、`/permit`、`permissionCardIds`）。
- 规则 2：传统权限确认不得被破坏；未带 `data.type=question` 的 `permission` 事件按当前 `buildPermissionCard` 渲染，`/permit <permissionId> allow|deny` 行为不变。
- 规则 3：单选和多选的选项 `value` 必须为非空字符串；缺失 `label` 时用 `value` 展示。
- 规则 4：自由文本模式下，`required !== false` 时空字符串不可提交，返回飞书提示。
- 规则 5：多选提交返回 string[]；单选、确认和自由文本返回 string。
- 规则 6：卡片回调必须携带 `routeKey`；缺失时才允许用现有 `buildRouteKey` 兜底。
- 规则 7：重复提交同一问题不应导致多个不同答案进入 opencode；第一条成功回复为准，后续返回已处理提示。
- 规则 8：driver 回传失败时，`questionReplyStates[id]` 回滚为 `pending`，允许用户重新提交。
- 规则 9：飞书卡片中不展示敏感 token、完整环境变量或大段命令输出；元数据仅展示经过截断和转义的摘要。
- 规则 10：`OpencodeDriver.replyPermission` 对 TUI bridge 不抛错，转发到 `tuiBridge.replyQuestion`；对 HTTP transport 保持现有行为。

## 6. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| TUI runtime 上报未知 inputMode | 按 `confirm` 降级渲染，或返回明确错误并记录 warn 日志，不抛未捕获异常。 |
| 单选/多选缺少 options | 卡片显示错误状态，不发送不可操作的空选项卡片，记录 warn。 |
| 多选未选择任何项且 required 为 true | 不回传 opencode，飞书侧提示必须至少选择 1 项。 |
| 自由文本为空且 required 为 true | 不回传 opencode，飞书侧提示必须输入内容。 |
| `/answer` 找不到 session | 沿用现有行为，回复 `No session bound to this conversation.`。 |
| driver 不支持回复 | 沿用现有行为，回复 `当前 agent 不支持权限回复`。 |
| 飞书重复点击或重复回调 | 查询 `questionReplyStates`，replied 返回已处理提示，submitting 返回正在处理提示，pending 允许提交。 |
| driver 回传失败 | `questionReplyStates[id]` 回滚为 `pending`，飞书回复 `权限不存在或已过期` 或等价错误提示，并记录 warn 日志。 |
| 旧版 TUI runtime 未上报 question metadata | 继续按现有 permission 事件处理，不要求升级才能使用原权限确认。 |
| TUI bridge runtime 不在线或 stale | `tuiBridge.replyQuestion` 返回错误，飞书回复 `OpenCode TUI runtime 未连接`，`questionReplyStates[id]` 回滚为 `pending`。 |

## 7. 非目标

- 本次不实现任意复杂表单编排，只支持确认、单选、多选、自由文本 4 种输入模式。
- 本次不实现图片、文件上传或富文本输入。
- 本次不新增持久化数据库表；问题卡片映射和回复状态继续使用当前进程内存状态。
- 本次不改变飞书应用鉴权、事件订阅和 WebSocket 接入方式。
- 本次不强制修改 opencode 上游协议；若上游事件字段不同，在 TUI bridge 适配层做归一化。
- 本次不把 `/permit` 升级为通用回复命令；`/permit` 保持只处理传统权限 allow/deny，通用回复走 `/answer`。

## 8. 变更影响清单

| 文件 | 变更类型 | 说明 |
| ---- | -------- | ---- |
| `src/drivers/opencode-driver.js` | 修改 | `replyPermission` 对 TUI bridge 转发到 `tuiBridge.replyQuestion`，不再抛错 |
| `src/opencode-tui-bridge/bridge.js` | 新增方法 | `replyQuestion(sessionRef, questionId, answer)` 投递 `question_reply` delivery |
| `src/platform/feishu/cards.js` | 新增 | `buildQuestionCard`、`buildQuestionRepliedCard` |
| `src/platform/feishu/platform.js` | 修改 | `_handleCardAction` 传递 `formValue` |
| `src/platform/feishu/events.js` | 无变更 | `parseCardAction` 已解析 `formValue` |
| `src/app/bootstrap.js` | 修改 | `onCardAction` 传递 `formValue` 到 `dispatcher.handleCommand` |
| `src/dispatch/message-dispatcher.js` | 新增 | `questionReplyStates`、`_cmdAnswer`、question 事件分发分支 |
| `src/dispatch/permission-handler.js` | 修改 | `handle` 方法对 `data.type=question` 分发到 question 渲染 |
| `src/platform/feishu/commands.js` | 修改 | COMMANDS 新增 `answer` 条目 |
| `src/drivers/agent-driver.js` | 修改 | `AgentEvent.TYPE_PERMISSION` schema 兼容新 metadata；`EVENT_TYPE_PERMISSION_REPLIED` 的 `response` schema 应扩展为 `string\|string[]`，或在 question 场景下 `response` 为 JSON 序列化的 string |
