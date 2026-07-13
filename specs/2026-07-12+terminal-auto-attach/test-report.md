# OpenCode 启动自动纳入 Walker — 测试报告

## 测试概览

- 总接口数（REQ）：10
- 通过：10
- 失败：0
- 警告：0

## 集成测试

本次新增 1 个集成测试文件 `test/integration-hook-routing.test.js`（6 个测试用例），覆盖 spec 要求的 5 个跨模块交互场景。已有的 `test/opencode-hook-receiver.test.js`、`test/opencode-hook-health-poller.test.js`、`test/opencode-hook-installer.test.js` 也包含 E2E 和模块级集成测试，在报告中一并标注覆盖情况。

### 集成测试 1: Hook 纳入 → 路由绑定 → 消息派发
- **涉及模块**: opencode-hook/receiver → core/session-service → dispatch/message-dispatcher → drivers/agent-driver(stub)
- **状态**: PASS
- **测试结果**: plugin 上报 `session.created` + cwd → receiver 按 cwd 匹配 route → 创建 Walker session 加入 route 的 sessions 列表 → `handleIncomingMessage` 派发到焦点 session 的 driver.prompt。验证了 route 下 2 个 session（初始 + hook 纳入）、焦点保持初始 session、prompt 调用到焦点 session 的 agentRef.opencodeSessionId。同 cwd 启动第二个 OpenCode 加入同一 routeKey 且不动 focusSessionId 也已验证。
- **覆盖文件**: `test/integration-hook-routing.test.js:67-160`
- **已有覆盖**: `test/opencode-hook-receiver.test.js` 覆盖了 hook 纳入 + cwd 匹配 route 的单模块场景，但未串联到 dispatcher 消息派发。本测试补充了跨模块串联。

### 集成测试 2: 1:N 路由 → 切焦点 → 消息派发
- **涉及模块**: core/session-service（setFocus）→ dispatch/message-dispatcher（_cmdUse + handleIncomingMessage）
- **状态**: PASS
- **测试结果**: route 下 2 个 session → `/use <newFocusId>` 切焦点 → `getCurrent` 返回新焦点 → `handleIncomingMessage` 派发到新焦点 session 的 driver.prompt（agentRef.opencodeSessionId 为 `oc_focus_new`）。
- **覆盖文件**: `test/integration-hook-routing.test.js:165-213`
- **已有覆盖**: `test/message-dispatcher.test.js:1155` 用 mock 覆盖了 `/use 切焦点`，但未用真实 SessionService 串联。本测试补充了真实 SessionService 的端到端验证。

### 集成测试 3: 非焦点 session 输出回群
- **涉及模块**: dispatch/message-dispatcher（_handleWatchedSessionEvent + _isFocusSession）→ core/session-service（getCurrent/getRouteForSession）
- **状态**: PASS
- **测试结果**: 非焦点 session watch 事件 → 输出带 `[session: <id前8位>]` 前缀回群；焦点 session 输出不带前缀。使用真实 SessionService 验证 `_isFocusSession` 的 route 查找逻辑。
- **覆盖文件**: `test/integration-hook-routing.test.js:218-262`
- **已有覆盖**: `test/message-dispatcher.test.js:1330-1399` 用 mock 已完整覆盖（含 nonFocusOutput=false 静默场景）。本测试用真实 SessionService 补充确认。

### 集成测试 4: OpenCode 退出检测 cascade
- **涉及模块**: opencode-hook/health-poller → core/session-service（removeSessionFromRoute）→ dispatch/message-dispatcher（_cancelTurn + _stopSessionWatch）
- **状态**: PASS
- **测试结果**: 心跳连续 2 次失败 → detached → 取消 running turn → 从 route 移除 session → 焦点自动切到另一个 session。无 running turn 时退出不报错，仍从 route 移除。
- **覆盖文件**: `test/integration-hook-routing.test.js:267-355`
- **已有覆盖**: `test/opencode-hook-health-poller.test.js` 用 mock SessionService 已完整覆盖（连续 2 次失败、exitAction=none、无 turn 退出、untrack、stop 等）。本测试用真实 SessionService 补充 cascade 串联。

### 集成测试 5: E2E hook receiver 路由可达
- **涉及模块**: admin/server → opencode-hook/receiver → core/session-service
- **状态**: PASS（已有覆盖）
- **测试结果**: 通过完整 HTTP server（createAdminServer）验证 `POST /opencode/hook/session-created` 路由可达，返回 200，session 正确创建并纳入 route。验证了 loopback 检查、token 鉴权、session 创建。
- **覆盖文件**: `test/opencode-hook-receiver.test.js:526-661`（4 个 E2E 测试）
- **说明**: 该场景已被现有 E2E 测试完整覆盖，无需重复编写。

## 回归测试

- **测试命令**: `npm test`（等价于 `npm run check`：node --check 逐文件 + `node --test test/*.test.js`）
- **总测试数**: 587
- **通过**: 587
- **失败**: 0
- **跳过**: 0

