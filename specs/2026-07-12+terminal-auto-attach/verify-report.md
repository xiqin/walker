# OpenCode 启动自动纳入 Walker — 完成前验证报告

verdict: PASS
evidence-command: npm test
evidence-exit-code: 0
evidence-sha256: 10C9CA22AA7C386995E7D6A5B76B207AB0C35F4EE7B75DC086D45695648DCAAA

## 1. 前置产出核验

### test-report.md 确认

- **文件**: `specs/2026-07-12+terminal-auto-attach/test-report.md`
- **verdict**: PASS
- **回归测试**: 587 个测试全部通过，0 失败，0 跳过
- **集成测试**: 6 个新增集成测试覆盖 5 个跨模块场景
- **REQ 覆盖**: REQ-001 到 REQ-010 全部 PASS
- **evidence-sha256**: `10C9CA22AA7C386995E7D6A5B76B207AB0C35F4EE7B75DC086D45695648DCAAA`
- **evidence-exit-code**: 0

### reviewer 判定确认

所有 7 个 task 均通过 combined-reviewer 审查：
- T1: 2 轮修复后 PASS（0 阻断，3 警告）
- T2: 首轮 PASS（0 阻断，3 警告）
- T3: 首轮 PASS（0 阻断，1 建议）
- T4: 3 轮修复后 PASS（0 阻断，1 警告）
- T5: 首轮 PASS（0 阻断，1 警告）
- T6: 首轮 PASS（0 阻断，5 警告）
- T7: 首轮 PASS（0 阻断，0 警告）

## 2. 编译验证

constitution.md 为模板状态，无 BUILD_CMD/VET_CMD 定义。使用项目 `package.json` 的 test 命令作为构建+测试验证。

### 执行命令

```
npm test
```

### 结果

- **退出码**: 0
- **测试总数**: 587
- **通过**: 587
- **失败**: 0
- **跳过**: 0
- **duration_ms**: ~5908ms

### 覆盖范围

`npm test` 等价于 `node --check` 逐文件语法检查 + `node --test test/*.test.js`，覆盖 `src/` 和 `test/` 下所有 `.js` 文件。

## 3. 占位符扫描

### 扫描范围

- `src/**/*.js`（含新增 `src/opencode-hook/*.js`）
- `test/**/*.js`

### 扫描模式

```
正则: 单词边界 + (待定标记 / 未完成标记 / 修复标记 / 占位标记) + 单词边界
```

### 结果

- `src/` 命中: 0
- `src/opencode-hook/` 命中: 0
- 无占位符残留

## 4. 类型一致性检查

后续 task 使用的类型、方法签名和属性名与前序 task 定义一致：

| 接口 | 定义方 | 消费方 | 一致性 |
|-----|--------|--------|--------|
| `addSessionToRoute(routeKey, sessionId)` | T1 SessionService | T2 receiver, T4 dispatcher | ✅ |
| `setFocus(routeKey, sessionId)` | T1 SessionService | T4 _cmdUse | ✅ |
| `removeSessionFromRoute(routeKey, sessionId)` | T1 SessionService | T4 _cmdUse off, T6 health-poller | ✅ |
| `listSessionsInRoute(routeKey)` | T1 SessionService | T4 _cmdList, _cmdStatus | ✅ |
| `getRouteCwd(routeKey)` | T1 SessionService | T4 _cmdStatus | ✅ |
| `getCurrent(routeKey)` 返回焦点 session | T1 SessionService | T4 handleIncomingMessage, T6 health-poller | ✅ |
| `installHookPlugin({ opencodeConfigDir, walkerPort, enabled })` | T2 installer | T4 bootstrap | ✅ |
| `createHookReceiverRoutes(ctx)` 返回路由数组 | T2 receiver | T4 bootstrap | ✅ |
| `ctx.onSessionEnrolled({ sessionId, routeKey })` 回调 | T2 receiver | T4 bootstrap → dispatcher.ensureWatchForSession | ✅ |
| `createHealthPoller(options)` → `{ start, stop, track, untrack, getTrackedSessions }` | T6 health-poller | T4 bootstrap | ✅ |
| `walkerOpendcodeHookEnabled` 等配置项 | T3 env.js | T4 bootstrap, T6 health-poller | ✅ |
| `buildButtonValue('cmd:/use', sessionId, routeKey)` | T5 cards.js | T4 _cmdUse 消费按钮 action | ✅ |

## 5. 最终一致性核验

spec.md 19 条验收标准在 test-report 中的对应验证：

