# 飞书进度卡片重构 — 最终回答改为普通文本消息

## 1. 概述

**需求来源**：用户反馈进度卡片消息因 Walker 主动截断（`MAX_TEXT_LEN=200`）导致长回答丢失完整信息。
**需求类型**：修改
**选定方案**：方案 A — 进度卡片只展示过程状态，Agent 最终回答无论长短都通过普通文本消息完整发送，沿用 `replyText()` 现有的 3500 字符自动分片能力；最终回答不再保留在卡片中。

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | ProgressCard 不再承载最终回答文本 | P0 | 给定 type='text' 事件，当 append 到 ProgressCard 时，则 formatAgentEvent 对 text 事件返回空字符串（不显示 text 内容），卡片元素中不出现最终回答 |
| REQ-002 | Dispatcher 不再用 text 事件更新卡片 | P0 | 给定 card 模式下的 displayEvents 含 TYPE_TEXT，当 _renderCardProgress 执行时，则跳过该事件，不调用 updateProgressCard，不产生无内容变化的 PATCH |
| REQ-003 | reasoning 事件仍可在卡片中截断展示 | P1 | 给定 type='reasoning' 事件，当 append 时，则卡片中显示 🤔 前缀 + 截断到 MAX_TEXT_LEN 的文本 |
| REQ-004 | reasoning/tool_use/error/status 事件行为不变 | P1 | 给定 reasoning/tool_use/error/status 事件，当 append 时，则按现有逻辑格式化并展示（与重构前一致） |
| REQ-005 | card 模式下 Agent 完成后通过 replyText 发送完整最终回答 | P0 | 给定 progressStyle='card' 且 driver.prompt 返回含 TYPE_TEXT 事件的 events，当 _renderEvents 执行时，则调用 replyText 且只调用一次，发送 _textFromDisplayEvents 拼接的完整文本；文本通过 replyText 自动分片（每片 ≤3500 字符） |
| REQ-006 | 使用 events 中已有 done 事件标记卡片完成 | P0 | 给定 card 模式且 displayEvents 含 TYPE_DONE，当 _renderCardProgress 遍历该事件时，则按原有路径调用一次 updateProgressCard，卡片 phase 切换为 done；不得额外构造或追加第二个 done 事件 |
| REQ-007 | 最终回答为空时不发送空文本消息 | P1 | 给定 events 不含任何 TYPE_TEXT 事件或文本为空，当 _renderEvents 完成时，则不调用 replyText 发送空字符串 |
| REQ-008 | legacy 模式行为不变 | P1 | 给定 progressStyle≠'card'，当 _renderEvents 执行时，则仍通过 _renderLegacyProgress 用 replyText 发送完整文本 |
| REQ-009 | 心跳 status 事件行为不变 | P1 | 给定 card 模式下心跳触发，当 tick 执行时，则仍通过 updateProgressCard 追加 status 事件到卡片，不受 text 事件改动影响 |
| REQ-010 | 被动监听 session 完成转发不受影响 | P1 | 给定 _handleWatchedSessionEvent 收到 TYPE_DONE，当 text 非空时，则仍通过 sendText 转发完整文本，不受本次改动影响 |
| REQ-011 | done 后的进度卡片显示中性完成提示 | P0 | 给定 ProgressCard 收到 done 事件，当 render 时，则卡片标题为"完成"，正文显示"✅ 处理完成"；提示不声明文本消息一定发送成功 |
| REQ-012 | 仅在文本发送成功后记录 deliveredText | P0 | 给定 card 模式最终文本非空，当 replyText 返回真值成功结果（生产实现为结果数组）时，则调用 _rememberDeliveredText；当 replyText 缺失、返回 undefined/null 或重试 3 次后失败时，则不记录 deliveredText，使 watchSession 仍可补发 |
| REQ-013 | 卡片不可用时最终文本仍只发送一次 | P0 | 给定 sendProgressCard 返回 null 或卡片创建失败，当 _renderCardProgress 执行时，则不调用 _renderLegacyProgress；最终文本仅由 _renderEvents 的统一 replyText 路径发送一次 |
| REQ-014 | 补充/更新测试覆盖 | P0 | 给定重构后的代码，当运行 `npm test` 时，则相关测试全部通过，并覆盖：text 不进入卡片且不触发 PATCH、card 模式 replyText 恰好发送一次完整文本、空文本不发送、仅一个 done、卡片创建失败不重复发送、replyText 失败或返回 undefined 时不记录 deliveredText、watchSession 可在失败后补发；成功路径 mock 必须返回明确的真值结果 |

