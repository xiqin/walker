# 测试报告：移除 Claude 集成

verdict: PASS

evidence-command: npm run check
evidence-exit-code: 0
evidence-file: evidence/T7-check.log
evidence-sha256: a1933cfff2a6a6b23d496b3c896d2881ab7b23e3ad846ecaedd0b21c57a57ba2
evidence-git-tree: 3730cc772385518a107c20979e93881bb87462c9
evidence-diff-sha256: 9180a33be55806e52a9e572932e0a73e67e3d66a0c40da29995bda8c0ecbd249
known: 首次全量检查有 3 项未通过，复测前已修复。下文 fail 0 表示失败数为零。

## 结论

`npm run lint`、`node --test test/claude-removal-guard.test.js` 和 `npm run check` 的退出码都是 0。

首次 `npm run check` 失败 3 项。失败测试仍期望旧 Claude 会话被 watch、按 cwd 自动绑定，或被 `handlePlatformMessage` prompt。这些断言已改成 driver 调用前返回 `claude_removed` 或不绑定，并纳入 T4 owns。复测后全量检查通过。

本次没有提交，也没有修改 `H:\walker` 主工作区。

## 命令与退出码

| 命令 | 退出码 | 结果 | 证据 |
| --- | ---: | --- | --- |
| `npm run lint` | 0 | eslint 无诊断输出 | `evidence/T7-lint.log` |
| `node --test test/claude-removal-guard.test.js` | 0 | tests 7，pass 7，fail 0 | `evidence/T7-guard.log` |
| `npm run check` | 0 | tests 1490，suites 69，pass 1490，fail 0，duration_ms 86657.1931 | `evidence/T7-check.log` |

定向收口记录：`evidence/T1-T5-closure.log` 为 165 pass、0 fail。修复飞书回归后，`test/integration-feishu-tui-sync.test.js` 与 `test/message-dispatcher-platform-event.test.js` 一起运行是 40 pass、0 fail；这两项也包含在上面的全量 `npm run check` 中。

## 需求覆盖

| Requirement | 结果 | 证据 |
| --- | --- | --- |
| REQ-001 | PASS | 启动与关闭不再加载 Claude 模块，见 `evidence/T7-check.log` |
| REQ-002 | PASS | CLI 与 provider 目录不再提供 Claude，见 `evidence/T7-check.log` |
| REQ-003 | PASS | 残留 `CLAUDE_*` 被忽略，默认 agent 为 claude 时拒绝启动，见 `evidence/T7-check.log` |
| REQ-004 | PASS | 飞书命令和入站消息不再接入 Claude，见 `evidence/T7-check.log` |
| REQ-005 | PASS | 旧 `agent=claude` 记录只做本地保留、停止和删除，见 `evidence/T7-check.log` |
| REQ-006 | PASS | OpenCode、Codex 和历史规格保持，见 `evidence/T7-guard.log` |
| REQ-007 | PASS | 现行文档和连接页不再把 Claude 列为可用接入，见 `evidence/T7-guard.log` |
| REQ-008 | PASS | lint 与 check 退出码为 0，源码和测试不再引用已删除模块，见 `evidence/T7-check.log` |

## REQ-008-B01

报告记录的定向与全量命令均已执行。lint、守卫测试和 check 的退出码都是 0。守卫测试本身只做静态检查，不调用 `npm`。

## 已删除的专用测试

下列文件已不存在。删除它们只表示运行时测试不再覆盖 Claude 接入，不表示历史规格被改写成当前仍可用：

- `test/claude-attach-command.test.js`
- `test/claude-attach-list.test.js`
- `test/claude-attach.test.js`
- `test/claude-bridge-sidecar.test.js`
- `test/claude-driver.test.js`
- `test/claude-pty-broker.test.js`
- `test/claude-tool-parity.integration.test.js`
- `test/claude-transcript.test.js`
- `test/claude-tui-reconnect.integration.test.js`
- `test/cli-claude-attach.test.js`

## REQ-008-B03：保留的历史

以下历史材料仍在，且本次没有把其中的旧 Claude 描述改写成运行时仍可用：

- `specs/2026-07-31-claude-provider`
- `specs/2026-08-21-claude-tui-feishu-shared-session`
- `.loom/compliance/history.json`
- `.loom/memory/MEMORY.md`
- `CHANGELOG.md` 的 0.1.0 段落仍保留历史句“预留扩展点，Claude Code CLI”

Unreleased 记录的是本次移除，现行 provider 示例为 `opencode`、`codex`、`shell`。

## 保护路径

- `src/drivers/opencode-driver.js` 相对当前 `HEAD` 无 diff。
- 当前 `HEAD` 仍是基线 `1ac4dc2966d26812bc67ad958f8b8f0e8e053c05`，因此相对该基线也无 diff。
- 该驱动不含 `ClaudeDriver`、`claude_removed` 和已删除 Claude 模块名。
- OpenCode 模型名 `claude-sonnet-4` 不是 Claude Code 接入，未删除。
- `src` 与 `test` 不再引用已删除 Claude 模块。
- 测试源码不 spawn 或 execFile 真实 `claude`，也不读取用户主目录 `.claude`。
