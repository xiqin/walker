# 飞书与 OpenCode TUI 消息同步修复 — 测试报告

## 测试概览

- 总 Requirement 数：3
- 通过：3
- 失败：0
- 警告：0

## 集成测试

### 集成测试 1: 飞书-TUI 双向链路

- **涉及模块**: MessageDispatcher → OpencodeDriver/Watcher → FeishuApi
- **状态**: PASS
- **测试结果**:
  - 入站 thread 消息 → prompt：✅
  - Thread fallback 到群根 route：✅
  - Watch 回复出站 → sendText：✅
  - 去重（相同文本不重复发送）：✅
  - Chat 隔离（不误投递到其他 chatId）：✅
  - Session 隔离（不跨 session 重复）：✅

## 回归测试

- **测试命令**: `npm test`
- **总测试数**: 620
- **通过**: 620
- **失败**: 0
- **跳过**: 0

### 新增代码引起的失败

无

### 预先存在的失败（标记为 WARN）

无

## 接口验证详情

### REQ-001: 飞书入站消息立即进入已 attach 的 OpenCode 会话

- **路径**: `handleIncomingMessage` → `_enqueuePrompt`
- **状态**: PASS
- **测试结果**:
  - Thread route 回退到同群根 route：✅
  - 已绑定线程 route 优先：✅
  - 双重未绑定时发送引导卡片：✅
  - 回退后 driver.prompt 使用正确 agentRef：✅
  - 集成测试入站链路通畅：✅

### REQ-002: TUI 回复立即推送，不依赖下一条飞书消息

- **路径**: `OpencodeSessionWatcher` → `_resumePolling` → `handlers.onEvent` → `_handleWatchedSessionEvent` → `_sendFeishu('sendText')`
- **状态**: PASS
- **测试结果**:
  - Resume 后继续用原始回调投递轮询消息：✅
  - Pending assistant 消息完成后可投递，游标不跳过：✅
  - Resume 后不重复投递已处理消息：✅
  - 集成测试出站链路通畅：✅

### REQ-003: 保持现有行为不变

- **路径**: 全链路
- **状态**: PASS
- **测试结果**:
  - 消息去重正常：✅
  - Chat/session 隔离正常：✅
  - StopWatch 清理轮询定时器：✅
  - 全量测试无回归：✅

## 编译和静态分析

- `node --check src/index.js`: ✅

## 结论

verdict: PASS

## Evidence Receipt

- evidence-command: `node --test test/integration-feishu-tui-sync.test.js test/message-dispatcher.test.js test/opencode-driver.test.js`
- evidence-exit-code: 0
- evidence-file: `evidence/test.log`
- evidence-sha256: `0AC9C29813EAA677F16F877B9B4929C28CD29D71BC46FE3B5FF73D11DD4C2758`
