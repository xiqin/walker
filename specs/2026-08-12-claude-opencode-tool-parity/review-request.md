# 代码审查请求

**功能：** Claude 工具接入向 OpenCode 对齐
**分支/工作区：** `main`，当前工作区相对 `HEAD` 的未提交 diff
**Spec：** `specs/2026-08-12-claude-opencode-tool-parity/spec.md`
**验证结论：** PASS，`verify-report.md` 已记录 SHA-256 evidence receipt

## Standards

- 无阻断发现。当前实现遵守既定 Claude 长期 TUI/sidecar 单进程架构，没有引入 headless stream-json worker 或第二套 Claude 会话模型。
- 无阻断发现。启动参数以数组形式传入 PTY broker，`CLAUDE_CONFIG_DIR` 与 `--settings` 语义已拆分，危险权限模式采用 closed-by-default 处理。
- 无阻断发现。配置层、provider catalog、driver、transcript parser 与测试证据已按任务边界补齐；`npm test` 与 `git diff --check` 均通过。
- 注意：当前工作区在用户批准下保持 dirty，diff 中包含本次 Claude parity 改动，也包含早前已存在的飞书/dispatcher 与 Claude 历史列表相关未提交改动；审查时请按文件来源区分，不要把 dirty 工作区整体视为单一原子提交。

## Spec

- 无阻断发现。`REQ-001` 至 `REQ-008` 均已在 `traceability.json` 映射到真实测试和 evidence，`convergence-report.json` 显示 45/45 behavior 全部 covered。
- 无阻断发现。Claude permission/question reply 明确保持 unsupported/degraded，不伪造 OpenCode 协议；OpenCode permission reply 回归仍通过。
- 无阻断发现。验证阶段仅修正规格产物 hygiene：将能力矩阵中的旧任务事件名改为 `task_list`，并把 traceability evidence 路径规范化为 specDir 相对路径；未改变需求、实现范围或生产代码。

## 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none
- Residual risks: dirty `main` 工作区需要审查者按来源辨别相关与既有改动；真实 Claude Code question/hook JSONL 形状未来仍可能变化，当前实现只映射稳定字段并脱敏。

## 变更统计

```text
.env.example                            |  14 +-
.loom/compliance/history.json           |  58 ++++
src/admin/config-editor.js              |  35 ++-
src/admin/config.js                     |  26 +-
src/app/bootstrap.js                    |  14 +-
src/config/env.js                       |  50 +++-
src/dispatch/message-dispatcher.js      | 118 ++++++++-
src/drivers/agent-driver.js             |  12 +-
src/drivers/claude-driver.js            | 202 ++++++++++++--
src/drivers/claude-pty-broker.js        |  23 +-
src/drivers/claude-transcript.js        | 452 ++++++++++++++++++++++++++++++--
src/platform/feishu/cards.js            |  35 +--
src/platform/feishu/commands.js         |   2 +-
src/providers/provider-catalog.js       |  48 +++-
test/admin-observability-config.test.js |  62 ++++-
test/bootstrap.test.js                  |  22 +-
test/claude-driver.test.js              | 177 +++++++++++++
test/claude-pty-broker.test.js          |  37 +++
test/claude-transcript.test.js          | 287 +++++++++++++++++++-
test/config-env.test.js                 |  68 ++++-
test/feishu-cards.test.js               |  42 +++
test/message-dispatcher.test.js         |   8 +-
test/provider-catalog.test.js           |  39 ++-
23 files changed, 1718 insertions(+), 113 deletions(-)
```

另有新增目录和测试文件：`specs/2026-08-12-claude-opencode-tool-parity/`、`test/claude-attach-list.test.js`、`test/claude-tool-parity.integration.test.js`。

## 主要变更

1. Claude driver/PTY 启动路径统一 create/resume launch args，支持 model、fallback model、agent、tools、allowed/disallowed tools、agents JSON、MCP configs、strict MCP、settings file、setting sources、plugin dirs、bare、safe mode 与 slash command 开关。
2. 修复权限配置语义：旧 `default` 迁移为空并省略 `--permission-mode`，非法模式启动前拒绝，`bypassPermissions` 需要显式危险确认且不能与 `safeMode` 同时启用。
3. 拆分 `CLAUDE_CONFIG_DIR` 与 `--settings`：前者仅用于 transcript 根，后者只来自 `CLAUDE_SETTINGS_FILE`/`settingsFile`。
4. 扩展 `AgentEvent` 的 `tool_use` schema，增加可选 `callID`、`phase`、`result`、`isError`、`orphan`，保持 OpenCode 旧字段兼容。
5. 增强 Claude transcript parser/watcher，按顺序输出 text、reasoning、tool_use start/result、question/hook 稳定字段与有界脱敏诊断，并保留历史会话扫描实现。
6. 配置/admin/provider catalog 增加 Claude 新配置项与 `capabilityStatus`，区分 supported、degraded、unsupported，Claude permission/question reply 不再误报 supported。
7. 新增跨链路集成测试，覆盖完整配置、多轮 prompt、sidecar reuse、历史列表、lease/stop 语义、Claude reply 降级和 OpenCode permission reply 回归。

## 自测情况

