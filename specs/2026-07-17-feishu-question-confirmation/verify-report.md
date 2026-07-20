# Verify Report — 飞书交互式问题通知与确认

## 概览

| 项目 | 结果 |
|------|------|
| lint | PASS（0 error） |
| check（test） | PASS（1004/1004） |
| 占位符扫描 | PASS（0 占位符残留） |
| 类型一致性 | PASS |
| spec 覆盖 | PASS（REQ-001~013 全覆盖） |
| drift check | PASS（无 spec 外范围引入） |

## 1. 前置产出核验

test-report.md Verdict: PASS，1004 测试通过，0 失败，13 个 REQ 全覆盖。

## 2. 编译验证

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `npm run lint` | 0 | PASS |
| `npm run check` | 0 | PASS（1004 tests, 0 fail） |

## 3. 占位符扫描

扫描变更的 9 个源文件：`src/drivers/agent-driver.js`、`src/opencode-tui-bridge/bridge.js`、`src/drivers/opencode-driver.js`、`src/platform/feishu/cards.js`、`src/platform/feishu/platform.js`、`src/app/bootstrap.js`、`src/platform/feishu/commands.js`、`src/dispatch/message-dispatcher.js`、`src/dispatch/permission-handler.js`。

结果：0 个占位符残留（未发现待办标记或占位文本）。

## 4. 类型一致性检查

| 接口 | spec 定义 | 实现签名 | 一致 |
|------|-----------|----------|------|
| `replyQuestion(sessionRef, questionId, answer)` | §3.2 | `bridge.js:204` `(sessionRef, questionId, answer)` | ✅ |
| `buildQuestionCard(questionEvent, sessionId, routeKey)` | §4.3 | `cards.js:522` `(questionEvent, sessionId, routeKey)` | ✅ |
| `buildQuestionRepliedCard(questionId, answer)` | plan T4 2 参数 | `cards.js:600` `(questionId, answer)` | ✅ |
| `_cmdAnswer(cmd)` | §3.5 | `message-dispatcher.js:792` `async _cmdAnswer(cmd)` | ✅ |
| `questionReplyStates` | §4.2 3 态机 | `message-dispatcher.js:60` Map，60/809/1230/1241 使用 | ✅ |
| `response: string\|string[]` | §8 agent-driver.js | `agent-driver.js:121` `'string|string[]'` | ✅ |
| `COMMANDS.answer` | §3.3 | `commands.js:18` `{ desc, usage }` | ✅ |
| `DELIVERY_TYPE_QUESTION_REPLY` | §3.2 | `bridge.js:12` `'question_reply'` | ✅ |
| `replyPermission` TUI bridge 分支 | §3.4 | `opencode-driver.js:527-531` 转发到 replyQuestion | ✅ |
| `formValue` 全链路 | §3.3 | platform.js:112 → bootstrap.js:161 → dispatcher | ✅ |

## 5. 最终一致性核验

| REQ | spec 验收标准 | test-report 覆盖 | 实现确认 |
|-----|---------------|-------------------|----------|
| REQ-001 | TUI bridge 接收交互式问题事件 | integration #1 | normalizeEvents 允许 TYPE_PERMISSION；_handlePermissionEvent 区分 question ✅ |
| REQ-002 | single_select 卡片渲染 | integration #2, cards test | buildQuestionCard single_select 分支 ✅ |
| REQ-003 | multi_select 卡片渲染 | integration #3, cards test | buildQuestionCard multi_select 分支 + formValue ✅ |
| REQ-004 | text 自由文本输入 | integration #4, cards test | buildQuestionCard text 分支 + input 组件 ✅ |
| REQ-005 | /answer 命令处理 | integration #1-4 | _cmdAnswer 实现 formValue/args 解析 ✅ |
| REQ-006 | confirm 确认卡片 | integration #1, cards test | buildQuestionCard confirm 分支 + allow/deny ✅ |
| REQ-007 | 回调路由准确性 | cards routeKey test | buildButtonValue 传递 routeKey ✅ |
| REQ-008 | 卡片状态更新 | integration #8-11 | buildQuestionRepliedCard + patch 策略 ✅ |
| REQ-009 | 幂等与重复点击保护 | integration #5-7 | questionReplyStates 3 态机 ✅ |
| REQ-010 | 向后兼容 | integration #8-11 | _handlePermissionEvent 无 data.type=question 走 handle ✅ |
| REQ-011 | TUI bridge 回复通道 | integration #20, bridge test | replyPermission TUI 转发 + replyQuestion ✅ |
| REQ-012 | formValue 全链路 | integration, platform/bootstrap test | 4 处传递点确认 ✅ |
| REQ-013 | 未知 inputMode 降级 | integration #12, cards/handler test | effectiveMode 降级 + warn 日志 ✅ |

## 6. Drift Check

### 未引入 spec 外范围
- 无新增数据库表 ✅
- 无新增 HTTP 路由 ✅
- 未修改 /permit 命令行为 ✅
- 未修改飞书鉴权/事件订阅方式 ✅

### 业务规则对齐
- 规则 1（question 一律走 /answer）：`_handlePermissionEvent` 按 `data.type=question` 分发 ✅
- 规则 2（传统 permission 不破坏）：无 data.type=question 走 handle ✅
- 规则 3（options value 非空）：dispatcher _cmdAnswer required 校验兜底 ✅
- 规则 4（text required 空字符串）：_cmdAnswer isEmpty 校验 ✅
- 规则 5（multi_select string[]）：formValue 传递保持类型 ✅
- 规则 6（routeKey 携带）：buildButtonValue 传递 routeKey ✅
- 规则 7（重复提交保护）：questionReplyStates replied/submitting 拒绝 ✅
- 规则 8（失败回滚 pending）：_cmdAnswer catch 块 stateEntry.state = 'pending' ✅
- 规则 9（不展示敏感信息）：卡片仅展示截断摘要 ✅
- 规则 10（TUI bridge 不抛错）：replyPermission 转发到 replyQuestion ✅

### 异常场景对齐
- 未知 inputMode 降级为 confirm：effectiveMode fallback + warn ✅
- select 缺 options：buildQuestionCard 返回错误状态卡片 + warn ✅
- 多选/文本 required 空值：_cmdAnswer required 校验 ✅
- 无 session：沿用现有 No session bound 回复 ✅
- driver 不支持：沿用现有 不支持权限回复 ✅
- 重复点击：questionReplyStates 幂等 ✅
- driver 回传失败：回滚 pending ✅

### 剩余风险
1. 飞书 `multi_select_static` 和 `input` 组件类型未在代码库中使用过，需卡片预览工具验证实际渲染效果
2. `buildQuestionCard` 中 options value 非空校验由 dispatcher `_cmdAnswer` required 校验兜底，卡片层未单独校验

## Verdict

Verdict: PASS

- evidence-command: `npm run test`
- evidence-exit-code: 0
