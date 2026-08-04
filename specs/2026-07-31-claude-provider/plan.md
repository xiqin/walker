# Claude Provider 实现计划

## 摘要

本计划将 `claude` provider 从 stub 升级为真实 `AgentDriver`。首版采用 Claude Code CLI 的 `--print --output-format stream-json` 能力，不依赖未验证 HTTP API，不复用 OpenCode TUI bridge/sqlite 会话库，也不默认启用危险权限跳过参数。

实现顺序原按依赖拆为四个任务：核心 driver、provider/bootstrap 诊断接入、admin/config/session 集成、验证报告与回归证据。增量范围追加第五个任务：Claude/kscc 与 OpenCode 等价 TUI 会话链路。除测试报告任务外，前置任务都包含对应单元测试，执行阶段必须用 fake CLI runtime/spawn/terminal launcher，避免真实 Claude prompt 费用。

## 任务概览

## Task Overview

本节是规划校验器识别的任务概览入口，内容与上方“任务概览”保持一致。

| Task | 名称 | 复杂度 | 依赖 | 主要 owns | 覆盖 REQ |
|---|---|---|---|---|---|
| T1 | Claude CLI Driver 核心实现 | high | 无 | `src/drivers/claude-driver.js`, `test/claude-driver.test.js` | REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-009 |
| T2 | Provider Catalog 与 Bootstrap 注册 | medium | T1 | `src/app/bootstrap.js`, `src/providers/provider-catalog.js`, `src/providers/provider-health.js`, provider/bootstrap 测试 | REQ-001, REQ-002, REQ-008 |
| T3 | Admin Config 与 Session Agent 泛化 | medium | T1,T2 | `src/admin/config.js`, `src/admin/config-editor.js`, `src/admin/session-admin.js`, admin/session 测试 | REQ-001, REQ-007, REQ-008 |
| T4 | 资料基线、回归验证与执行报告 | medium | T1,T2,T3 | `specs/2026-07-31-claude-provider/test-report.md` | REQ-001, REQ-008, REQ-009 |
| T5 | Claude/kscc TUI 会话等价链路 | high | T1,T2,T3 | `src/dispatch/message-dispatcher.js`, `test/message-dispatcher.test.js`, Claude/provider/admin 增量回归 | REQ-010 |

## Task Files

- `tasks/T1.md`
- `tasks/T2.md`
- `tasks/T3.md`
- `tasks/T4.md`
- `tasks/T5.md`

## 架构约束

1. `ClaudeDriver` 必须继承 `AgentDriver`，所有新增函数带中文 JSDoc，错误信息可诊断且不泄漏密钥。
2. CLI 调用必须使用 `spawn`/`execFile` 的 argv 数组，不启用 shell，不做字符串拼接执行。
3. provider catalog 可以声明 Claude 具备 Walker 层 sessions/models/permissions/TUI window 能力，但不得声明 Claude 具备 OpenCode HTTP 或 OpenCode TUI bridge 能力。
4. `session-admin` 创建底层 agent session 时应按 `session.agent` 查 registry，而不是仅硬编码 `opencode`。
5. 默认 agent 保持 `opencode`；只有显式配置 `WALKER_DEFAULT_AGENT=claude` 时才走 Claude 默认路径。
6. 自动测试不得发送真实 Claude prompt；测试只允许 fake `execFile`/`spawn`/terminal launcher 或只记录本机 `--version`/`--help` 调研基线。

## 串行与并行边界

## Task Dependencies

T1 无前置依赖；T2 依赖 T1；T3 依赖 T1 与 T2；T4 依赖 T1、T2 与 T3；T5 依赖 T1、T2 与 T3，并在原后台 CLI provider 已可用后追加窗口/TUI 等价链路。全部任务按串行顺序执行，避免前序产物和后序集成测试之间出现 ownership 冲突。

T1 是所有后续任务的接口基础，必须先完成。T2 与 T3 都依赖 T1，且 T3 依赖 T2 的 provider/config key 形态，因此规划为串行执行。T4 只在 T1-T3 完成后生成报告和运行整体验证。T5 是用户飞书实测后的增量任务，必须保留原后台 `--print` 行为作为可诊断回退，同时新增 `/new claude` 后的可见终端窗口、同一 Claude/kscc 会话复用、watch/refresh 诊断和 OpenCode 链路不回归验证。为避免与已完成 T1-T3 的 ownership 冲突，T5 owns 增量调度入口与新增/扩展测试，必要的 driver/catalog/admin 调整作为受依赖接口的读取与增量修改点，在执行 handoff 中记录真实改动。

## 验证策略

1. T1 运行 `node --test test/claude-driver.test.js` 或项目现有测试入口覆盖 driver 行为。
2. T2 运行 provider/bootstrap 相关测试，确认 `claude` 非 stub 且 `opencode` 不回归。
3. T3 运行 admin/config/session 相关测试，确认 `CLAUDE_*` allowlist 与泛化创建逻辑正确。
4. T4 运行 `npm test`，并将命令、结果、Claude Code 资料基线写入 `test-report.md`。
5. T5 运行 Claude driver、message dispatcher、provider catalog、admin/session 相关测试，覆盖 fake terminal launcher、同 session prompt 复用、窗口失败降级、状态输出和 OpenCode watch/TUI 回归。

## Traceability

完整 REQ/behavior 到 task 的映射见 `traceability.json`。planning 阶段仅填充 task 映射，tests/evidence 由 executing 阶段补齐真实文件与报告引用。
