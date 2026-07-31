# 代码审查请求

**功能：** 代码审查安全与稳定性修复
**Spec：** `specs/2026-07-31-review-fixes`
**Fixed point：** `HEAD`，当前审查对象为工作区未提交改动
**验证结论：** PASS，见 `verify-report.md`

## Standards

- 无阻断发现。T1 到 T6 已完成任务级复审，`loom_verify_artifacts` 通过，完整 `npm test` 通过。
- 当前变更仍未提交；本审查请求用于提交前人工审查，不代表已完成 git 提交。
- 已知非阻断风险：WebSocket Origin 使用 Host 精确匹配，兼容性偏保守；Provider/CLI 脱敏为格式规则，不是通用秘密检测器；`safeWriteJson` no-clobber 路径依赖 `linkSync`，特殊文件系统会进入明确异常路径。

## Spec

- 无阻断发现。`convergence-report.json` 将 27 个 behavior 全部分类为 covered，blocker count 为 0。
- `traceability.json` 已将全部 6 个 REQ 与 27 个 behavior 映射到 task、测试文件和 evidence。
- `test-report.md` 与 `verify-report.md` 均有 PASS verdict 与标准 Evidence Receipt。

## 预审查摘要

- Standards findings: 0 blocker，worst: none。
- Spec findings: 0 blocker，worst: none。

## 变更统计

Tracked diff stat:

```text
 .loom/compliance/history.json      |  55 +++++++++++++++
 .loom/memory/MEMORY.md             |   4 +-
 .loom/memory/store.json            |  16 +++++
 README.md                          |  10 +++
 src/admin/agent-runtime-admin.js   |  37 ++++++++--
 src/admin/auth.js                  |  35 ++++++----
 src/admin/router.js                |   1 +
 src/admin/server.js                |  61 ++++++++++++++++-
 src/app/bootstrap.js               |  20 +++++-
 src/dispatch/message-dispatcher.js |  67 ++++++++++++++++++
 src/drivers/driver-registry.js     |  58 +++++++++++++++-
 src/index.js                       |  79 ++++++++++++++-------
 src/platform/feishu/events.js      |  27 +++++++-
 src/platform/feishu/platform.js    |  25 +++++--
 test/bootstrap.test.js             | 136 +++++++++++++++++++++++++++++++++++++
 test/feishu-platform.test.js       |  39 +++++++++++
 16 files changed, 614 insertions(+), 56 deletions(-)
```

Untracked additions include:

- `specs/2026-07-31-review-fixes/`
- `src/admin/ws-events.js`
- `src/api/`
- `src/cli/`
- `src/events/`
- `src/platforms/`
- `src/providers/`
- New tests: `test/api-v1-auth.test.js`, `test/api-v1.test.js`, `test/doctor-cli.test.js`, `test/event-bus.test.js`, `test/events-websocket.test.js`, `test/feishu-platform-driver.test.js`, `test/init-cli.test.js`, `test/message-dispatcher-platform-event.test.js`, `test/platform-driver.test.js`, `test/provider-catalog.test.js`, `test/providers-cli.test.js` and related files.

## 主要变更

1. Admin session 隔离：`src/admin/auth.js` 改为按 admin config 实例持有 session store，避免登录 sid 跨 server/config 复用；`src/admin/server.js` 显式复用该 store 给 WebSocket 鉴权。
2. WebSocket 事件流加固：`src/admin/ws-events.js` 新增 Origin 校验、payload/filter 限制、连续坏消息关闭、主动 stop 释放连接、拒绝与异常路径可观测且脱敏。
3. Provider 诊断安全：`src/providers/provider-detectors.js` 为外部命令构造最小环境，避免向 `where`/`which` 和 provider `--version` 子进程传递 token/secret/API key。
4. API v1 脱敏：`src/api/v1/common.js` 不再向客户端返回内部异常 message；`src/api/v1/prompt-routes.js` 对 prompt events 做递归脱敏。
5. 飞书 platform event 边界：放宽空文本、补 sender id fallback、保留标准化 `userId`，并将 `platform.adapter_error` 接入 app `eventStore`。
6. CLI 安全写入：`src/cli/safe-write.js` 在 `overwrite=false` 时使用 no-clobber 提交路径，防止检查后并发创建目标被覆盖。

