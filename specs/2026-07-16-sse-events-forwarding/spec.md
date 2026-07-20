# OpenCode 原生提问同步到飞书 — 需求规格

## 1. 概述

**需求来源**：用户反馈 OpenCode `question` 工具只在本地 TUI 弹出选择窗口，飞书没有收到同一提问，导致无法从飞书完成选择并回传答案。

**需求类型**：修改

**选定方案**：完整原生映射。Walker 独立承载 OpenCode 的 `question.asked`、`question.replied`、`question.rejected` 事件，不再将原生提问伪装成 permission；一次调用中的多个问题分别发送飞书卡片，全部答案收集完成后，以原始顺序一次性调用 OpenCode 原生 `question.reply`。

**目标结果**：

- OpenCode 本地 TUI 与飞书同时展示同一组问题。
- 用户可在飞书完成单选、多选和自定义答案输入。
- 飞书答案按 OpenCode 要求组装为 `string[][]`，并恢复被 `question` 工具挂起的会话。
- 本地 TUI 与飞书并发回答时，仅首个被 OpenCode 接受的整组回复生效，其他交互得到明确的“已处理”反馈。
- 新旧 TUI bridge 协议严格隔离，未加载原生 question reply 能力的旧插件不得收到新载荷。

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | 转发原生提问事件 | P0 | 给定 OpenCode 发布包含一个或多个 `questions` 的 `question.asked`，当插件接收该事件时，则 Walker 收到独立的 question asked 事件，且 `requestID`、`sessionID`、`tool`、问题顺序、标题、正文、选项、`multiple` 和 `custom` 信息保持一致。 |
| REQ-002 | 为每个问题发送飞书卡片 | P0 | 给定一次请求包含 N 个问题，当 Walker 处理该请求时，则目标飞书会话收到 N 张可交互卡片，每张卡片明确显示“问题 i/N”，并与原始问题一一对应。 |
| REQ-003 | 支持单选答案 | P0 | 给定问题的 `multiple` 不为 `true` 且存在预设选项，当用户在飞书选择一个选项并提交时，则该题保存为只含该选项标签的一个答案数组。 |
| REQ-004 | 支持多选答案 | P0 | 给定问题的 `multiple` 为 `true`，当用户在飞书选择多个选项并提交时，则该题保存全部选中标签，且预设选项按原始 `options` 顺序排列。 |
| REQ-005 | 支持自定义答案 | P0 | 给定问题允许 `custom`，当用户填写非空自定义答案时，则自定义文本作为该题答案；单选题不得同时提交预设选项和自定义答案，多选题可将非空自定义答案追加到已选标签之后。 |
| REQ-006 | 完整回复多问题请求 | P0 | 给定一次请求包含 N 个问题，当且仅当 N 个问题均已在飞书取得合法答案时，则 Walker 按原始问题顺序组装 `answers: string[][]`，并只调用一次该请求的 OpenCode 原生 `question.reply`。 |
| REQ-007 | 执行原生 question reply delivery | P0 | 给定插件收到 `question_reply` delivery，当 delivery 包含合法 `requestID` 和 `answers` 时，则插件调用 OpenCode SDK 的 question reply API，不得将其作为普通提示词发送给会话。 |
| REQ-008 | 同步本地 TUI 抢先回复 | P0 | 给定飞书尚未完成或正在提交答案，当 OpenCode 发布同一 `requestID` 的 `question.replied` 时，则 Walker 将整组请求标记为已回复、停止后续远程提交，并将相关飞书卡片更新为已由其他入口处理。 |
| REQ-009 | 同步拒绝事件 | P1 | 给定 OpenCode 发布同一 `requestID` 的 `question.rejected`，当 Walker 收到事件时，则该请求进入已拒绝终态，相关飞书卡片停止接受答案并显示提问已取消。 |
| REQ-010 | 幂等与并发保护 | P0 | 给定同一题或同一请求收到重复、并发卡片回调，当首个合法处理已占用提交权或请求已进入终态时，则后续回调不得产生第二次有效原生回复，并返回“正在处理”或“已处理”的明确结果。 |
| REQ-011 | 提交失败安全收敛 | P0 | 给定原生回复未被插件执行且错误明确可重试，当提交失败时，则已收集答案不得丢失，全部相关卡片提供统一重试入口；给定 delivery 已被插件接受但最终结果丢失，或 OpenCode 返回 request not found，则请求进入 `processed_unknown`，不得自动或人工重复提交。 |
| REQ-012 | 保持 permission 链路兼容 | P0 | 给定现有 permission 请求与回复流程，当新增原生 question 链路后，则 permission 卡片、`replyPermission` 调用和已有行为保持不变。 |
| REQ-013 | 保留飞书路由隔离 | P0 | 给定多个飞书会话或多个 OpenCode agent 同时存在相同序号的问题，当处理卡片回调时，则必须通过原始路由、agent 引用和 `requestID` 定位唯一请求，不得把答案发送到其他会话或 agent。 |
| REQ-014 | Bridge 协议能力门禁 | P0 | 给定 TUI runtime 的 `bridgeProtocolVersion` 小于 4，当 Walker 尝试回复原生 question 时，则在 delivery 入队前返回 `QUESTION_REPLY_UNSUPPORTED`，不得把新载荷交给旧插件；给定版本不小于 4，则插件按原生 question reply 语义执行。 |
| REQ-015 | 卡片发送失败降级 | P0 | 给定任一问题卡片在首次发送和 1 次重试后仍失败，则整组请求进入 `feishu_unavailable`，已发送卡片全部更新为“请在本地 TUI 回答”且停止接受远程答案，不留下永远无法完成的部分交互。 |
| REQ-016 | 用户可见的幂等反馈 | P0 | 给定用户重复点击、并发点击、点击已终结卡片或点击重试按钮，则飞书原卡片必须显示“正在处理”“已处理”“已取消”“结果待确认”或“请求已过期”之一；不得仅返回 dispatcher 内部对象。 |
| REQ-017 | 状态有界保留 | P1 | 给定请求已进入 `replied`、`rejected`、`processed_unknown` 或 `feishu_unavailable`，则状态保留 24 小时且终态记录总量不超过 1000 条；过期或被容量淘汰后的旧卡片回调显示“请求已过期”。 |
| REQ-018 | 挂起会话可接收回复 | P0 | 给定 question 发生时 session 处于 busy，或该 question 嵌套在仍执行中的 prompt delivery 内，当 Walker 排队 `question_reply` 时，则 protocol v4 插件仍能并行拉取并执行该控制型 delivery，且不得启动第二个 prompt 或覆盖父 prompt 的 delivery 状态。 |

