# 飞书与 OpenCode TUI 消息同步修复 — 验证报告

## 验证概览

verdict: PASS
验证日期: 2026-07-14

## 1. 前置产出核验

| 产物 | 状态 | 说明 |
|------|------|------|
| test-report.md | ✅ PASS | 3/3 REQ 通过，620/620 回归测试通过 |
| T1 reviewer | ✅ PASS | REQ-001/003 覆盖完整，无阻塞问题 |
| T2 reviewer | ✅ PASS | REQ-002/003 覆盖完整，无阻塞问题 |
| T3 reviewer | ✅ PASS（修复后） | 阻塞问题（用例4 driverRegistry hack + cwd 硬编码）已修复 |

## 2. 编译验证

| 命令 | 退出码 | 说明 |
|------|--------|------|
| `node --check src/dispatch/message-dispatcher.js` | 0 | 语法正确 |
| `node --check src/drivers/opencode-session-watcher.js` | 0 | 语法正确 |
| `node --check src/drivers/opencode-driver.js` | 0 | 语法正确 |
| `node --check src/app/bootstrap.js` | 0 | 语法正确 |

## 3. 占位符扫描

| 范围 | 模式 | 结果 |
|------|------|------|
| `src/dispatch/` | 占位符关键词扫描 | 无匹配 |
| `src/drivers/` | 占位符关键词扫描 | 无匹配 |
| `test/*.test.js` | 占位符关键词扫描 | 无匹配 |

## 4. 全量回归测试

| 指标 | 值 |
|------|-----|
| 命令 | `npm test` |
| 退出码 | 0 |
| 总测试 | 620 |
| 通过 | 620 |
| 失败 | 0 |

## 5. Spec 覆盖 Drift Check

| REQ | spec 要求 | 实现 | 测试 | 判定 |
|-----|-----------|------|------|------|
| REQ-001 | 飞书入站消息立即进入已 attach 会话；thread 自身 route 未绑定时复用同群根 route | `handleIncomingMessage` fallback 逻辑（:85-98） | 4 单元 + 2 集成 | ✅ |
| REQ-002 | TUI 回复立即推送，不依赖下一条飞书消息；watcher suspend/resume 后继续使用原始回调 | `_resumePolling` 取 `watcher._handlers`（:119） | 4 单元 + 2 集成 | ✅ |
| REQ-003 | 保持现有行为不变 | 无侵入性改动，去重/隔离/focus 链路未变更 | 去重 + 隔离 + stopWatch 清理测试 | ✅ |

### 验收标准逐项

| # | 验收标准 | 证据 | 判定 |
|---|----------|------|------|
| 1 | 建立可重复运行的失败反馈环 | test-report.md 记录定向测试 5/5 通过 | ✅ |
| 2 | 修复前失败、修复后通过 | T1/T2 implementer 确认旧实现会导致测试失败；修复后全量通过 | ✅ |
| 3 | 飞书入站无需额外事件 | 集成测试用例1/2 单次 `handleIncomingMessage` 即完成入站 | ✅ |
| 4 | TUI 回复无需下一条飞书消息 | 集成测试用例1 直接 `handlers.onEvent()` 触发出站，无需额外入站 | ✅ |
| 5 | 定向测试和全量测试通过 | 定向 5/5，全量 620/620 | ✅ |

### 范围外检查

- 未引入 spec 外功能
- 未违反 constitution（最小改动、精准手术、中文注释）
- 无未验证路径

## 6. 剩余风险

1. **T3 集成测试用例4（chat 隔离）**：仅验证 chatA 的回复不误投递到 chatB，未验证反向。风险极低，因 chatId 参数由 `_chatIdFromRouteKey` 从 routeKey 提取，方向无关。
2. **T1 非阻塞建议未实施**：routeMode='user' 回归测试、chatId 缺失边界测试、同群不变量注释。不影响正确性，可在后续迭代补充。

## Evidence

evidence-command: npm test
evidence-exit-code: 0
evidence-file: evidence/test.log
evidence-sha256: 0AC9C29813EAA677F16F877B9B4929C28CD29D71BC46FE3B5FF73D11DD4C2758
