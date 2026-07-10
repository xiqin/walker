# Project Health Sweep Code Review Request

## 审查基准

- Fixed point: `HEAD` at `86439ce Merge feature/2026-07-09-feishu-opendray-bridge: Walker 飞书多 Agent CLI 桥接器`
- Scope: 本次 `specs/2026-07-09-project-health-sweep` 流水线产物，以及 T1 到 T6 声明的源码和测试文件。
- Workspace note: 本轮开始前工作区已有大量未提交改动；本审查请求只归纳本次健康审计任务涉及的文件与规格产物，不把既有脏状态视为本轮变更。

## Standards

- 无阻断发现。
- `git diff --check` 已针对本轮源码和测试文件运行，无空白或补丁格式问题。
- `.loom/rules/constitution.md` 的技术栈和编码红线仍是模板内容，缺少具体 `BUILD_CMD`、`VET_CMD`、`TEST_CMD`。本轮按项目实际 `package.json` 的 `npm run check` 和已落盘报告验证。
- 图后端状态：未发现 `.loom/graph.config.json`，本阶段未执行图索引同步；早期探索已使用现有 CodeGraph 查询理解架构。

## Spec

- 无阻断发现。
- `plan.md` 将本轮 13 类缺陷映射为 `REQ-001` 到 `REQ-013`，`test-report.md` 已逐项确认实现、测试和 task handoff 证据。
- `verify-report.md` 重新运行 `npm run check` 并保存 `evidence/verification.log`，192 tests 全部通过。
- 剩余风险已明确记录：未做真实飞书租户、真实 `WSClient` 长连接、真实 OpenCode 服务端到端演练；Windows/WSL terminal 转义未在真实交互窗口手动覆盖所有特殊字符组合；未来 OpenCode SSE schema 变化仍可能需要适配。

## 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none
- Residual risks: 3 项，均已记录在 `verify-report.md` 和本请求中。

## 变更统计

Tracked diff stat for main T1-T6 files:

```text
src/core/http-helper.js              | 153 ++++++++-
src/core/json-store.js               |   9 +-
src/core/session-service.js          |  18 +-
src/dispatch/message-dispatcher.js   | 418 ++++++++++++++++++++++---
src/drivers/opencode-driver.js       | 274 ++++++++++++++--
src/platform/feishu/api.js           |  57 +++-
src/platform/feishu/events.js        |  26 +-
src/platform/feishu/platform.js      | 107 ++++---
src/platform/feishu/progress-card.js |  15 +-
src/runtime/windows-runtime.js       |  37 ++-
src/runtime/wsl-runtime.js           |  36 +++
test/feishu-events.test.js           |  48 +++
test/json-store.test.js              |  36 +++
test/message-dispatcher.test.js      | 592 ++++++++++++++++++++++++++++++++++-
test/opencode-driver.test.js         | 345 ++++++++++++++++++--
test/progress-card.test.js           |  24 ++
test/runtime.test.js                 |  77 +++++
test/session-service.test.js         |  64 ++++
18 files changed, 2160 insertions(+), 176 deletions(-)
```

New files in this scope include `test/feishu-api.test.js`, `test/feishu-platform.test.js`, `test/http-helper.test.js`, and `specs/2026-07-09-project-health-sweep/` reports and handoffs.

## 主要变更

1. Hardened core persistence and transport boundaries: `JsonStore` fallback cloning, `httpRequest()` timeout support, and SSE response validation plus frame parsing.
2. Hardened Feishu platform behavior: API HTTP/business error handling, real card message IDs, reaction error swallowing, progress card `update_multi`, mention command parsing, fast WebSocket ACK, and awaited `WSClient.start()`.
3. Hardened session and dispatcher state convergence: deleted sessions cannot be rebound, dirty routes are cleaned, terminal states are protected, command errors are surfaced, and Feishu async send failures are contained.
4. Hardened OpenCode driver behavior: `createSession()` rejects non-2xx or missing session IDs before opening terminals, and directory-level SSE events must explicitly match the target session.
5. Hardened Windows/WSL terminal command construction with `cmd.exe /v:off` and caret escaping for control characters.
6. Added focused regression coverage and persisted evidence reports for all `REQ-001` through `REQ-013` requirements.

