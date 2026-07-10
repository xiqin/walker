# Walker 网页管理端实现计划

**目标：** 在现有 Walker 单进程服务内增加本地网页管理端，提供受控 Admin API、静态控制台、诊断维护能力和完整测试覆盖。

**架构：** 管理端作为 `createApp(config)` 的可选子服务启动，默认绑定 `127.0.0.1`。后端新增 `src/admin/` 模块，按配置、HTTP 骨架、业务 API、文件维护、调试工具、静态 SPA、应用集成分层；现有飞书消息处理链路只增加必要事件采集，不改变主流程行为。

**技术栈：** Node.js CommonJS、内置 `http/fs/path/child_process`、现有 `SessionService`、`DriverRegistry`、runtime、飞书卡片渲染器、`node:test`。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 管理端配置与事件指标基础 | 配置/内存状态 | 中等 | 无 | `tasks/T1.md` |
| T2 | Admin HTTP 服务骨架与鉴权 | HTTP 基础设施 | 高 | T1 | `tasks/T2.md` |
| T3 | Session、Route、Agent 与 Runtime API | 业务 API | 高 | T1, T2 | `tasks/T3.md` |
| T4 | 配置编辑、日志、附件、维护与诊断 API | 文件/诊断 API | 高 | T1, T2, T3 | `tasks/T4.md` |
| T5 | 调试工具、卡片预览、指标与服务控制 API | 工具 API | 中等 | T1, T2, T3 | `tasks/T5.md` |
| T6 | 无构建静态 SPA 控制台 | 前端 UI | 高 | T2, T3, T4, T5 | `tasks/T6.md` |
| T7 | 应用集成、脚本收口与全量验证 | 集成/验证 | 高 | T1, T2, T3, T4, T5, T6 | `tasks/T7.md` |

## 依赖关系

T1 -> T2 -> T3 -> T4 -> T6 -> T7

T1 -> T2 -> T3 -> T5 -> T6 -> T7

## 文件结构规划

新增 `src/admin/` 作为管理端后端模块目录。`server.js` 只处理 HTTP 生命周期、鉴权、请求解析、静态文件与路由分发；功能 API 分散在独立 route/service 文件中，避免把所有逻辑塞进入口。`public/` 放置无构建 SPA 静态资源。最终由 `src/admin/index.js` 组装全部 routes，再由 `src/app/bootstrap.js` 挂载。

测试继续采用 `node:test`。每个任务拥有独立测试文件；只有 T7 修改既有 `test/bootstrap.test.js` 和 `package.json`，负责启动集成与检查脚本收口。

## 串行与并行边界

T1、T2、T3、T4、T5、T6、T7 按依赖串行执行。`owns` 声明保持文件级不重叠；T4 和 T5 均依赖 T3，但拥有不同 route/service 文件，完成 T3 后可在无共享写入的前提下并行实现。T7 是最终集成任务，必须在所有功能任务完成后执行。

## 需求覆盖

REQ-001 至 REQ-026 均映射到至少一个任务。P0 功能集中在 T1、T2、T3、T4、T6、T7；P1/P2 工具能力集中在 T5 和 T6；自动化验证由每个任务的局部测试加 T7 全量检查共同覆盖。
