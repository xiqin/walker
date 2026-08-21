# Test Report: Claude TUI 与飞书共享会话

## 结论

执行阶段测试通过。T1-T6 的定向测试、跨模块综合测试与全量 `npm test` 均已通过；`traceability.json` 中 `REQ-001` 到 `REQ-010` 及全部 50 个 behavior 均已有真实测试文件与 evidence 引用。

## Evidence Receipt

| Evidence | 命令 | 结果 |
| --- | --- | --- |
| `evidence/T1-test.log` | `node --test "test/claude-pty-broker.test.js" "test/claude-bridge-sidecar.test.js" "test/claude-tui-reconnect.integration.test.js"` | 33 pass / 0 fail |
| `evidence/T2-test.log` | `node --test "test/claude-driver.test.js" "test/claude-tool-parity.integration.test.js" "test/provider-catalog.test.js"` | 67 pass / 0 fail |
| `evidence/T3-test.log` | `node --test "test/claude-transcript.test.js"` | 33 pass / 0 fail |
| `evidence/T4-test.log` | `node --test "test/question-handler.test.js" "test/integration-feishu-tui-sync.test.js"` | 70 pass / 0 fail |
| `evidence/T5-test.log` | `node --test "test/message-dispatcher.test.js" "test/progress-card.test.js" "test/integration-feishu-tui-sync.test.js"` | 291 pass / 0 fail |
| `evidence/T6-test.log` | `node --test "test/claude-driver.test.js" "test/claude-transcript.test.js" "test/question-handler.test.js" "test/integration-feishu-tui-sync.test.js" "test/message-dispatcher.test.js" "test/progress-card.test.js" "test/claude-pty-broker.test.js" "test/claude-bridge-sidecar.test.js" "test/provider-catalog.test.js" "test/claude-tool-parity.integration.test.js"` | 452 pass / 0 fail |
| `evidence/T6-npm-test.log` | `npm test` | 1585 pass / 0 fail |

## Requirement Coverage

| Requirement | 覆盖摘要 | Evidence |
| --- | --- | --- |
| `REQ-001` | Walker 托管 Claude runtime、状态、日志、原子 agentRef 与 no-resume reply 保护均有 driver/broker 测试覆盖。 | `T1-test.log`, `T2-test.log`, `T6-test.log` |
| `REQ-002` | 本地 attach/replay、detach/re-attach、边界与异常输入均有 broker/bridge 测试覆盖。 | `T1-test.log`, `T6-test.log` |
| `REQ-003` | 飞书 route 到 managed Claude、external-readonly 降级、只读禁止写入与可观测日志均有 integration/question 测试覆盖。 | `T4-test.log`, `T6-test.log` |
| `REQ-004` | `AskUserQuestion` hook、transcript fallback、2 秒内事件路径、脱敏与日志源区分均有 transcript 测试覆盖。 | `T3-test.log`, `T6-test.log` |
| `REQ-005` | 飞书答案写入同一 runtime、无效答案拒绝、awaiting 状态、write failure 分类、no-resume 与原子键序列均有 driver/question 测试覆盖。 | `T2-test.log`, `T4-test.log`, `T6-test.log` |
| `REQ-006` | matching `tool_result` ACK、状态流转、幂等、超时与日志均有 transcript/question 测试覆盖。 | `T3-test.log`, `T4-test.log`, `T6-test.log` |
| `REQ-007` | 输入仲裁、短租约、原子键序列、本地先答、迟到答案与过期 lease 均有 driver/question 测试覆盖。 | `T2-test.log`, `T4-test.log`, `T6-test.log` |
| `REQ-008` | OpenCode 入站、watch、question reply、bridge register 与 upstream_error 空消息回归均有 message/progress/integration 测试覆盖。 | `T5-test.log`, `T6-test.log` |
| `REQ-009` | runtime/question/answer/ACK/降级日志、敏感信息脱敏与外部失败分类均有 question/integration 测试覆盖。 | `T4-test.log`, `T6-test.log` |
| `REQ-010` | external transcript 观察、external-readonly 状态、只读提示、禁止接管外部进程与迁移提示均有 transcript/integration/question 测试覆盖。 | `T3-test.log`, `T4-test.log`, `T6-test.log` |

## 修复中发现的问题

全量 `npm test` 首次执行暴露两个 lint 问题和两个旧 `/attach claude` 测试契约问题：

- `src/dispatch/question-handler.js` 中一处缩进不符合 ESLint，已修复为格式-only 改动。
- `test/claude-bridge-sidecar.test.js` 存在未使用 helper `assertNoMessage`，已删除。
- `test/claude-attach-list.test.js` 仍期待 external Claude `/attach` 调用 `resumeSession`，与已批准的 external-readonly 契约冲突；已改为断言不调用 `resumeSession`，并保存只读 `agentRef`。

上述修复后，相关回归与全量 `npm test` 均通过。

## 未运行项

未运行外部真实飞书或真实 Claude CLI 端到端手工测试；本报告只覆盖本地自动化测试与模拟 driver/平台行为。
