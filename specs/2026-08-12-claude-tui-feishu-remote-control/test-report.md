# Test Report

## Summary

- Spec: `specs/2026-08-12-claude-tui-feishu-remote-control`
- Stage: `executing`
- Verdict: PASS

## Evidence Receipt

- evidence-command: `npm test`
- evidence-exit-code: 0
- evidence-file: `evidence/executing-test-evidence.md`
- evidence-sha256: `A8A99F23C37A6E27E22296829DD8CA77A87668AA150068587D8FBC9A46161AFB`

## Result Summary

执行阶段 T1-T4 已完成，7 个 REQ、39 个 behavior 均有持久化测试引用与 evidence receipt。最新全量验证通过。

## Commands

| Scope | Command | Result |
| --- | --- | --- |
| T1 attach 无历史回放 | `node --test "test/claude-attach.test.js" "test/claude-attach-command.test.js" "test/cli-claude-attach.test.js"` | PASS, 18/18 |
| T2 driver/transcript 生命周期 | `node --test "test/claude-driver.test.js" "test/claude-transcript.test.js" "test/claude-pty-broker.test.js"` | PASS, 78/78 |
| T3 飞书恢复集成 | `node --test "test/claude-tui-reconnect.integration.test.js"` | PASS, 7/7 |
| T4 claude/kscc/OpenCode 回归 | `node --test "test/claude-tool-parity.integration.test.js" "test/claude-attach-command.test.js" "test/cli-claude-attach.test.js" "test/opencode-driver.test.js" "test/opencode-tui-bridge.test.js"` | PASS, 179/179 |
| Review precheck bridge sidecar attach | `node --test "test/claude-bridge-sidecar.test.js"` | PASS, 6/6 |
| Attach regression after review precheck fix | `node --test "test/claude-attach.test.js" "test/claude-attach-command.test.js" "test/cli-claude-attach.test.js"` | PASS, 18/18 |
| 全量 lint/check | `npm test` | PASS, 1511/1511, all passed |

Full latest `npm test` output: `C:\Users\tianxiqin\.local\share\opencode\tool-output\tool_ff5a7074b001AyIMsKzsbCflnx`.

Evidence receipt: `specs/2026-08-12-claude-tui-feishu-remote-control/evidence/executing-test-evidence.md`.

## Requirement Coverage

| Requirement | Coverage |
| --- | --- |
| REQ-001 单 runtime 所有权 | Covered by T2/T3 driver and dispatcher tests |
| REQ-002 恢复与窗口解耦 | Covered by T2/T3 zero-window resume tests |
| REQ-003 无历史 ANSI 回放 | Covered by T1 attach server/CLI tests, bridge sidecar attach tests, and T4 parity tests |
| REQ-004 飞书输入安全仲裁 | Covered by T2 prompt transaction, lease, queue, busy/permission and validation tests |
| REQ-005 精确 transcript 回复 | Covered by T2 driver/transcript cursor, UUID, cwd and error-path tests |
| REQ-006 生命周期与诊断 | Covered by T2 lifecycle diagnostics and T3 persistence error redaction tests |
| REQ-007 兼容与回归边界 | Covered by T4 claude/kscc parity, attach CLI and OpenCode regression tests |

## Notes

- 执行中发现 `MessageDispatcher._prepareClaudeAgentRef()` 的持久化错误日志会输出原始 `Error.message`，可能泄露 `TOKEN=secret` 形式的敏感值；已新增 `sanitizeErrorReason()` 并用 T3 集成测试覆盖。
- 本次没有引入 Remote Control、`--print`、`--background` 或第二个 Claude/kscc 进程方案。
- OpenCode 生产模块未因本次修复产生行为性修改，相关定向测试通过。
