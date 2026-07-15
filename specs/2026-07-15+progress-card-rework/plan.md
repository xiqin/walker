# 飞书进度卡片重构实现计划

**目标：** 将进度卡片限定为过程状态展示，并在 card 模式下通过普通文本消息完整发送 Agent 最终回答。

**架构：** 保留现有事件合并和飞书 API 分层，只在 `ProgressCard` 展示模型与 `MessageDispatcher` 渲染编排两处做最小行为调整。卡片模型忽略文本事件并在完成态渲染中性提示；调度器跳过文本卡片更新，由 `_renderEvents` 统一发送最终文本，并仅在发送成功后记录已送达状态。

**技术栈：** Node.js CommonJS、内置 `node:test`、飞书交互卡片与文本消息 API

---

## 文件结构

| 文件 | 操作 | 职责 |
| ---- | ---- | ---- |
| `src/platform/feishu/progress-card.js` | 修改 | 忽略最终文本事件，保留过程事件，渲染完成提示 |
| `test/progress-card.test.js` | 修改 | 验证卡片模型的新行为和未变行为 |
| `src/dispatch/message-dispatcher.js` | 修改 | 跳过文本卡片更新，统一发送最终文本并控制 deliveredText 记录 |
| `test/message-dispatcher.test.js` | 修改 | 验证 card、legacy、心跳、失败补发及去重行为 |

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 调整进度卡片展示模型 | 平台展示层 | 低 | 无 | `tasks/T1.md` |
| T2 | 重构 card 模式最终文本发送 | 消息调度层 | 中 | 无 | `tasks/T2.md` |

## 依赖关系

T1 与 T2 无代码文件所有权交集，可并行实施；两项完成后统一运行 `npm test` 验证集成结果。

## Requirement 覆盖

| Requirement ID | Task |
| -------------- | ---- |
| REQ-001 | T1 |
| REQ-002 | T2 |
| REQ-003 | T1 |
| REQ-004 | T1 |
| REQ-005 | T2 |
| REQ-006 | T2 |
| REQ-007 | T2 |
| REQ-008 | T2 |
| REQ-009 | T2 |
| REQ-010 | T2 |
| REQ-011 | T1 |
| REQ-012 | T2 |
| REQ-013 | T2 |
| REQ-014 | T1、T2 |

## 集成验证

1. 运行 `node --test test/progress-card.test.js`。
2. 运行 `node --test test/message-dispatcher.test.js`。
3. 运行 `npm test`，确认语法检查和全量测试全部通过。
4. 检查最终差异仅包含规格、计划、上述四个源码或测试文件及 loom 自动生成的阶段产物。
