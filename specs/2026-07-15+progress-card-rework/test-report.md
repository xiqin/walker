# 测试报告 — 飞书进度卡片重构

verdict: PASS

649/649 测试全部通过，语法检查通过，14 个 Requirement 全部有测试覆盖。

## 验证范围

| 测试文件 | 覆盖内容 | 结果 |
|----------|----------|------|
| `test/progress-card.test.js` | T1：ProgressCard 忽略 text、保留 reasoning/tool/error/status、done 显示"✅ 处理完成" | 21/21 通过 |
| `test/message-dispatcher.test.js` | T2：card 模式跳过 TYPE_TEXT、replyText 单发完整文本、空文本不发、卡片失败不重复、replyText 失败/undefined 不记录 deliveredText、watch 可补发、legacy/心跳/watch 不变 | 66/66 通过 |
| `test/bootstrap.test.js` | 下游：createApp 集成，进度卡片 done 后绿色，最终回答通过 replyText 发送 | 9/9 通过 |
| `test/integration-feishu-tui-sync.test.js` | 下游：飞书-TUI 双向链路，embedded TUI 回答通过 replyText 发送，watch 去重正常 | 6/6 通过 |

## 集成验证

```
npm test
# tests 649
# pass 649
# fail 0
# cancelled 0
# skipped 0
```

## 语法检查

- `node --check src/platform/feishu/progress-card.js`：通过
- `node --check src/dispatch/message-dispatcher.js`：通过

## Requirement 覆盖

| REQ | 测试覆盖 |
|-----|----------|
| REQ-001 | formatAgentEvent text 返回空、ProgressCard 忽略普通/delta text |
| REQ-002 | card 模式不使用文本事件更新卡片 |
| REQ-003 | reasoning 长文本保留前缀并截断 |
| REQ-004 | reasoning/tool_use/error/status 行为保持 |
| REQ-005 | card 模式通过 replyText 发送合并后的完整回答 |
| REQ-006 | card 模式只更新一个 done 事件 |
| REQ-007 | card 模式空回答不发送文本消息 |
| REQ-008 | legacy 模式行为保持不变 |
| REQ-009 | 心跳仍更新 TYPE_STATUS |
| REQ-010 | watch 完成仍通过 sendText 转发 |
| REQ-011 | done 后显示中性完成提示 |
| REQ-012 | replyText undefined 不标记已送达、replyText 失败后 watch 可补发 |
| REQ-013 | 卡片创建失败不触发 legacy 重复发送 |
| REQ-014 | 全部场景均有自动化覆盖 |

## 改动文件

| 文件 | 改动 |
|------|------|
| `src/platform/feishu/progress-card.js` | text 返回空、删除 delta 合并、done 追加"✅ 处理完成" |
| `test/progress-card.test.js` | 更新 4 个旧测试，新增 5 个测试 |
| `src/dispatch/message-dispatcher.js` | _renderEvents card 分支统一 replyText、_renderCardProgress 跳过 TYPE_TEXT 且无 cardId 直接返回 |
| `test/message-dispatcher.test.js` | replyText mock 返回真值，更新 8 个测试，新增 6 个测试 |
| `test/bootstrap.test.js` | 同步下游：replyText 记录调用并返回真值，断言改为 replyText 收到完整文本 |
| `test/integration-feishu-tui-sync.test.js` | 同步下游：replyText 返回真值，断言改为 replyText 收到 embedded TUI 回答 |
