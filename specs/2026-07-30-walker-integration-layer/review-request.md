# 代码审查请求

**功能：** Walker 可扩展集成层
**审查范围：** 当前工作区相对 `HEAD` 的未提交 diff
**Spec：** `specs/2026-07-30-walker-integration-layer/spec.md`
**验证报告：** `specs/2026-07-30-walker-integration-layer/verify-report.md`

## 预审查 Findings

### Standards

- 无阻断发现。已按项目现有 CommonJS、内置 `http` 路由、现有 Admin auth/response、`SessionService`、`DriverRegistry`、`event-store` 和 `ws` 依赖扩展；未引入重型后端或新运行时依赖。
- 注意：当前变更尚未提交，审查固定点为 `HEAD`，审查范围是工作区 diff 与新增未跟踪文件。

### Spec

- 无阻断发现。实现已覆盖 `REQ-001` 至 `REQ-007`，共 43 个 behavior；`traceability.json` 中每个 behavior 均有真实持久化测试与 evidence 引用。

### 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none

## 变更统计

已跟踪文件 diff 统计：

```text
.loom/compliance/history.json      | 15 ++++++++
README.md                          | 10 +++++
src/admin/agent-runtime-admin.js   | 37 ++++++++++++++++--
src/admin/router.js                |  1 +
src/admin/server.js                | 56 ++++++++++++++++++++++++++-
src/app/bootstrap.js               |  2 +
src/dispatch/message-dispatcher.js | 47 +++++++++++++++++++++++
src/drivers/driver-registry.js     | 58 +++++++++++++++++++++++++++-
src/index.js                       | 79 ++++++++++++++++++++++++++------------
src/platform/feishu/events.js      | 22 ++++++++++-
src/platform/feishu/platform.js    | 22 ++++++++-
11 files changed, 312 insertions(+), 37 deletions(-)
```

新增文件重点目录：

- `src/providers/`：Provider Catalog、detector、health service。
- `src/cli/`：doctor/providers/init/safe-write/CLI output 模块。
- `src/api/v1/`：providers、sessions、routes、prompt、events、metrics HTTP API。
- `src/events/` 与 `src/admin/ws-events.js`：EventBus 与 WebSocket 事件流。
- `src/platforms/`：PlatformDriver、PlatformRegistry、FeishuPlatformDriver。
- `test/*`：provider、CLI、API、init、WS、platform 新增测试。
- `specs/2026-07-30-walker-integration-layer/`：spec、plan、tasks、traceability、报告、handoff、evidence。

## 主要变更

1. Provider Catalog 与 DriverRegistry 增强：新增 opencode、claude、codex、shell provider 元信息、命令/版本/健康检测、异常结构化，`DriverRegistry` 保持 `list()` 兼容并新增 provider 状态接口。
2. CLI 产品化：新增 `walker doctor`、`walker providers list`、`walker providers doctor [id]`、真实 `walker init`，统一输出脱敏与只读诊断。
3. 稳定 `/api/v1`：新增 providers、sessions、routes、prompt、events、metrics API，复用 Admin token 与统一 `{ ok, data/error }` 响应。
4. 初始化体验：`walker init` 创建 Walker 数据目录、`state.json`、`dedup.json`、`attachments/`、`logs/`、`config.json`，幂等且安全写入，不写第三方密钥或系统配置。
5. 实时事件流：新增 EventBus 与认证 WebSocket `/api/v1/events/stream`，支持过滤、脱敏、心跳、断开清理和多 Admin server 复用 `eventStore`。
6. PlatformDriver 抽象：新增平台中立事件契约、PlatformRegistry、FeishuPlatformDriver，并在 `MessageDispatcher` 增加 `handlePlatformMessage(event)`，保持现有飞书路径兼容。
7. 文档与账本：更新 README，新增完整 spec/plan/tasks/traceability/test-report/verify-report/evidence/handoff。

## 重点关注

1. 安全性：`/api/v1` 与 WebSocket 是否完整复用 Admin token；provider/API/CLI/WS 输出是否仍无 secret/token 明文泄漏。
2. API 稳定性：`/api/v1/routes` 已刻意映射为安全 DTO，不返回 Admin route 的原始 `session`；请重点确认 DTO 字段是否足够且不暴露内部 state。
3. 并发与生命周期：EventBus 对同一 `eventStore` 的多 Admin server 订阅集合、`stop()` 注销逻辑、慢/异常 listener 隔离是否稳健。
4. 兼容性：`driverRegistry.list()`、飞书长连接消息处理、卡片/附件/命令/权限/问题处理、现有 `/api/admin/*` 是否保持兼容。
5. CLI 写入安全：`walker init` 的安全写入、损坏配置保护、幂等行为和不修改 shell profile/系统服务/第三方密钥边界。