## 3. 接口/API 设计

本次不新增对外接口。改动集中在内部方法：

### 3.1 ProgressCard.append(event) — 行为变更
- **改动**：type='text' 事件不再格式化为卡片行，不再累积或截断 text delta
- **改动**：done 状态渲染中性提示"✅ 处理完成"
- **保留**：reasoning/tool_use/error/status 行为不变

### 3.2 MessageDispatcher._renderEvents(session, event, events, progressCardId) — 行为变更
- **改动**：card 模式下，由该方法作为最终回答的唯一发送入口；_renderCardProgress 完成后，通过 replyText 发送 _textFromDisplayEvents 拼接的完整文本（非空时）
- **改动**：仅当 replyText 返回真值成功结果时，才调用 _rememberDeliveredText 记录已送达文本；生产实现成功时返回结果数组
- **保留**：legacy 模式仍由 _renderLegacyProgress 发送文本并维持现有记录行为

### 3.3 MessageDispatcher._renderCardProgress(session, event, displayEvents, progressCardId) — 行为变更
- **改动**：遍历 displayEvents 时跳过 TYPE_TEXT，不调用 updateProgressCard
- **改动**：卡片创建失败或不可用时直接返回，不再调用 _renderLegacyProgress，避免与 _renderEvents 的统一文本发送路径重复
- **保留**：使用 displayEvents 中已有 TYPE_DONE 更新卡片，不额外构造 done 事件

## 4. 数据设计

无新增数据结构。沿用现有：
- `ProgressCard.entries[]` / `entryTypes[]`：卡片事件行（不再含 text 类型行）
- `MessageDispatcher._textFromDisplayEvents()`：从 displayEvents 提取完整文本
- `replyText()` 的 `MAX_TEXT_CHARS=3500` 分片逻辑

## 5. 业务规则

- 规则 1：进度卡片只展示 reasoning/tool_use/error/status/done 事件，不展示 text 事件内容
- 规则 2：最终回答文本通过 replyText 以普通文本消息发送，支持自动分片
- 规则 3：最终回答为空时不发送空消息
- 规则 4：reasoning 事件仍截断到 MAX_TEXT_LEN=200，避免卡片膨胀
- 规则 5：done 事件后卡片标题为"完成"，正文含"✅ 处理完成"提示
- 规则 6：legacy 模式（progressStyle≠'card'）行为完全不变
- 规则 7：被动监听 session（_handleWatchedSessionEvent）的 sendText 转发不受影响
- 规则 8：card 模式的最终回答只有 _renderEvents 可以发送；_renderCardProgress 不得发送或回退发送文本
- 规则 9：只有 replyText 成功后才能把文本记录为已送达；发送失败时保留 watchSession 补发机会
- 规则 10：TYPE_DONE 只使用 driver 返回的现有事件，不追加重复 done

## 6. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| 最终回答超 3500 字符 | replyText 自动分片为多条文本消息 |
| 最终回答为空（只有 reasoning/tool_use） | 不发送空文本消息；卡片正常标记完成 |
| patchCard 失败返回 new_message 策略 | 仍发新卡片；text 事件不用于创建新卡片；最终回答仍仅通过 replyText 发送一次 |
| 初始卡片创建失败 | 不执行 legacy 文本回退；最终回答由 _renderEvents 统一通过 replyText 发送一次 |
| replyText 本身失败 | _callFeishu 重试 3 次，失败后记录 warn 日志且不记录 deliveredText，允许 watchSession 后续补发 |
| 心跳期间无 text 事件 | 卡片只显示 status 事件；完成后卡片标记 done，无 replyText 文本发送 |
| driver.prompt 返回 error 事件 | 走现有 sendErrorCard 路径，不执行 replyText 最终回答发送 |

## 7. 非目标

- 不调整 MAX_TEXT_LEN 或 MAX_EVENT_LINES 的值
- 不实现卡片内分页或滚动
- 不新增文件消息类型
- 不改动 legacy 模式的文本发送逻辑
- 不改动 _handleWatchedSessionEvent 的 sendText 转发逻辑
- 不改动 replyText/replyCard 的底层 API 封装
- 不改动 _coalesceDisplayEvents/_pushDisplayEvent/_stripPromptEcho 的文本合并逻辑
- 不处理 replyText 多分片发送到中途失败时，外层整体重试可能导致已成功分片重复的问题
