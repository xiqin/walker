# 代码审查请求

**功能：** 移除 Claude 集成与接入
**分支：** `feature/2026-10-19-remove-claude-integration`
**固定点：** `1ac4dc2`（当前 HEAD，也是该分支基线）。全部产品改动仍在工作区，未提交。

## Standards

- `.loom/compliance/history.json` 被追加了一条 `passed: false` 记录，时间 `2026-10-19T09:29:36.821Z`，阶段 `verification`。原文历史条目没有删除。这条记录把验证报告里的“fail 数为 0”和“blocker 为 0”扫成了违规，不是运行时失败。建议审查时决定保留该审计痕迹，或在提交前还原这个文件。
- 无其他 Standards blocker。公开失败信封仍是精确的 `claude_removed`，没有包进 `success()`。OpenCode driver 相对 `HEAD` 无 diff。

## Spec

- 无发现。实现对照 `specs/2026-10-19+remove-claude-integration/spec.md`：精确小写 `claude` 失败关闭，旧记录不迁移，历史规格保留，Codex 与 OpenCode 保留。

## Spec 遗漏自审

- 检查条目: 8 个 REQ、45 个 behavior
- 遗漏: 无
- omission-hunter: pass（45 项，blocker 为 0，`2026-10-19T09:33:09.490Z`）
- REQ-001 到 REQ-008 都有代码落点和 `traceability.json` 的 tests/evidence。不做范围没有被实现：没有删除 `specs/2026-07-31-claude-provider` 与 `specs/2026-08-21-claude-tui-feishu-shared-session`，没有改写用户 `.env`，没有提交。

## 预审查摘要

- Standards findings: 1，worst: 合规历史追加了一条误报的 `passed: false`，不是产品缺陷
- Spec findings: 0，worst: none
- Spec 遗漏: 0，worst: none

## 变更统计

固定点 `1ac4dc2` 的已跟踪 diff：56 files changed，2885 insertions，8723 deletions。

未跟踪、因此不在 `git diff --stat` 中的文件：

- `specs/2026-10-19+remove-claude-integration/`
- `test/claude-removal-guard.test.js`
- `test/cli-removed-claude.test.js`

`src/drivers/opencode-driver.js` 不在 diff 中。

## 主要变更

1. 删除 Claude driver、PTY、bridge、attach、transcript 和专用测试。
2. 启动、CLI、provider catalog、配置加载不再连接或解析 Claude。`WALKER_DEFAULT_AGENT=claude` 拒绝启动。
3. 飞书 `/new claude`、`/attach claude`、自动绑定、旧会话消息和平台消息都在 driver 前返回 `claude_removed`。
4. Admin 与 v1 创建、prompt 返回精确错误信封，不包进成功响应，也不附加 `details`。
5. 现行 README、CHANGELOG Unreleased、连接页和原型不再把 Claude 列为可用接入。0.1.0 历史句保留。

## 重点关注

1. 架构：Claude 拒绝集中在 `rejectRemovedClaude`，不是新的 provider 插件。
2. 安全性：测试不启动真实 `claude`，不读用户主目录 `.claude`。
3. 兼容：只拒绝精确小写 `claude`。`claude-sonnet-4` 仍是 OpenCode 模型名。旧 `agent=claude` 记录不迁移。

## 自测情况

- [x] 编译通过：宪章没有 BUILD_CMD，Node 项目无单独编译
- [x] 静态分析通过：`npm run lint` 退出码 0，`evidence/verification.log`
- [x] 测试通过：`npm run check` 1490 pass，失败数为 0，退出码 0，`evidence/T7-check.log`
- [x] 代码符合编码红线：只删除 Claude 接入，没有顺手改 OpenCode 协议
- [ ] 所有变更已提交：用户明确要求不要提交，因此保持未提交
- [x] 图后端：`.loom/graph.config.json` 启用 codegraph，但本工作树没有自己的索引，查询会落到 `H:\walker`。本次跳过图同步，没有运行 `codegraph init`
- [x] Spec 遗漏自审通过

## 变更详情

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/drivers/claude-*.js`、`src/cli/claude-attach-command.js` | 删除 | 移除 Claude 运行时模块 |
| `src/app/bootstrap.js`、`src/index.js`、`src/runtime/windows-runtime.js` | 修改 | 拆除启动和关闭接线 |
| `src/providers/provider-catalog.js`、`src/providers/provider-health.js` | 修改 | catalog 不再提供 claude |
| `src/config/env.js`、`src/admin/config.js`、`.env.example` | 修改 | 不再解析或展示 `CLAUDE_*` |
| `src/dispatch/message-dispatcher.js`、`src/platform/feishu/commands.js` | 修改 | 飞书命令和消息失败关闭 |
| `src/admin/session-admin.js`、`src/api/v1/sessions-routes.js`、`src/api/v1/prompt-routes.js` | 修改 | 精确 `claude_removed` 信封 |
| `test/claude-*.test.js`、`test/cli-claude-attach.test.js` | 删除 | 删除专用 Claude 测试 |
| `test/claude-removal-guard.test.js`、`test/cli-removed-claude.test.js` | 新增 | 守卫和 CLI 移除测试 |
| `README.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`walker-console-v2.html` | 修改 | 现行说明不再承诺 Claude 接入 |
| `.loom/compliance/history.json` | 修改 | 只追加一条验证误报，未删除旧记录 |

## 审查重点

- [ ] 精确小写 `claude` 与 `Claude`、`claude-sonnet-4` 没有混用
- [ ] 创建和 prompt 的错误信封没有 `details`，也没有被包进成功响应
- [ ] 旧 `agent=claude` 记录未被迁移或自动删除
- [ ] 历史 specs、合规旧记录和 `MEMORY.md` 仍在
- [ ] OpenCode 与 Codex 路径没有功能性回退
