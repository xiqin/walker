# 代码审查请求：不同会话消息独立执行

**分支：** `feature/2026-10-20-session-prompt-concurrency`

**预审查基线：** 当前 `HEAD`（`76fbfbf`）对比工作区改动及新建的规格目录

**状态：** 审查材料已交付用户；用户在当前会话中确认“已审查，通过”（见 `review-feedback.md`）；工作区未提交，未指定外部审查者，也未创建外部审查请求。

## Standards

- 无阻断发现。`src/dispatch/message-dispatcher.js:238-242` 仅调整锁内任务的返回包装，未改动 `_enqueueRouteLock`、会话队列、命令入口或公共接口；`test/message-dispatcher.test.js:185-377` 覆盖并发、故障与命令顺序。
- 项目宪章中的构建、静态检查和红线仍为占位项；本次使用现有 `npm test`（含 ESLint 和检查）、`node --check` 及 `git diff --check`，仓库无构建脚本。

## Spec

- 无发现。依据 `spec.md:9-32` 的 REQ-001、REQ-002、返回时机及非目标核对：路由锁仅保护入队，不再等待提示词；同会话仍串行，路由级命令仍互斥；不更改路由规则和外部接口。参见 `src/dispatch/message-dispatcher.js:238-242`、`test/message-dispatcher.test.js:185-377`。

## Spec 遗漏自审

- 检查条目：2 项需求、9 项行为（REQ-001-B01～B04、REQ-002-B01～B05）；代码落点在 `src/dispatch/message-dispatcher.js:238-242`，既有队列及命令互斥见同文件 `:459-470`、`:532-537`、`:2222-2234`；逐项测试和证据见 `traceability.json` 与 `test/message-dispatcher.test.js:185-377`。
- 边界及禁止行为：引用消息使用生效路由、同会话不重叠、命令占锁时消息等待、提示词失败后队列恢复和返回结果时机均已核对；不同 route 与空 route 保持原有路径，未修改外部 TUI 并发能力。
- 遗漏：无。`findings/omission-hunter.json` 检查九项行为，0 阻断项。
- omission-hunter：通过。

## 预审查摘要

- Standards findings：0，worst：无。
- Spec findings：0，worst：无。
- Spec 遗漏：0，worst：无。

## 变更统计

以 `HEAD` 为基线的已跟踪文件统计（新建的 `specs/2026-10-20-session-prompt-concurrency/` 尚未纳入 `git diff --stat`）：

```text
 .loom/compliance/history.json      |   8 ++
 src/dispatch/message-dispatcher.js |   6 +-
 test/message-dispatcher.test.js    | 214 +++++++++++++++++++++++++++++++++++++
 3 files changed, 227 insertions(+), 1 deletion(-)
```

`.loom/compliance/history.json` 为流水线生成的合规记录；规格目录包含已批准的需求、计划、映射、测试证据、验证报告和交接记录。

## 主要变更

1. 在路由锁任务内将 `_enqueuePrompt` 返回的 Promise 放入普通对象，使路由锁在入队后释放；`handleIncomingMessage` 在锁外等待本消息结果。
2. 增加受控 Promise 回归测试，覆盖跨会话并发、同会话串行、异常恢复与命令互斥；补齐规格、追踪及验证证据。

## 自测情况

- [x] 定向测试：223/223（`evidence/T1-node-test.log`）。
- [x] 全量 `npm test`：1511/1511，0 失败；本次预审查复跑通过，包含 ESLint。
- [x] `node --check src/dispatch/message-dispatcher.js`、`git diff --check`：通过。
- [x] 九项行为的遗漏自审及 omission-hunter：通过。
- [ ] 提交与外部审查：未执行；用户已在当前会话中审查通过，没有指定外部审查目标。
- [ ] 图索引同步：本工作树没有可查询的 CodeGraph 索引；真实飞书和 Agent 运行时未接入。

## 审查重点

- [ ] 检查包装 Promise 是否确实只缩短路由锁、不使消息处理提前返回。
- [ ] 检查 `/new`、`/attach`、`/clear` 与跨会话消息并发时的既有互斥语义。
- [ ] 检查受控 Promise 测试的断言质量及异常清理。
- [ ] 确认外部 TUI 自身的并发限制不被误认为本次已验证。
