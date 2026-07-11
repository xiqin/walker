# 代码审查请求

**功能：** Walker 短期演进：长任务可观测、可取消、可限时
**Fixed Point：** 当前未提交工作区相对 `HEAD`
**Spec：** `specs/2026-07-11+walker-short-term-evolution/spec.md`

## Standards

- 无阻断发现。
- 已按现有 Node/CommonJS 与 `node:test` 约定实现，配置集中由 `src/config/env.js` 解析，经 `src/app/bootstrap.js` 注入 `MessageDispatcher`。
- 已知注意事项：当前工作区包含本轮前已有的长文本分片、attach/watch restore、OpenCode watch polling 去重等未提交改动；这些改动未回滚，也应在审查时与本轮 REQ-001 到 REQ-006 区分。
- 已知注意事项：verification 自动产物脚本因本机 opencode skill 包缺少 `artifact-checker.js` 依赖失败，已在 `verify-report.md` 中通过手动产物检查、测试报告、全量测试和 evidence receipt 补证。

## Spec

- 无阻断发现。
- REQ-001：心跳参数已环境变量化，并通过 bootstrap 注入 dispatcher。
- REQ-002：已新增 `/cancel`，取消当前 turn，保留 Walker session 并回到 `idle`。
- REQ-003：已新增 `/status`，并保留 `/ps` 作为别名。
- REQ-004：已新增 `WALKER_MAX_TURN_TIME_MINS`，默认 `0` 关闭，启用后自动取消超时 turn。
- REQ-005：已补强取消/超时残留输出和重复 `done` 防护测试。
- REQ-006：README 已补齐新增命令、配置项和长任务行为说明。

## 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none

## 变更统计

```text
 .gitignore                         |   2 +
 .loom/compliance/history.json      |  12 ++
 README.md                          |  18 ++
 package.json                       |   1 +
 src/app/bootstrap.js               |   4 +
 src/config/env.js                  |   9 +
 src/core/session-service.js        |   8 +
 src/dispatch/message-dispatcher.js | 332 +++++++++++++++++++++++++++++++++---
 src/drivers/opencode-driver.js     | 198 +++++++++++++++++++++-
 src/platform/feishu/api.js         |  69 ++++++--
 src/platform/feishu/cards.js       |  48 +++++-
 src/platform/feishu/commands.js    |   3 +
 test/bootstrap.test.js             |  38 +++++
 test/config-env.test.js            |  28 ++++
 test/feishu-api.test.js            |  44 +++++
 test/feishu-cards.test.js          |  13 ++
 test/feishu-commands.test.js       |  36 +++-
 test/message-dispatcher.test.js    | 335 +++++++++++++++++++++++++++++++++++++
 test/opencode-driver.test.js       |  56 ++++++-
 19 files changed, 1207 insertions(+), 47 deletions(-)
```

## 主要变更

1. 新增心跳和最大 turn 时长配置：`WALKER_PROMPT_HEARTBEAT_INITIAL_MS`、`WALKER_PROMPT_HEARTBEAT_INTERVAL_MS`、`WALKER_PROMPT_HEARTBEAT_STUCK_MS`、`WALKER_MAX_TURN_TIME_MINS`。
2. 新增飞书命令 `/cancel`、`/status`、`/ps`，并补充命令解析和帮助文案测试。
3. `MessageDispatcher` 新增 turn 生命周期状态，支持手动取消、超时自动取消、心跳清理、watch buffer 清理和残留输出抑制。
4. README 更新新增配置、命令和长任务行为说明。
5. 补充验证产物：`test-report.md`、`verify-report.md`、`evidence/verification.log`、T1-T4 handoff。

## 自测情况

- [x] T1：`node --test test/config-env.test.js test/bootstrap.test.js` 通过，14/14。
- [x] T2：`node --test test/feishu-commands.test.js` 通过，19/19。
- [x] T3：`node --test test/message-dispatcher.test.js` 通过，42/42。
- [x] T4：README 关键字检查通过，命中 14 处。
- [x] 全量：`npm test` 通过，504 tests，30 suites，504 pass，0 fail。
- [x] 图索引：`codegraph sync .` 通过，Already up to date。
- [x] 验证报告：`verify-report.md` 结论 PASS，并包含 Evidence Receipt。

## 变更详情

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/config/env.js` | 修改 | 解析心跳和最大 turn 时长环境变量，非法值回落默认值。 |
| `src/app/bootstrap.js` | 修改 | 将新增配置注入 `MessageDispatcher`。 |
| `src/platform/feishu/commands.js` | 修改 | 注册 `/cancel`、`/status`、`/ps`。 |
| `src/dispatch/message-dispatcher.js` | 修改 | turn 生命周期、取消、状态、超时、残留输出抑制。 |
| `README.md` | 修改 | 新增配置、命令和长任务行为说明。 |
| `test/config-env.test.js` | 修改 | 覆盖新增环境变量默认值、覆盖值和非法值。 |
| `test/bootstrap.test.js` | 修改 | 覆盖新增配置注入 dispatcher。 |
| `test/feishu-commands.test.js` | 修改 | 覆盖新增命令解析和帮助输出。 |
| `test/message-dispatcher.test.js` | 修改 | 覆盖取消、状态、超时、残留输出和重复 done。 |
| `specs/2026-07-11+walker-short-term-evolution/` | 新增 | spec、plan、task handoff、测试报告、验证报告和 evidence receipt。 |

## 审查重点

- [ ] `MessageDispatcher` turn 状态是否在成功、失败、取消、超时、watch 停止等路径均正确清理。
- [ ] `/cancel` 使用 `driver.cancel` 或 fallback `driver.stop` 后，Walker session 保留并回 `idle` 的语义是否清晰且安全。
- [ ] 取消/超时后的 `driver.prompt` 迟到事件与后台 watch 残留输出是否被充分抑制。
- [ ] `/status` 输出是否足够诊断长任务状态，且不泄露敏感信息。
- [ ] 新增环境变量默认值是否保持现有行为兼容。
- [ ] README 与实际行为是否一致。

## 已知风险

- 当前工作区并非干净基线，存在本轮前已有未提交修复；审查时建议按 spec/handoff 区分本轮短期演进与此前修复。
- `/cancel` 第一版允许 fallback 到 OpenCode `driver.stop(agentRef)`，不是协议级细粒度 turn cancel；README 和 spec 已说明该语义。
- 本轮不实现 ACP Driver、多 Agent 平台、飞书以外平台、新配置文件格式、复杂 Web 管理后台、团队权限和审计日志。
