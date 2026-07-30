# 代码审查请求

**功能：** 日志体积优化
**Fixed point：** `HEAD` 工作区 diff
**Spec 来源：** `specs/2026-07-30-log-optimization/spec.md`、`requirements.json`、`plan.md`
**验证报告：** `specs/2026-07-30-log-optimization/verify-report.md`

## Standards

- 无 blocker 发现。
- 预审查范围覆盖日志轮转工具、logger 文件写入策略、daemon 启动前轮转、Admin 日志清空接口、Admin 日志页面清空按钮和对应测试。
- 代码未引入第三方依赖，轮转实现使用 `statSync` 判断大小，不读取完整日志文件。
- Admin 清空接口不接受用户传入路径，只按 allowlist 处理当前日志文件和数字归档。
- 残余风险已记录：daemon 只在启动前轮转，不移动运行中已打开的文件描述符；Windows 文件占用时清空会返回文件级异常列表；Admin 不读取数字归档内容。

## Spec

- 无 blocker 发现。
- REQ-001 至 REQ-005 已全部实现并有持久化测试覆盖。
- `traceability.json` 覆盖 5 个 REQ、27 个 behavior，且每个 behavior 均有 `tests` 与 `evidence`。
- `convergence-report.json` round 1 结论为 converged，27/27 behavior covered。
- `verify-report.md` verdict 为 PASS。

## 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none

## 变更统计

`git diff --stat` 当前 tracked 修改摘要：

```text
.loom/compliance/history.json        |  10 ++
src/admin/file-admin.js              | 105 +++++++++++++++--
src/admin/maintenance-routes.js      |  33 ++++++
src/admin/public/js/pages/logs.js    |  53 +++++++--
src/cli/daemon.js                    |   3 +
src/core/logger.js                   |  20 +++-
test/admin-files-diagnostics.test.js | 216 +++++++++++++++++++++++++++++++++++
test/admin-ui-workspaces.test.js     | 110 ++++++++++++++++++
8 files changed, 529 insertions(+), 21 deletions(-)
```

新增未跟踪文件：

```text
specs/2026-07-30-log-optimization/
src/core/log-rotation.js
test/daemon.test.js
test/log-rotation.test.js
test/logger.test.js
```

## 主要变更

1. 新增 `src/core/log-rotation.js`，提供同步日志轮转能力，默认单文件阈值 `10MB`，最多保留 `5` 个数字归档。
2. 调整 `src/core/logger.js`，默认不再写入 `logs/walker.log`，仅当 `WALKER_LOG_FILE=true` 时启用结构化文件日志并在打开写入流前轮转。
3. 调整 `src/cli/daemon.js`，后台进程启动前对 `logs/walker.out.log` 与 `logs/walker.err.log` 执行轮转，再以追加模式打开当前文件。
4. 扩展 `src/admin/file-admin.js`，保留真实运行时日志文件名和 legacy 文件名兼容，新增 `clearLogs(options)` 安全清空 allowlist 日志文件和数字归档。
5. 扩展 `src/admin/maintenance-routes.js`，新增 `POST /api/admin/logs/clear`，并让读取与清空都支持显式 `fallbackToCwd`，解决 Admin `dataDir` 与项目根日志目录分离的问题。
6. 调整 `src/admin/public/js/pages/logs.js`，新增“清空日志”按钮、busy 单飞、成功刷新、异常反馈，并更新文案说明 `walker.log` 仅在 `WALKER_LOG_FILE=true` 时启用。
7. 新增和扩展测试，覆盖轮转边界、logger 环境变量策略、daemon 启动顺序、Admin 后端清空安全边界、Admin UI 清空交互。

## 自测情况

- [x] 执行计划内完整 Node 测试集通过。
- [x] `test-report.md` 记录 executing 阶段总测试证据。
- [x] `verify-report.md` 记录 verification 阶段总测试证据。
- [x] `traceability.json` 中 5 个 REQ、27 个 behavior 均补齐测试与证据。
- [x] `loom_converge` round 1 converged。
- [x] CodeGraph 后端已用于定向理解与预审查；当前环境未暴露 `loom_graph_sync` 工具，因此未执行图索引同步。

