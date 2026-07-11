# Walker 短期演进规格

## 背景

Walker 当前定位是通过飞书长连接操控本机 OpenCode Agent 会话的轻量 Agent Hub。近期已完成长文本分片、后台 watch 去重、跨项目 attach 提示、进度卡片心跳等可靠性修复。本轮演进聚焦短期 1-2 周内可交付的稳定性和远程控制能力，不引入 ACP、多平台或复杂 Web 管理后台。

## 产品目标

让个人开发者在飞书中远程控制本机 OpenCode 时，能够清楚知道任务是否仍在执行、能够取消异常任务、能够查看当前运行状态，并且减少重复推送和长任务失控。

## 范围

## Requirement IDs

| ID | 需求 |
| --- | --- |
| REQ-001 | 心跳参数环境变量化，默认行为与当前实现一致。 |
| REQ-002 | 新增 `/cancel` 命令，取消当前正在执行的 turn，保留 Walker session。 |
| REQ-003 | 新增 `/status` 命令，并保留 `/ps` 作为等价别名。 |
| REQ-004 | 新增单轮最大执行时长 `WALKER_MAX_TURN_TIME_MINS`，超时后自动取消当前 turn。 |
| REQ-005 | 补强重复推送测试和取消/超时残留输出防护。 |
| REQ-006 | 更新 README，补齐新增命令、配置项和长任务行为说明。 |

### 本轮实现

1. 心跳参数环境变量化。
2. 新增 `/cancel` 命令，用于取消当前正在执行的 turn，但保留 session。
3. 新增 `/status` 命令，并保留 `/ps` 作为等价别名。
4. 新增单轮最大执行时长 `max_turn_time_mins`，超时后自动取消当前 turn。
5. 补强重复推送测试，覆盖 prompt 渲染、watch 恢复、SSE、轮询之间的重复交付风险。
6. 更新 README，补齐新增命令、配置项和长任务行为说明。

### 本轮不实现

1. 不实现 ACP Driver。
2. 不接入 Claude、Codex、Gemini、Cursor 等新 Agent。
3. 不新增飞书以外的平台。
4. 不重构为新的配置文件格式，仅继续使用现有 `.env` 和环境变量机制。
5. 不实现复杂 Web 管理后台。
6. 不实现团队权限系统和审计日志。

## 关键行为定义

### 心跳配置

新增环境变量：

| 变量 | 默认值 | 单位 | 说明 |
| --- | --- | --- | --- |
| `WALKER_PROMPT_HEARTBEAT_INITIAL_MS` | `30000` | 毫秒 | prompt 开始后多久无事件时首次更新进度卡片 |
| `WALKER_PROMPT_HEARTBEAT_INTERVAL_MS` | `60000` | 毫秒 | 首次心跳后的重复更新间隔 |
| `WALKER_PROMPT_HEARTBEAT_STUCK_MS` | `300000` | 毫秒 | 达到该时长后提示任务可能卡住 |
| `WALKER_MAX_TURN_TIME_MINS` | `0` | 分钟 | 单轮 prompt 最大执行时长，`0` 表示不启用自动超时 |

心跳只更新原进度卡片，不发送普通群消息。非 card 进度模式下不启用卡片心跳。

### `/cancel`

`/cancel` 用于取消当前绑定 session 的当前 turn。

行为要求：

1. 如果当前会话没有绑定 session，回复 `No running session to cancel.`。
2. 如果当前 session 不在运行中，回复 `No running turn to cancel.`。
3. 如果 driver 支持取消当前 turn，应调用对应取消能力。
4. 当前 OpenCode 驱动若缺少细粒度 cancel 能力，可复用 `driver.stop(agentRef)` 作为第一版实现，但语义上只将 Walker session 标记回 `idle`，不删除 session。
5. `/cancel` 必须清理该 session 的 prompt 心跳、prompt 队列后续状态、后台 watch buffer 中与本轮相关的待发文本。
6. `/cancel` 返回后，后续 watch 恢复时不得把已取消 turn 的残留回答推送到飞书。

`/cancel` 与 `/stop` 的区别：

| 命令 | 语义 | Walker session 状态 | 远端 Agent session |
| --- | --- | --- | --- |
| `/cancel` | 取消当前 turn，保留会话 | 回到 `idle` | 尽量停止当前执行，不删除 |
| `/stop` | 停止当前 session | `stopped` | 调用 driver stop |

### `/status` 和 `/ps`

`/status` 展示当前 routeKey 绑定的 session 和运行状态。`/ps` 是别名。

最少包含：

