# Walker 可扩展集成层实现计划

**目标：** 将 Walker 从“飞书入口绑定 OpenCode”的桥接器，演进为具备 Provider 检测、稳定本地 API、初始化诊断、实时事件和平台入口抽象的本地优先集成层。

**架构：** 先在底层建立 Provider Catalog 和统一健康检测，随后以 `/api/v1` 固化 session、route、prompt、events 的服务边界。`walker doctor/init`、WebSocket 事件流和 PlatformDriver 均复用这些底层服务，避免重写 OpenCodeDriver 与现有飞书主链路。

**技术栈：** Node.js CommonJS、内置 `http` 路由、已有 `ws` 依赖、现有 `SessionService`、`DriverRegistry`、`event-store`、Admin auth 和 CLI 入口。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | Provider Catalog 与 DriverRegistry 增强 | provider/driver | high | 无 | REQ-001, REQ-007 | REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B04, REQ-001-B05, REQ-001-B06, REQ-001-B07, REQ-007-B05 | `tasks/T1.md` |
| T2 | Doctor CLI 与 provider 命令 | cli/diagnostics | medium | T1 | REQ-002, REQ-005, REQ-007 | REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04, REQ-002-B05, REQ-002-B06, REQ-005-B06, REQ-007-B03, REQ-007-B06 | `tasks/T2.md` |
| T3 | 稳定 `/api/v1` HTTP API | api/service | high | T1 | REQ-003, REQ-007 | REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-003-B04, REQ-003-B05, REQ-003-B06, REQ-007-B01, REQ-007-B03, REQ-007-B04, REQ-007-B05 | `tasks/T3.md` |
| T4 | `walker init` 初始化体验 | cli/write | medium | T1, T2 | REQ-005, REQ-007 | REQ-005-B01, REQ-005-B02, REQ-005-B03, REQ-005-B04, REQ-005-B05, REQ-005-B06, REQ-007-B03, REQ-007-B05, REQ-007-B06 | `tasks/T4.md` |
| T5 | EventBus 与 WebSocket 事件流 | events/realtime | high | T3 | REQ-006, REQ-007 | REQ-006-B01, REQ-006-B02, REQ-006-B03, REQ-006-B04, REQ-006-B05, REQ-006-B06, REQ-007-B03, REQ-007-B04, REQ-007-B05 | `tasks/T5.md` |
| T6 | PlatformDriver 轻 adapter 与兼容收口 | platform/integration | high | T1, T3 | REQ-004, REQ-007 | REQ-004-B01, REQ-004-B02, REQ-004-B03, REQ-004-B04, REQ-004-B05, REQ-004-B06, REQ-007-B01, REQ-007-B02, REQ-007-B03, REQ-007-B04, REQ-007-B05, REQ-007-B06 | `tasks/T6.md` |

## 依赖关系

T1 → T2 → T4

T1 → T3 → T5

T1 → T3 → T6

T6 作为兼容收口任务，在 T1 与 T3 完成后执行；T5 与 T6 可在没有共享写入文件冲突时串行或分批执行，但建议 T5 先完成事件基础设施。

## 文件结构规划

| 区域 | 计划变更 | 说明 |
| ---- | -------- | ---- |
| `src/providers/` | 新增 provider catalog、detectors、doctor service | 管理 opencode、claude、codex、shell 元信息与检测结果。 |
| `src/drivers/driver-registry.js` | 增强 registry 元信息查询 | 保持 `list()` 兼容，同时增加 provider 状态入口。 |
| `src/cli/` 与 `src/index.js` | 新增 doctor/providers/init 命令入口 | CLI 路由一次性接入，具体 init 逻辑由独立模块实现。 |
| `src/api/v1/` | 新增稳定 HTTP API 路由 | 暴露 providers、sessions、routes、prompt、events、metrics。 |
| `src/events/` 与 `src/admin/ws-events.js` | 新增 EventBus 和 WS 事件流 | `event-store` 写入后发布，WS 做认证、过滤、心跳和脱敏。 |
| `src/platforms/` 与 `src/platform/feishu/` | 新增平台驱动接口与飞书 adapter | 先轻 adapter 化，不接入其他真实平台。 |
| `test/` | 增加单元、集成和回归测试 | 覆盖 provider/doctor/API/init/WS/platform 以及现有兼容行为。 |
| `README.md` | 更新使用说明与兼容边界 | 说明新命令、新 API 与非目标。 |

## 并行边界

T1 是底层依赖，必须先执行。T2 与 T3 在 T1 完成后可以分支，但 T4 依赖 T2 的 CLI 路由。T5 依赖 T3 的 API 和认证边界。T6 触碰飞书入口与 dispatcher，必须在底层 provider 和 API 形态稳定后执行，避免多任务同时改动主消息链路。

## 风险与控制

| 风险 | 控制方式 |
| ---- | -------- |
| `MessageDispatcher` 与飞书耦合较深 | T6 只做 adapter 和标准事件入口，不一次性移除原有飞书调用。 |
| `/api/v1` 公开后响应格式需要稳定 | T3 引入统一 success/error 包装和 v1 DTO，不暴露 state 文件原结构。 |
| Provider 检测可能因命令超时或缺失影响启动 | T1 所有检测异常转结构化结果，不抛到主进程。 |
| WebSocket 慢客户端阻塞主流程 | T5 的 EventBus publish 不等待慢 listener，发送失败隔离记录。 |
| init 写配置破坏用户环境 | T4 只写 Walker 数据目录和明确 plugin 文件，使用安全写入，不写第三方密钥。 |
| 安全边界扩大 | T2/T3/T5/T6 均复用 loopback 和 `WALKER_ADMIN_TOKEN` 约束，所有输出脱敏。 |

## 验证策略

- 计划阶段校验：`node C:\Users\tianxiqin\.config\opencode\skills\loom-writing-plans\scripts\validate-plan.mjs --spec-dir specs/2026-07-30-walker-integration-layer`。
- 执行阶段基础验证：`npm test`。
- 重点回归测试：`test/message-dispatcher.test.js`、`test/feishu-platform.test.js`、`test/admin-core-api.test.js`、`test/admin-server.test.js`、`test/session-service.test.js`、`test/bootstrap.test.js`。
- 新增测试按 task 落入 provider、CLI、API、init、WebSocket、PlatformDriver 对应文件。

## Traceability 初始映射

planning 阶段已在同目录 `traceability.json` 中覆盖每个 `REQ-xxx` 及其全部 behavior。`tests` 与 `evidence` 在 executing 阶段由实际测试和收据补齐。
