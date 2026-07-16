# 飞书消息与指令交互增强实现计划

**目标：** 让飞书普通回复展示本次请求指定的模型，并把 `/model`、`/help` 从纯文本提示升级为可点击的飞书交互卡片。

**架构：** 采用驱动层统一模型视图、飞书平台层专用卡片渲染、dispatcher 业务命令集成的分层方案。卡片按钮继续复用现有 `cmd:/...` 回流协议，避免新增平台事件类型。普通 Agent 回复只在最终文本发送边界追加模型 footer，不改变 Agent 事件处理流程。

**技术栈：** Node.js CommonJS、飞书交互卡片 JSON、现有 `MessageDispatcher` / driver registry / Feishu API 适配层。

---

## Requirement IDs

| ID | 来源 | 验收点 |
| -- | ---- | ------ |
| REQ-001 | spec 目标与详细行为：飞书回复模型 footer | 普通 Agent 最终文本底部包含 `模型：...` footer，解析不到模型时显示 `未指定`。 |
| REQ-002 | spec `/model` 交互卡片 | `/model` 无参数返回模型卡片，包含可点击按钮，支持 Recent 最多 5 个、总按钮最多 20 个、超限提示。 |
| REQ-003 | spec 点击模型按钮 | 模型按钮 action 可被现有卡片回流解析为 `/model <provider>/<id>`，点击后更新当前会话 `model` 字段。 |
| REQ-004 | spec `/help` 交互卡片 | `/help` 返回命令帮助卡片，至少包含 `/new`、`/attach`、`/list`、`/model` 等命令按钮。 |
| REQ-005 | spec 多 agent 扩展约束 | dispatcher 通过当前 agent driver 获取统一模型目录；不固定回退到 OpenCode driver；OpencodeDriver 输出统一模型视图并映射 OpenCode Recent。 |
| REQ-006 | spec 风险：命令去重 | 同一卡片上点击不同模型按钮不能被 `messageId + name` 去重误判为重复。 |
| REQ-007 | spec 验收标准：现有命令仍可用 | 保持已有纯文本命令解析与无卡片能力 fallback 行为。 |

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 统一模型视图与 OpenCode Recent 映射 | 驱动层 | 中等 | 无 | `tasks/T1.md` |
| T2 | 飞书模型、帮助卡片与 API 挂载 | 平台 UI 层 | 中等 | T1 | `tasks/T2.md` |
| T3 | dispatcher 命令集成、模型 footer 与去重修正 | 业务集成层 | 高 | T1, T2 | `tasks/T3.md` |

## 依赖关系

T1 → T2 → T3

## 文件结构规划

| 文件 | 计划改动 | 所属 Task |
| ---- | -------- | --------- |
| `src/drivers/agent-driver.js` | 增加基类 `listModels()` 契约或默认不支持实现，明确统一模型视图字段。 | T1 |
| `src/drivers/opencode-driver.js` | 将 `/api/model` 返回转换为统一模型视图，保留 `source`、`groups`、`lastUsedAt`，映射 Recent 元数据。 | T1 |
| `test/opencode-driver.test.js` | 覆盖统一模型视图、Recent 映射、enabled/status 过滤。 | T1 |
| `src/platform/feishu/cards.js` | 新增 `renderModelListCard`、`renderHelpCard`，复用 `buildCommandValue`，限制 Recent 5 个、总按钮 20 个。 | T2 |
| `src/app/bootstrap.js` | 挂载 `sendModelList`、`sendHelpCard` 到 `feishuApiTarget`。 | T2 |
| `src/platform/feishu/commands.js` | 导出可供帮助卡片消费的命令元数据，保持 `formatHelp()` 兼容。 | T2 |
| `test/feishu-cards.test.js` | 覆盖模型卡片、Recent、超限提示、帮助按钮 action/routeKey。 | T2 |
| `src/dispatch/message-dispatcher.js` | `/model` 无参数改用当前 session agent driver 的 `listModels()`；`/help` 优先卡片；保留 fallback；追加 footer；修正命令去重。 | T3 |
| `test/message-dispatcher.test.js` | 覆盖 `/model` 卡片发送、无模型目录提示、点击按钮更新、`/help` 卡片、footer、去重参数区分。 | T3 |

## 串行与并行边界

- T1、T2、T3 的 `owns` 集合不重叠。
- T2 依赖 T1 的统一模型字段约定，但不写驱动层文件。
- T3 是 dispatcher 集成点，依赖 T1 的模型目录能力和 T2 的平台卡片能力。
- 本计划不建议并行 subagent 执行，因为业务集成依赖明确，串行实现更安全。

## 验证计划

- 每个 task 先补充对应单元测试，再实现生产代码。
- 局部验证优先运行相关测试文件；最终运行 `npm run check`。
- planning 产物校验运行 `node C:\Users\tianxiqin\.config\opencode\skills\loom-writing-plans\scripts\validate-plan.mjs --spec-dir specs/2026-07-16-feishu-message-interactions`。