最终验证命令：

```powershell
node --test "test/log-rotation.test.js" "test/logger.test.js" "test/daemon.test.js" "test/admin-files-diagnostics.test.js" "test/admin-ui-workspaces.test.js"
```

最新人工运行结果：`98 pass / 0 fail`。

持久化验证证据：

```text
evidence-file: evidence/verification.log
evidence-sha256: 4F7B124B0553E64CBB0897F53E9CF2ADEA42D5FE58B0BF872195CD785383BAFD
```

## 变更详情

| 文件 | 类型 | 说明 |
| ---- | ---- | ---- |
| `src/core/log-rotation.js` | 新增 | 通用同步日志轮转工具，默认 10MB、5 归档、非抛出式错误结果。 |
| `src/core/logger.js` | 修改 | `walker.log` 默认关闭，`WALKER_LOG_FILE=true` 显式启用并接入轮转。 |
| `src/cli/daemon.js` | 修改 | 启动前轮转 `walker.out.log` 与 `walker.err.log`。 |
| `src/admin/file-admin.js` | 修改 | 读取真实运行时日志文件名，新增 allowlist 日志清空能力。 |
| `src/admin/maintenance-routes.js` | 修改 | 新增 `POST /api/admin/logs/clear`，日志读写均支持 cwd fallback。 |
| `src/admin/public/js/pages/logs.js` | 修改 | 新增清空按钮、反馈区、busy 防重复和正确日志策略文案。 |
| `test/log-rotation.test.js` | 新增 | 覆盖轮转阈值、归档数量、异常场景、stat 判断。 |
| `test/logger.test.js` | 新增 | 覆盖 `WALKER_LOG_FILE` 策略、stderr、脱敏、log level、轮转接入。 |
| `test/daemon.test.js` | 新增 | 覆盖 daemon 启动前轮转和异常容错。 |
| `test/admin-files-diagnostics.test.js` | 修改 | 覆盖日志读取兼容、清空接口、安全边界、cwd fallback。 |
| `test/admin-ui-workspaces.test.js` | 修改 | 覆盖清空按钮、POST 路径、成功刷新、异常保留、busy 单飞、文案。 |
| `specs/2026-07-30-log-optimization/` | 新增 | spec、plan、tasks、traceability、evidence、test-report、verify-report、review request。 |

## 审查重点

- [ ] `rotateLogFile(filePath, options)` 的轮转顺序、归档保留数量和异常返回语义是否足够稳健。
- [ ] `logger.js` 默认关闭 `walker.log` 是否符合生产可观测性预期，`WALKER_LOG_FILE=true` 是否足够明确。
- [ ] `daemon.js` 只做启动前轮转是否符合当前 daemon 生命周期约束。
- [ ] `clearLogs(options)` 的 allowlist、cwd fallback、当前文件截断和归档删除是否安全。
- [ ] `POST /api/admin/logs/clear` 的响应语义、事件记录和 Admin 认证边界是否符合现有路由约定。
- [ ] Admin UI 清空按钮的单飞、Abort/cleanup 行为和反馈文案是否符合现有页面交互风格。
- [ ] 测试是否覆盖了核心风险而不过度耦合实现细节。

## 已知限制

- `.loom/rules/constitution.md` 中 BUILD_CMD/VET_CMD/TEST_CMD 仍为模板占位，无法执行项目级构建/静态检查命令；本次执行了计划内完整 Node 测试集。
- `verify-artifacts.mjs` 在本机因 opencode skill 安装缺少 `artifact-checker.js` 无法运行，输出已保存到 `evidence/artifact-check.log`，`verify-report.md` 标记为 known-warning。
- 当前未提交任何改动，审查 fixed point 为 `HEAD` 工作区 diff。
