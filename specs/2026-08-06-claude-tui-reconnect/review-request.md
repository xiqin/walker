# 代码审查请求

**功能：** Claude TUI 跨 Walker 重启续接  
**审查基准：** 当前工作区相对 `HEAD` 的未提交变更  
**规格目录：** `specs/2026-08-06-claude-tui-reconnect`

## Standards

- 无阻断发现。
- 已确认 `npm run lint` 通过，证据见 `evidence/verification-lint.log`。
- 已确认 `npm run check` 通过，1452 个测试全部通过，证据见 `evidence/verification-check.log`。
- 已确认规格产物未命中未完成标记。

## Spec

- 无阻断发现。
- `spec.md` 中 `REQ-001` 到 `REQ-006` 均已在 `test-report.md`、`verify-report.md` 和 `traceability.json` 中闭环。
- 全部 27 个 behavior 均有真实测试文件和 evidence 引用。

## 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none

## 变更统计

已修改的已跟踪文件统计：

```text
.loom/compliance/history.json      |  16 +++
src/app/bootstrap.js               |  24 +++-
src/cli/claude-attach-command.js   | 121 ++++++++++++----
src/dispatch/message-dispatcher.js |  34 ++++-
src/drivers/claude-driver.js       | 107 +++++++++++++-
src/drivers/claude-pty-broker.js   |  53 ++++++-
test/bootstrap.test.js             |  91 +++++++++++-
test/claude-driver.test.js         | 230 +++++++++++++++++++++++++++--
test/claude-pty-broker.test.js     |  67 +++++++++
test/message-dispatcher.test.js    | 286 ++++++++++++++++++++++++++++++++++---
10 files changed, 960 insertions(+), 69 deletions(-)
```

新增文件包括：

- `src/drivers/claude-bridge-sidecar.js`
- `test/claude-attach-command.test.js`
- `test/claude-bridge-sidecar.test.js`
- `test/claude-tui-reconnect.integration.test.js`
- `specs/2026-08-06-claude-tui-reconnect/` 下的规格、计划、任务、报告、handoff 和 evidence 产物

## 主要变更

1. 新增 `ClaudeBridgeSidecar` 本地控制面，提供 runtime registry、attach token、loopback/token 授权、输入输出转发、可续接状态快照和 Walker connection 断开语义。
2. `ClaudeDriver` 支持注入 `claudeBridge`，在旧 runtime 可续接时复用同一 runtime；不可用时才回退到新受控 runtime；新增 `stopWalkerConnection()`，Walker stop 不再 kill/detach runtime 或打开独立 `claude --resume` 终端。
3. `ClaudePtyBroker` 增加 bridge lookup/write 支持，同时保留用户主动 stop/delete 时 kill runtime 的原语义。
4. `MessageDispatcher` 调整 Claude `agentRef` 准备流程，stale runtime 必须先经 driver 判定或 resume；关键 `agentRef` 持久化成功后才 prompt，持久化失败会发错误卡并阻止 prompt。
5. `walker claude attach` CLI 增加断线重连状态机，支持重试窗口、raw mode 清理、token 必填和错误脱敏。
6. 修复 OpenCode TUI bridge watch 手工 DONE 事件回归：watch 手工输出跳过可选 runtime footer 补查，避免用户可见飞书回复被本地 DB 查询阻塞；prompt DONE 路径仍保留 runtime footer 补查。
7. 新增单元、集成、回归测试和结构化 evidence，覆盖 `REQ-001` 到 `REQ-006` 的 27 个 behavior。

## 重点关注

1. 架构设计：`ClaudeBridgeSidecar` 当前是本地控制面基础，需重点审查 runtime registry、attach WebSocket 和 driver/broker 集成边界是否足够清晰。
2. 生命周期语义：Walker stop/restart 必须与用户主动 stop/delete 区分；旧 runtime 可用时不得创建第二个 PTY/TUI。
3. 安全性：sidecar 必须只接受 loopback 和 token；snapshot、agentRef、日志、错误文本不得泄露 token、API key、Bearer 或 secret。
4. 原子性：dispatcher 在 resume/回退后必须先持久化新 `agentRef`，再执行 prompt；持久化失败不能写入 runtime。
5. 回归风险：OpenCode TUI bridge 的 watch 手工事件跳过 runtime lookup 只应影响手工 watch 输出，不应影响 prompt DONE 的 runtime footer 补齐。

## 自测情况

- [x] `node --test "test/claude-tui-reconnect.integration.test.js"` 通过，证据 `evidence/T6-node-test.log`。
- [x] Claude TUI 相关套件 279 个测试通过。
- [x] `node --test "test/message-dispatcher.test.js" "test/integration-feishu-tui-sync.test.js"` 通过，覆盖 OpenCode 回归修复。
- [x] `npm run lint` 通过，证据 `evidence/verification-lint.log`。
- [x] `npm run check` 通过，1452 个测试全部通过，证据 `evidence/verification-check.log`。
- [x] `loom_verify_artifacts` 通过。

## 变更详情

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/drivers/claude-bridge-sidecar.js` | 新增 | Claude 本地 bridge/sidecar 控制面基础。 |
| `src/drivers/claude-driver.js` | 修改 | 增加 bridge reconnect/回退决策、bridge prompt 写入、active 判定和 `stopWalkerConnection()`。 |
| `src/drivers/claude-pty-broker.js` | 修改 | 增加 bridge runtime lookup/write 支持，保留 stop/delete kill 语义。 |
| `src/dispatch/message-dispatcher.js` | 修改 | Claude `agentRef` 原子持久化；OpenCode watch 手工事件跳过可选 runtime lookup。 |
| `src/cli/claude-attach-command.js` | 修改 | attach CLI 断线重连、超时退出、raw mode 清理和错误脱敏。 |
| `src/app/bootstrap.js` | 修改 | Walker stop 改为释放 Claude Walker connection，不 detach/kill/runtime handoff。 |
| `test/claude-tui-reconnect.integration.test.js` | 新增 | 跨模块集成收口测试。 |
| `test/claude-bridge-sidecar.test.js` | 新增 | sidecar 单元测试。 |
| `test/claude-attach-command.test.js` | 新增 | attach CLI 重连与安全测试。 |
| `test/*` 相关既有测试 | 修改 | 覆盖 driver、broker、dispatcher、bootstrap、OpenCode 回归路径。 |
| `specs/2026-08-06-claude-tui-reconnect/*` | 新增 | spec、requirements、plan、tasks、traceability、reports、handoffs、evidence。 |

## 审查重点

- [ ] sidecar 控制面与 Walker 主进程生命周期边界是否合理。
- [ ] bridge runtime 可续接判定、回退判定和错误状态是否覆盖边界。
- [ ] stop/delete 与 stopWalkerConnection 语义是否完全分离。
- [ ] dispatcher 的持久化后 prompt 顺序是否可靠。
- [ ] attach CLI 重连路径是否会重复调度、泄露 token 或遗漏 raw mode 恢复。
- [ ] OpenCode watch 手工事件回归修复是否只影响目标路径。

## 剩余风险

- T6 集成测试使用 fake PTY/broker，不启动真实 Claude 进程；真实 Claude CLI 交互仍建议人工冒烟验证。
- attach CLI 计时仍使用真实 `Date.now()`；如果后续需要完全虚拟 timer，可继续注入 `now()`。
