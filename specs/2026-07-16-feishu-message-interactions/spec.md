# 飞书消息与指令交互增强 Spec

## 背景

Walker 当前通过飞书 WebSocket 接收文本消息和交互卡片事件。现有卡片按钮的 `value.action` 会经由 `parseCommand` 回流到 `MessageDispatcher.handleCommand`，已经支持将按钮点击转换为 `/use`、`/attach` 等命令。

本次需求包含三个交互增强：

1. Agent 回复给飞书的消息底部显示本次消息使用的模型，并优化消息格式。
2. `/model` 指令返回可点击的模型选择按钮。
3. `/help` 指令返回可点击的命令按钮。

## 目标

- 飞书最终文本回复应在底部包含模型信息，格式为清晰的分隔区块，例如 `模型：provider/modelID`。
- 模型信息取自当前会话实际用于 prompt 的模型解析结果，优先 `session.model`，否则 `defaultModel`，无模型时不显示或显示未指定。
- `/model` 无参数时不再只返回纯文本列表，应返回飞书交互卡片，按 provider 分组展示可用模型并提供选择按钮。
- 点击模型按钮后执行等价的 `/model <provider>/<model_id>`，完成当前会话模型切换。
- `/help` 返回飞书交互卡片，展示命令说明并提供常用命令按钮。
- 点击帮助卡片按钮后执行等价的 `/<command>`。
- 复用现有飞书卡片动作协议，不新增新的平台事件类型或独立交互协议。

## 非目标

- 不修改 OpenCode 模型目录 API。
- 不引入分页、搜索或多级模型选择流程。
- 不改变已有纯文本命令解析规则。
- 不做数据迁移；历史 `session.model` 字符串继续在读取边界兼容。

## 推荐方案

### 方案 A：新增专用卡片渲染函数、统一模型视图并复用命令回流协议

在驱动层约定统一模型视图，由各 agent driver 负责把自身模型目录转换为统一结构，飞书层不直接依赖 OpenCode 的原始字段。统一模型对象包含：

- `id`：模型 ID。
- `name`：展示名称。
- `provider`：模型供应商或模型命名空间。
- `status`：模型状态。
- `enabled`：是否可用。
- `source`：模型来源，例如 `opencode`、`claudecode`、`codex`。
- `groups`：模型分组标签数组，例如 `['recent']`。
- `lastUsedAt`：agent 可提供时的最近使用时间戳。
- `raw`：可选调试字段，仅驱动内部或测试使用，卡片层不依赖。

在 `src/platform/feishu/cards.js` 新增：

- `renderModelListCard(models, options)`：过滤非 deprecated/disabled 模型，优先显示统一模型视图中的 `Recent` 分组，再按 provider 分组，每个模型提供 `cmd:/model <provider>/<id>` 按钮。
- `renderHelpCard(commands, options)`：展示命令用法和说明，每个命令提供 `cmd:/<name>` 按钮。

在 `src/app/bootstrap.js` 挂载：

- `sendModelList(replyCtx, models, options)`
- `sendHelpCard(replyCtx, routeKey)`

在 `MessageDispatcher` 中：

- `/model` 无参数时从当前 agent driver 获取统一模型目录，优先调用 `sendModelList`，无卡片能力时可退回文本。
- `/help` 优先调用 `sendHelpCard`，无卡片能力时可退回 `replyText(formatHelp())`。
- Agent 回复文本前通过 `_resolveSessionModel(session)` 获取本次使用模型，并在最终飞书文本末尾追加统一的模型 footer。

取舍：改动集中、复用现有按钮协议，测试面清晰；模型目录扩展点在 driver 层，后续接入 Claude Code、Codex 等 agent 时只需实现统一模型目录，不需要重写飞书卡片交互；飞书卡片数量限制需要控制展示项数量。

### 方案 B：把所有命令响应统一迁移为卡片

将 `/status`、`/current`、`/agents` 等命令也改为交互卡片。

取舍：视觉一致性更强，但范围扩大，容易引入非本次需求的行为回归。

### 方案 C：用纯文本链接式命令提示替代按钮

保留纯文本输出，只在帮助和模型列表中提示用户复制命令。

取舍：实现最小，但不满足“可以直接点击选择/使用”的需求。

## 决策

采用方案 A。

## 详细行为

### 飞书回复模型 footer

- 对普通 Agent 回复的最终文本追加 footer。
- footer 内容使用 `_formatModel` 输出：
  - `{ providerID: 'anthropic', modelID: 'claude-sonnet-4' }` 显示为 `anthropic/claude-sonnet-4`。
  - `{ providerID: '', modelID: 'claude-sonnet-4' }` 显示为 `claude-sonnet-4`。