## 3. 接口与事件设计

### 3.1 OpenCode 到 Walker：question asked 事件

- **来源事件**：`question.asked`
- **Walker 事件类型**：独立的 question asked 类型，不复用 permission 类型。
- **用途**：将完整的原生 `QuestionRequest` 转发给 dispatcher。

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| `requestID` | `string` | 是 | OpenCode 原生问题请求 ID，取自 `QuestionRequest.id`。 |
| `sessionID` | `string` | 是 | 发起提问的 OpenCode 会话 ID。 |
| `questions` | `QuestionInfo[]` | 是 | 按原始顺序排列的问题列表，至少包含一项。 |
| `tool` | `{ messageID: string, callID: string }` | 否 | OpenCode 提供的工具调用关联信息，原样保留。 |

`QuestionInfo` 的规范化结构：

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| `question` | `string` | 是 | 问题正文。 |
| `header` | `string` | 是 | 问题短标题。 |
| `options` | `{ label: string, description: string }[]` | 是 | 预设选项；允许为空数组。 |
| `multiple` | `boolean` | 否 | `true` 表示可选择多个预设选项。 |
| `custom` | `boolean` | 否 | 是否允许自定义答案；未提供时按允许处理，与 question 工具默认行为一致。 |

### 3.2 OpenCode 到 Walker：question replied 事件

- **来源事件**：`question.replied`
- **Walker 事件类型**：独立的 question replied 类型。
- **用途**：通知 Walker 该请求已从本地 TUI 或其他入口成功回答。

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| `requestID` | `string` | 是 | 已回复的原生问题请求 ID。 |
| `sessionID` | `string` | 是 | 对应 OpenCode 会话 ID。 |
| `answers` | `string[][]` | 是 | OpenCode 最终接受的完整答案。 |

### 3.3 OpenCode 到 Walker：question rejected 事件

- **来源事件**：`question.rejected`
- **Walker 事件类型**：独立的 question rejected 类型。
- **用途**：通知 Walker 该请求已取消，不再接受飞书答案。

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| `requestID` | `string` | 是 | 已拒绝的原生问题请求 ID。 |
| `sessionID` | `string` | 是 | 对应 OpenCode 会话 ID。 |

