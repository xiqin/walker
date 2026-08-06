# Claude TUI 重启续接验证报告

## 结论

verdict: PASS

实现已满足当前规格。Walker 重启后，如果旧 Claude TUI/control 面仍可用，飞书消息会进入同一 runtime；旧 runtime 不可用时才回退到新受控 `claude --resume` runtime。

- evidence-command: `node --test "test/claude-tui-reconnect.integration.test.js"`
- evidence-exit-code: 0
- evidence-file: `evidence/T6-node-test.log`
- evidence-sha256: `9d647c83a7bfdba5dccf7b4628d9fa213d46c8825f66e6a483304565ab4208d4`

## 验证项

| REQ | 验证结论 |
| --- | --- |
| `REQ-001` | 通过。T6 集成测试证明旧 runtime `rt_old_tui` 存活时 prompt 写入旧 runtime，且没有调用 `resumeRuntime` 或打开第二个 TUI。 |
| `REQ-002` | 通过。T6 集成测试证明 sidecar runtime 缺失时回退到 `rt_fallback_new`，持久化新 `agentRef` 后才 prompt。 |
| `REQ-003` | 通过。`ClaudeDriver.stopWalkerConnection()` 和 sidecar `stopWalkerConnection()` 保留 registry、reject pending、不 kill、不 detach；bootstrap stop 幂等。 |
| `REQ-004` | 通过。attach CLI close 后在恢复窗口内重新 resolve/connect，持续不可恢复时非零退出并释放 raw mode。 |
| `REQ-005` | 通过。状态字段可区分 `reconnected`、`fallback`、`walker-disconnected`，dispatcher 不凭旧 terminal active 误写 stale runtime。 |
| `REQ-006` | 通过。sidecar 仅接受 loopback 和 token；snapshot、agentRef、错误文本和日志断言不泄露 token/API key/Bearer。 |

## 风险与限制

- T6 使用可记录的 fake PTY/broker 隔离真实 Claude CLI，验证 Walker 内部控制面和消息路径，不启动真实 Claude 进程。
- 当前旧 `pty-attach` ref 在 driver 判定 sidecar runtime 可用时可直接 prompt 写入旧 runtime；显式 `bridge-sidecar` ref 更新和回退状态更新由 driver/dispatcher 单元测试覆盖。
- `runClaudeAttachCommand()` 的计时仍使用真实 `Date.now()`，当前测试用短恢复窗口验证，后续若需要完全虚拟 timer 可注入 `now()`。

## Evidence Receipt

| file | evidence-command | exit-code | sha256 |
| --- | --- | --- | --- |
| `evidence/T1-node-test.log` | `node --test "test/claude-bridge-sidecar.test.js"` | 0 | `dcd30538ea807f1f700bbb5e9956c8a0be86e2cc3474f6429422d3e069f1d093` |
| `evidence/T2-node-test.log` | `node --test "test/claude-driver.test.js" "test/claude-pty-broker.test.js"` | 0 | `da08038bba85032d077fe81552a0dbaef5ec70cfb77890745fc52d8a917f54a5` |
| `evidence/T3-node-test.log` | `node --test "test/message-dispatcher.test.js"` | 0 | `3072173f1eabe30e8066e2d8f7bc439e4dd98d528cddd15a101b5d32fb671de7` |
| `evidence/T4-node-test.log` | `node --test "test/claude-attach-command.test.js"` | 0 | `2ebc2e25655b0b03c95d8b4656bc54f0e02f1718642c511aed6ae4d3f2699f00` |
| `evidence/T5-node-test.log` | `node --test "test/bootstrap.test.js" "test/claude-driver.test.js"` | 0 | `72a4a359783404e5f5ef309b46d7e09f7120f57cc34a9f8079d7bb49ce93baaf` |
| `evidence/T6-node-test.log` | `node --test "test/claude-tui-reconnect.integration.test.js"` | 0 | `9d647c83a7bfdba5dccf7b4628d9fa213d46c8825f66e6a483304565ab4208d4` |
| `evidence/verification-lint.log` | `npm run lint` | 0 | `db6966e6df6d07f435b7d49e65cc4ce4a922524d2ca9639d14fd88ed3c4f410e` |
| `evidence/verification-check.log` | `npm run check` | 0 | `742969f77db70d47a5ae9e9d6e986e2a5b596b4520697e143e5df79eacc67df1` |

## 最终验证命令

- `node --test "test/claude-tui-reconnect.integration.test.js"`
- `node --test "test/claude-bridge-sidecar.test.js" "test/claude-driver.test.js" "test/claude-pty-broker.test.js" "test/message-dispatcher.test.js" "test/claude-attach-command.test.js" "test/cli-claude-attach.test.js" "test/bootstrap.test.js" "test/claude-tui-reconnect.integration.test.js"`
- `npm run lint`
- `npm run check`
- 占位符扫描：未命中未完成标记。