### 新增代码引起的失败
无。

### 预先存在的失败（标记为 WARN）
无。

## 接口验证详情

### REQ-001: Walker 启动时自动写入 hook plugin（不覆盖已存在文件）
- **状态**: PASS
- **验证**:
  - 正常流程：`installHookPlugin` 写入新 plugin 文件 → `test/opencode-hook-installer.test.js:17-32` PASS
  - 不覆盖：已存在 plugin 文件时返回 `{ installed: false, reason: 'already_exists' }` → `test/opencode-hook-installer.test.js:34-47` PASS
  - HOOK_ENABLED=false：返回 `{ installed: false, reason: 'disabled' }` → `test/opencode-hook-installer.test.js:49-60` PASS
  - 默认路径：未传入 opencodeConfigDir 时使用 `~/.config/opencode/plugins/walker-hook.js` → `test/opencode-hook-installer.test.js:62-81` PASS
  - plugin 内容：包含 `session.created`、`127.0.0.1`、`/opencode/hook/session-created`，不含 token → `test/opencode-hook-installer.test.js:83-101` PASS
  - bootstrap 集成：`src/app/bootstrap.js:273` 调用 `installHookPlugin` → 构建检查 PASS

### REQ-002: HTTP 端点接收 plugin 上报，按 cwd 找 routeKey 创建 Walker session 并加入 route
- **状态**: PASS
- **验证**:
  - 正常流程：上报 session.created 并按 cwd 精确匹配 route → `test/opencode-hook-receiver.test.js:87-114` PASS
  - 子目录匹配：cwd 匹配子目录 route → `test/opencode-hook-receiver.test.js:116-139` PASS
  - 幂等：重复上报同一 opencodeSessionId 返回相同 walkerSessionId → `test/opencode-hook-receiver.test.js:141-170` PASS
  - 游离 session：无匹配 cwd 时创建游离 session（routeKey=null）→ `test/opencode-hook-receiver.test.js:172-197` PASS
  - 多候选选最近活跃 → `test/opencode-hook-receiver.test.js:199-226` PASS
  - 参数验证：缺少 sessionId/cwd 返回 400 → `test/opencode-hook-receiver.test.js:228-256` PASS
  - E2E 路由可达 → `test/opencode-hook-receiver.test.js:526-661` PASS
  - 跨模块串联到消息派发 → `test/integration-hook-routing.test.js:67-160` PASS

### REQ-003: SessionService routes 结构升级为 { focusSessionId, sessions[], cwd }
- **状态**: PASS
- **验证**:
  - addSessionToRoute 新增 session → `test/session-service.test.js:450` PASS
  - getCurrent 返回焦点 session → `test/session-service.test.js:451` PASS
  - setFocus 切换焦点 → `test/session-service.test.js:452` PASS
  - setFocus 拒绝不在 sessions 列表的 sessionId → `test/session-service.test.js:453` PASS
  - removeSessionFromRoute 移除焦点后自动切 → `test/session-service.test.js:454` PASS
  - removeSessionFromRoute 移除最后一个 session 后删除 route → `test/session-service.test.js:455` PASS
  - listSessionsInRoute 列出 route 下所有 session（焦点在前）→ `test/session-service.test.js:456` PASS
  - getRouteCwd/setRouteCwd → `test/session-service.test.js:458-460` PASS
  - createSession 带 route 时加入 sessions 列表 → `test/session-service.test.js:461` PASS
  - deleteSession 从 route sessions 移除并自动切焦点 → `test/session-service.test.js:462` PASS
  - getRouteForSession 遍历 sessions 数组查找 → `test/session-service.test.js:463` PASS
  - 旧单值 routes 格式自动迁移 → `test/session-service.test.js:449` PASS
  - unbindRoute 从 sessions 列表移除焦点 session → `test/session-service.test.js:464` PASS

### REQ-004: Dispatcher /use 切焦点、/list 列 route session、非焦点输出带标识
- **状态**: PASS
- **验证**:
  - /use 切焦点（调用 setFocus 而非 bindRoute）→ `test/message-dispatcher.test.js:1155` PASS
  - /use 不在 sessions 列表的 id 返回错误 → `test/message-dispatcher.test.js:1183` PASS
  - /use off 移除焦点 session → `test/message-dispatcher.test.js:1207-1250` PASS
  - /list 列 route 下多 session（焦点在前）→ `test/message-dispatcher.test.js:1253` PASS
  - 非焦点 session 输出带 [session: <id前8位>] 前缀 → `test/message-dispatcher.test.js:1331` PASS
  - 焦点 session 输出不带前缀 → `test/message-dispatcher.test.js:1355` PASS
  - nonFocusOutput=false 非焦点静默 → `test/message-dispatcher.test.js:1378` PASS
  - 跨模块串联 → `test/integration-hook-routing.test.js:165-262` PASS

