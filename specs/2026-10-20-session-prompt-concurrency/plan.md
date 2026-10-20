# 不同会话消息独立执行实现计划

**目标：** 同一路由的不同会话可以同时推进提示词，同时保留同会话串行和路由命令互斥。

**架构：** 保留现有 `MessageDispatcher` 路由锁与会话队列；在路由锁内只提交 `_enqueuePrompt`，锁外继续等待该调用的处理结果。保持引用消息的生效路由解析、命令入口、返回值与错误处理逻辑不变。代码和行为回归测试一起交付，以防锁意外跨越提示词生命周期。

**技术栈：** Node.js 22、CommonJS、`node:test`、ESLint。

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | 缩短路由锁并验证消息调度 | 调度与集成 | 中等 | 无 | REQ-001、REQ-002 | REQ-001-B01～B04、REQ-002-B01～B05 | `tasks/T1.md` |

## 文件结构与依赖

- `src/dispatch/message-dispatcher.js`：调整 `handleIncomingMessage` 调用 `_enqueueRouteLock` 的边界，保持 `_enqueuePrompt` 队列和命令锁语义。
- `test/message-dispatcher.test.js`：在现有调度器行为测试中验证两种会话关系、异常与路由命令。
- T1 内部按生产逻辑、重构审查、行为测试、全量验证的顺序执行；没有跨 task 文件写入冲突。

## 依赖关系

T1 无前置 task，也不与其他 task 并行；任务内先完成生产代码再写行为测试。

## Traceability 初始映射

`traceability.json` 对 REQ-001、REQ-002 及全部九个行为映射至 T1。执行阶段补齐测试与真实证据引用，验证阶段复核。

## 验证

运行 `node --test test/message-dispatcher.test.js` 与 `npm test`；以受控 Promise 验证 B 无需等待 A 结束、同一会话 A2 必须等待 A1，且命令和消息入队的路由锁仍互斥。外部 TUI runtime 的物理并发限制不属于本计划。
