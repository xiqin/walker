# Executing Test Evidence

Spec: `specs/2026-08-12-claude-tui-feishu-remote-control`

## 定向测试

| Task | Command | Result |
| --- | --- | --- |
| T1 | `node --test "test/claude-attach.test.js" "test/claude-attach-command.test.js" "test/cli-claude-attach.test.js"` | PASS, 18 tests, 18 pass, 0 fail, duration_ms 1249.9592 |
| T2 | `node --test "test/claude-driver.test.js" "test/claude-transcript.test.js" "test/claude-pty-broker.test.js"` | PASS, 78 tests, 78 pass, 0 fail, duration_ms 1024.3453 after dispatcher log redaction fix |
| T3 | `node --test "test/claude-tui-reconnect.integration.test.js"` | PASS, 7 tests, 7 pass, 0 fail, duration_ms 355.336 after redaction assertion |
| T4 | `node --test "test/claude-tool-parity.integration.test.js" "test/claude-attach-command.test.js" "test/cli-claude-attach.test.js" "test/opencode-driver.test.js" "test/opencode-tui-bridge.test.js"` | PASS, 179 tests, 179 pass, 0 fail, duration_ms 10108.1625; full captured output: `C:\Users\tianxiqin\.local\share\opencode\tool-output\tool_ff58d46f2001p15CkKh1kJd7fy` |
| Review precheck fix | `node --test "test/claude-bridge-sidecar.test.js"` | PASS, 6 tests, 6 pass, 0 fail, duration_ms 281.7159 after bridge sidecar attach replay fix |
| Attach regression after review precheck fix | `node --test "test/claude-attach.test.js" "test/claude-attach-command.test.js" "test/cli-claude-attach.test.js"` | PASS, 18 tests, 18 pass, 0 fail, duration_ms 671.0223 |

## 全量验证

Command: `npm test`

Result: PASS, 1511 tests, 1511 pass, 0 fail, 74 suites, duration_ms 76959.4862 after bridge sidecar attach replay fix.

Full captured output: `C:\Users\tianxiqin\.local\share\opencode\tool-output\tool_ff5a7074b001AyIMsKzsbCflnx`.

## 代码审查证据

- `src/drivers/claude-attach-server.js`：用户 attach 订阅固定为 `{ replay: false }`，连接前 replay 缓冲不会发给新 attach 客户端。
- `src/drivers/claude-bridge-sidecar.js`：bridge sidecar attach 订阅同样固定为 `{ replay: false }`，避免 ClaudeDriver 使用 bridge sidecar 作为 attach server 时重新发送历史 TUI 字节。
- `src/drivers/claude-driver.js`：`resumeSession()` 通过 `_resumePromises` 合并并发恢复；恢复路径不再调用 `_ensureTerminal()`；`isSessionRefActive()` 对 active PTY runtime 不依赖 attach 窗口状态。
- `src/dispatch/message-dispatcher.js`：飞书恢复路径在 `resumeSession()` 后先持久化 `agentRef`，持久化失败时返回错误卡片且不进入 prompt；日志中的错误原因通过 `sanitizeErrorReason()` 脱敏。
- OpenCode 生产模块未为本次 Claude 修复做行为性修改；OpenCode 定向测试通过。
