# 飞书 /clear 当前 TUI 清空上下文 — 测试报告

## 测试概览

- 总接口数（REQ-001..010）：10
- 通过：10
- 失败：0
- 警告：0

## 集成测试

集成测试文件：`test/integration-feishu-tui-sync.test.js`

### 集成测试 1: 飞书 /clear 在当前 TUI 创建空上下文（control 携带新 session ID）
- **涉及模块**: feishu commands → message-dispatcher → opencode-driver → bridge.clearSession → poll/reportEvents
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ delivery.type=clear，返回 cleared/oldSessionId/newSessionId/walkerSessionId，回复 "Cleared session"
  - 异常处理：✅（见后续错误恢复用例）
  - 数据一致性：✅ 新旧 session ID 正确对应

### 集成测试 2: clear 全链路不访问独立服务或 createSession
- **涉及模块**: opencode-driver → bridge（不触发 HTTP/SSE/createSession）
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ networkCalls=0，createSessionCalls=0
  - 异常处理：N/A
  - 数据一致性：✅ 不调用独立 OpenCode HTTP/SSE

### 集成测试 3: 关联 register 与 control 完成后 route 焦点切换（control-first / register-first）
- **涉及模块**: bridge.register → bridge.reportEvents → sessionService.setFocus
- **状态**: PASS（2 个用例，覆盖两种到达顺序）
- **测试结果**:
  - 正常流程：✅ 汇合前焦点保持旧 session，汇合后切换到新 session；runtime.currentSessionId 同步更新
  - 异常处理：✅ 部分到达不切换焦点
  - 数据一致性：✅ 原子切换，两种顺序结果一致

### 集成测试 4: clear 后旧 session 仍在 route 且可通过 setFocus 恢复
- **涉及模块**: sessionService.listSessionsInRoute → setFocus → getCurrent
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ 旧 session 保留在 route，status 非 stopped/deleted，setFocus 后可恢复
  - 异常处理：N/A
  - 数据一致性：✅ 旧 session 未被删除/停止/移出

### 集成测试 5: 新 session 继承 model 与 cwd
- **涉及模块**: bridge._tryCompleteClear → sessionService.updateSessionField / createSession
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ newWalker.model === 旧 model，cwd 来自关联 register
  - 异常处理：N/A
  - 数据一致性：✅ agentRef.opencodeSessionId 指向新 OpenCode session

### 集成测试 6: 注入无关普通 register 不阻断 clear 且不提前改变原 route 焦点
- **涉及模块**: bridge.register（普通 + 关联）→ clear 完成
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ 普通 register 聚焦自己的 session，clear 仍可后续完成并切换焦点
  - 异常处理：✅ 关联与普通 register 隔离
  - 数据一致性：✅ clear 完成后焦点正确

### 集成测试 7: 错误关联 ID 的 register 被拒绝且不回退为普通注册
- **涉及模块**: bridge.register（controlDeliveryId 校验）
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ 未知 controlDeliveryId 抛错
  - 异常处理：✅ 被拒绝后 route 焦点不变，不回退为普通 register
  - 数据一致性：✅

### 集成测试 8: 同一 runtime 并发 clear 在投递前失败且只创建一个新 OpenCode session
- **涉及模块**: dispatcher → bridge.clearSession（并发互斥）
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ 第二个 clear 被拒绝（busy/rejected/error），回复拒绝消息
  - 异常处理：✅ 只创建一个新 Walker session
  - 数据一致性：✅

### 集成测试 9: stale runtime 与运行中 clear 保持旧焦点
- **涉及模块**: bridge.clearSession → runtime 心跳校验
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ stale runtime 返回 error，旧焦点不变
  - 异常处理：✅
  - 数据一致性：✅

### 集成测试 10: 运行中 /clear 在 route lock 外立即提示先 /cancel
- **涉及模块**: dispatcher._preflightClear → turnStates 检查
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ 运行中立即拒绝（busy/rejected），回复含 "cancel"
  - 异常处理：✅ 拒绝后旧焦点不变，不会排队后自动执行
  - 数据一致性：✅

### 集成测试 11: clear error 可恢复（旧焦点不变，pending 清理）
- **涉及模块**: bridge.reportEvents(error) → clearSession reject
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ error 返回错误
  - 异常处理：✅ 旧焦点不变，_clearPending.size=0
  - 数据一致性：✅

### 集成测试 12: clear 超时可恢复（旧焦点不变，pending 清理）
- **涉及模块**: bridge.clearSession → timer 超时
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ 超时返回 error
  - 异常处理：✅ 旧焦点不变，_clearPending.size=0
  - 数据一致性：✅

### 集成测试 13: 超时后迟到 control 与关联 register 均不切换焦点
- **涉及模块**: bridge.reportEvents / register（超时后拒绝）
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ 迟到 control 和 register 均抛错
  - 异常处理：✅ 焦点不变
  - 数据一致性：✅

### 集成测试 14: clear 后现有 prompt 双向链路仍正常工作
- **涉及模块**: dispatcher.handleIncomingMessage → bridge.poll/reportEvents → feishu reply
- **状态**: PASS
- **测试结果**:
  - 正常流程：✅ clear 后 prompt delivery.type=prompt，回复回到飞书
  - 异常处理：N/A
  - 数据一致性：✅ 新 session 的双向链路正常

### 集成测试补充说明

