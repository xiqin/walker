# 代码审查请求

**功能：** 飞书进度卡片重构 — 最终回答通过普通文本完整发送，卡片只展示过程状态
**Spec：** `specs/2026-07-15+progress-card-rework/spec.md`
**Plan：** `specs/2026-07-15+progress-card-rework/plan.md`

## 预审查（Standards + Spec 双轴）

### Standards

- 无发现。改动遵守 constitution 极简优先、精准手术原则，未新增架构层，未顺便优化无关代码，测试验证行为而非实现耦合。

### Spec

- 无发现。REQ-001 至 REQ-014 全部由自动化测试覆盖（见 `test-report.md` Requirement 覆盖表），非目标边界清晰。

### 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none

## 变更统计

```
 src/dispatch/message-dispatcher.js       |  11 +-
 src/platform/feishu/progress-card.js      |  15 +-
 test/bootstrap.test.js                    |   7 +-
 test/integration-feishu-tui-sync.test.js  |  11 +-
 test/message-dispatcher.test.js           | 232 ++++++++++++++++++++++++++++---
 test/progress-card.test.js                |  58 ++++++--
 6 files changed, 292 insertions(+), 42 deletions(-)
```

## 主要变更

1. **ProgressCard 忽略 text 事件**：`formatAgentEvent('text')` 返回空字符串；`append` 中 text 事件仅触发 `_updatePhase` 阶段切换但不进卡片；删除了原 delta 合并逻辑。
2. **Dispatcher card 模式统一通过 replyText 发送最终回答**：`_renderEvents` card 分支先渲染卡片，再提取完整文本通过 `replyText` 发送一次；仅当 `replyText` 返回真值时才 `_rememberDeliveredText`，失败/undefined 允许 watch 补发。
3. **_renderCardProgress 跳过 TYPE_TEXT**：遍历 displayEvents 时 `continue` 跳过 TYPE_TEXT，避免无意义 PATCH；无 cardId 时直接返回，不再回退 legacy（避免与 `_renderEvents` 的 replyText 重复发送）。
4. **done 卡片显示中性完成提示**：`render` 在 done 状态追加 `{ tag:'div', text:{content:'✅ 处理完成'} }`。
5. **下游测试同步**：`bootstrap.test.js` 和 `integration-feishu-tui-sync.test.js` 的 mock `replyText` 改为返回真值数组，断言改为通过 replyText 收到最终回答。

## 重点关注

1. **消息发送唯一性**：card 模式下 `_renderEvents` 是最终回答的唯一发送入口，`_renderCardProgress` 不再回退 legacy。需确认无重复发送路径。
2. **deliveredText 记录条件**：仅当 `replyText` 返回真值（生产为数组 `[{ message_id }]`）才记录，否则 watch 可补发。需确认生产 `replyText` 返回值符合预期。
3. **非目标边界**：多分片中途失败后的部分重复问题为本次明确非目标，legacy/心跳/watch 路径行为不变。

## 自测情况

- [x] 编译通过：`node --check src/platform/feishu/progress-card.js` exit 0
- [x] 编译通过：`node --check src/dispatch/message-dispatcher.js` exit 0
- [x] 测试通过：`npm test` 649/649 pass / 0 fail
- [x] 代码符合编码红线：极简改动、精准手术、未新增架构层
- [x] 图后端：本项目未启用 `.codegraph/`，索引查询已跳过

## 变更详情

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/platform/feishu/progress-card.js` | 修改 | text 返回空、删除 delta 合并、done 追加中性提示 |
| `src/dispatch/message-dispatcher.js` | 修改 | _renderEvents card 分支统一 replyText、_renderCardProgress 跳过 TYPE_TEXT 且无 cardId 直接返回 |
| `test/progress-card.test.js` | 修改 | 更新 4 个旧测试，新增 5 个测试 |
| `test/message-dispatcher.test.js` | 修改 | replyText mock 返回真值，更新 8 个测试，新增 6 个测试 |
| `test/bootstrap.test.js` | 修改 | 下游同步：replyText 记录并返回真值，断言改为 replyText 收到文本 |
| `test/integration-feishu-tui-sync.test.js` | 修改 | 下游同步：replyText 返回真值，断言改为 replyText 收到回答 |

## 审查重点

- [ ] 架构合规性：改动是否在既有分层内，是否引入隐藏状态
- [ ] 代码质量：text 返回空是否会导致意外副作用、replyText 真值判断是否健壮
- [ ] 安全性：无安全敏感操作
- [ ] 性能影响：card 模式新增一次 replyText 调用，无额外循环
- [ ] 测试覆盖：空文本、卡片失败、undefined/失败补发、done 唯一性是否充分
