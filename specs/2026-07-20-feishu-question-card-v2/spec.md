# 飞书原生 Question 卡片 V2 方案规格

## 1. 背景

Walker 已支持 OpenCode 原生 `question.asked` 事件转发到飞书，并通过飞书卡片按钮回传到 TUI/OpenCode。当前线上验证结果如下：

- 单选与多选使用 legacy 卡片 `elements` + `tag:'action'` + 普通按钮协议时，飞书可显示选项且可提交。
- 多选普通按钮协议每点击一个选项都会触发 `card.action.trigger`，飞书客户端会显示一次 loading，并由 Walker patch 卡片高亮。
- 当前普通按钮只展示 `option.label`，没有展示 `option.description`，用户缺少决策信息。
- legacy `action/actions` 混用 `behaviors/form_submit` 会导致飞书发送 API 返回 HTTP 400。
- `tag:'form'` 容器中放 legacy `select_static/multi_select_static` 在真实客户端会出现选项不可见。

本规格基于已验证的稳定路径，按“方案 4”实施混合策略：单选继续使用普通按钮，多选迁移到完整 Card JSON 2.0 客户端本地选择表单。

## 2. 目标

| ID | 目标 | 验收标准 |
| -- | ---- | -------- |
| G1 | 单选保持稳定 | 单选题继续渲染为 legacy v1 普通按钮，点击选项直接走 `/answer <key> --option <value> <session>` 并提交成功。 |
| G2 | 多选消除逐项 loading | 多选题不再为每个选项生成 `--toggle` 回调按钮；用户在飞书客户端本地完成多选，只在点击“提交”时产生一次回调。 |
| G3 | 展示选项描述 | 单选和多选都展示每个选项的 `label` 与 `description`；无 description 时只展示 label。 |
| G4 | 避免飞书 HTTP 400 | 新结构不得混用 Card JSON 1.0 `elements/action/actions` 与 Card JSON 2.0 `behaviors/form_submit`。多选使用完整 `schema:'2.0'` + `body.elements` 结构。 |
| G5 | 兼容现有回传链路 | `QuestionHandler.submitAnswers()`、`OpencodeDriver.replyQuestion()`、`OpencodeTuiBridge.replyQuestion()` 与 OpenCode `api.client.question.reply` 链路保持不变。 |
| G6 | 文本题降级清晰 | 无预设选项或纯自定义文本题继续提示“请在本地 TUI 输入”，不尝试在飞书卡片中采集文本。 |

## 3. 非目标

- 不在本阶段实现自由文本飞书输入框。
- 不迁移所有飞书卡片到 Card JSON 2.0。
- 不改 OpenCode SDK、TUI bridge delivery 协议或 `question.reply` 二维 answers 结构。
- 不恢复 `select_static/multi_select_static` + `form_submit` 的 legacy 混用方案。

## 4. 方案对比

| 方案 | 描述 | 优点 | 缺点 | 结论 |
| ---- | ---- | ---- | ---- | ---- |
| A | 保留普通按钮，多选继续 `--toggle`，只补充描述列表 | 改动最小，风险最低 | 每个选项仍 loading，不能解决核心体验 | 不选，作为回退方案 |
| B | 普通按钮点击后不 patch 高亮 | 减少一次 PATCH API 调用 | 仍有按钮回调 loading，且用户看不到已选状态 | 不选 |
| C | 全部题型迁移到 Card JSON 2.0 | 结构统一，能力更强 | 单选已稳定，全面迁移增加不必要风险 | 不选 |
| D | 混合策略：单选 v1 按钮，多选完整 v2 表单 | 保留稳定单选，根治多选逐项 loading，支持描述展示 | 需要处理 v1/v2 两种卡片结构与回调解析 | 采用 |

## 5. 卡片结构契约

### 5.1 单选题：legacy v1 普通按钮

单选继续由 `buildNativeQuestionCard(options)` 返回 Card JSON 1.0 结构：

```json
{
  "config": { "wide_screen_mode": true, "update_multi": true },
  "header": { "title": { "tag": "plain_text", "content": "交互式问题" }, "template": "blue" },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "问题正文和选项说明" } },
    { "tag": "action", "actions": [{ "tag": "button" }] }
  ]
}
```

规则：

- 选项按钮只展示短 label，避免按钮过高或换行不可控。
- 选项描述在按钮上方的 Markdown 列表展示。
- 按钮 `value.action` 保持 `cmd:/answer <requestID:index> --option option_<n> <walkerSessionId>`。
- 不使用 `behaviors`、`form_submit`、`tag:'form'`。

### 5.2 多选题：完整 Card JSON 2.0 表单

多选题返回完整 Card JSON 2.0 结构：

```json
{
  "schema": "2.0",
  "config": { "update_multi": true, "width_mode": "fill" },
  "header": { "title": { "tag": "plain_text", "content": "交互式问题" }, "template": "blue" },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "问题正文和选项说明" },
      {
        "tag": "form",
        "elements": [
          {
            "tag": "checkbox",
            "name": "question_selected",
            "options": [
              { "text": { "tag": "plain_text", "content": "文本消息" }, "value": "option_0" }
            ]
          },
          {
            "tag": "button",
            "name": "question_submit",
            "form_action_type": "submit",
            "text": { "tag": "plain_text", "content": "提交" },
            "type": "primary"
          }
        ]
      }
    ]
  }
}
```

