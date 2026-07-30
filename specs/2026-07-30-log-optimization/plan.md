# 日志体积优化实现计划

## 摘要

本计划基于已批准的日志体积优化规格，按依赖顺序落地内置日志轮转、`walker.log` 默认关闭、daemon stdout/stderr 启动前轮转、Admin 清空日志接口和 Admin 页面清空按钮。

核心约束：单文件达到 `10MB` 后在下一次写入前轮转，每类最多保留 `5` 个归档；`walker.log` 默认不再写入，显式设置 `WALKER_LOG_FILE=true` 时恢复写入；清空日志只允许处理项目 `logs/` 目录中的日志允许列表文件及其归档。

## 文件结构

| 文件 | 责任 |
| --- | --- |
| `src/core/log-rotation.js` | 新增通用同步日志轮转工具，供 logger 与 daemon 复用。 |
| `src/core/logger.js` | 调整 `walker.log` 默认文件写入策略，并在显式启用时接入轮转。 |
| `src/cli/daemon.js` | daemon 启动时打开 stdout/stderr 日志文件前执行轮转。 |
| `src/admin/file-admin.js` | 新增日志清空能力，保留读取当前日志和旧文件名兼容。 |
| `src/admin/maintenance-routes.js` | 新增 Admin 清空日志路由，复用现有管理端路由封装。 |
| `src/admin/public/js/pages/logs.js` | 新增清空日志按钮、busy 状态、成功刷新和失败反馈。 |
| `test/log-rotation.test.js` | 覆盖日志轮转边界、保留数量和失败容错。 |
| `test/logger.test.js` | 覆盖 `WALKER_LOG_FILE` 默认关闭、显式开启/关闭、脱敏与 stderr 输出。 |
| `test/daemon.test.js` | 覆盖 daemon 打开日志前触发 stdout/stderr 轮转。 |
| `test/admin-files-diagnostics.test.js` | 覆盖后端清空日志函数与路由行为。 |
| `test/admin-ui-workspaces.test.js` | 覆盖 Admin 日志页面清空按钮交互。 |

## Task 概览

| Task | 文件 | 标题 | 依赖 | 覆盖需求 | 主要验证 |
| --- | --- | --- | --- | --- | --- |
| T1 | `tasks/T1.md` | 实现通用日志轮转工具 | 无 | REQ-001 | `node --test test/log-rotation.test.js` |
| T2 | `tasks/T2.md` | 调整结构化 logger 文件写入策略 | T1 | REQ-001, REQ-002 | `node --test test/logger.test.js test/log-rotation.test.js` |
| T3 | `tasks/T3.md` | daemon stdout/stderr 日志启动前轮转 | T1 | REQ-001 | `node --test test/daemon.test.js test/log-rotation.test.js` |
| T4 | `tasks/T4.md` | Admin 后端清空日志接口 | T1 | REQ-003, REQ-004, REQ-005 | `node --test test/admin-files-diagnostics.test.js` |
| T5 | `tasks/T5.md` | Admin 日志页面清空按钮 | T4 | REQ-003, REQ-005 | `node --test test/admin-ui-workspaces.test.js test/admin-files-diagnostics.test.js` |

## 依赖顺序

1. T1 先提供可复用的轮转能力，避免 logger 与 daemon 各自实现文件保留逻辑。
2. T2 和 T3 都依赖 T1，但分别 owns `logger.js` 与 `daemon.js`，后续可在 T1 完成后并行执行。
3. T4 依赖 T1 的日志文件命名与归档识别规则，负责后端安全清理。
4. T5 依赖 T4 的清空接口，负责 UI 交互和状态反馈。

## 风险控制

- 轮转使用 `stat` 判断文件大小，不读取完整日志内容。
- 轮转失败不得向 logger 或 daemon 调用方抛出异常。
- Windows 上当前打开的日志文件清空优先使用截断，归档文件可删除；失败时返回明确文件级错误。
- Admin 清空能力不得接受用户传入路径，后端只基于 allowlist 枚举日志文件。

## 验证计划

执行阶段至少运行：

```powershell
node --test "test/log-rotation.test.js" "test/logger.test.js" "test/daemon.test.js" "test/admin-files-diagnostics.test.js" "test/admin-ui-workspaces.test.js"
```

若某个既有测试文件名称或用例组织与计划不同，执行阶段可以在保持需求覆盖不变的前提下调整测试落点，并同步更新 `traceability.json` 的 `tests` 与 `evidence`。
