# Claude Provider REQ-010 代码审查请求

**功能：** Claude/kscc 与 OpenCode 等价 Walker 层 TUI/window 会话链路
**固定审查点：** 当前工作区相对 `HEAD` 的未提交 diff，重点关注 T5/REQ-010 增量
**当前状态：** T5 executing 已完成；尚需重新进入 verification 更新 `verify-report.md`

## Findings

### Standards

- 无已知阻断发现。实现继续沿用现有 `AgentDriver`、`MessageDispatcher`、provider catalog 与 admin session DTO 分层。
- Claude/kscc 的窗口能力实现为 Walker 层 `cli-terminal` 会话链路，不伪造 OpenCode HTTP server、TUI bridge、sqlite session store 或 `opencodeSessionId`。
- 终端启动路径通过可注入 `openTerminal(command, args, options)` 实现，测试验证 `shell:false` 与 argv 数组，不通过 shell 拼接用户标题、cwd 或 prompt。
- 自动测试使用 fake CLI、fake terminal launcher 和 fake spawn，不执行真实 Claude prompt 或真实终端 launcher。

### Spec

- 无已知阻断发现。`requirements.json` 已新增 `REQ-010`，包含 `REQ-010-B01` 到 `REQ-010-B11` 共 11 个 behavior。
- `traceability.json` 已将 REQ-010 与全部 behavior 映射到 T5，并补齐真实 `tests` 与 `evidence`。
- `loom_validate_plan` 与 `loom_analyze_artifacts` 均通过，requirement/behavior/traceability coverage 为 100%。

### 预审查摘要

- Standards findings: 0 blocker，worst: none
- Spec findings: 0 blocker，worst: none

## 变更统计

来自 `git diff --stat`，包含首版 Claude provider 与 T5 增量的当前未提交 diff 摘要：

```text
.env.example                                   | 11 +++
.loom/compliance/history.json                  | 80 +++++++++++++++++++++
.loom/memory/MEMORY.md                         |  4 +-
.loom/memory/store.json                        | 16 +++++
src/admin/agent-runtime-admin.js               |  4 +-
src/admin/config-editor.js                     |  3 +
src/admin/config.js                            | 19 +++++
src/admin/session-admin.js                     | 23 ++++--
src/app/bootstrap.js                           | 21 +++++-
src/config/env.js                              |  9 +++
src/dispatch/message-dispatcher.js             | 51 +++++++++++---
src/providers/provider-catalog.js              | 14 +++-
src/providers/provider-detectors.js            | 17 ++++-
src/providers/provider-health.js               | 12 +++-
test/admin-config-event.test.js                |  6 ++
test/admin-core-api.test.js                    | 80 +++++++++++++++++++++
test/admin-observability-config.test.js        | 71 ++++++++++++++++++-
test/bootstrap.test.js                         | 53 +++++++++++++-
test/config-env.test.js                        | 29 ++++++++
test/driver-registry.test.js                   | 20 ++++++
test/message-dispatcher-platform-event.test.js | 18 ++++-
test/message-dispatcher.test.js                | 97 ++++++++++++++++++++++++++
test/provider-catalog.test.js                  | 63 +++++++++++++++++
23 files changed, 691 insertions(+), 30 deletions(-)
```

新增未跟踪文件/目录仍包括：

```text
specs/2026-07-31-claude-provider/
src/drivers/claude-driver.js
test/claude-driver.test.js
```

## 主要变更

1. `src/drivers/claude-driver.js`：Claude session 创建改为 Walker 层 `cli-terminal` session；通过可注入 `openTerminal` 拉起 Claude/kscc 交互式窗口，记录 `terminal` metadata；`prompt()` 继续使用后台 `--print --output-format stream-json`，但复用同一 `claudeSessionId`；新增 `watchSession()`、`isSessionRefActive()`、terminal registry、stop/delete 状态诊断与失败脱敏。
2. `src/dispatch/message-dispatcher.js`：`/new` 不再依赖 `agentRef.opencodeSessionId`；对 Claude session 使用通用 agentRef id；创建回复展示 `terminal active/failed/unavailable`；watch/refresh/restore 按 driver 能力和 `claudeSessionId` 分发。
3. `src/providers/provider-catalog.js`：Claude catalog 声明 Walker 层真实 `tui:true` 与 `window:true`，保持 `http:false`，避免伪造 OpenCode bridge。
4. `src/admin/session-admin.js`：Admin session DTO 展示 Claude `transport:'cli-terminal'` 与 `window` 诊断；`normalizeTransport()` 支持 `cli-terminal`。
5. 测试新增 REQ-010 覆盖：终端 launcher、同 session prompt 复用、失败降级、watch 幂等、provider catalog 能力、Admin 状态展示、OpenCode 不回归。

## 自测情况