实现时允许根据飞书实际字段约束调整 `checkbox` 的精确属性名，但必须满足以下硬约束：

- 顶层必须声明 `schema:'2.0'`。
- 组件必须放在 `body.elements` 下。
- 不得出现 v1-only 的顶层 `elements` 或 `tag:'action'`。
- 表单提交按钮必须使用 v2 表单语义，不得使用 legacy `value.action` + `behaviors/form_submit` 混用。
- 回调中必须能让 `parseCardAction()` 得到 `action` 或可派生命令的信息，以及 `formValue.question_selected`。

### 5.3 选项描述展示

所有有预设选项的问题都在正文中展示编号说明：

```text
**问题 1/1**
你想优先接入哪些飞书消息类型？可以多选。

选项说明：
1. **文本消息**
   接收普通文本内容，适合作为最基础的消息入口。
2. **图片消息**
   接收图片并提取图片 key 或下载链接，适合视觉/截图类场景。
```

规则：

- label 使用粗体。
- description 使用普通文本；多行描述需要按 Markdown 转义。
- 无 description 时不输出空说明行。
- 飞书按钮或 checkbox 的 label 保持短文本，详细信息在说明区展示。

## 6. 回调与解析契约

### 6.1 单选回调

单选沿用当前按钮协议：

```text
/answer <requestID:index> --option option_<n> <walkerSessionId>
```

`QuestionHandler.handleAnswer()` 解析 `--option` 后直接调用 `_acceptAnswers()`。

### 6.2 多选回调

多选新卡片必须在提交时生成等价命令：

```text
/answer <requestID:index> --form <walkerSessionId>
```

并携带：

```json
{
  "question_selected": ["option_0", "option_2"]
}
```

`QuestionHandler.handleAnswer()` 已保留 `--form` 兼容路径，继续通过 `_parseAnswers(question, cmd.formValue)` 解析。必要时扩展 `parseCardAction()`，兼容 Card JSON 2.0 回调中表单字段的新位置。

### 6.3 旧 `--toggle` 兼容

现有 `--toggle` 与 `--submit` 解析保留，原因：

- 已发出的旧卡片仍可能被用户点击。
- 单元测试可以继续覆盖按钮协议的兼容性。

但新生成的多选卡片不得再使用 `--toggle`。

## 7. 验证要求

必须补充或更新以下测试：

- `test/feishu-cards.test.js`
  - 单选卡片仍为 v1 `elements/action/actions`，无 `schema:'2.0'`。
  - 单选正文包含 label + description 的选项说明。
  - 多选卡片为完整 `schema:'2.0'`，使用 `body.elements`，不含顶层 `elements` 和 `tag:'action'`。
  - 多选不生成 `--toggle` 按钮。
  - 多选正文包含 label + description 的选项说明。
- `test/feishu-events.test.js`
  - 覆盖 Card JSON 2.0 表单回调字段位置。
- `test/question-handler.test.js`
  - 保留 `--form` 多选提交测试。
  - 保留 `--toggle` 旧卡片兼容测试。
- `test/integration-feishu-question.test.js`
  - 单选使用按钮提交。
  - 多选模拟 v2 表单提交，只产生一次 `--form` 命令。

最终验证命令：

```bash
node --test test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js test/feishu-platform.test.js
npx eslint src/platform/feishu/cards.js src/platform/feishu/events.js src/dispatch/question-handler.js test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js
git diff --check -- src/platform/feishu/cards.js src/platform/feishu/events.js src/dispatch/question-handler.js test/feishu-cards.test.js test/feishu-events.test.js test/question-handler.test.js test/integration-feishu-question.test.js
npm test
```

## 8. 风险与回退

| 风险 | 影响 | 缓解 |
| ---- | ---- | ---- |
| Card JSON 2.0 checkbox 字段与文档存在差异 | 飞书发送 400 或客户端不渲染 | 先用结构测试锁定不混用 v1/v2，再通过真实飞书日志确认；必要时把多选临时回退到方案 A。 |
| 旧客户端低于 7.20 | 用户看不到 v2 卡片内容 | 卡片正文或日志提示 Card JSON 2.0 依赖；如现场反馈旧客户端占比高，回退普通按钮。 |
| v2 表单回调字段位置不同 | Walker 解析不到 `formValue` | 扩展 `parseCardAction()` 覆盖 raw v2 与 SDK 归一化形态，并新增回归测试。 |
| 多题混合 v1/v2 patch 逻辑差异 | 状态卡片更新失败 | 状态卡片继续使用现有 v1 status card；`_patch()` 只按 cardId patch 完整 card JSON，不依赖原卡片版本。 |

## 9. 决策

- 采用混合策略：单选 legacy v1 普通按钮，多选完整 Card JSON 2.0 表单。
- 选项描述统一在正文 Markdown 中展示，不依赖按钮副标题。
- 新多选不再使用 `--toggle`；旧 `--toggle` 入口保留兼容。
- 禁止再次混用 legacy `action/actions` 与 v2 `behaviors/form_submit`。
