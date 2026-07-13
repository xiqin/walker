# 代码审查请求

**功能：** OpenCode 启动自动纳入 Walker + 1:N Session 路由
**分支：** 当前工作分支（未提交）
**spec：** `specs/2026-07-12+terminal-auto-attach/spec.md`

## 变更统计

```
 .loom/compliance/history.json      |   8 +
 README.md                          |  75 ++++++++-
 src/admin/config.js                |   4 +
 src/admin/index.js                 |   2 +
 src/admin/route-admin.js           |  16 +-
 src/admin/router.js                |   2 +-
 src/admin/session-admin.js         |   6 +-
 src/app/bootstrap.js               |  55 +++++-
 src/config/env.js                  |   4 +
 src/core/session-service.js        | 246 +++++++++++++++++++++++----
 src/dispatch/message-dispatcher.js |  79 +++++++--
 src/platform/feishu/cards.js       |   2 +-
 src/opencode-hook/                 | 新增目录（3 文件）
 test/                              | 10 文件修改/新建
 18 files changed, 1173 insertions(+), 66 deletions(-)
```

## 主要变更

1. **SessionService 1:N routes 升级**：routes 从 `{ routeKey: sessionId }` 升级为 `{ routeKey: { focusSessionId, sessions[], cwd, updatedAt } }`，旧格式自动迁移；新增 6 个公开方法（addSessionToRoute/setFocus/removeSessionFromRoute/listSessionsInRoute/getRouteCwd/setRouteCwd）
2. **Hook plugin 安装 + receiver 端点**：Walker 启动时自动写入 `~/.config/opencode/plugins/walker-hook.js`（不覆盖已存在）；POST `/opencode/hook/session-created` 接收 OpenCode 上报，按 cwd 匹配 routeKey 创建 Walker session 纳入 1:N 列表
3. **配置项新增**：4 个环境变量（HOOK_ENABLED/HEALTH_POLL_INTERVAL_MS/EXIT_ACTION/NON_FOCUS_OUTPUT）+ EDITABLE_ENV_KEYS 白名单
4. **Dispatcher 命令改造**：/use 切焦点、/list 列 route session、/status 多 session 状态、非焦点 session 输出回群带 `[session: xxx]` 标识
5. **飞书卡片**：/list 卡片"设为焦点/已聚焦"按钮
6. **心跳轮询**：每 session 独立心跳轮询 `/global/health`，连续 2 次失败判定 detached，取消 turn + 从 route 移除 + 自动切焦点
7. **README 更新**：新增 3 个章节 + 4 个环境变量文档

## 重点关注

1. **架构设计**：1:N routes 数据结构升级是核心改动，影响 session-service/message-dispatcher/admin 三层；旧格式自动迁移机制保证向后兼容
2. **安全性**：hook receiver 端点 loopback 校验（127.0.0.1/::1/::ffff:127.0.0.1）+ admin token 鉴权；plugin 文件不含敏感信息；`isAdminApiPath` 扩展 `/opencode/hook/` 前缀
3. **性能**：`_readNormalized` 每次遍历所有 route（性能优化建议）；`getRouteForSession` O(R×S) 遍历

## 自测情况

- [x] 编译通过（`node --check` 逐文件）
- [x] 测试通过（`npm test`：587 pass / 0 fail / 0 skip）
- [x] 代码符合编码红线（0 占位符残留）
- [x] 图后端已跳过（未启用）

## 变更详情

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/core/session-service.js` | 修改 | routes 1:N 升级 + 6 新方法 + 旧格式迁移 |
| `src/opencode-hook/plugin-template.js` | 新增 | 生成 plugin JS 内容字符串 |
| `src/opencode-hook/installer.js` | 新增 | 安装 hook plugin（不覆盖） |
| `src/opencode-hook/receiver.js` | 新增 | POST /opencode/hook/session-created 端点 + 自动纳入逻辑 |
| `src/opencode-hook/health-poller.js` | 新增 | 每 session 独立心跳轮询 |
| `src/config/env.js` | 修改 | 4 个新配置项 |
| `src/admin/config.js` | 修改 | EDITABLE_ENV_KEYS 白名单 |
| `src/admin/router.js` | 修改 | isAdminApiPath 扩展 /opencode/hook/ |
| `src/admin/route-admin.js` | 修改 | 适配 routes 新对象格式 |
| `src/admin/session-admin.js` | 修改 | 适配 routes 新对象格式 |
| `src/admin/index.js` | 修改 | hookReceiverRoutes 参数支持 |
| `src/dispatch/message-dispatcher.js` | 修改 | /use//list//status 改造 + 非焦点输出 + ensureWatchForSession |
| `src/app/bootstrap.js` | 修改 | 集成 plugin 安装 + receiver 路由 + health poller |
| `src/platform/feishu/cards.js` | 修改 | "设为焦点/已聚焦"按钮 |
| `README.md` | 修改 | 3 新章节 + 4 环境变量文档 |

## Standards 轴预审查

- **发现 0 个阻断**：架构分层清晰（数据层/接口层/业务层/UI层），命名规范，错误处理完整
- **5 个警告（非阻断）**：
  - W1: health-poller 用 `/global/health`，opencode-driver 用 `/health`，需运行时确认
  - W2: 配置项命名 `walkerOpendcode*` vs `opencode*` 不一致
  - W3: cards.js marker 仍为"← 当前绑定"，建议改为"← 当前焦点"
  - W4: `isSpaFallbackCandidate` 未排除 `/opencode/hook/` 前缀（防御性）
  - W5: `_readNormalized` 每次遍历所有 route（性能优化）

## Spec 轴预审查

- **spec 来源**：`specs/2026-07-12+terminal-auto-attach/spec.md`（10 个 REQ，19 条验收标准）
- **发现 0 个偏差**：REQ-001 到 REQ-010 全部有测试覆盖，19/19 验收标准对应 test-report PASS

## 预审查摘要

- Standards findings: 5（全部警告级），worst: W1 health 端点需运行时确认
- Spec findings: 0，worst: none

## 审查重点

- [ ] 架构合规性：1:N routes 升级的向后兼容性、跨模块适配完整性
- [ ] 代码质量：hook receiver 安全约束（loopback + token）、plugin 无敏感信息
- [ ] 安全性检查：admin token 鉴权链路、`isAdminApiPath` 扩展影响范围
- [ ] 性能影响：`_readNormalized` 遍历开销、`getRouteForSession` O(R×S) 遍历