`test/integration-feishu-tui-sync.test.js` 中 `/clear` 全链路集成测试共 14 个 `it()` 声明（其中 "关联 register 与 control 完成" 用 `for...of` 循环展开为 2 个用例），实际执行 15 个 /clear 集成测试用例。结合 `test/opencode-tui-bridge.test.js` 中 14 个 `clearSession` 单元测试，spec 中 REQ-001..010 的关键端到端流程均已覆盖，无需补充。

## 回归测试

- **测试命令**: npm test
- **总测试数**: 710
- **通过**: 710
- **失败**: 0
- **跳过**: 0
- **取消**: 0
- **todo**: 0
- **耗时**: 8240.21ms
- **退出码**: 0

### 新增代码引起的失败

无。

### 预先存在的失败（标记为 WARN）

无。全部测试通过。

## 接口验证详情

### REQ-001: /clear 可解析且出现在 /help
- **状态**: PASS
- **代码实现**: `src/platform/feishu/commands.js:13` 注册 `clear: { desc: '在当前 TUI 新建空上下文并保留旧会话', usage: '/clear' }`；`src/dispatch/message-dispatcher.js:233` `handleCommand` 中 `clear` 分支可解析
- **测试覆盖**: `test/feishu-commands.test.js` 验证命令注册；`test/message-dispatcher.test.js` 验证 handleCommand clear 分支
- **README**: `README.md:164` 命令表包含 `/clear` 说明

### REQ-002: 在当前 TUI 创建空上下文
- **状态**: PASS
- **代码实现**: `bridge.clearSession` 投递 `type:'clear'` delivery（`bridge.js:175`）；插件 `plugin-template.js:200` 调用 `api.client.session.create({ title })` 创建顶层 session
- **测试覆盖**: 集成测试 1 验证 delivery.type=clear 且新 session 创建成功

### REQ-003: 保持当前终端和 TUI runtime
- **状态**: PASS
- **代码实现**: `opencode-driver.js` clearSession 委托 bridge，不触发 HTTP create/openTerminal；bridge 复用同一 runtimeId
- **测试覆盖**: 集成测试 2 验证 networkCalls=0、createSessionCalls=0；集成测试 3 验证新旧 session 使用同一 runtimeId

### REQ-004: 将当前 TUI 导航到新 session
- **状态**: PASS
- **代码实现**: `plugin-template.js:216` 调用 `api.route.navigate('session', { sessionID: newSessionId })`
- **测试覆盖**: 集成测试 1、3 验证 clear 成功后 TUI 导航到新 session（通过 control.newSessionId 上报验证）

### REQ-005: 原子更新 Walker route 焦点
- **状态**: PASS
- **代码实现**: `bridge.js:314-364` `_tryCompleteClear` 在 registerCompleted && controlCompleted 双条件满足后才提交 runtime、加入 route、设焦点
- **测试覆盖**: 集成测试 3（control-first/register-first 两种顺序）验证汇合前焦点不变、汇合后原子切换

### REQ-006: 保留旧会话
- **状态**: PASS
- **代码实现**: `bridge.js:359-362` 新 session addSessionToRoute + setFocus，不删除/停止/移出旧 session
- **测试覆盖**: 集成测试 4 验证旧 session 仍在 route、status 非 stopped/deleted、可 setFocus 恢复

### REQ-007: 继承会话设置
- **状态**: PASS
- **代码实现**: `bridge.js:355-356` 继承旧 model；`bridge.js:331` cwd 来自关联 register 上报的 registeredCwd
- **测试覆盖**: 集成测试 5 验证 newWalker.model === 旧 model、cwd === 关联 register cwd

### REQ-008: 明确拒绝不支持场景
- **状态**: PASS
- **代码实现**: `message-dispatcher.js:272-297` 锁外预检（无绑定/running/活动 turn/pending queue/并发 clear）；`bridge.js:175` clearSession 校验 transport/stale runtime
- **测试覆盖**: 集成测试 8（并发 clear 拒绝）、9（stale runtime）、10（运行中立即提示 /cancel）；bridge 单元测试覆盖无效 transport、旧 session 拒绝

### REQ-009: 创建失败可恢复
- **状态**: PASS
- **代码实现**: `bridge.js:396-400` _failClear 清理 pending 并 reject；`plugin-template.js:267-283` 失败时最佳努力导航回旧 session，回滚失败提示手工切回
- **测试覆盖**: 集成测试 11（error 恢复）、12（超时恢复）、13（迟到事件拒绝）验证旧焦点不变、pending 清理

### REQ-010: 文档与回归测试
- **状态**: PASS
- **代码实现**: `README.md:164` 命令表说明 `/clear` 语义（适用范围、/cancel 前置、/list+/use 恢复）
- **测试覆盖**: `npm test` 全量 710 测试通过，0 失败；命令、dispatcher、bridge、插件测试均通过

## 编译和静态分析

- BUILD_CMD (`node --check src/index.js`): ✅（退出码 0）
- VET_CMD: ✅（npm test 包含语法检查，全部通过）

## 结论

- **全部 PASS** → 通过

所有 10 个 REQ 均有代码实现和测试覆盖，710 个回归测试全部通过，编译检查通过，README 已更新。无失败、无警告。

## Evidence Receipt

- evidence-command: `npm test`
- evidence-exit-code: 0
- evidence-file: evidence/test.log
- evidence-sha256: 956c7d83a5bab64aef7905817af41c3dc85a70d9d8e4254fd42c40d4ba3c2b41
- evidence-size: 622156 bytes
- evidence-tests-total: 710
- evidence-tests-pass: 710
- evidence-tests-fail: 0
- evidence-tests-skipped: 0

verdict: PASS
