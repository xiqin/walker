# 执行阶段测试报告

## 结论

verdict: PASS

执行阶段通过。T1-T6 均已完成并通过审查；`traceability.json` 已为 7 个 REQ、36 个 behavior 补齐真实测试引用和 evidence 引用。

## 任务状态

| Task | 结果 | 主要验证 |
| --- | --- | --- |
| T1 | PASS | Claude PTY broker/runtime 生命周期、恢复、退出、回放、队列与日志测试通过 |
| T2 | PASS | 本机 attach server、CLI、Windows attach terminal 与 runtime 兼容测试通过 |
| T3 | PASS | ClaudeDriver 长期 PTY prompt、输入仲裁、attach broker facade 测试通过 |
| T4 | PASS | 精确 UUID transcript path、边界读取、watcher、错误诊断与隔离测试通过 |
| T5 | PASS | Dispatcher pty-attach agentRef 持久化、旧引用迁移、stop/delete/watch 测试通过 |
| T6 | PASS | OpenCode 边界、Claude 定向、diff check 与全量 `npm test` 通过 |

## Evidence Receipt

- evidence-command: `npm test *> specs/2026-08-03+claude-native-external-tui/evidence/T6-npm-test.log`
- evidence-exit-code: 0
- evidence-file: `evidence/T6-npm-test.log`
- evidence-sha256: `6B3FC7F66D4CCC19A04C4A42D1A42F0D2EE3E88FCB40EAEE7FA68A9650A93B0E`

| Evidence | 命令/内容 | 结果 |
| --- | --- | --- |
| `specs/2026-08-03+claude-native-external-tui/evidence/T1-node-test.log` | `node --test test/claude-pty-broker.test.js` | 10 pass / 0 fail |
| `specs/2026-08-03+claude-native-external-tui/evidence/T2-node-test.log` | `node --test test/claude-attach.test.js test/cli-claude-attach.test.js test/runtime.test.js` | PASS |
| `specs/2026-08-03+claude-native-external-tui/evidence/T2-eslint.log` | `npx eslint src/drivers/claude-attach-server.js src/cli/claude-attach-command.js src/runtime/windows-runtime.js src/index.js test/claude-attach.test.js test/cli-claude-attach.test.js test/runtime.test.js` | PASS |
| `specs/2026-08-03+claude-native-external-tui/evidence/T3-node-test.log` | `node --test test/claude-driver.test.js` | 19 pass / 0 fail |
| `specs/2026-08-03+claude-native-external-tui/evidence/T3-eslint.log` | `npx eslint src/drivers/claude-driver.js test/claude-driver.test.js` | PASS |
| `specs/2026-08-03+claude-native-external-tui/evidence/T4-node-test.log` | `node --test test/claude-transcript.test.js` | 7 pass / 0 fail |
| `specs/2026-08-03+claude-native-external-tui/evidence/T4-eslint.log` | `npx eslint src/drivers/claude-transcript.js test/claude-transcript.test.js` | PASS |
| `specs/2026-08-03+claude-native-external-tui/evidence/T5-node-test.log` | `node --test test/message-dispatcher.test.js` | 185 pass / 0 fail |
| `specs/2026-08-03+claude-native-external-tui/evidence/T5-eslint.log` | `npx eslint src/dispatch/message-dispatcher.js test/message-dispatcher.test.js` | PASS |
| `specs/2026-08-03+claude-native-external-tui/evidence/T6-diff-name-only.log` | `git diff --name-only` OpenCode 专属路径检查 | PASS |
| `specs/2026-08-03+claude-native-external-tui/evidence/T6-opencode-tests.log` | `node --test test/opencode-driver.test.js test/opencode-tui-bridge.test.js test/opencode-http-client.test.js test/runtime.test.js` | 186 pass / 0 fail |
| `specs/2026-08-03+claude-native-external-tui/evidence/T6-claude-tests.log` | Claude PTY/attach/driver/transcript/dispatcher/runtime 定向测试 | 260 pass / 0 fail |
| `specs/2026-08-03+claude-native-external-tui/evidence/T6-diff-check.log` | `git diff --check` | PASS |
| `specs/2026-08-03+claude-native-external-tui/evidence/T6-npm-test.log` | `npm test` | 1418 pass / 0 fail |

## Requirement Coverage

| Requirement | 覆盖任务 | 状态 |
| --- | --- | --- |
| REQ-001 长期 Claude ConPTY 会话 | T1, T3 | covered |
| REQ-002 外部终端 attach | T2 | covered |
| REQ-003 飞书与本地输入仲裁 | T3 | covered |
| REQ-004 双向轮次观察与回复 | T4 | covered |
| REQ-005 停止、退出和恢复 | T1, T5 | covered |
| REQ-006 本地 attach 安全与诊断 | T1, T2 | covered |
| REQ-007 OpenCode 零变更 | T6 | covered |

## Traceability Closure

- `traceability.json` 已覆盖 7 个 REQ。
- `traceability.json` 已覆盖 36 个 behavior。
- 每个 behavior 均包含非空 `tasks`、`tests` 和 `evidence`。
- 每个 behavior 的 evidence 引用均指向 `specs/2026-08-03+claude-native-external-tui/evidence/` 下真实文件。
- 每个 JavaScript 测试引用均指向仓库中真实存在的测试文件。

## 修复记录

- T1 reviewer 要求将 `agentRef.transport` 改为 `pty-attach`，保证 `resumeRuntime` generation 递增，并隔离旧 generation 的迟到 `data/exit`；已修复并补测试。
- T3 reviewer 要求真实 attach 输入路径必须经过 Driver 输入仲裁；已通过 attach broker facade 修复并补测试。
- T4 reviewer 要求对齐真实 Claude project 目录编码、canonical workspace fail closed、细分 transcript 错误码；已修复并补测试。
- T6 首次全量测试暴露 `test/message-dispatcher-platform-event.test.js` 的 Claude fixture 使用非 UUID `claude_1`，与 T5 fail-closed 规格冲突；已改为合法 UUID，生产逻辑仍拒绝缺失或非法 UUID。

## 残余风险

- `node-pty` 安装期间 npm 报告 eslint 相关包 engine warning：当前 Node 为 22.11.0，部分 eslint 包声明 `^22.13.0`；现有测试与 lint 命令均已通过。
- npm audit 报告的高危项来自既有 `@larksuiteoapi/node-sdk -> axios` 链路，不是本次 `node-pty` 引入；未在本任务内处理。
- 工作树在执行前已有大量非本 feature 的改动和未跟踪文件；本任务未回退或修改不相关改动。
