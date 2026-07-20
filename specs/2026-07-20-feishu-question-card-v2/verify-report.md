# 飞书原生 Question 卡片 V2 完成前验证报告

## 1. 验证范围

按方案 4 实施飞书原生 question 混合卡片：单选 legacy v1 普通按钮，多选完整 Card JSON 2.0 表单一次提交，所有预设选项展示 label/description，纯自定义文本题提示本地 TUI 输入。本报告基于 `specs/2026-07-20-feishu-question-card-v2/test-report.md`、当前源码和新鲜定向验证证据。

## 2. 前置产出核验

| 产物 | 路径 | 状态 |
| --- | --- | --- |
| spec.md | `specs/2026-07-20-feishu-question-card-v2/spec.md` | 存在，213 行，G1-G6 目标完整 |
| plan.md | `specs/2026-07-20-feishu-question-card-v2/plan.md` | 存在，REQ-001 到 REQ-006 映射完整 |
| tasks/ | `specs/2026-07-20-feishu-question-card-v2/tasks/T1-T4.md` | 存在，frontmatter 完整，owns 无交集 |
| test-report.md | `specs/2026-07-20-feishu-question-card-v2/test-report.md` | 存在，76 行，T1-T4 全 PASS |
| handoffs/brainstorming.json | `handoffs/brainstorming.json` | status=done |
| handoffs/planning.json | `handoffs/planning.json` | status=done |
| handoffs/executing.json | `handoffs/executing.json` | status=done |

## 3. 编译/检查/测试命令与新鲜证据