### 3.4 Walker 到 OpenCode：question reply delivery

- **delivery 类型**：`question_reply`
- **执行入口**：OpenCode 插件的 delivery 执行器。
- **执行动作**：调用 OpenCode SDK 原生 question reply API。

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| `requestID` | `string` | 是 | 待回复的原生请求 ID。 |
| `answers` | `string[][]` | 是 | 与原始问题数量相同、顺序一致的完整答案。 |

插件必须执行等价于以下语义的调用：

```js
api.client.question.reply({ requestID, answers })
```

`question_reply` 不得进入 `promptAsync`，也不得转换为自然语言提示词。

该载荷属于 **TUI bridge protocol v4**。实现必须同时：

- 将生成插件标记升级为新的 Walker TUI bridge 版本。
- 将插件注册字段 `bridgeProtocolVersion` 从 3 升级为 4。
- 在 delivery 入队前检查 runtime 的协议版本；版本小于 4 时返回错误码 `QUESTION_REPLY_UNSUPPORTED`，提示重启 OpenCode 以加载新插件。
- 旧协议的 `{ questionId, answer }` 与 v4 的 `{ requestID, answers }` 不得兼容混用，也不得增加将 v4 载荷降级为普通 prompt 的兼容逻辑。

protocol v4 同时扩展 delivery 拉取语义。poll 请求新增可选的 `acceptedTypes: string[]`，响应仍为一条原有 delivery 对象或 `null`：

- v4 插件调用 poll 时必须携带 `acceptedTypes`。session idle 且没有活跃 delivery 时传入 `['prompt', 'clear', 'question_reply']`；session busy 或已有父 prompt delivery 时传入 `['question_reply']`。
- v3 及更早插件未携带 `acceptedTypes` 时，Bridge 保留现有 FIFO `queue.shift()` 语义，以维持普通 prompt 和 clear 行为；版本门禁确保这些 runtime 的队列中不会出现 `question_reply`。
- Bridge 从 runtime 队列中取出第一条类型匹配的 delivery；不匹配的 prompt/clear 必须保留原顺序，不得因控制型 poll 被弹出或丢弃。
- `question_reply` 是控制型 delivery，不受 session idle 门禁限制；它可与同一 session 的一个父 prompt delivery同时处于 leased 状态。
- 同一 session 同时最多执行一个 question reply 控制 delivery。插件已有活跃控制 delivery 时不得再次 poll 控制队列，完成或放弃当前控制 delivery 后才拉取下一条。
- 插件分别追踪父 prompt delivery 与 question reply 控制 delivery，并分别维护 delivery ID、heartbeat timer 和 final 上报；控制 delivery 不得覆盖父 delivery 的状态或事件。
- 插件只有在 accepted 回执成功后才调用 question reply SDK；载荷校验失败时直接上报未调用 SDK 的 final 错误。accepted 上报出现临时连接错误时，插件保留该控制 delivery 并在后续 tick 重试 accepted，不得调用 SDK 或重新 poll。
- Bridge 在控制 delivery 被 poll 取出时记录 `dequeuedAt` 并启动 accepted 确认超时，时长使用 runtime stale 窗口，默认 10 秒。超时前仍未确认 accepted 时，以 `safeToRetry: true` 结束 queued delivery并写入超时 tombstone。
- accepted 上报必须按 delivery ID 幂等：queued 状态首次 accepted 转为 leased；同一 runtime/session 对 leased delivery 重放 accepted 时返回成功及 `duplicate: true`，不得重置租约；若 delivery 已因 accepted 超时结束，则返回明确的 `expired: true`，插件不得调用 SDK。

### 3.5 Driver 接口

Driver 增加与 permission 分离的原生提问回复能力：

```js
replyQuestion(agentRef, requestID, answers)
```

- `agentRef` 用于选择正确的 OpenCode 插件连接和会话路由。
- `requestID` 与 `answers` 原样写入 `question_reply` delivery。
- 现有 `replyPermission(agentRef, permissionID, answer, always)` 不改变签名和语义。
- `replyQuestion` 复用 bridge 的 queued → accepted → heartbeat → final delivery 生命周期，但控制 delivery 状态与父 prompt delivery 分开保存，并向调用方保留错误阶段信息。

