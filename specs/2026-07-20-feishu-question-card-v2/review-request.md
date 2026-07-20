# 代码审查请求

**功能：** 飞书原生 Question 卡片 V2（方案 4 混合策略）
**Spec：** `specs/2026-07-20-feishu-question-card-v2/spec.md`
**基线 commit：** `1e280e2 feat: 支持飞书原生问题交互回传`

## 变更统计

```
 src/dispatch/question-handler.js         |   3 +-
 src/platform/feishu/cards.js             | 110 ++++++++++++++++++++++---------
 test/feishu-cards.test.js                |  60 ++++++++++++-----
 test/feishu-events.test.js               |  74 +++++++++++++++++++++
 test/integration-feishu-question.test.js |  40 ++++++++---
 test/question-handler.test.js            |   3 +-
 6 files changed, 230 insertions(+), 60 deletions(-)
```

## 主要变更

1. `src/platform/feishu/cards.js:buildNativeQuestionCard()` 改为混合输出：
   - 单选：legacy v1 `{config, header, elements:[div, action]}` + `--option option_<n>` 按钮，正文 Markdown 列表展示 `label/description`。
   - 多选：完整 Card JSON 2.0 `{schema:'2.0', config:{update_multi:true,width_mode:'fill'}, header, body:{elements:[markdown, form]}}`，form 含 `checkbox name:'question_selected'` + `button name:'question_submit' form_action_type:'submit'`，按钮 value 为 `/answer <key> --form <session>`。
   - 无预设题：v1 div only，正文提示本地 TUI 输入。
   - 新增 `buildOptionDescriptionLines(presetOptions)`、`buildNativeQuestionSubmitValue(questionKey, walkerSessionId, routeKey)`。
2. `src/dispatch/question-handler.js:_patchQuestionCard()` 兼容 v2 卡片结构：`card.body` 时 fallback 为空 text，避免读 `card.elements[0]` 报错。
3. `test/feishu-cards.test.js`：更新 3 个 buildNativeQuestionCard 测试锁定单选 v1 + 描述展示、多选完整 v2 + 禁止 `--toggle`/混用字段、无预设题本地 TUI 提示。
4. `test/feishu-events.test.js`：新增 3 个 v2 表单回调解析测试（raw payload、SDK 归一化、form_value 放在 action.value.form_value），确认 `parseCardAction()` 已兼容。
5. `test/question-handler.test.js`：多选 toggle 测试断言改为 v2 结构。
6. `test/integration-feishu-question.test.js`：新增 `findFormSubmitValue(card)` + `submitV2Form(index, formValue)`；首个用例改为单选 `--option` 按钮 + 多选一次 v2 `--form` 表单提交（`void` + `waitFor` 模式避免 unref setInterval 阻塞 lease resolve）。

## Standards 预审查

- 卡片构建函数职责单一，新增两个纯函数便于测试与复用。
- `_patchQuestionCard` 兼容性分支使用三元表达式，可读性可接受；未引入重复代码。
- 集成测试 `void` + `waitFor` 模式与现有 `req_concurrent` 用例一致，未引入新时序范式。
- 未发现重复、过长函数、霰弹式修改、循环依赖、全局状态、过度 mock 等坏味道。
- 无发现 blocker。

## Spec 预审查

- G1 单选保持 legacy v1 普通按钮 + `--option`：✅ `cards.js` 单选分支返回 v1 结构，按钮 `--option option_<n>`。
- G2 多选消除逐项 loading，只在提交时一次回调：✅ 多选分支使用 v2 表单 + checkbox + `form_action_type:'submit'`，无 `--toggle` 按钮。
- G3 展示 label/description：✅ `buildOptionDescriptionLines` 编号 + label 粗体 + description，单选 v1 正文与多选 v2 markdown 均展示。
- G4 避免飞书 HTTP 400，不混用 v1 `elements/action/actions` 与 v2 `behaviors/form_submit`，多选完整 `schema:'2.0' + body.elements`：✅ 多选卡片顶层 `schema:'2.0'`，无顶层 `elements`/`tag:'action'`，提交按钮用 v2 表单语义而非 `behaviors`。
- G5 兼容现有 OpenCode question reply 链路：✅ 多选 v2 提交归一为 `/answer <key> --form <session>` + `formValue.question_selected`，走 `QuestionHandler.handleAnswer()` 的 `--form` + `_parseAnswers()`，未改 `submitAnswers()`/driver/TUI bridge。
- G6 无预设/纯自定义文本题提示本地 TUI 输入：✅ 无预设题 v1 div only，正文含本地 TUI 提示。
- 旧 `--toggle`/`--submit` 兼容入口保留：✅ `handleAnswer()` 参数解析与 `--toggle` 路径未删，`question-handler.test.js` 旧测试保留。
- 无 spec 外范围：未改 SDK、TUI bridge、answers 结构，未迁移其他卡片，未恢复 legacy 混用。
- 无发现 blocker。

## 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none

## 自测情况

- [x] 定向测试 `node --test test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js test/feishu-platform.test.js`：101/101 PASS（新鲜证据，verify-report.md）
- [x] `npx eslint <改动文件>`：PASS，无输出（test-report.md）
- [x] `git diff --check`：PASS，无输出（test-report.md）
- [x] 全量 `npm test`：1007/1007 PASS，0 fail，0 cancelled（test-report.md）
- [x] 占位符扫描：无（verify-report.md）
- [x] 代码符合编码红线：未引入占位符、未硬编码密钥、未跳过校验
- [x] 图后端已同步：`codegraph sync` 已执行（执行阶段）

## 变更详情

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/platform/feishu/cards.js` | 修改 | `buildNativeQuestionCard` 混合输出 v1/v2；新增 `buildOptionDescriptionLines`、`buildNativeQuestionSubmitValue` |
| `src/dispatch/question-handler.js` | 修改 | `_patchQuestionCard` 兼容 v2 `card.body` 结构 |
| `test/feishu-cards.test.js` | 修改 | 锁定单选 v1 + 描述、多选 v2、无预设题本地 TUI |
| `test/feishu-events.test.js` | 修改 | 新增 v2 表单回调解析测试 |
| `test/question-handler.test.js` | 修改 | 多选 toggle 断言改为 v2 结构 |
| `test/integration-feishu-question.test.js` | 修改 | 新增 `findFormSubmitValue`/`submitV2Form`；首个用例改为单选按钮 + 多选 v2 表单 |

## 审查重点

- [ ] 架构合规性：v1/v2 混合输出是否清晰分层，`_patchQuestionCard` 兼容分支是否足够
- [ ] 代码质量：`buildOptionDescriptionLines` / `buildNativeQuestionSubmitValue` 是否可复用，v2 卡片 JSON 字段是否符合飞书规范
- [ ] 安全性：无密钥/凭证引入，`escapeLarkMd` 已用于用户输入
- [ ] 性能影响：多选 v2 一次提交替代逐项 `--toggle` + PATCH，减少飞书 API 调用
- [ ] 真实飞书兼容性：Card JSON 2.0 `schema:'2.0'` + `body.elements` + `form/checkbox/button form_action_type:'submit'` 是否被飞书 API 接受（本地无法验证，需现场确认）

## 剩余风险

- Card JSON 2.0 真实飞书发送 API 与客户端渲染行为需现场确认：v2 发送不 400、checkbox 可见可选、回调 `form_value.question_selected`、单选描述列表可见、多选无逐项 loading。
- 低版本飞书客户端对 v2 卡片的支持范围未验证。