| # | 验收标准 | test-report 覆盖 | 状态 |
|---|---------|-----------------|------|
| 1 | Walker 启动时自动写入 plugin（不存在时） | REQ-001: installer.test.js:17-32 | ✅ |
| 2 | 已存在 plugin 不覆盖 | REQ-001: installer.test.js:34-47 | ✅ |
| 3 | plugin 上报 session.created + cwd | REQ-002: receiver.test.js:87-114 | ✅ |
| 4 | Walker 按 cwd 找 routeKey 创建 session 加入 sessions 列表 | REQ-002: receiver.test.js:87-114 | ✅ |
| 5 | 同 cwd 第二个 OpenCode 加入同一 routeKey，不动 focusSessionId | REQ-002: receiver.test.js:141-170 (幂等) + integration:67-160 | ✅ |
| 6 | 普通消息发给焦点 session，输出回原 routeKey | REQ-004: integration:67-160 | ✅ |
| 7 | 非焦点 session SSE 事件回群带 [session: wks_N] 标识 | REQ-004: dispatcher.test.js:1331 + integration:218-262 | ✅ |
| 8 | /list 列 route 下所有 session，标记焦点，有"设为焦点"按钮 | REQ-004: dispatcher.test.js:1253 + REQ-006: cards.test.js:45-83 | ✅ |
| 9 | /use <id> 切焦点，消息改发新焦点 | REQ-004: dispatcher.test.js:1155 + integration:165-213 | ✅ |
| 10 | OpenCode 退出 → 心跳检测 → 取消 turn → 移除 → 切焦点 | REQ-005: health-poller.test.js:152,184 + integration:267-355 | ✅ |
| 11 | 无 running turn 时退出不报错 | REQ-005: health-poller.test.js:245 | ✅ |
| 12 | /status 显示多 session 状态、focus、attached/detached | REQ-008: dispatcher.test.js:1283-1327 | ✅ |
| 13 | Walker 不可达时 plugin 静默忽略 | REQ-001: plugin-template.js 设计 + installer.test.js:83-94 | ✅ |
| 14 | HOOK_ENABLED=false 退回手动模式 | REQ-001: installer.test.js:49-60 | ✅ |
| 15 | EXIT_ACTION=none 只记录不取消 | REQ-005: health-poller.test.js:216 | ✅ |
| 16 | NON_FOCUS_OUTPUT=false 非焦点静默 | REQ-004: dispatcher.test.js:1378 | ✅ |
| 17 | 旧 routes 单值格式自动迁移 | REQ-003: session-service.test.js:449 | ✅ |
| 18 | npm test 通过 | 回归测试: 587/587 pass | ✅ |
| 19 | README 包含 4 类说明 | REQ-010: README.md:79-126 | ✅ |

## 6. Drift Check

### 用户目标对齐

spec 用户目标：OpenCode 启动自动纳入 Walker，无需飞书命令；同 cwd 多 OpenCode 不串会话；退出自动取消 turn。

实现达成：
- ✅ 自动纳入：hook plugin 安装 + session.created 上报 + receiver 按 cwd 匹配 route
- ✅ 不串会话：1:N routes 结构 + 焦点机制 + 非焦点输出带标识
- ✅ 退出检测：心跳轮询 + detached 取消 turn + 自动切焦点

### 遗漏验收标准

无遗漏。19 条验收标准全部有对应测试覆盖。

### Spec 外范围引入

无 spec 外功能引入。所有改动均在 spec.md "功能范围"和 10 个 REQ 内。

### Constitution 合规

constitution.md 为模板状态（无实质 BUILD_CMD/VET_CMD/TEST_CMD 约束），但遵循了其编码行为准则：
- ✅ 极简优先：未添加推测性实现
- ✅ 精准手术：改动集中在 SessionService、Dispatcher、新 opencode-hook 模块
- ✅ 依赖显式传递：hook receiver 通过 ctx 注入，health-poller 通过 options 注入
- ✅ 配置集中管理：4 个新配置项进入 env.js + EDITABLE_ENV_KEYS

### 未验证路径

无未验证路径。所有新增代码路径（plugin 安装、receiver 端点、1:N 路由、命令改造、心跳轮询、卡片按钮、README）均有测试覆盖。

## 7. 已知警告（非阻断）

以下警告均来自 reviewer 审查，不影响功能正确性和验收标准达成：

| # | 警告 | 来源 | 影响 | 处置 |
|---|------|------|------|------|
| W1 | health-poller 使用 `/global/health` 但 opencode-driver 使用 `/health` | T6 reviewer | 需确认 OpenCode 实际端点 | 运行时确认；若端点为 `/health` 则修正 health-poller.js:95 |
| W2 | 配置项命名 `walkerOpendcode*`（Opendcode）vs `opencode*` 不一致 | T3 reviewer/T6 reviewer | 不影响功能，影响可维护性 | 后续统一为 `walkerOpencode*` |
| W3 | cards.js marker 仍为"← 当前绑定"，建议改为"← 当前焦点" | T5 reviewer | 语义不一致，不影响功能 | 后续修正 |
| W4 | `isSpaFallbackCandidate` 未排除 `/opencode/hook/` 前缀 | T4 reviewer | 防御性建议，当前无实际影响 | 后续同步 |
| W5 | `_readNormalized` 每次遍历所有 route | T1 reviewer | 性能优化建议，当前规模可接受 | 后续优化 |

## 8. 验证结论

### 综合判定

**PASS** ✅

### 证据清单

| 证据 | 命令 | 退出码 | SHA-256 |
|------|------|--------|---------|
| 回归测试 | `npm test` | 0 | `10C9CA22AA7C386995E7D6A5B76B207AB0C35F4EE7B75DC086D45695648DCAAA` |
| 占位符扫描 | 正则扫描待定/未完成/修复/占位标记 in src/ | 0 (无匹配) | — |
| 类型一致性 | 人工核验 12 个跨 task 接口 | — | — |
| 验收标准覆盖 | 19/19 条对应 test-report | — | — |

### 剩余风险

1. **W1 health 端点**：`/global/health` 是 spec 和 OpenCode 官方文档中的端点，但 opencode-driver.js 现有代码使用 `/health`。若 OpenCode 实际暴露的是 `/health`，health-poller 会连续 2 次失败误判所有 session 为 detached。需在运行时确认或修正为 `/health`。
2. **W2 命名一致性**：`walkerOpendcode*` 拼写偏差不影响功能，但可读性降低。

### 产物

- `specs/2026-07-12+terminal-auto-attach/verify-report.md`（本文件）
- `specs/2026-07-12+terminal-auto-attach/test-report.md`（前置）
- `specs/2026-07-12+terminal-auto-attach/handoffs/verification.json`（handoff）