- [x] `node --test test/claude-driver.test.js test/claude-pty-broker.test.js`，PASS，52 tests，evidence `evidence/T1-node-test-claude-driver-pty-broker.log`
- [x] `node --test test/claude-tui-reconnect.integration.test.js`，PASS，5 tests，evidence `evidence/T1-node-test-claude-tui-reconnect.log`
- [x] `node --test test/claude-transcript.test.js test/opencode-driver.test.js`，PASS，111 tests，evidence `evidence/T2-node-test-claude-transcript-opencode-driver.log`
- [x] `node --test test/config-env.test.js test/bootstrap.test.js test/admin-observability-config.test.js test/provider-catalog.test.js`，PASS，91 tests，evidence `evidence/T3-node-test.log`
- [x] `node --test test/claude-tool-parity.integration.test.js test/claude-driver.test.js test/claude-pty-broker.test.js test/claude-transcript.test.js test/opencode-driver.test.js test/provider-catalog.test.js`，PASS，evidence `evidence/T4-node-test-claude-tool-parity-regression.log`
- [x] `npm test > specs\2026-08-12-claude-opencode-tool-parity\evidence\verification-npm-test.log 2>&1`，exit 0，sha256 `87DB49038B3EFDFA44FAE5C0063DA6EBB62DD1EE0F43956FF6770BD8A029701F`
- [x] `git diff --check > specs\2026-08-12-claude-opencode-tool-parity\evidence\verification-git-diff-check.log 2>&1`，exit 0，sha256 `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855`
- [x] `loom_verify_artifacts`，ok:true
- [x] `loom_converge`，45/45 covered，0 blockers
- [x] `loom_omission_hunt`，0 blockers

## 变更详情

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/drivers/claude-driver.js` | 修改 | 统一 launch args、权限迁移、配置校验、unsupported reply API、transcript event 映射 |
| `src/drivers/claude-pty-broker.js` | 修改 | create/resume 使用调用方完整 launch args，resume spawn error 时保留旧 runtime |
| `src/drivers/claude-transcript.js` | 修改 | 多 block 解析、tool result 关联、orphan 标记、有界诊断、历史会话列表兼容 |
| `src/drivers/agent-driver.js` | 修改 | 扩展 `tool_use` schema 的可选生命周期字段 |
| `src/config/env.js` | 修改 | 新增 Claude env 配置解析、严格布尔校验、旧 permission default 迁移 |
| `src/app/bootstrap.js` | 修改 | 传递新增 Claude options，并使用 `transcriptConfigDir` 分离 transcript 根 |
| `src/admin/config.js` | 修改 | 管理面新增 Claude 配置定义、枚举和说明 |
| `src/admin/config-editor.js` | 修改 | 配置编辑校验同步新枚举、JSON/list/boolean 约束与原子更新 |
| `src/providers/provider-catalog.js` | 修改 | 增加 Claude/OpenCode `capabilityStatus`，修正 Claude permission/question reply 状态 |
| `.env.example` | 修改 | 补齐 Claude 新环境变量与安全说明 |
| `test/claude-tool-parity.integration.test.js` | 新增 | 跨链路契约回归测试 |
| `test/claude-driver.test.js` | 修改 | 启动参数、权限迁移、unsupported reply、watchSession 事件测试 |
| `test/claude-pty-broker.test.js` | 修改 | launchArgs 与 resume 原子性测试 |
| `test/claude-transcript.test.js` | 修改 | transcript 结构化事件与历史列表测试 |
| `test/config-env.test.js` | 修改 | env 解析与安全迁移测试 |
| `test/bootstrap.test.js` | 修改 | bootstrap options 传递测试 |
| `test/admin-observability-config.test.js` | 修改 | admin schema 与原子更新测试 |
| `test/provider-catalog.test.js` | 修改 | capabilityStatus 测试 |
| `specs/2026-08-12-claude-opencode-tool-parity/` | 新增/修改 | spec、plan、tasks、traceability、test/verify/convergence 报告、evidence 与 handoffs |

## 审查重点

- [ ] `src/drivers/claude-driver.js` 的 launch args 构造是否完整覆盖 Claude CLI 2.1.228 支持项，且长期 TUI 路径不混入 print/stream-json 参数。
- [ ] `src/drivers/claude-pty-broker.js` 的 resume 替换顺序是否确实在新 spawn 成功前保留旧 runtime。
- [ ] `src/drivers/claude-transcript.js` 的 tool_use/tool_result 关联、orphan 标记和未知 block 诊断是否足够稳健且不泄露敏感 payload。
- [ ] 配置层和 admin editor 对 JSON/list/boolean/enum 的拒绝路径是否足够可诊断，且不把原始 secret 写入错误或日志。
- [ ] provider catalog 的 `capabilityStatus` 是否对 Claude/OpenCode 能力差异表达准确，避免误导上层 UI 或用户。
- [ ] dirty `main` 中飞书/dispatcher 与历史会话列表相关改动是否应作为本次审查范围的一部分，或拆分为独立后续审查。

## 已知非阻断风险

- `mapClaudeLineEvents` 的 legacy print-stream 映射仍保持旧字段形状；本次主路径是长期 TUI transcript watcher，已按 spec 覆盖。
- Claude Code 后续版本可能调整 question/hook JSONL 形状；当前实现只映射稳定字段并脱敏，必要时需补 fixture。
- 真实 Claude TUI 未在验证中启动；T4 使用可控 fake PTY/bridge/transcript/HTTP client 验证 Walker 侧契约。