- 若解析不到模型，则显示 `未指定`。
- footer 与正文之间使用分隔线，避免和模型输出混在一起。

### `/model` 交互卡片

- Header：`可用模型`。
- 卡片正文优先展示 OpenCode `/models` 或模型接口返回的 `Recent` 分组；Recent 必须来自 agent driver 暴露的统一模型视图，不从 Walker session 历史推断。
- `Recent` 最多展示 5 个模型。
- 随后按 provider 分组展示模型名称和 ID。
- 每个模型提供一个按钮，按钮 value 为 `cmd:/model <provider>/<id>` 或 `cmd:/model <id>`。
- routeKey 写入按钮 value，保证线程和群聊场景下点击后路由准确。
- 过滤 `status === 'deprecated'` 或 `enabled === false` 的模型。
- 对展示数量设置上限：最多展示 20 个模型按钮。超过上限时提示使用 `/model <provider>/<model_id>` 精确切换。

### 多 agent 扩展约束

- `MessageDispatcher` 不直接判断 OpenCode 特有字段，只调用当前 agent driver 的 `listModels()` 或等价能力。
- `OpencodeDriver` 负责把 OpenCode `/api/model` 或 `/models` 的返回转换为统一模型视图，并将 OpenCode Recent 标记映射到 `groups: ['recent']` 或 `lastUsedAt`。
- 后续 `ClaudeCodeDriver`、`CodexDriver` 接入时，也通过同一统一模型视图输出模型目录。
- 飞书卡片层只根据统一字段渲染 `Recent`、provider 分组和按钮，不感知具体 agent。
- 当前会话的 agent 如果不支持模型目录，则 `/model` 返回“不支持模型列表”的提示；不回退到固定 OpenCode driver，避免多 agent 场景下误切其它 agent 的模型。

### `/help` 交互卡片

- Header：`Walker 命令帮助`。
- 展示每个命令的 usage 和 desc。
- 每个命令提供一个按钮，按钮 value 为 `cmd:/<name>`。
- routeKey 写入按钮 value。

## 验收标准

- `/model` 无参数时返回交互卡片，卡片包含模型按钮，按钮 action 可被现有 `onCardAction` 解析为 `/model <model>`。
- 点击模型按钮后当前会话 `model` 字段被更新为规范化对象。
- `/help` 返回交互卡片，卡片包含至少 `/new`、`/attach`、`/list`、`/model` 等命令按钮。
- 普通 Agent 文本回复底部包含模型信息 footer。
- 现有命令文本输入仍可用。
- 相关单元测试通过，至少覆盖卡片渲染和 `/model`、`/help` dispatcher 行为。

## Requirement IDs

| ID | 验收点 |
| -- | ------ |
| REQ-001 | 普通 Agent 最终文本底部包含 `模型：...` footer，解析不到模型时显示 `未指定`。 |
| REQ-002 | `/model` 无参数返回模型卡片，包含可点击按钮，支持 Recent 最多 5 个、总按钮最多 20 个、超限提示。 |
| REQ-003 | 模型按钮 action 可被现有卡片回流解析为 `/model <provider>/<id>`，点击后更新当前会话 `model` 字段。 |
| REQ-004 | `/help` 返回命令帮助卡片，至少包含 `/new`、`/attach`、`/list`、`/model` 等命令按钮。 |
| REQ-005 | dispatcher 通过当前 agent driver 获取统一模型目录；不固定回退到 OpenCode driver；OpencodeDriver 输出统一模型视图并映射 OpenCode Recent。 |
| REQ-006 | 同一卡片上点击不同模型按钮不能被 `messageId + name` 去重误判为重复。 |
| REQ-007 | 保持已有纯文本命令解析与无卡片能力 fallback 行为。 |

## 影响范围

- `src/platform/feishu/cards.js`
- `src/app/bootstrap.js`
- `src/dispatch/message-dispatcher.js`
- `test/feishu-cards.test.js`
- `test/message-dispatcher.test.js`

## 风险

- 飞书卡片按钮数量过多会导致卡片发送失败，因此模型列表需要限制展示数量。
- 按钮点击使用原卡片 messageId，命令去重 key 可能与原卡片消息相关；现有命令处理已按 `cmd:<messageId>:<name>` 去重，需避免同一卡片上重复点击不同模型被误判为重复。实现时需要将去重 key 纳入参数或对卡片动作命令做更细粒度区分。