控制 delivery 失败必须携带结构化字段：

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `code` | `string` | 稳定错误码，如 `QUESTION_REPLY_UNSUPPORTED`、`QUESTION_NOT_FOUND`、`TUI_RUNTIME_DISCONNECTED`。 |
| `deliveryPhase` | `preflight \| queued \| leased` | 失败时 Bridge 已知的 delivery 阶段；协议门禁或入队前连接检查失败使用 `preflight`。 |
| `sdkInvoked` | `boolean` | 插件是否已经开始调用 OpenCode question reply SDK。 |
| `safeToRetry` | `boolean` | 仅当可以证明 SDK 未被调用时为 `true`。 |

回复结果按是否可能已被 OpenCode 接受分为以下三类：

| 分类 | 判定条件 | Dispatcher 行为 |
| ---- | -------- | --------------- |
| `retryable` | 结构化错误明确给出 `safeToRetry: true` 且 `sdkInvoked: false` | 回到 `collecting`，保留完整答案并展示重试按钮。 |
| `succeeded` | 插件确认 SDK question reply 成功并完成 final；或收到 `question.replied` | 进入 `replied`，禁止再次提交。 |
| `processed_unknown` | `sdkInvoked: true` 后租约丢失或 final 回执丢失；SDK 返回 request not found；错误未明确标记 `safeToRetry: true` | 进入 `processed_unknown`，禁止再次提交，等待可能迟到的 replied/rejected 事件校正显示。 |

协议版本过低属于 `QUESTION_REPLY_UNSUPPORTED`，不属于临时可重试错误；请求转为 `feishu_unavailable`，提示用户重启 OpenCode 后在本地 TUI 回答当前问题。

### 3.6 飞书卡片回调标识

每张问题卡片使用以下逻辑标识：

```text
questionKey = requestID + ":" + questionIndex
```

- `questionIndex` 从 `0` 开始，与 `questions` 和最终 `answers` 的数组下标一致。
- 卡片回调必须携带 `questionKey`、创建卡片时的 Walker session ID，并保留现有飞书 routeKey，使 dispatcher 能定位原始 agent 和目标飞书会话。
- `requestID` 只用于回复 OpenCode；`questionKey` 只用于区分同一请求内的卡片，不替代原生 `requestID`。
- Dispatcher 必须校验回调 `messageId` 等于该题已记录的飞书卡片 ID、routeKey 等于请求记录，并校验回调中的 Walker session ID 仍映射到请求保存的 agentRef；questionIndex 也必须有效。任一不匹配均拒绝处理。
- 回调处理使用请求创建时保存的 agentRef，不得根据点击时的当前焦点 session 重新推导目标 agent。

### 3.7 飞书问题表单协议

每张卡片使用一个统一提交按钮，按钮动作携带 `questionKey`；预设选项和自定义答案通过不同表单字段提交：

| 字段 | 飞书控件 | 值格式 | 适用场景 |
| ---- | -------- | ------ | -------- |
| `question_selected` | 单选题使用 `select_static`，多选题使用 `multi_select_static` | `option_0`、`option_1` 等稳定序号 | 存在预设选项时。 |
| `question_custom` | `input` | 用户输入的原始文本 | `custom` 不为 `false` 时。 |

- 选项值不得直接使用 label，dispatcher 必须根据请求状态中的原始 `options` 将稳定序号映射回 label，防止空格、特殊字符或重复描述影响命令解析。
- 单选题可以同时渲染 `select_static` 和 `input`，但提交时两者互斥；两者同时非空时拒绝本次回调。
- 多选题可以同时渲染 `multi_select_static` 和 `input`；最终答案先按原始 `options` 顺序排列所选 label，随后追加非空自定义文本，不依赖飞书返回选中值的顺序。
- 无预设选项且允许自定义答案时只渲染 `input`。
- 禁止自定义答案时不渲染 `question_custom`。
- 表单提交动作使用 `cmd:/answer {questionKey} --form {walkerSessionId}`；重试动作使用独立的 `cmd:/answer {questionKey} --retry {walkerSessionId}`，后者不得读取或覆盖表单答案。大括号内容表示运行时替换值，不是文档占位符。

## 4. 状态设计

### 4.1 请求状态

每个原生请求以 `agentRef + requestID` 作为内部唯一键，保存以下信息：