## 自测情况

- PASS: `npm run check`
- Evidence file: `specs/2026-07-09-project-health-sweep/evidence/verification.log`
- Evidence SHA-256: `dd1927cd5b42b0445663fddf32b7a93f18dca80075f24c1cee3511bc19bcfc5a`
- Result: syntax checks passed; `node --test test/*.test.js` completed 192 tests, 192 passed, 0 failed.
- Additional check: `git diff --check` on T1-T6 changed source/test files returned no output.
- Artifact checker: inconclusive due local skill install missing `C:\Users\tianxiqin\.config\opencode\src\core\artifact-checker.js`; manual artifact, verdict, evidence receipt, placeholder, task-state, and fresh `npm run check` verification completed.

## 变更详情

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/core/json-store.js` | 修改 | fallback 默认值深拷贝，避免 `update()` 污染构造默认值 |
| `src/core/http-helper.js` | 修改 | HTTP timeout、SSE status/content-type 校验、标准帧解析 |
| `src/platform/feishu/api.js` | 修改 | HTTP 与飞书业务错误判定、真实 card message id、reaction reject 捕获 |
| `src/platform/feishu/progress-card.js` | 修改 | progress card 增加 `config.update_multi` |
| `src/platform/feishu/events.js` | 修改 | 清理群聊 mention 前缀以识别命令 |
| `src/platform/feishu/platform.js` | 修改 | 快速 ACK 后台处理、`WSClient.start()` async 传播 |
| `src/core/session-service.js` | 修改 | deleted/missing session route 清理和终态保护 |
| `src/dispatch/message-dispatcher.js` | 修改 | 飞书异步错误边界、命令错误反馈、prompt 后状态收敛 |
| `src/drivers/opencode-driver.js` | 修改 | createSession 响应校验、目录级 SSE session 过滤 |
| `src/runtime/windows-runtime.js` | 修改 | `cmd.exe` 命令片段转义和 delayed expansion 防护 |
| `src/runtime/wsl-runtime.js` | 修改 | WSL terminal 命令片段转义和 delayed expansion 防护 |
| `test/*.test.js` | 修改/新增 | 覆盖 T1-T6 红绿回归场景 |
| `specs/2026-07-09-project-health-sweep/*` | 新增 | spec、plan、task handoffs、test report、verify report 和证据日志 |

## 审查重点

- Feishu API 错误处理是否和飞书 `{ code, msg, data }` 业务语义一致。
- Feishu WebSocket 快速 ACK 后台处理是否满足 3 秒 ACK，同时不会吞掉关键错误诊断。
- `MessageDispatcher` 对 stopped/deleted 终态的保护是否足够覆盖并发 prompt 完成路径。
- OpenCode directory-level SSE 过滤策略是否过严，是否可能过滤未来 schema 中合法但不同字段路径的 session id。
- Windows/WSL `cmd.exe /k` 转义是否覆盖实际 shell 语义，特别是 `& | < > ^ % ! "` 与空格组合。
- 新增测试是否验证行为边界，而不是过度耦合到实现细节。

## 审查材料

- `specs/2026-07-09-project-health-sweep/spec.md`
- `specs/2026-07-09-project-health-sweep/plan.md`
- `specs/2026-07-09-project-health-sweep/test-report.md`
- `specs/2026-07-09-project-health-sweep/verify-report.md`
- `specs/2026-07-09-project-health-sweep/handoffs/T1.json` through `T6.json`
- `specs/2026-07-09-project-health-sweep/handoffs/executing.json`
- `specs/2026-07-09-project-health-sweep/handoffs/verification.json`