- [x] `node --test test/claude-driver.test.js test/message-dispatcher.test.js test/provider-catalog.test.js test/admin-core-api.test.js`：PASS，277 tests，23 suites，0 fail。
- [x] `npm test *> specs/2026-07-31-claude-provider/evidence/test.log`：PASS，1379 tests，69 suites，0 fail。
- [x] `git diff --check`：PASS，无输出。
- [x] `loom_validate_plan`：PASS，T1-T5 plan/task/traceability 有效。
- [x] `loom_analyze_artifacts`：PASS，requirement/behavior/traceability coverage 100%，findings 空。
- [x] `traceability.json` JSON parse：PASS。

Evidence Receipt：

```text
targeted-command: node --test test/claude-driver.test.js test/message-dispatcher.test.js test/provider-catalog.test.js test/admin-core-api.test.js *> specs/2026-07-31-claude-provider/evidence/T5-req010-tests.log
targeted-exit-code: 0
targeted-evidence-file: evidence/T5-req010-tests.log
targeted-evidence-sha256: 8A8924C372EFBC7AA12CED70EBED6AF3EE35606F77B94346DF16EE4CABC8232C

full-command: npm test *> specs/2026-07-31-claude-provider/evidence/test.log
full-exit-code: 0
full-evidence-file: evidence/test.log
full-evidence-sha256: 9261EE22791BDD930F7AE37068EF5E77063E58B42AAED37A342AAD6BE090554B
```

## 重点关注

1. `ClaudeDriver.createSession()` 在 terminal 启动失败时是否应继续返回 degraded sessionRef，还是应让 `/new claude` 失败；当前实现选择可诊断降级，并在飞书回复中明确 `terminal failed/unavailable`，避免伪报完整成功。
2. `ClaudeDriver.prompt()` 仍使用后台 `--print` 与同一 `claudeSessionId` 复用上下文，而不是向交互式 TUI 进程注入输入；请重点审查这是否满足“飞书消息复用同一 Claude/kscc 会话”的实际体验预期。
3. `MessageDispatcher` 的通用 watch/restore 分发是否保持 OpenCode 既有 `opencodeSessionId`/TUI bridge watcher 行为不回归。
4. Claude catalog 的 `tui:true/window:true/http:false` 是否准确表达 Walker 层 terminal window 能力，而非 OpenCode TUI bridge 协议能力。
5. Admin DTO 暴露 `window` metadata 是否足够诊断 active/stopped/failed/unavailable 状态，且未泄漏敏感环境变量。

## 变更详情

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/drivers/claude-driver.js` | 修改 | 增加 `cli-terminal` session、terminal launcher/registry、watch/isActive/stop 诊断和同 session prompt 复用 |
| `src/dispatch/message-dispatcher.js` | 修改 | `/new`、watch/refresh/restore 支持 generic agentRef 与 Claude `claudeSessionId`，回复 terminal 状态 |
| `src/providers/provider-catalog.js` | 修改 | Claude capabilities 更新为 `tui:true`、`window:true`、`http:false` |
| `src/admin/session-admin.js` | 修改 | Admin session DTO 展示 `cli-terminal` 与 `window` 诊断 |
| `test/claude-driver.test.js` | 修改 | 覆盖 terminal launcher、同 session prompt、失败脱敏、watch/stop 诊断 |
| `test/message-dispatcher.test.js` | 修改 | 覆盖 `/new claude` terminal 状态、无 `opencodeSessionId` 和 Claude watch 幂等 |
| `test/provider-catalog.test.js` | 修改 | 覆盖 Claude TUI/window/http 能力声明 |
| `test/admin-core-api.test.js` | 修改 | 覆盖 Admin `cli-terminal` 与 window 状态展示 |
| `specs/2026-07-31-claude-provider/evidence/T5-req010-tests.md` | 新增 | T5/REQ-010 行为级证据收据 |
| `specs/2026-07-31-claude-provider/test-report.md` | 修改 | 更新 REQ-010 与最新全量测试证据 |
| `specs/2026-07-31-claude-provider/traceability.json` | 修改 | REQ-010 与 11 个 behavior 补齐 tests/evidence |

## 审查清单

- [ ] Claude/kscc window 链路是否满足 `/new claude` 后可见终端窗口与可诊断生命周期。
- [ ] 飞书 prompt 是否正确复用同一 `claudeSessionId`，且不会创建无关后台会话。
- [ ] 失败/降级状态是否对飞书、Admin、provider catalog 可见，且不会把后台 `--print` 冒充完整 TUI 成功。
- [ ] OpenCode 专属 TUI bridge、sqlite session store 与 `opencodeSessionId` 语义是否未被 Claude 污染。
- [ ] 测试证据是否足以覆盖 `REQ-010-B01` 到 `REQ-010-B11`。
