# 飞书原生 Question 卡片 V2 测试报告

## 范围

按方案 4 实施飞书原生 question 混合卡片：单选保持 legacy v1 普通按钮 `/answer --option`，多选迁移到完整 Card JSON 2.0 表单一次提交，所有预设选项在正文展示 label/description，纯自定义文本题继续提示本地 TUI 输入。

## 任务完成情况

| Task | 内容 | 结果 |
| --- | --- | --- |
| T1 | 卡片结构与描述渲染 | PASS |
| T2 | Card JSON 2.0 回调解析 | PASS（events.js 已兼容，仅补测试） |
| T3 | Question 回传集成兼容 | PASS |
| T4 | 端到端验证与回归收口 | PASS |

## 实现摘要

### T1 `src/platform/feishu/cards.js`

- 新增 `buildOptionDescriptionLines(presetOptions)`：编号 + label 粗体 + description 普通文本。
- 新增 `buildNativeQuestionSubmitValue(questionKey, walkerSessionId, routeKey)`：多选 v2 提交按钮 value，action 为 `cmd:/answer <key> --form <session>`。
- 重写 `buildNativeQuestionCard(options)`：
  - 无预设选项 → legacy v1 `{config, header, elements:[div]}`，正文只提示本地 TUI 输入。
  - 单选 → legacy v1 `{config, header, elements:[div, action]}`，按钮上方 Markdown 列表展示选项说明，按钮 `value.action` 为 `cmd:/answer <key> --option option_<n> <session>`。
  - 多选 → 完整 Card JSON 2.0 `{schema:'2.0', config:{update_multi:true, width_mode:'fill'}, header, body:{elements:[markdown, form]}}`，form 包含 `checkbox name:'question_selected' options` 和 `button name:'question_submit' form_action_type:'submit'`。
- 禁止混用 legacy `tag:'action'` 与 v2 `behaviors/form_submit`。

### T2 `src/platform/feishu/events.js`

- `parseCardAction()` 当前实现已从 `action.form_value || value.form_value || data.form_value` 读取 formValue，并从 `value.action` 读取命令，已兼容 v2 表单回调。
- T2 未修改生产代码，仅补充 `test/feishu-events.test.js` 覆盖 v2 raw payload、SDK 归一化形态、`action.value.form_value` 三种字段位置。

### T3 `src/dispatch/question-handler.js` + 集成测试

- 修改 `_patchQuestionCard()`：兼容 v2 卡片结构，`const fallbackText = card.body ? '' : (card.elements[0] && card.elements[0].text && card.elements[0].text.content) || ''`。
- `QuestionHandler.handleAnswer()` 保留 `--option`、`--toggle`、`--submit`、`--form`、`--retry` 全部入口；新多选走 `--form` + `_parseAnswers()`，不触发 `_patchQuestionCard` 逐项高亮。
- 移除 `submitAnswers` 调试诊断日志。
- `test/integration-feishu-question.test.js`：
  - `findButtonValue(card, text)` 扩展支持 v2：遍历 `card.elements || []` + `card.body.elements || []`。
  - 新增 `findFormSubmitValue(card)`：从 `card.body.elements` 找 v2 form submit button value。
  - 新增 `submitV2Form(index, formValue)`：模拟 v2 表单提交回调。
  - 首个集成用例改为单选 `--option` 按钮 + 多选一次 v2 `--form` 表单提交；多选用 `void fixture.submitV2Form(1, ...)` + `waitFor(questionCalls.length === 1)` 模式，避免 await lease Promise 阻塞测试 event loop（插件 poll 的 setInterval 被 unref，await 单一 lease 期间可能无机会触发）。

## 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `node --test test/feishu-cards.test.js` | 50/50 PASS |
| `node --test test/feishu-events.test.js` | 16/16 PASS |
| `node --test test/question-handler.test.js` | 20/20 PASS |
| `node --test test/integration-feishu-question.test.js` | 6/6 PASS，0 cancelled |
| `node --test test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js test/feishu-platform.test.js` | 101/101 PASS |
| `npx eslint src/platform/feishu/cards.js src/platform/feishu/events.js src/dispatch/question-handler.js test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js` | PASS，无输出 |
| `git diff --check -- ...` | PASS，无输出 |
| `npm test` | 1007/1007 PASS，0 fail，0 cancelled |

## 修改文件

- `src/platform/feishu/cards.js`
- `src/dispatch/question-handler.js`
- `test/feishu-cards.test.js`
- `test/feishu-events.test.js`
- `test/question-handler.test.js`
- `test/integration-feishu-question.test.js`

## 真实飞书待确认项

本地测试全部通过，但以下项需真实飞书环境确认：

1. **多选 Card JSON 2.0 发送不再 400**：真实飞书 API 接受 `schema:'2.0'` + `body.elements` + form/checkbox/button 结构。
2. **多选 checkbox 在飞书客户端可见可选**：飞书客户端渲染 `checkbox name:'question_selected' options` 正常。
3. **多选提交回传 `form_value.question_selected`**：飞书回调 payload 中 `action.form_value.question_selected` 为选中 option value 数组。
4. **单选按钮 + 描述列表可见**：单选 v1 卡片正文 Markdown 编号列表（`**1. label**\n description`）在飞书客户端正常渲染。
5. **多选一次提交无逐项 loading**：多选本地勾选不触发回调，只有点提交按钮才一次回调。

若真实飞书发送 400 或 checkbox 不可见，需根据飞书 API 返回 body 精确到字段调整；若回调 `form_value` 字段位置不同，需扩展 `parseCardAction()` 兼容。
