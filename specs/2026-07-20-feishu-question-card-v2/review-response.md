# 代码审查反馈处理

**功能：** 飞书原生 Question 卡片 V2（方案 4 混合策略）
**Spec：** `specs/2026-07-20-feishu-question-card-v2/spec.md`
**基线 commit：** `1e280e2 feat: 支持飞书原生问题交互回传`
**Reviewer：** 自审（无外部 reviewer）

## 审查来源

无外部 reviewer 参与本轮审查。按 `loom-receiving-code-review` 流程，由实施者基于 `review-request.md` 的审查重点与剩余风险做自审，并对每个重点项给出明确结论。

## 反馈分类

无外部评论需要分类（无 NIT / SUGGESTION / ISSUE / BLOCKER 来自 reviewer）。本自审按 `review-request.md` 的 5 项审查重点逐项核验。

## 审查重点核验

### 1. 架构合规性：v1/v2 混合输出是否清晰分层，`_patchQuestionCard` 兼容分支是否足够

**结论：通过。**

- `buildNativeQuestionCard(options)` 按题型分支输出：无预设 → v1 div only；单选 → v1 `{config, header, elements:[div, action]}`；多选 → v2 `{schema:'2.0', config, header, body:{elements}}`。分支条件基于 `question.multiple` 与 `presetOptions.length`，无歧义。
- v1 与 v2 结构在顶层即分离（`elements` vs `body.elements` + `schema`），不存在混用字段。
- `_patchQuestionCard(request, index)` 的兼容分支 `card.body ? '' : (card.elements[0] && card.elements[0].text && card.elements[0].text.content) || ''` 覆盖 v2 卡片无 `elements[0]` 的情况，返回空字符串作为 fallback text，不破坏 `_patch()` 的参数契约。
- 新多选走 `--form` 路径，不触发 `_patchQuestionCard`；旧 `--toggle` 仍走该函数，但旧卡片是 v1 结构，兼容分支不影响旧路径。

### 2. 代码质量：`buildOptionDescriptionLines` / `buildNativeQuestionSubmitValue` 是否可复用，v2 卡片 JSON 字段是否符合飞书规范

**结论：通过（本地层面），真实飞书字段需现场确认。**

- `buildOptionDescriptionLines(presetOptions)` 是纯函数，输入选项数组，输出 Markdown 行数组，无副作用，可被单测与未来其他卡片复用。
- `buildNativeQuestionSubmitValue(questionKey, walkerSessionId, routeKey)` 是纯函数，封装提交按钮 `value` 构造，与 `buildButtonValue` 风格一致。
- v2 卡片字段：`schema:'2.0'`、`config.update_multi:true`、`config.width_mode:'fill'`、`header`、`body.elements`、`form.elements`、`checkbox.name:'question_selected'`、`checkbox.options[].value`、`button.name:'question_submit'`、`button.form_action_type:'submit'`。这些字段来自飞书 Card JSON 2.0 公开文档约定，本地无法验证真实 API 接受度，`review-request.md` 已明确列为剩余风险。
- 无重复代码，无过长函数（`buildNativeQuestionCard` 主体约 75 行，分支清晰）。

### 3. 安全性：无密钥/凭证引入，`escapeLarkMd` 已用于用户输入

**结论：通过。**

- 本次改动未引入任何密钥、凭证或环境变量读取。
- `buildOptionDescriptionLines` 的 label/description 通过 `escapeLarkMd` 转义（已在 `cards.js` 既有实现中保留），未因新增分支绕过转义。
- 提交按钮 `value.action` 中的 `questionKey`、`walkerSessionId`、`routeKey` 来自服务端生成，不受用户输入控制；`routeKey` 通过 `buildNativeQuestionSubmitValue` 透传，未拼接未转义用户文本。

### 4. 性能影响：多选 v2 一次提交替代逐项 `--toggle` + PATCH，减少飞书 API 调用

**结论：通过（改进）。**

- 旧多选协议：每个选项点击 → `card.action.trigger` → `--toggle` → `_patchQuestionCard` → PATCH 卡片。N 个选项产生 N 次回调 + N 次 PATCH，每次约 440ms loading。
- 新多选协议：本地勾选 checkbox → 点提交 → 一次 `card.action.trigger` → `--form` → `_acceptAnswers` → `submitAnswers`。1 次回调 + 0 次 PATCH（提交后直接 `submitAnswers`，不再 toggle 高亮）。
- 性能改进符合 G2 目标，无负面影响。

### 5. 真实飞书兼容性：Card JSON 2.0 是否被飞书 API 接受

**结论：本地无法验证，列为剩余风险，需现场确认。**

- 本地测试只验证 `buildNativeQuestionCard()` 输出的 JSON 结构与字段约束，无法验证飞书发送 API 是否返回 200/400。
- `test-report.md` 与 `verify-report.md` 均已明确记录 5 项真实飞书待确认项：v2 发送不 400、checkbox 可见可选、回调 `form_value.question_selected`、单选描述列表可见、多选无逐项 loading。
- 现场验证步骤：重启 Walker → 触发 OpenCode question → 观察飞书卡片渲染 → 提交 → 观察 Walker 日志 `card action received` + `formKeys` + `native question answer accepted` + `answer command handled status:'replied'`。

## 处理动作

| # | 类别 | 来源 | 动作 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 自审重点 | review-request 架构合规性 | 核验通过，无需改动 | done |
| 2 | 自审重点 | review-request 代码质量 | 核验通过，无需改动 | done |
| 3 | 自审重点 | review-request 安全性 | 核验通过，无需改动 | done |
| 4 | 自审重点 | review-request 性能影响 | 核验通过，改进已实现 | done |
| 5 | 自审重点 | review-request 真实飞书兼容性 | 本地无法验证，列剩余风险 | done |

## Push Back

无。本次自审未发现需要向 reviewer 澄清或反驳的项。

## 遗留风险（继承自 review-request）

- Card JSON 2.0 真实飞书发送 API 与客户端渲染行为需现场确认。
- 低版本飞书客户端对 v2 卡片的支持范围未验证。

## 自审结论

- 5 项审查重点全部核验通过。
- 无 BLOCKER，无 ISSUE 需要修复。
- 遗留风险为真实飞书兼容性，非代码层面问题，需现场确认。
- 建议进入 `synced` 阶段完成索引同步与记忆更新。
