# 审查反馈回复

**功能：** 飞书原生 question 同步（OpenCode question → 飞书交互卡片 → answers[][]）
**关联审查请求：** `code-review-request.md` / `review-request.md`

## 反馈来源

- 外部审查者反馈：无。
- 本地预审查 findings：3 项 Standards 轻微注释缺失（S1/S2/S3），Spec 无发现。
- review-gate 用户已明确批准。

## 分类与处理

### BLOCKER

无。

### SUGGESTION（预审查轻微项，已采纳并修复）

| # | 位置 | 问题 | 处理 |
|---|------|------|------|
| S1a | `src/dispatch/question-handler.js:297 handleReplied` | 公共方法缺中文注释 | 已补 `/** 处理原生 question.replied 事件，已显式终态时不覆盖。 */` |
| S1b | `src/dispatch/question-handler.js:308 handleRejected` | 公共方法缺中文注释 | 已补 `/** 处理原生 question.rejected 事件，已显式终态时不覆盖。 */` |
| S1c | `src/dispatch/question-handler.js:22 _key`、`:26 _requestOptions`、`:38 _terminal`、`:44 pruneStates`、`:143 _parseQuestionKey`、`:151 _patch`、`:163 _patchOne`、`:168 _patchAll`、`:172 _parseAnswers`、`:191 _expired`、`:292 _findRequest` | 私有方法缺中文注释 | 已逐一补齐简洁中文注释 |
| S2 | `src/drivers/opencode-driver.js:548 replyQuestion` | 预审查报告标注缺注释，复核后已存在 `/** 通过 protocol v4 TUI Bridge 回复原生 question，不降级为 permission 或 prompt。 */`，无需新增 | 维持现状 |
| S3 | `src/opencode-tui-bridge/bridge.js:223 replyQuestion` | 公共方法缺中文注释 | 已补 `/** 通过 protocol v4 控制 delivery 将原生 question 答复投递给 OpenCode 插件。 */` |

### 讨论

无。

## 验证

- `node --check`：`src/dispatch/question-handler.js`、`src/opencode-tui-bridge/bridge.js`、`src/drivers/opencode-driver.js` 全部通过。
- `npx eslint src\dispatch\question-handler.js src\opencode-tui-bridge\bridge.js src\drivers\opencode-driver.js`：exit 0，无错误。
- `node --test test\question-handler.test.js test\message-dispatcher.test.js test\permission-handler.test.js test\opencode-tui-bridge.test.js test\opencode-driver.test.js`：270 tests / 270 pass / 0 fail。

## 已知风险

无。此前旧 plugin-template 断言与 Bridge pending/cancelled 测试信号已修复；最新 `npm test` 为 995/995 PASS、fail 0、cancelled 0。

## 结论

所有 BLOCKER 已处理（无）；3 项轻微注释缺失已补齐并重新验证通过。代码可进入分支收尾。