## 自测情况

- [x] 全量回归通过：`npm run check *> specs/2026-07-30-walker-integration-layer/evidence/test.log`，退出码 0，1321 tests passed，0 failed。
- [x] Lint 通过：验证阶段 `npm run lint`，退出码 0。
- [x] Whitespace 通过：验证阶段 `git diff --check`，退出码 0。
- [x] Traceability 闭环通过：7 个 REQ / 43 个 behavior 均有非空 tests/evidence，引用存在性检查通过。
- [x] 意图收敛通过：`convergence-report.json` 显示 43/43 behavior covered，0 blocker。
- [x] 负空间审查通过：`findings/omission-hunter.json` findings 空，0 blocker。
- [x] 占位符扫描通过：spec 目录 Markdown 无未完成标记。
- [x] 图后端已用于实现/审查阶段代码理解；未执行额外图索引同步。

## Evidence Receipt

- evidence-command: `npm run check *> specs/2026-07-30-walker-integration-layer/evidence/test.log`
- evidence-exit-code: `0`
- evidence-file: `evidence/test.log`
- evidence-sha256: `4c659e4d3209c7c2b62a88e6e3a46134520656cbe7e63a185efdd2902a7c4af9`
- evidence-summary: `# tests 1321`, `# pass 1321`, `# fail 0`
- verification-log: `evidence/verification.log`
- verification-log-sha256: `41c281ffb0f512d75e94e2ba29e7c1335bd690c330acb549a28794cfe4ccd3b6`

## 变更详情

| 文件/目录 | 变更类型 | 说明 |
| --------- | -------- | ---- |
| `src/providers/` | 新增 | Provider catalog、命令检测、健康检测与异常隔离。 |
| `src/drivers/driver-registry.js` | 修改 | 新增 provider metadata/status/doctor 接口，保持 `list()` 兼容。 |
| `src/admin/agent-runtime-admin.js` | 修改 | Admin agent 列表可复用真实 provider status。 |
| `src/cli/` | 新增 | doctor/providers/init、安全写入和 CLI 输出脱敏模块。 |
| `src/index.js` | 修改 | 接入 doctor/providers/init 命令，保留现有 start/stop/status/logs/help。 |
| `src/api/v1/` | 新增 | 稳定受保护 HTTP API，包含 providers/sessions/routes/prompt/events/metrics。 |
| `src/admin/router.js` | 修改 | 将 `/api/v1/` 纳入受保护 API 路由。 |
| `src/app/bootstrap.js` | 修改 | 注册 `/api/v1` routes 到 Admin server context。 |
| `src/events/`、`src/admin/ws-events.js`、`src/admin/server.js` | 新增/修改 | EventBus、WebSocket upgrade、event-store publisher 多 bus 管理。 |
| `src/platforms/` | 新增 | PlatformDriver、PlatformRegistry、FeishuPlatformDriver。 |
| `src/platform/feishu/*` | 修改 | 飞书事件转换与 platform driver 轻 adapter 接入。 |
| `src/dispatch/message-dispatcher.js` | 修改 | 新增 `handlePlatformMessage(event)` 与平台事件可观察性。 |
| `README.md` | 修改 | 更新新 CLI/API/平台抽象说明。 |
| `test/*.test.js` | 新增/修改 | 新增 provider、CLI、API、init、WS、platform 行为与回归测试。 |
| `specs/2026-07-30-walker-integration-layer/` | 新增 | 规格、计划、任务、traceability、报告、evidence 和 handoff。 |

## 审查重点

- [ ] 架构合规性：provider/API/WS/platform 分层是否清晰，未把 Admin state 直接作为 v1 contract 暴露。
- [ ] 代码质量：新增模块边界、错误对象、DTO 转换、测试是否可维护。
- [ ] 安全性检查：token/secret 脱敏、Admin token 复用、init 写入边界、WS 鉴权。
- [ ] 性能影响：provider 检测超时、WS publish 非阻塞、慢客户端隔离。
- [ ] 兼容性：现有飞书入口、Admin API、CLI 子命令、session/route 恢复路径。

verdict: READY_FOR_REVIEW