```js
{
  agentRef,
  requestID,
  sessionID,
  routeKey,
  questions,
  answers,
  cards,
  cardStates,
  cardAttempts,
  status,
  submitError,
  completedAt
}
```

| 字段 | 说明 |
| ---- | ---- |
| `answers` | 与 `questions` 等长的数组；未回答位置为内部空值，已回答位置为非空 `string[]`。 |
| `cards` | 每题对应的飞书消息 ID，用于提交后或外部终态事件到达时更新卡片。 |
| `cardStates` | 与问题等长，单题状态为 `pending`、`sending`、`sent`、`answered` 或 `send_failed`。 |
| `cardAttempts` | 与问题等长的非负整数数组；每次调用飞书发送 API 前递增，每题最多为 2，防止重复 asked 事件突破“首次发送 + 1 次重试”的上限。 |
| `status` | 请求级状态：`sending_cards`、`collecting`、`submitting`、`replied`、`rejected`、`processed_unknown`、`feishu_unavailable`。 |
| `submitError` | 最近一次可重试提交错误；下一次开始提交时清除。 |
| `completedAt` | 进入 `replied`、`rejected`、`processed_unknown` 或 `feishu_unavailable` 的时间，用于有界保留和淘汰。 |

### 4.2 状态转换

| 当前状态 | 触发条件 | 下一状态 | 动作 |
| -------- | -------- | -------- | ---- |
| 不存在 | 收到 `question.asked` | `sending_cards` | 建立请求状态并逐题发送飞书卡片，每张失败卡片额外重试 1 次。 |
| `sending_cards` | 全部卡片发送成功 | `collecting` | 开放每张卡片的答案提交。 |
| `sending_cards` | 任一卡片重试后仍失败 | `feishu_unavailable` | 停止继续收集，已发送卡片全部更新为“请在本地 TUI 回答”。 |
| `collecting` | 某题首次提交合法答案，仍有其他题未答 | `collecting` | 保存该题答案并将对应卡片更新为已收集。 |
| `collecting` | 最后一题首次提交合法答案 | `submitting` | 原子占用整组提交权，组装完整 `answers` 并调用 `replyQuestion`。 |
| `submitting` | 原生回复成功，或收到相同请求的 `question.replied` | `replied` | 保存最终答案并将全部卡片更新为已处理。 |
| `submitting` | 明确的 `retryable` 失败 | `collecting` | 保留全部已收集答案，记录错误，将所有相关卡片改为失败卡片并提供 `--retry` 按钮。 |
| `submitting` | 结果无法确认或 request not found | `processed_unknown` | 禁止再次提交，将全部卡片更新为“结果待确认”。 |
| `collecting` | 收到 `question.replied` | `replied` | 放弃未提交的飞书草稿答案，使用事件中的最终答案更新全部卡片。 |
| `sending_cards`、`collecting`、`submitting` 或 `feishu_unavailable` | 收到 `question.rejected` | `rejected` | 停止提交并将全部已发送卡片更新为已取消。 |
| `sending_cards`、`collecting`、`submitting` 或 `feishu_unavailable` | 收到 `question.replied` | `replied` | 使用事件中的最终答案更新全部已发送卡片。 |
| `processed_unknown` | 收到迟到的 `question.replied` 或 `question.rejected` | `replied` 或 `rejected` | 用 OpenCode 的明确终态校正卡片显示。 |
| `replied`、`rejected`、`processed_unknown` 或 `feishu_unavailable` | 收到重复回调 | 状态不变 | 不再调用原生回复，并在原卡片显示对应终态。 |

### 4.3 问题级提交规则

- 每题只接受首个合法飞书答案。
- 已收集问题的重复回调不覆盖原答案。
- 当全部答案已收集但上一次整组提交发生明确 `retryable` 失败时，所有相关卡片更新为统一失败卡片并显示“重试提交”按钮；点击任一按钮只重发已保存的完整答案，不读取表单，也不覆盖已有题目答案。
- 请求进入 `submitting` 后，所有相关飞书回调均通过卡片更新显示“正在处理”，不得并发创建第二个 delivery。
- `processed_unknown` 不提供重试按钮，因为再次提交可能覆盖或重复一个已经成功的原生回复。
- 每次回调在读取和修改请求状态前执行终态记录的 TTL 与容量淘汰；找不到状态时将当前卡片更新为“请求已过期”，不得尝试重建答案。
- 请求处于 `sending_cards` 时收到回调，不保存答案，原卡片显示“问题仍在准备，请稍后提交”；全部卡片发送成功后用户可再次提交。

