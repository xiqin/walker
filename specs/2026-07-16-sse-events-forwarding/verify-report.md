## 完成前验证报告

**功能：** SSE Events Forwarding — OpenCode 原生 question 同步飞书交互卡片并回传答案
**验证时间：** 2026-07-20 02:05

### 检查结果

| 检查项 | 状态 | 说明 |
| ------ | ---- | ---- |
| 前置产出核验 | ✅ | `test-report.md` verdict PASS，18/18 REQ 覆盖；全量回归 `npm test` 995/995 PASS |
| BUILD_CMD | ✅ | `node --check` 对 9 个本次改动的源文件全部通过 |
| VET_CMD | ✅ | `npx eslint` 对 9 个源文件无错误 |
| TEST_CMD | ✅ | 全量 `npm test` 995/995 PASS；集成测试 6/6 PASS；插件能力探测 40/40 PASS |
| 占位符扫描 | ✅ | 源码未检测到任何占位符；6 处 `EVENT_TYPE` 前缀常量为合法事件类型 |
| 类型一致性 | ✅ | Bridge/Driver `replyQuestion(sessionRef/agentRef, requestID, answers)` 签名一致；错误对象四属性 `code/deliveryPhase/sdkInvoked/safeToRetry` 在 Bridge→Driver→QuestionHandler 链路一致传递 |
| 最终一致性核验 | ✅ | spec 18 个 REQ 在 test-report 中均有对应测试覆盖，全部 PASS；未引入 spec 外范围（SSE adapter 明确排除） |

### Requirement Coverage

| Requirement ID | 代码位置 | 测试证据 | 状态 |
| -------------- | -------- | -------- | ---- |
| REQ-001 | `src/drivers/agent-driver.js:DATA_SCHEMAS.question_asked`, `src/opencode-hook/plugin-template.js` 原生事件映射 | `test/agent-driver-schema.test.js`, `test/opencode-hook-installer.test.js`, 集成测试用例1 | PASS |
| REQ-002 | `src/dispatch/question-handler.js:handleAsked`, `src/platform/feishu/cards.js:buildNativeQuestionCard` | `test/feishu-cards.test.js`, `test/question-handler.test.js`, 集成测试用例1 | PASS |
| REQ-003 | `src/platform/feishu/cards.js:select_static`, `src/dispatch/question-handler.js:answer parsing` | `test/feishu-cards.test.js`, `test/question-handler.test.js`, 集成测试用例1 | PASS |
| REQ-004 | `src/platform/feishu/cards.js:multi_select_static`, `src/dispatch/question-handler.js:answer parsing` | `test/feishu-cards.test.js`, `test/question-handler.test.js`, 集成测试用例1 | PASS |
| REQ-005 | `src/platform/feishu/cards.js:question_custom`, `src/dispatch/question-handler.js:answer parsing` | `test/feishu-cards.test.js`, `test/question-handler.test.js`, 集成测试用例1 | PASS |
| REQ-006 | `src/dispatch/question-handler.js:submitAnswers` | `test/question-handler.test.js`, 集成测试用例1 | PASS |
| REQ-007 | `src/opencode-tui-bridge/bridge.js:replyQuestion`, `src/opencode-hook/plugin-template.js:executeDelivery`, `src/drivers/opencode-driver.js:replyQuestion` | T2/T3/T4 定向测试, 集成测试用例1/5 | PASS |
| REQ-008 | `src/dispatch/question-handler.js:handleReplied` | `test/question-handler.test.js`, 集成测试用例2 | PASS |
| REQ-009 | `src/dispatch/question-handler.js:handleRejected` | `test/question-handler.test.js`, 集成测试用例2 | PASS |
| REQ-010 | `src/dispatch/question-handler.js:handleAnswer`, `src/dispatch/message-dispatcher.js:/answer dedup skip` | `test/question-handler.test.js`, 集成测试用例2 | PASS |
| REQ-011 | `src/opencode-tui-bridge/bridge.js:delivery lifecycle`, `src/dispatch/question-handler.js:submitAnswers` | T2/T3/T4/T6 定向测试, 集成测试用例3 | PASS |
| REQ-012 | `src/drivers/opencode-driver.js:replyPermission`, `src/dispatch/permission-handler.js` | `test/opencode-driver.test.js`, `test/permission-handler.test.js`, 集成测试用例6 | PASS |
| REQ-013 | `src/dispatch/question-handler.js:callback validation` | `test/question-handler.test.js` | PASS |
| REQ-014 | `src/opencode-tui-bridge/bridge.js:protocol gate`, `src/opencode-hook/plugin-template.js:bridgeProtocolVersion:4`, `src/drivers/opencode-driver.js:preflight` | T2/T3/T4 定向测试, 集成测试用例4 | PASS |
| REQ-015 | `src/dispatch/question-handler.js:cardAttempts`, `src/platform/feishu/cards.js:feishu_unavailable` | `test/feishu-cards.test.js`, `test/question-handler.test.js` | PASS |
| REQ-016 | `src/platform/feishu/cards.js:buildNativeQuestionStatusCard`, `src/dispatch/question-handler.js:patch feedback` | `test/feishu-cards.test.js`, `test/question-handler.test.js` | PASS |
| REQ-017 | `src/dispatch/question-handler.js:pruneStates` | `test/question-handler.test.js` | PASS |
| REQ-018 | `src/opencode-tui-bridge/bridge.js:acceptedTypes`, `src/opencode-hook/plugin-template.js:tick` | T2/T3 定向测试, 集成测试用例5 | PASS |

### 风险处理状态

| 风险 | 状态 | 证据 |
| ---- | ---- | ---- |
| OpenCode SDK/Plugin 公开文档未列出 `question.reply` client | 已缓解 | 生成插件在 SDK 调用前探测 `api.client.question?.reply`；缺失时返回 `QUESTION_REPLY_UNSUPPORTED`、`deliveryPhase='queued'`、`sdkInvoked=false`、`safeToRetry=false`；`test/opencode-hook-installer.test.js` 40/40 PASS |
| 旧 plugin-template 断言与 Bridge pending/cancelled 测试信号 | 已修复 | `npm test` 995/995 PASS，fail 0，cancelled 0 |

### Evidence Receipt

- evidence-command: `node --check <9 source files>; npx eslint <9 source files>; node --test test/integration-feishu-question.test.js; node --test test/opencode-hook-installer.test.js; npm test`
- evidence-exit-code: `0`
- evidence-file: `evidence/verification.log`
- evidence-sha256: `11ceb6b5281a807e58bc5a100440c045794c8908585e0955eb5f47e31ac3e8c0`
- full-regression-file: `evidence/test.log`
- full-regression-sha256: `7ab6620fe78ab4927e23ab62b3099ec10b65bb7add94d5aa2501e6c0100bf878`

verdict: PASS
