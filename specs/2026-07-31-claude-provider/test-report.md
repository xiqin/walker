# Claude Provider 执行测试报告

## 结论

verdict: PASS

Claude provider 功能完善的执行阶段测试通过。已实现真实 Claude Code CLI driver、bootstrap/catalog 注册、admin 配置、通用 session 创建与回归验证；增量 T5 已实现 Claude/kscc 与 OpenCode 等价的 Walker 层 TUI/window 会话链路。自动测试使用 fake CLI、fake terminal launcher 或注入依赖，不发送真实 Claude prompt。

## Evidence Receipt

- evidence-command: `npm test *> specs/2026-07-31-claude-provider/evidence/test.log`
- evidence-exit-code: 0
- evidence-file: `evidence/test.log`
- evidence-sha256: 9261EE22791BDD930F7AE37068EF5E77063E58B42AAED37A342AAD6BE090554B

## 资料基线

- 本机 `claude --version`: `2.1.196 (Claude Code)`。
- npm `@anthropic-ai/claude-code`: latest `2.1.220`，stable `2.1.212`，next `2.1.220`，bin `claude: bin/claude.exe`。
- `claude --help` 确认 Claude Code 默认交互 session，`-p/--print` 用于非交互输出。
- `claude --help` 确认 `--output-format text|json|stream-json`、`--input-format text|stream-json`、`--resume`、`--continue`、`--session-id <uuid>`、`--model`、`--fallback-model`、`--agent`、`--permission-mode default|acceptEdits|auto|bypassPermissions|dontAsk|plan`、`--allowed-tools`、`--disallowed-tools`、`--add-dir`、`--settings`、`--mcp-config`、`--bare`、`--safe-mode`、`--no-session-persistence`、`--bg/--background` 等参数存在。
- 官方文档抓取 `https://docs.anthropic.com/en/docs/claude-code/overview`、`/cli-reference`、`/sdk` 在本环境不可用，因此实现继续以本机 CLI help/version 和 npm 元数据作为可复核资料来源，不依赖未验证 HTTP API。

## 验证命令

- `node --test test/claude-driver.test.js`: passed, 9 tests.
- `npx eslint src/drivers/claude-driver.js test/claude-driver.test.js`: passed.
- `node --test test/bootstrap.test.js test/provider-catalog.test.js test/driver-registry.test.js test/providers-cli.test.js test/doctor-cli.test.js`: passed, 53 tests.
- `npx eslint src/app/bootstrap.js src/providers/provider-catalog.js src/providers/provider-health.js test/bootstrap.test.js test/provider-catalog.test.js test/driver-registry.test.js test/providers-cli.test.js test/doctor-cli.test.js`: passed.
- `node --test test/admin-observability-config.test.js test/admin-config-event.test.js test/admin-core-api.test.js test/config-env.test.js test/session-service.test.js`: passed, 163 tests.
- `npx eslint src/admin/config.js src/admin/config-editor.js src/admin/session-admin.js src/config/env.js test/admin-observability-config.test.js test/admin-config-event.test.js test/admin-core-api.test.js test/config-env.test.js test/session-service.test.js`: passed.
- `node --test test/claude-driver.test.js test/message-dispatcher.test.js test/provider-catalog.test.js test/admin-core-api.test.js`: PASS, all 277 tests in 23 suites passed. Evidence: `evidence/T5-req010-tests.log`, SHA256 `8A8924C372EFBC7AA12CED70EBED6AF3EE35606F77B94346DF16EE4CABC8232C`.
- `npm test`: PASS, all 1379 tests in 69 suites passed. Evidence: `evidence/test.log`, SHA256 `9261EE22791BDD930F7AE37068EF5E77063E58B42AAED37A342AAD6BE090554B`.
- `grep` 安全扫描 `claude\s+--print|--print.*stream-json|spawn\([^\n]*claude|execFile\([^\n]*claude` under `test/*.js`: only matched `test/claude-driver.test.js` fake CLI assertions.

## REQ 覆盖入口

- REQ-001: `test/bootstrap.test.js`、`test/provider-catalog.test.js`、`test/driver-registry.test.js` 验证 Claude provider 已注册为真实 driver，catalog/doctor 状态可见且 OpenCode 不回归。
- REQ-002: `test/claude-driver.test.js` 和 `test/driver-registry.test.js` 验证 CLI 探测、版本诊断、脱敏错误和 provider 状态。
- REQ-003: `test/claude-driver.test.js` 和 `test/admin-core-api.test.js` 验证 Claude sessionRef 创建、恢复、session-id 传递和按 agent 创建底层 session。
- REQ-004: `test/claude-driver.test.js` 验证 `stream-json` 事件映射、未知事件容错、非零退出 stderr 脱敏和状态事件。
- REQ-005: `test/claude-driver.test.js` 验证 model/fallback/agent/tools/permission argv 映射、shell:false，以及默认不传危险权限参数。
- REQ-006: `test/claude-driver.test.js` 验证 stop/cancel/delete 对 pending 子进程的幂等终止与清理。
- REQ-007: `test/admin-observability-config.test.js`、`test/admin-config-event.test.js`、`test/config-env.test.js`、`test/admin-core-api.test.js` 验证 Claude 配置可见、可编辑、校验、原子写入、运行时解析与错误诊断。
- REQ-008: `test/bootstrap.test.js`、`test/admin-core-api.test.js`、`test/config-env.test.js`、`test/driver-registry.test.js` 验证显式 `agent=claude` 路径和默认 OpenCode 兼容路径。
- REQ-009: 本报告记录资料新鲜度、全量回归、fake CLI 约束和测试证据入口。
- REQ-010: `test/claude-driver.test.js`、`test/message-dispatcher.test.js`、`test/provider-catalog.test.js`、`test/admin-core-api.test.js` 验证 Claude/kscc terminal/window 启动、同 session prompt 复用、watch 幂等、状态诊断、catalog/admin 可观测性、安全 argv/脱敏、OpenCode 不回归和异常状态不伪报成功。

## Evidence References

- `specs/2026-07-31-claude-provider/evidence/T1-claude-driver-tests.md`
- `specs/2026-07-31-claude-provider/evidence/T2-provider-bootstrap-tests.md`
- `specs/2026-07-31-claude-provider/evidence/T3-admin-config-session-tests.md`
- `specs/2026-07-31-claude-provider/evidence/T5-req010-tests.md`
- `specs/2026-07-31-claude-provider/evidence/T5-req010-tests.log`
- `specs/2026-07-31-claude-provider/evidence/test.log`
- `specs/2026-07-31-claude-provider/test-report.md`

## 真实 Claude 调用约束

自动化测试不执行真实 `claude --print` 或真实 terminal launcher。T1 使用 fake `execFile/spawn`，T2 使用注入的 registry/status，T3 使用 fake registry 与本地配置测试，T5 使用 fake terminal launcher 与 fake spawn 验证 argv/session/window 语义。全量测试安全扫描仅命中 fake CLI 断言文件。
