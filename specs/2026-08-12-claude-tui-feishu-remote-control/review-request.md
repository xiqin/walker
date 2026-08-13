# 代码审查请求

**功能：** Claude 原生 TUI 与飞书单进程协同
**分支：** `feature/2026-08-12-claude-tui-feishu-remote-control`
**审查基准：** 当前工作树相对 `HEAD` 的本地 diff
**规格来源：** `specs/2026-08-12-claude-tui-feishu-remote-control/spec.md`

## Findings

## Standards

- 无阻断发现。
- 预审查期间发现并已修复：`src/drivers/claude-bridge-sidecar.js:_attach` 仍会对 attach 客户端请求 historical replay，违反统一 attach 协议边界；已改为 `{ replay: false }`，并新增 `test/claude-bridge-sidecar.test.js` 覆盖。
- 工作区存在并存的非本功能改动：`.env.example`、admin/config/provider、Feishu cards/commands、若干配置与 provider 测试、未跟踪 `specs/2026-08-12-claude-opencode-tool-parity/`、`test/claude-attach-list.test.js` 等。请审查时把本功能核心文件与这些既有/并存改动分开看。

## Spec

- 无阻断发现。
- `convergence-report.json` round 2 已收敛：7 个 REQ、39 个 behavior 全部 `covered`，`behavior_coverage: 100%`，`blocker_count: 0`。
- `findings/omission-hunter.json` 通过：39 个 behavior 已检查，`findings: []`，`blocker_count: 0`。

## 预审查摘要

- Standards findings: 0 个未解决，worst: none。
- Spec findings: 0 个未解决，worst: none。

## 变更统计

本功能核心文件当前统计：

```text
src/dispatch/message-dispatcher.js            | 168 +++++++++++++--
src/drivers/claude-attach-server.js           |   2 +-
src/drivers/claude-bridge-sidecar.js          |   2 +-
src/drivers/claude-driver.js                  | 224 +++++++++++++++++---
test/claude-attach.test.js                    |  61 ++++--
test/claude-bridge-sidecar.test.js            |  57 ++++-
test/claude-driver.test.js                    | 223 +++++++++++++++++++-
test/claude-transcript.test.js                | 287 +++++++++++++++++++++++++-
test/claude-tui-reconnect.integration.test.js | 108 +++++++++-
9 files changed, 1058 insertions(+), 74 deletions(-)
```

全局 `git status` 仍包含其他未提交/未跟踪改动，未在本审查请求中归为本功能核心 diff。

## 主要变更

1. `src/drivers/claude-driver.js` 将 `resumeSession()` 与打开 attach 窗口解耦：恢复只恢复可写 runtime，不再隐式 `_ensureTerminal()`。
2. `src/drivers/claude-driver.js` 增加 `_resumePromises`，同一 Claude UUID 的并发恢复合并为一次 runtime 恢复。
3. `src/drivers/claude-driver.js:isSessionRefActive()` 对 active PTY runtime 不再依赖 `_windows` 或 `terminal.status`，避免飞书普通消息因为窗口状态失效而误判会话不可用。
4. `src/drivers/claude-attach-server.js` 与 `src/drivers/claude-bridge-sidecar.js` 的 attach WebSocket 输出订阅均固定 `{ replay: false }`，新 attach 客户端只接收连接后的实时 PTY 字节。
5. `src/dispatch/message-dispatcher.js` 在 Claude agentRef 持久化失败时先脱敏日志，再返回统一错误卡片，并保证不向 PTY 写入 prompt。
6. 测试覆盖扩展到 attach 无历史回放、bridge sidecar attach 无回放、runtime/window 解耦、并发恢复、飞书恢复持久化顺序、transcript 精确 UUID/cwd 读取、claude/kscc/OpenCode 回归。

## 自测情况

- [x] `node --test "test/claude-bridge-sidecar.test.js"`：PASS，6/6。
- [x] `node --test "test/claude-attach.test.js" "test/claude-attach-command.test.js" "test/cli-claude-attach.test.js"`：PASS，18/18。
- [x] `npm test`：PASS，1511/1511，74 suites，完整输出 `C:\Users\tianxiqin\.local\share\opencode\tool-output\tool_ff5a7074b001AyIMsKzsbCflnx`。
- [x] `loom_validate_plan`：PASS。
- [x] `loom tasks --spec-dir "specs/2026-08-12-claude-tui-feishu-remote-control" --validate`：PASS，无 owns 冲突。
- [x] `loom_verify_artifacts`：PASS，errors/warnings 为空。
- [x] `loom_converge(round=2)`：PASS，100% covered。

## 变更详情

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/drivers/claude-attach-server.js` | 修改 | 标准 attach server 禁用历史 replay，只转发实时输出。 |
| `src/drivers/claude-bridge-sidecar.js` | 修改 | bridge sidecar attach 同步禁用历史 replay。 |
| `src/drivers/claude-driver.js` | 修改 | runtime 恢复不弹窗、active 判断与窗口解耦、并发 resume 互斥。 |
| `src/dispatch/message-dispatcher.js` | 修改 | Claude agentRef 持久化失败时脱敏日志、错误卡片返回、阻止 PTY 写入。 |
| `test/claude-attach.test.js` | 修改 | 覆盖无历史 replay、实时字节、超大 replay、参数绕过、鉴权边界。 |
| `test/claude-bridge-sidecar.test.js` | 修改 | 覆盖 bridge sidecar attach 禁 replay 与实时输出。 |
| `test/claude-driver.test.js` | 修改 | 覆盖 resume 零开窗、并发恢复合并、窗口失败不杀 runtime、输入仲裁。 |
| `test/claude-transcript.test.js` | 修改 | 覆盖精确 UUID/cwd transcript、cursor、路径安全和错误路径。 |
| `test/claude-tui-reconnect.integration.test.js` | 修改 | 覆盖飞书恢复零窗口、先持久化再 prompt、持久化错误不写 PTY 且日志脱敏。 |
| `test/claude-tool-parity.integration.test.js` | 新增/修改 | 覆盖 claude/kscc 参数化、禁止 `--print`/`--background`/`--remote-control`、OpenCode 非影响边界。 |
| `specs/2026-08-12-claude-tui-feishu-remote-control/` | 新增/修改 | 规格、计划、traceability、测试报告、验证报告、收敛报告和 evidence。 |

## 审查重点

- [ ] `ClaudeDriver.resumeSession()` 是否真正只恢复 runtime，不会因飞书普通消息隐式打开窗口。
- [ ] `isSessionRefActive()` 对 PTY 与 bridge runtime 的判断是否避免把窗口状态误当 runtime 可写性。
- [ ] 标准 attach server 与 bridge sidecar attach 是否都无法通过 replay 参数或历史缓冲发送旧 ANSI/TUI 字节。
- [ ] dispatcher 的 agentRef 持久化失败路径是否保持“零 PTY 写入”和日志脱敏。
- [ ] 测试是否覆盖行为而非实现细节，尤其是并发恢复、错误路径和 OpenCode 回归边界。

## 风险与边界

- 本实现刻意不采用 Claude Remote Control、`--print`、`--background` 或第二个 Claude/kscc 进程；这些路径仍按 spec 排除。
- 新 attach 不提供历史屏幕恢复；只保证连接后的实时 PTY 字节，因此不会再重放旧 ANSI/TUI 历史。
- 当前工作树不是干净分支，存在本功能以外的并存改动；请优先审查上表核心文件和 spec 目录。