## 5. 业务规则

- 原生请求是最小回复单位。即使飞书按问题拆成多张卡片，也必须等全部问题回答后一次性回复 OpenCode。
- 最终 `answers` 外层数组长度必须与 `questions` 长度相同，且下标严格对应。
- 单选题必须产生且只产生一个非空字符串答案。
- 多选题必须产生至少一个非空字符串答案；预设选项使用其 `label`，不使用 `description`，并按原始 `options` 顺序排列。
- 单选题允许自定义答案时，预设选项与自定义答案互斥。
- 多选题允许自定义答案时，自定义文本非空才追加到答案数组，且位于预设选项之后。
- 所有自定义文本在校验时去除首尾空白；去除后为空视为未填写。
- `custom` 缺省时按 `true` 处理；显式为 `false` 时飞书卡片不得提供自定义答案入口。
- 卡片必须展示选项的 `label` 和 `description`；提交给 OpenCode 的仅为 `label` 或用户输入的自定义文本。
- 本地 TUI 不被禁用或隐藏。它与飞书是同一原生请求的两个回答入口。
- OpenCode 是最终并发裁决者。若飞书提交与本地 TUI 同时发生，以 OpenCode 首个成功接受的回复为准。
- 若飞书调用收到“请求不存在”类结果，且随后或已经收到 `question.replied`/`question.rejected`，按已处理终态展示，不作为可重试失败。
- 若 request not found 到达时尚未收到明确终态，则进入 `processed_unknown`；它表示停止输入和提交，但允许迟到的 OpenCode 终态事件校正显示。
- 原生 question 状态与现有 permission 回复状态分开存储，避免相同 ID 或相同卡片动作互相污染。
- 请求状态只需进程内保存，不新增数据库或跨进程持久化；服务重启后由 OpenCode 后续事件决定终态。
- `replied`、`rejected`、`processed_unknown`、`feishu_unavailable` 状态保留 24 小时，四类终态合计最多保留 1000 条；超过任一限制时按 `completedAt` 从旧到新淘汰。
- 所有“正在处理”“已处理”“已取消”“结果待确认”“请在本地 TUI 回答”和“请求已过期”反馈必须通过 patch 原卡片实现；patch 失败时向原 chatId 发送一次文本反馈，且不得因反馈失败改变请求状态。
- 同一请求最先观察到的明确 OpenCode 终态生效；后续矛盾终态只记录协议错误，不反转 `replied` 与 `rejected`。

## 6. 异常与边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| `question.asked` 缺少 `requestID`、`sessionID` 或有效问题列表 | 记录协议错误，不发送不可回复的飞书卡片，不影响其他事件。 |
| 同一 `agentRef + requestID` 重复收到 asked 事件 | 复用已有请求状态；仅对仍为 `pending` 或 `send_failed` 且 `cardAttempts < 2` 的卡片执行发送，不重复发送已记录 messageId 的卡片。 |
| 问题没有预设选项但允许自定义答案 | 发送文本输入卡片，要求提交一个非空答案。 |
| 问题没有预设选项且禁止自定义答案 | 将请求转为 `feishu_unavailable` 并记录协议错误；已发送卡片提示在本地 TUI 回答，不向 OpenCode 提交空答案。 |
| 单选题同时提交预设选项和自定义答案 | 拒绝本次题目回调，提示二选一，不改变已保存状态。 |
| 多选题未选预设项且自定义答案为空 | 拒绝本次题目回调，提示至少提供一个答案。 |
| 卡片回调中的 `questionIndex` 越界 | 拒绝回调并记录无效标识，不影响请求状态。 |
| routeKey、Walker session 到 agentRef 的映射或 messageId 与请求记录不匹配 | 拒绝回调，不向任何 agent 发送 delivery；原卡片可更新时显示“请求无效”。 |
| 飞书发送部分卡片失败 | 每张失败卡片额外重试 1 次；仍失败则进入 `feishu_unavailable`，禁用已发送卡片并提示在 TUI 回答。 |
| delivery 在 runtime accepted 前失败，且错误明确 `safeToRetry: true` | 保留答案并回到可重试状态，所有相关卡片显示提交失败及重试按钮。 |
| delivery accepted 后租约丢失或 final 回执丢失 | 进入 `processed_unknown`，显示结果待确认，不得重试。 |
| 原生回复返回 request not found | 进入 `processed_unknown`；若随后收到 replied/rejected，则校正为明确终态。 |
| runtime 的 bridge protocol 小于 4 | 不入队 delivery，进入 `feishu_unavailable`，提示重启 OpenCode 并在本地 TUI 回答。 |
| TUI 在飞书只回答部分问题后完成整组回复 | 丢弃飞书未提交草稿，以 `question.replied.answers` 为最终答案，并更新所有卡片。 |
| rejected 在飞书提交中先于回复成功或 replied 事件到达 | 进入 rejected；后续本地调用结果不得把状态改回 replied。若 replied 已先成为明确终态，则迟到的 rejected 只记录协议错误。 |
| replied 事件在飞书回复 API 成功前到达 | 直接进入 replied 终态；API 后续成功或“请求不存在”均不得触发第二次状态转换。 |
| Walker 服务重启导致内存状态丢失，旧卡片再次回调 | 返回请求已失效或无法定位的明确提示，不猜测或重建不完整的 `answers`。 |
| 终态记录超过 24 小时或超过 1000 条被淘汰 | 旧卡片回调显示请求已过期，不重新联系 OpenCode。 |