### REQ-005: 心跳轮询检测 OpenCode detached，取消 turn 并从 route 移除，自动切焦点
- **状态**: PASS
- **验证**:
  - track 启动独立轮询 → `test/opencode-hook-health-poller.test.js:77` PASS
  - untrack 停止轮询 → `test/opencode-hook-health-poller.test.js:101` PASS
  - 单次失败不判定 detached → `test/opencode-hook-health-poller.test.js:126` PASS
  - detached 取消 turn 并移除 route → `test/opencode-hook-health-poller.test.js:152` PASS
  - 焦点 detached 自动切下一个 session → `test/opencode-hook-health-poller.test.js:184` PASS
  - exitAction=none 不取消 turn → `test/opencode-hook-health-poller.test.js:216` PASS
  - 无 running turn 时退出不报错 → `test/opencode-hook-health-poller.test.js:245` PASS
  - stop 清空所有追踪 → `test/opencode-hook-health-poller.test.js:273` PASS
  - track 幂等 → `test/opencode-hook-health-poller.test.js:302` PASS
  - health 端点 URL 正确拼接 /global/health → `test/opencode-hook-health-poller.test.js:324` PASS
  - 跨模块 cascade 串联 → `test/integration-hook-routing.test.js:267-355` PASS

### REQ-006: 飞书卡片 /list 加"设为焦点"按钮
- **状态**: PASS
- **验证**:
  - 非焦点 session 有"设为焦点"按钮（value=`cmd:/use <id>`，type=primary）→ `test/feishu-cards.test.js:45-60` PASS
  - 焦点 session 标记"已聚焦"（type=default）→ `test/feishu-cards.test.js:62-73` PASS
  - 设为焦点按钮携带 routeKey → `test/feishu-cards.test.js:75-83` PASS

### REQ-007: 4 个新配置项
- **状态**: PASS
- **验证**:
  - WALKER_OPENCODE_HOOK_ENABLED 默认 true + 自定义解析 → `test/config-env.test.js:109-119` PASS
  - WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS 默认 5000 + 自定义 + 无效值回落 → `test/config-env.test.js:121-135` PASS
  - WALKER_OPENCODE_EXIT_ACTION 默认 cancel + 自定义 → `test/config-env.test.js:137-145` PASS
  - WALKER_OPENCODE_NON_FOCUS_OUTPUT 默认 true + 自定义 → `test/config-env.test.js:147-157` PASS
  - 4 个配置项在 EDITABLE_ENV_KEYS 白名单 → `test/config-env.test.js:159` PASS

### REQ-008: /status 显示 route 下多 session 状态
- **状态**: PASS
- **验证**:
  - /status 显示 Route、Active sessions、Focus、Other → `test/message-dispatcher.test.js:1283-1313` PASS
  - /status 无 session 时显示未绑定提示 → `test/message-dispatcher.test.js:1315-1327` PASS

### REQ-009: 安全约束（loopback + admin token）
- **状态**: PASS
- **验证**:
  - 非 loopback 请求返回 403 → `test/opencode-hook-receiver.test.js:258-274` PASS
  - IPv6 loopback ::1 放行 → `test/opencode-hook-receiver.test.js:276-294` PASS
  - 配置 token 时无 token 请求返回 401 → `test/opencode-hook-receiver.test.js:296-312` PASS
  - 配置 token 时携带正确 token 放行 → `test/opencode-hook-receiver.test.js:314-333` PASS
  - 直接传 adminConfig（无 .admin 属性）token 鉴权生效 → `test/opencode-hook-receiver.test.js:335-365` PASS
  - E2E loopback 和 token 鉴权 → `test/opencode-hook-receiver.test.js:555-621` PASS
  - plugin 文件不含 token → `test/opencode-hook-installer.test.js:83-94` PASS

### REQ-010: README 更新
- **状态**: PASS
- **验证**:
  - README 包含 1:N session 路由说明 → `README.md:106-126`（1:N Session 路由章节）
  - README 包含 hook plugin 说明 → `README.md:86-104`（OpenCode 自动纳入章节）
  - README 包含退出行为说明 → `README.md:128-138`（OpenCode 退出行为章节）
  - README 包含 4 个配置项说明 → `README.md:79-82`（配置表格）
  - 命令清单 /use 描述更新为切焦点 → `README.md:124-126`

## 编译和静态分析

- BUILD_CMD: `node --check`（逐文件语法检查，覆盖所有 src/ 和 test/ 文件）+ `node --test test/*.test.js`
- BUILD_CMD: ✅（退出码 0，587 个测试全部通过）

## 结论

- **全部 PASS** → 通过

## Evidence Receipt

- evidence-command: `npm test`
- evidence-exit-code: `0`
- evidence-file: `evidence/test.log`
- evidence-sha256: `10C9CA22AA7C386995E7D6A5B76B207AB0C35F4EE7B75DC086D45695648DCAAA`

verdict: PASS
