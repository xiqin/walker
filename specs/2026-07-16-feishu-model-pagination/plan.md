# 飞书模型卡片分页实现计划

## 摘要

在现有 `/model` 交互卡片上增加原地翻页能力。实现保持每页最多 20 个模型按钮，先构造稳定、去重的完整模型序列，再按页切片；分页动作复用 `cmd:/model --page <页码>`，由 dispatcher 识别并通过飞书 `patchCard` 更新触发动作的原卡片。

## 文件结构规划

| 文件 | 职责 |
| --- | --- |
| `src/platform/feishu/cards.js` | 构造完整模型顺序、分页切片、页码归一化和导航按钮 |
| `test/feishu-cards.test.js` | 验证 53 个模型的三页覆盖、排序去重、导航边界和 routeKey |
| `src/dispatch/message-dispatcher.js` | 识别 `/model --page N`、跳过分页动作去重并传递分页上下文 |
| `src/app/bootstrap.js` | 分页动作存在 `updateMessageId` 时 patch 原卡片，否则发送新卡片 |
| `test/message-dispatcher.test.js` | 验证分页命令、页码参数、去重豁免、模型切换与 fallback 兼容 |
| `test/bootstrap.test.js` | 验证 `sendModelList` 在新卡片和原卡片更新之间正确选择 API |

## Task 概览

| Task | 名称 | Requirements | 依赖 | 复杂度 |
| --- | --- | --- | --- | --- |
| T1 | 模型卡片稳定分页与导航 | REQ-001, REQ-002, REQ-003, REQ-004, REQ-005 | 无 | medium |
| T2 | 分页命令与原卡片更新集成 | REQ-002, REQ-003, REQ-005, REQ-006, REQ-007 | T1 | high |

## 依赖关系

`T1 → T2`

T2 依赖 T1 确定的 `renderModelListCard(models, options)` 分页接口和导航动作格式，因此不并行执行。

## 验证策略

- T1 运行 `node test/feishu-cards.test.js`。
- T2 运行 `node test/message-dispatcher.test.js` 和 `node test/bootstrap.test.js`。
- 集成完成后运行 `npm run check`。

## 完成标准

- REQ-001 至 REQ-007 均映射到至少一个 task 和持久化测试。
- 53 个模型可通过三页访问且每个模型只出现一次。
- 分页点击 patch 原卡片，并可在相邻页面反复往返。
- 直接模型切换、routeKey 和纯文本 fallback 保持兼容。