## 7. 验证范围

- 插件事件映射测试：asked、replied、rejected 的字段完整性与过滤行为。
- 插件 delivery 测试：`question_reply` 调用原生 SDK，且不调用 `promptAsync`；插件版本与 `bridgeProtocolVersion: 4` 正确上报。
- TUI bridge 测试：独立 question 事件可进入标准 AgentEvent 流；完整 `answers` 可进入 delivery 队列；`acceptedTypes` 只取匹配 delivery 且保留其他队列顺序；省略 `acceptedTypes` 时保持旧 FIFO 行为；queued 控制 delivery 超过默认 10 秒 accepted 确认窗口后产生可重试错误。
- accepted 幂等测试：首次 accepted 建立租约；响应丢失后的同 ID 重放返回 `duplicate: true` 且不重置租约；确认超时后的迟到 accepted 返回 `expired: true`，插件不调用 SDK。
- Driver 测试：`replyQuestion` 生成正确 delivery；protocol 小于 4 时拒绝入队；permission 方法保持原行为。
- 飞书卡片测试：`question_selected`、`question_custom`、稳定选项序号、单选互斥、多选追加、问题序号、回调标识、重试卡片及各类终态卡片。
- Dispatcher 状态机测试：逐题收集、完整数组顺序、messageId/routeKey/agentRef 校验、重复回调、并发提交、accepted 前失败重试、accepted 后结果不确定、request not found、replied/rejected 抢先终止。
- 卡片发送测试：单卡发送失败重试、重复 asked 不突破每题 2 次发送上限、部分发送失败进入 `feishu_unavailable`、已发送卡片降级提示。
- 保留策略测试：24 小时 TTL、1000 条容量淘汰和过期卡片反馈。
- 集成测试：一次包含多个问题的原生 question 从插件事件进入 Walker，经飞书逐题作答，最终只产生一次正确的原生 question reply delivery。
- 嵌套集成测试：question 在飞书发起的父 prompt 尚未完成时出现，控制 poll 在 session busy 且父 delivery leased 的情况下完成 question reply，父 prompt 随后继续并正常 final。
- 回归测试：现有 permission、普通消息、clear delivery 和飞书卡片回调测试继续通过。

## 8. 非目标

- 本次不关闭或替换 OpenCode 本地 TUI 的提问窗口。
- 本次不新增飞书侧“拒绝整个问题请求”的按钮或远程 `question.reject` 功能。
- 本次不新增 question 请求及答案的数据库持久化、跨进程恢复或历史查询页面。
- 本次不改变 OpenCode 原生 question 协议、答案顺序或首个成功回复生效的语义。
- 本次不重构现有 permission 业务为 question 协议。
- 本次不支持在飞书修改已收集的单题答案；提交错误后的重试使用已保存答案。
- 本次不在结果不确定或 request not found 时自动重放原生回复。
- 本次不为旧版 TUI bridge 增加兼容降级；旧 runtime 必须重启以加载 protocol v4。
- 本次不处理与该需求无关的消息类型接入或飞书机器人配置变更。