`.loom/rules/constitution.md` 未显式声明 BUILD_CMD/VET_CMD/TEST_CMD 字段，采用项目标准验证命令。以下为本验证阶段获取的新鲜证据（非 test-report 重复）：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node --test test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js test/feishu-platform.test.js` | 0 | 101/101 PASS，0 fail，0 cancelled，duration 5372ms |
| `npx eslint src/platform/feishu/cards.js src/platform/feishu/events.js src/dispatch/question-handler.js test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js` | 0 | PASS，无输出（引用 test-report 证据，本轮未重复运行） |
| `git diff --check -- src/platform/feishu/cards.js src/platform/feishu/events.js src/dispatch/question-handler.js test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js` | 0 | PASS，无输出（引用 test-report 证据） |
| `npm test` | 0 | 1007/1007 PASS，0 fail，0 cancelled（引用 test-report 证据） |

## 4. 占位符扫描

| 范围 | 检查方式 | 结果 |
| --- | --- | --- |
| `specs/2026-07-20-feishu-question-card-v2/` | 占位符关键词正则扫描 | 无匹配 |
| `src/platform/feishu/cards.js`, `src/platform/feishu/events.js`, `src/dispatch/question-handler.js` | 占位符关键词正则扫描 | 无匹配 |

## 5. 类型一致性检查

| 前序 task 定义 | 后续 task 使用 | 一致性 |
| --- | --- | --- |
| `buildNativeQuestionCard(options)` 返回 v1 或 v2 完整 card JSON | `QuestionHandler._sendCards()` / `_patchQuestionCard()` 调用 | 一致；`_patchQuestionCard` 已兼容 `card.body` 与 `card.elements` 两种形态 |
| `parseCardAction(data)` 返回 `{action, formValue, routeKey, openId, chatId, messageId}` | `bootstrap.onCardAction()` → `dispatcher.handleCommand()` 消费 | 一致，字段不变 |
| `QuestionHandler.handleAnswer(cmd)` 支持 `--option/--toggle/--submit/--form/--retry` | `MessageDispatcher.handleCommand()` 路由 `/answer` 到 `handleAnswer` | 一致，参数解析与 spec 6.x 契约匹配 |

## 6. 最终一致性核验（Drift Check）

| Spec 目标 | 实现位置 | 验证证据 | 结论 |
| --- | --- | --- | --- |
| G1 单选保持稳定（v1 `--option`） | `cards.js:701-721` 生成 v1 `elements/action` + `--option option_<n>` 按钮；`question-handler.js:329-331` `--option` 走 `_parseOptionAnswers` + `_acceptAnswers` | `test/feishu-cards.test.js` 单选 v1 测试 + `test/question-handler.test.js` `--option` 测试 PASS | 达成 |
| G2 多选消除逐项 loading | `cards.js:668-699` 多选输出 v2 `schema:'2.0'` + `body.elements` + `form` + `checkbox` + `button form_action_type='submit'`，不再生成 `--toggle` 按钮；`question-handler.js` 新多选走 `--form` + `_parseAnswers`，不触发 `_patchQuestionCard` 逐项高亮 | `test/feishu-cards.test.js` 多选 v2 测试断言无 `--toggle`；`test/integration-feishu-question.test.js` 首个用例多选 `submitV2Form` 一次 `--form` 提交 PASS | 达成 |
| G3 展示选项描述 | `cards.js:622-632` `buildOptionDescriptionLines()` 编号 + label 粗体 + description；单选 v1 在 `elements[0].div.text.content` Markdown 列表，多选 v2 在 `body.elements[0].markdown.content` | `test/feishu-cards.test.js` 单选/多选正文断言含 `**1. 蓝绿部署**` + `零停机切换` PASS | 达成 |
| G4 避免飞书 HTTP 400 | 单选纯 v1 `elements/action/actions`，多选纯 v2 `schema:'2.0' + body.elements`；无 `behaviors/form_submit` 与 v1 `tag:'action'` 混用 | `test/feishu-cards.test.js` 多选断言 `card.schema==='2.0'`、`card.elements===undefined`、`body.elements` 无 `tag:'action'` PASS | 达成（本地结构层面；真实飞书 API 400 待现场确认） |
| G5 兼容现有回传链路 | `QuestionHandler.submitAnswers()` → `driver.replyQuestion()` → `OpencodeTuiBridge.replyQuestion()` → `api.client.question.reply` 全链路未改；`--form` 入口复用 `_parseAnswers` | `test/question-handler.test.js` `--form` 多选测试 + `test/integration-feishu-question.test.js` 首个用例 `questionCalls` 断言 PASS | 达成 |
| G6 文本题降级清晰 | `cards.js:658-664` 无预设选项返回 v1 div only，正文含 `如需自定义答案，请在本地 TUI 输入。` | `test/feishu-cards.test.js` 无预设题测试断言正文含本地 TUI 提示 PASS | 达成 |

## 7. Spec 外范围检查

| 检查项 | 结论 |
| --- | --- |
| 是否引入 spec 未声明的卡片字段 | 否，多选使用 `schema/config/header/body/elements/form/checkbox/button` 均在 spec 5.2 契约内 |
| 是否改动 OpenCode SDK/TUI bridge/answers 结构 | 否，`OpencodeTuiBridge.replyQuestion()`、`OpencodeDriver.replyQuestion()`、`submitAnswers()` 未改 |
| 是否恢复 legacy `select_static/form_submit` 混用 | 否，新代码无 `select_static`、`behaviors`、`form_submit` 字段 |
| 是否迁移所有飞书卡片到 v2 | 否，状态卡片、权限卡片等其他卡片未改 |

## 8. 剩余风险

| 风险 | 影响 | 缓解状态 |
| --- | --- | --- |
| Card JSON 2.0 checkbox 字段与真实飞书文档差异 | 真实发送可能 400 或客户端不渲染 | 本地结构测试已锁定不混用 v1/v2；需真实飞书环境确认（见 test-report 真实飞书待确认项 1-3） |
| 低版本飞书客户端不支持 Card JSON 2.0 | 用户看不到多选卡片 | 未在代码中处理；如现场反馈占比高，需回退方案 A |
| v2 表单回调 `form_value` 字段位置差异 | Walker 解析不到 `formValue.question_selected` | `parseCardAction()` 已兼容 `action.form_value/value.form_value/data.form_value` 三种位置；真实回调需现场确认 |
| 多选无逐项 loading | 用户体验改善 | 本地测试确认无 `--toggle` 生成；真实客户端行为需现场确认 |

## 9. 验证结论

- **编译/检查/测试**：定向 101/101 PASS（本轮新鲜证据）；eslint、git diff --check、npm test 1007/1007 PASS（test-report 证据引用）。
- **占位符**：无。
- **类型一致性**：前序/后续 task 接口一致。
- **Spec drift**：G1-G6 全部在实现和测试中可验证，无 spec 外范围，无遗漏验收标准。
- **剩余风险**：Card JSON 2.0 真实飞书 API/客户端行为需现场确认，本地测试无法覆盖。

**验证结论：通过（本地验证层面）。** 真实飞书环境确认项已记录在 `test-report.md` 第 66-75 行，需用户现场复测后反馈。

## 10. 关键产物指纹

- `specs/2026-07-20-feishu-question-card-v2/spec.md`
- `specs/2026-07-20-feishu-question-card-v2/plan.md`
- `specs/2026-07-20-feishu-question-card-v2/tasks/T1-T4.md`
- `specs/2026-07-20-feishu-question-card-v2/test-report.md`
- `specs/2026-07-20-feishu-question-card-v2/verify-report.md`
- `src/platform/feishu/cards.js`
- `src/platform/feishu/events.js`（未改，T2 仅补测试）
- `src/dispatch/question-handler.js`
- `test/feishu-cards.test.js`
- `test/feishu-events.test.js`
- `test/question-handler.test.js`
- `test/integration-feishu-question.test.js`
