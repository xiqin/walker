# Claude TUI 重启续接测试报告

## 结论

verdict: PASS

T1 到 T6 的单元、集成和回归测试覆盖 `REQ-001` 到 `REQ-006` 及 27 个 behavior。

- evidence-command: `node --test "test/claude-tui-reconnect.integration.test.js"`
- evidence-exit-code: 0
- evidence-file: `evidence/T6-node-test.log`
- evidence-sha256: `9d647c83a7bfdba5dccf7b4628d9fa213d46c8825f66e6a483304565ab4208d4`

## Evidence Receipt

| file | evidence-command | exit-code | sha256 |
| --- | --- | --- | --- |
| `evidence/T1-node-test.log` | `node --test "test/claude-bridge-sidecar.test.js"` | 0 | `dcd30538ea807f1f700bbb5e9956c8a0be86e2cc3474f6429422d3e069f1d093` |
| `evidence/T2-node-test.log` | `node --test "test/claude-driver.test.js" "test/claude-pty-broker.test.js"` | 0 | `da08038bba85032d077fe81552a0dbaef5ec70cfb77890745fc52d8a917f54a5` |
| `evidence/T3-node-test.log` | `node --test "test/message-dispatcher.test.js"` | 0 | `3072173f1eabe30e8066e2d8f7bc439e4dd98d528cddd15a101b5d32fb671de7` |
| `evidence/T4-node-test.log` | `node --test "test/claude-attach-command.test.js"` | 0 | `2ebc2e25655b0b03c95d8b4656bc54f0e02f1718642c511aed6ae4d3f2699f00` |
| `evidence/T5-node-test.log` | `node --test "test/bootstrap.test.js" "test/claude-driver.test.js"` | 0 | `72a4a359783404e5f5ef309b46d7e09f7120f57cc34a9f8079d7bb49ce93baaf` |
| `evidence/T6-node-test.log` | `node --test "test/claude-tui-reconnect.integration.test.js"` | 0 | `9d647c83a7bfdba5dccf7b4628d9fa213d46c8825f66e6a483304565ab4208d4` |

## Requirement Coverage

| REQ | 覆盖测试 | 关键证据 |
| --- | --- | --- |
| `REQ-001` 旧 Claude TUI 存活时跨 Walker 重启续接同一 runtime | `test/claude-bridge-sidecar.test.js`, `test/claude-driver.test.js`, `test/message-dispatcher.test.js`, `test/bootstrap.test.js`, `test/claude-tui-reconnect.integration.test.js` | T6 验证飞书 prompt 写入 `rt_old_tui`，不调用 `resumeRuntime`，不打开新 attach 终端 |
| `REQ-002` 旧 runtime 不可用时回退到新受控 runtime | `test/claude-driver.test.js`, `test/claude-pty-broker.test.js`, `test/message-dispatcher.test.js`, `test/claude-tui-reconnect.integration.test.js` | T6 验证 missing sidecar runtime 时创建新 runtime，持久化新 `agentRef` 后再 prompt |
| `REQ-003` Walker stop 不破坏可续接 Claude runtime | `test/claude-bridge-sidecar.test.js`, `test/bootstrap.test.js`, `test/claude-driver.test.js`, `test/claude-tui-reconnect.integration.test.js` | T6 验证 pending 输入被 reject，sidecar runtime 变为 `walker-disconnected`/`reconnectable`，不 stop/delete/detach |
| `REQ-004` attach CLI 支持断线恢复连接语义 | `test/claude-attach-command.test.js`, `test/cli-claude-attach.test.js`, `test/claude-tui-reconnect.integration.test.js` | T6 验证 close 后重新 resolve/connect，窗口内恢复；持续不可恢复时非零退出并恢复 raw mode |
| `REQ-005` 运行状态与错误可观测 | `test/claude-bridge-sidecar.test.js`, `test/claude-driver.test.js`, `test/message-dispatcher.test.js`, `test/claude-tui-reconnect.integration.test.js` | T6 验证 reconnected/回退状态、previousRuntimeId、runtimeReason 和调用顺序 |
| `REQ-006` 安全边界保持本地、token 不泄露 | `test/claude-bridge-sidecar.test.js`, `test/claude-attach-command.test.js`, `test/claude-tui-reconnect.integration.test.js` | T6 验证 loopback/token 拒绝、错误脱敏、snapshot/log 不包含 secret |

## Behavior Coverage

`traceability.json` 已为全部 27 个 behavior 写入真实测试文件和 evidence 引用。T6 集成测试作为跨模块收口证据追加到所有 behavior。

## 执行摘要

- `test/claude-tui-reconnect.integration.test.js` 包含 4 个集成场景：旧 TUI runtime 续接、sidecar 不可用回退、Walker stop pending 处理、attach CLI 重连与安全边界。
- 单元测试覆盖 sidecar、driver/broker、dispatcher、attach CLI、bootstrap 生命周期。
- 执行阶段已运行 `npm run lint` 与 `npm run check`，并确认 `traceability.json`、`test-report.md`、`verify-report.md` 的 evidence 引用均指向真实文件。
