# 代码审查请求

**功能：** 飞书引用回复会话路由
**分支：** `feature/2026-08-12-feishu-quoted-session-routing`
**代码 worktree：** `H:\walker\.worktree\2026-08-12-feishu-quoted-session-routing`
**审查基准：** 隔离分支创建点 `64fa492 feat: stabilize Claude TUI Feishu runtime`，审查当前未提交 diff
**验证结论：** PASS

## Standards

- 无发现。预审查范围覆盖当前 diff 的架构分层、状态写入边界、错误处理、日志、测试质量和既有行为兼容性。
- 注意：当前变更尚未提交，审查对象是隔离 worktree 中的未提交 diff。

## Spec

- 无发现。实现与 `specs/2026-08-12+feishu-quoted-session-routing/spec.md` 的 5 个 REQ 和 24 个 behavior 对齐。
- 已核对非目标：未改变飞书卡片 action 路由语义；未把 `rootId` 作为唯一会话路由；未引入外部数据库或迁移；引用路由不切换 route 焦点。

## 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none

## 变更统计

```text
src/core/session-service.js        |  74 +++++++++
src/dispatch/message-dispatcher.js | 150 ++++++++++++++----
src/drivers/agent-driver.js        |  12 +-
src/platform/feishu/platform.js    |   2 +
src/providers/provider-catalog.js  |  13 +-
test/feishu-platform.test.js       |  72 +++++++++
test/message-dispatcher.test.js    | 313 +++++++++++++++++++++++++++++++++++++
test/provider-catalog.test.js      |   5 +-
test/session-service.test.js       | 167 ++++++++++++++++++++
9 files changed, 774 insertions(+), 34 deletions(-)
```

## 主要变更

1. `SessionService` 新增平台消息索引：`platformMessages.feishu`、`recordPlatformMessage()`、`resolveSessionByPlatformMessage()`、每平台 5000 条上限剪枝、删除 session 时清理映射。
2. `FeishuPlatform._handleMessageEvent()` 将飞书 `parent_id` 透传为 text/command 顶层 `parentId`。
3. `MessageDispatcher` 新增引用回复路由解析：`parentId` 映射优先于 route 焦点和 thread root fallback；命中后使用 mapped session/effective route，并保留原焦点不变。
4. `MessageDispatcher._callFeishu()` 在飞书发送成功后统一提取返回 message id 并记录绑定；记录失败只日志告警，不影响发送返回。
5. 用户确认的基线修复一并保留：provider catalog 能力声明、`AgentEvent` tool_use schema、`/attach claude` fail-closed、`/attach` 单 OpenCode 候选自动纳入。

## 变更详情

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/core/session-service.js` | 修改 | 新增平台消息映射状态、记录/解析 API、容量剪枝、删除清理。 |
| `src/platform/feishu/platform.js` | 修改 | text 和 command 入站 payload 顶层透传 `parentId`。 |
| `src/dispatch/message-dispatcher.js` | 修改 | 引用回复目标解析、effective route/session 上下文、出站消息绑定记录；保留 `/attach` 基线修复。 |
| `src/drivers/agent-driver.js` | 修改 | 扩展 tool_use 事件 schema 以兼容 lifecycle 字段。 |
| `src/providers/provider-catalog.js` | 修改 | 修正 Claude/OpenCode/Codex/Shell 能力声明与 capabilityStatus。 |
| `test/session-service.test.js` | 修改 | 覆盖映射记录、更新、剪枝、删除清理、旧 state 初始化、无效 session 解析。 |
| `test/feishu-platform.test.js` | 修改 | 覆盖 text/command 顶层 `parentId` 与缺失 `parent_id` 兼容。 |
| `test/message-dispatcher.test.js` | 修改 | 覆盖引用路由优先级、焦点不变、effective route lock、admin event 字段、出站绑定记录与失败路径。 |
| `test/provider-catalog.test.js` | 修改 | 同步 provider catalog 能力声明预期。 |

## 自测情况

- [x] `npm test` 通过，工作目录 `H:\walker\.worktree\2026-08-12-feishu-quoted-session-routing`。
- [x] `npm run lint` 通过，由 `npm test` 执行。
- [x] `npm run check` 通过，由 `npm test` 执行。
- [x] 定向测试通过：`node --test test/session-service.test.js`，55 pass。
- [x] 定向测试通过：`node --test test/feishu-platform.test.js test/feishu-events.test.js`，32 pass。
- [x] 定向测试通过：`node --test test/message-dispatcher.test.js test/message-dispatcher-platform-event.test.js test/permission-handler.test.js`，214 pass。
- [x] `loom_verify_artifacts` 通过。
- [x] `loom_converge` 第 1 轮收敛，24 个 behavior 全部 covered。
- [ ] 变更尚未提交；当前审查请求针对未提交 diff。
- [ ] 图后端同步未执行；本阶段仅使用已有验证报告和本地 diff 预审查。

## Evidence Receipt

- evidence-command: `npm test`
- evidence-exit-code: `0`
- evidence-file: `evidence/executing-npm-test.log`
- evidence-sha256: `7F099D5164FACDF97288B9BB4E58FA790EDEE27441F0D781F3772740C64083DA`
- total-tests: `1518`
- passed: `1518`
- failed: `0`

verdict: PASS

## 审查重点

- [ ] 引用回复路由优先级是否正确：`parentId` 映射优先，其次 route 焦点，再 thread root fallback，最后未绑定提示。
- [ ] 引用命中是否只影响本次投递，不应调用 `setFocus` 或 `bindRoute`。
- [ ] `platformMessages.feishu` 持久状态是否足够兼容旧 state，并且容量剪枝不会影响解析性能。
- [ ] 出站绑定记录是否只发生在飞书发送成功后，且记录异常不会影响回复主流程。
- [ ] `_extractFeishuMessageIds()` 对飞书返回形态的兼容性是否足够覆盖真实 API。
- [ ] 基线修复是否应与本功能同批提交，或后续拆成独立 commit。

## 剩余风险

- `npm install` 阶段报告当前 Node `v22.11.0` 低于部分 ESLint 依赖声明的 `^22.13.0` 下界，并报告 3 个 high severity audit findings；这些不是本功能引入，未在本阶段处理。
- 未连接真实飞书环境做端到端 API 回放；当前证据来自本地单元/集成测试与持久 evidence。
