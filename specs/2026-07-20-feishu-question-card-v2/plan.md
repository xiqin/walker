# 飞书原生 Question 卡片 V2 实现计划

**目标：** 按方案 4 实现飞书原生 question 混合卡片：单选继续使用已验证的 legacy v1 普通按钮，多选迁移到完整 Card JSON 2.0 表单一次提交，并在所有预设选项中展示 label 与 description。

**架构：** 卡片构建层按题型分支输出 v1 或 v2 完整卡片 JSON；事件解析层兼容 v2 表单提交回调并把多选提交归一化为 `/answer <key> --form <session>`；业务层复用现有 `QuestionHandler` 的 `--option`、`--form`、`--toggle` 兼容入口和 `question.reply` 提交流程。

**技术栈：** Node.js、node:test、ESLint、飞书 Card JSON 1.0/2.0、现有 Walker OpenCode question 回传链路。

---

## Requirement 映射

| Requirement ID | Spec 目标 | 验收摘要 |
| -------------- | --------- | -------- |
| REQ-001 | G1 | 单选题保持 legacy v1 普通按钮，点击直接 `/answer --option` 提交。 |
| REQ-002 | G2 | 多选题不再生成逐项 `--toggle` 新卡片，只通过 v2 表单一次提交。 |
| REQ-003 | G3 | 单选和多选正文都展示选项 label 与 description。 |
| REQ-004 | G4 | 多选完整使用 Card JSON 2.0，禁止混用 v1 `action/actions` 与 v2 `behaviors/form_submit`。 |
| REQ-005 | G5 | 保持 `QuestionHandler` 到 OpenCode `question.reply` 回传链路不变。 |
| REQ-006 | G6 | 无预设选项或纯自定义文本题继续提示本地 TUI 输入。 |

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 卡片结构与描述渲染 | 平台卡片构建 | 中等 | 无 | `tasks/T1.md` |
| T2 | Card JSON 2.0 回调解析 | 平台事件解析 | 中等 | T1 | `tasks/T2.md` |
| T3 | Question 回传集成兼容 | 业务集成 | 中等 | T1, T2 | `tasks/T3.md` |
| T4 | 端到端验证与回归收口 | 验证 | 中等 | T1, T2, T3 | `tasks/T4.md` |

## 依赖关系

T1 → T2 → T3 → T4

## 文件职责

| 文件 | 职责 | 主要变更阶段 |
| ---- | ---- | ------------ |
| `src/platform/feishu/cards.js` | 构建单选 v1 卡片、多选 v2 表单卡片、选项说明 Markdown、本地 TUI 降级提示 | T1 |
| `test/feishu-cards.test.js` | 锁定 v1/v2 卡片结构、描述展示、禁止 `--toggle` 新多选按钮、禁止混用字段 | T1 |
| `src/platform/feishu/events.js` | 解析 raw v2 或 SDK 归一化卡片提交事件，提取 action 与 formValue | T2 |
| `test/feishu-events.test.js` | 覆盖 v2 表单回调字段位置和向后兼容解析 | T2 |
| `src/dispatch/question-handler.js` | 保持 `--form` 多选解析与旧 `--toggle` 兼容，必要时接收事件层归一化结果 | T3 |
| `test/question-handler.test.js` | 覆盖 `--form` 多选提交、旧 `--toggle` 兼容、无预设题本地 TUI 降级 | T3 |
| `test/integration-feishu-question.test.js` | 覆盖单选按钮提交、多选 v2 表单一次提交到 OpenCode question reply | T3 |
| `test/feishu-platform.test.js` | 确认平台分发 v2 表单事件不等待后端处理且保留错误捕获 | T4 |

## 串行边界

- T1 独占卡片结构输出，T2 和 T3 不应在 T1 完成前假设最终字段。
- T2 独占事件解析归一化，T3 只消费 `cmd.formValue` 与命令参数。
- T3 连接业务链路和集成测试，依赖 T1 的卡片按钮/表单结构与 T2 的回调解析。
- T4 只做验证和必要测试修正，不引入新功能范围。

## 验证命令

```bash
node --test test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js test/feishu-platform.test.js
npx eslint src/platform/feishu/cards.js src/platform/feishu/events.js src/dispatch/question-handler.js test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js
git diff --check -- src/platform/feishu/cards.js src/platform/feishu/events.js src/dispatch/question-handler.js test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js
npm test
```