## 自测情况

- [x] 执行阶段汇总测试通过：`node --test test/api-v1-auth.test.js test/events-websocket.test.js test/provider-catalog.test.js test/providers-cli.test.js test/doctor-cli.test.js test/api-v1.test.js test/platform-driver.test.js test/feishu-platform-driver.test.js test/feishu-events.test.js test/feishu-platform.test.js test/message-dispatcher-platform-event.test.js test/bootstrap.test.js test/init-cli.test.js`
- [x] 执行阶段证据：`evidence/executing-summary-test.log`，SHA-256 `4762cdfeb24b27cd53900f3e5db5287ba3eec6f17d2af264099e76f654777a02`
- [x] 最终验证通过：`npm test`
- [x] 最终验证证据：`evidence/verification.log`，SHA-256 `c83862277dd3c780342f4f014158ad757e4dfb90f8201b324e04eb06a65feaf8`
- [x] `npm test` 覆盖 `npm run lint && npm run check`，最终统计为 1346 tests passing across 65 suites。
- [x] `loom_converge` round 1 converged，27 个 behavior 全部 covered。
- [x] `loom_verify_artifacts` ok，无 errors/warnings。
- [ ] Git 提交尚未创建，当前仍为工作区审查请求。

## 变更详情

| 文件或目录 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/admin/auth.js` | 修改 | session store 实例隔离，导出 `getSessionStore` 供同实例 WS 复用。 |
| `src/admin/server.js` | 修改 | 接入 event bus / WebSocket handler，stop 时清理 publisher 与 WS 连接。 |
| `src/admin/ws-events.js` | 新增 | `/api/v1/events/stream` WebSocket 事件流、鉴权、Origin、限额、脱敏与资源释放。 |
| `src/api/v1/` | 新增 | API v1 providers/sessions/routes/events/metrics/prompt 路由与统一响应。 |
| `src/providers/` | 新增 | provider catalog、health、detector，detector 使用最小子进程环境。 |
| `src/cli/` | 新增 | doctor/providers/init 命令、CLI 输出脱敏、安全 JSON 写入。 |
| `src/platforms/` | 新增 | 标准 platform driver 抽象、Feishu platform driver、registry。 |
| `src/platform/feishu/events.js` | 修改 | sender fallback、标准字段兼容、空 text 处理。 |
| `src/platform/feishu/platform.js` | 修改 | platform driver 接入与 adapter event 可观测。 |
| `src/app/bootstrap.js` | 修改 | API v1 路由接入、platform event 分发、adapter event 写入 eventStore。 |
| `src/dispatch/message-dispatcher.js` | 修改 | 标准 platform event 校验、文本/命令观测链路。 |
| `test/*.test.js` | 新增/修改 | 覆盖 Admin auth、WS、API v1、provider/CLI、Feishu platform、bootstrap、safeWriteJson 等行为。 |
| `specs/2026-07-31-review-fixes/` | 新增 | spec、requirements、plan、tasks、traceability、evidence、test/verify reports、handoffs。 |

## 审查重点

- [ ] 安全性：Admin sid 是否仅在同实例内有效；WebSocket cookie 鉴权与 Origin 规则是否足够。
- [ ] 敏感信息：API v1、prompt events、provider/doctor CLI、WebSocket events 的脱敏边界是否一致。
- [ ] 资源控制：WebSocket maxPayload/filter/bad message/stop cleanup 是否覆盖实际运行风险。
- [ ] 平台事件：飞书 sender fallback、空 text、adapter error 观测是否与现有命令/文本路径兼容。
- [ ] 文件写入：`safeWriteJson` 的 `linkSync` no-clobber 路径是否满足目标平台兼容性。
- [ ] 测试质量：新增测试是否覆盖行为而非实现细节，是否存在过度 mock 或遗漏边界。

## 后续处理

- 人工审查通过后，可进入 review gate approval。
- 若审查反馈需要修改，按 `loom-receiving-code-review` 处理并回写 `review-feedback.md`。