1. Walker session id。
2. Agent 名称。
3. Walker session 状态。
4. OpenCode session id。
5. 当前模型。
6. 工作目录。
7. 当前 turn 是否运行中。
8. 当前 turn 已运行时长。
9. 最近一次进度或 Agent 事件时间。
10. 是否有后台 watch。

如果没有绑定 session，回复当前会话未绑定，并提示使用 `/new` 或 `/attach`。

### 最大执行时长

当 `WALKER_MAX_TURN_TIME_MINS > 0` 时，每个 prompt turn 启动一个超时看门狗。

行为要求：

1. 超时后自动取消当前 turn。
2. 超时提示通过进度卡片或错误卡片发给飞书。
3. 超时必须清理心跳 timer。
4. 超时不得删除 Walker session。
5. 超时后 session 应回到 `idle` 或 `error`，本轮建议回到 `idle` 并发送明确超时提示。
6. prompt 后续若仍返回事件，必须被识别为已取消或过期，不能再推送最终回答。

### 重复推送补强

在当前已有去重基础上，补强测试和实现，避免以下路径重复：

1. prompt 主流程已渲染文本后，watch 恢复再次发送同一文本。
2. SSE 已投递文本后，轮询再次投递同一 assistant message。
3. done 事件重复到达导致同一 watch buffer 发送两次。
4. 取消或超时后的残留事件再次触发发送。

实现上优先采用最小化策略：保留当前 `sessionDeliveredTexts` 思路，必要时扩展为按 session 保存有限数量的文本 hash 或事件 key；不要引入持久化数据库。

## 用户交互文案

用户可见文案保持简洁。建议文案：

| 场景 | 文案 |
| --- | --- |
| `/cancel` 无绑定 | `No running session to cancel.` |
| `/cancel` 无运行 turn | `No running turn to cancel.` |
| `/cancel` 成功 | `Current turn cancelled: <sessionId>` |
| turn 超时 | `Current turn timed out after <N> minutes and was cancelled.` |
| `/status` 无绑定 | `No session bound to this conversation. Use /new or /attach first.` |

## 配置和兼容性

1. 默认值必须保持现有行为：不设置新环境变量时，心跳行为与当前实现一致，最大执行时长默认关闭。
2. 新配置集中从现有 env/config/bootstrap 路径注入 `MessageDispatcher`，不得在业务逻辑中散落读取 `process.env`。
3. 所有新增配置必须在 README 中说明。
4. `npm test` 必须通过。

## 测试要求

至少新增或更新以下测试：

1. `MessageDispatcher` 使用环境配置的心跳参数。
2. `/cancel` 无绑定 session 时返回可诊断提示。
3. `/cancel` 有 running session 时调用 driver stop 或 cancel，并将 session 回到 idle。
4. `/cancel` 后残留 watch 文本不再发送到飞书。
5. `/status` 无绑定时提示 `/new` 或 `/attach`。
6. `/status` 有绑定时返回 session、agent、状态、cwd、模型和运行时长。
7. `WALKER_MAX_TURN_TIME_MINS` 超时后取消当前 turn，清理心跳，不发送过期最终回答。
8. prompt/watch/SSE/polling 重复路径至少有一条新增回归测试。
9. README 包含新增命令和配置说明。

## 验收标准

1. 用户可以在飞书发送 `/cancel` 取消当前长任务。
2. 用户可以在飞书发送 `/status` 或 `/ps` 判断任务是否还在运行。
3. 长任务超过配置上限后会自动取消并提示用户。
4. 心跳参数可以通过环境变量调整。
5. 已取消或已超时任务的残留输出不会再次推送到飞书。
6. `npm test` 全量通过。
7. README 与实际行为一致。

## 备选方案比较

### 方案 A：最小增量实现（推荐）

在现有 `MessageDispatcher`、env/bootstrap、测试和 README 上增量实现。`/cancel` 第一版复用 driver stop 能力，后续再扩展细粒度 cancel。

优点：改动小，能快速提升可靠性。缺点：OpenCode 当前可能无法做到真正只取消单个 turn。

### 方案 B：先重构任务生命周期管理

先引入独立 TurnManager，集中管理队列、心跳、超时、取消和去重。

优点：架构更清晰。缺点：本轮范围显著扩大，容易引入回归。

### 方案 C：直接转向 ACP Driver

先接 ACP，再基于 ACP 实现取消和状态。

优点：长期方向正确。缺点：无法快速解决当前飞书 + OpenCode 的稳定性痛点。

本轮选择方案 A。

## 开放问题

无阻塞开放问题。`/cancel` 第一版允许复用 OpenCode `stop` 能力，但必须在文档中说明其语义是取消当前 turn、保留 Walker session。
