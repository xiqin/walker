# 测试报告 — SSE Events Forwarding（原生提问同步到飞书）

- **规格**: `specs/2026-07-16-sse-events-forwarding/spec.md`
- **报告日期**: 2026-07-20
- **执行者**: test-reporter refresh
- **任务范围**: T1–T7 全部完成；SDK `question.reply` 能力探测修复已纳入插件测试；集成测试与全量回归均通过

---

## 1. 执行命令与结果

### 1.1 全量回归测试

| 项 | 值 |
| --- | --- |
| 命令 | `npm test` |
| 退出码 | **0** |
| suites | 63 |
| tests | 995 |
| pass | **995** |
| fail | 0 |
| cancelled | 0 |
| skipped | 0 |
| duration_ms | 11934.0602 |
| evidence | `specs/2026-07-16-sse-events-forwarding/evidence/test.log` |
| evidence 字节数 | 912324 |
| evidence SHA-256 | `7ab6620fe78ab4927e23ab62b3099ec10b65bb7add94d5aa2501e6c0100bf878` |

全量回归测试已恢复为绿色信号。此前旧 plugin-template 断言和 Bridge replyQuestion 父套件 pending/cancelled 问题已修复；本次刷新没有失败、取消或跳过用例。

### 1.2 集成测试（定向）

| 项 | 值 |
| --- | --- |
| 命令 | `node --test test/integration-feishu-question.test.js` |
| 退出码 | **0** |
| suites | 1 |
| tests | 6 |
| pass | **6** |
| fail | 0 |
| cancelled | 0 |

集成测试套件 `集成测试: 原生 question protocol v4` 下 6 个用例全部通过：

1. 由原始飞书卡片回调经平台和 bootstrap adapter 逐题收集，并只调用一次原生 SDK。
2. 本地 TUI replied/rejected 抢先，重复和并发飞书卡片回调不会产生第二次原生回复。
3. accepted 前失败可安全重试，accepted 后租约丢失收敛为 processed_unknown 且不可重试。
4. protocol v3 的 QUESTION_REPLY_UNSUPPORTED 降级为 feishu_unavailable，并提示在本地 TUI 回答。
5. 父 prompt busy 时由真实插件 poll、accepted 和 SDK question.reply 完成控制 delivery，且保留父 prompt 与队列顺序。
6. 真实 Driver 的 permission 回复失败会经飞书 /permit 回调显示错误，同时普通 prompt 与 clear 保持回归。

### 1.3 插件能力探测测试

| 项 | 值 |
| --- | --- |
| 命令 | `node --test test/opencode-hook-installer.test.js` |
| 退出码 | **0** |
| tests | 40 |
| pass | **40** |

新增用例覆盖 `api.client.question?.reply` 缺失时的安全降级：插件在 SDK 调用前返回 `QUESTION_REPLY_UNSUPPORTED`，`deliveryPhase='queued'`、`sdkInvoked=false`、`safeToRetry=false`，不会调用 `promptAsync`，Walker 侧可降级为 `feishu_unavailable`。

---

## 2. REQ 接口验证详情（18 项）

对照 `spec.md` §2 的 18 个 REQ，基于 T1–T7 handoff、各任务定向测试文件与集成测试用例逐一核验测试覆盖。

| REQ | 功能点 | 覆盖任务 | 覆盖测试文件 / 用例 | 状态 |
| --- | --- | --- | --- | --- |
| REQ-001 | 转发原生提问事件 | T1, T2, T3, T6 | `test/agent-driver-schema.test.js`；`test/opencode-tui-bridge.test.js`；`test/opencode-hook-installer.test.js`；`test/integration-feishu-question.test.js` 用例1；`test/question-handler.test.js` | PASS |
| REQ-002 | 为每个问题发送飞书卡片 | T5, T6 | `test/feishu-cards.test.js`；`test/question-handler.test.js`；`test/integration-feishu-question.test.js` 用例1 | PASS |
| REQ-003 | 支持单选答案 | T5, T6 | `test/feishu-cards.test.js`；`test/question-handler.test.js`；`test/integration-feishu-question.test.js` 用例1 | PASS |
| REQ-004 | 支持多选答案 | T5, T6 | `test/feishu-cards.test.js`；`test/question-handler.test.js`；`test/integration-feishu-question.test.js` 用例1 | PASS |
| REQ-005 | 支持自定义答案 | T5, T6 | `test/feishu-cards.test.js`；`test/question-handler.test.js`；`test/integration-feishu-question.test.js` 用例1 | PASS |
| REQ-006 | 完整回复多问题请求 | T6, T7 | `test/question-handler.test.js`；`test/integration-feishu-question.test.js` 用例1 | PASS |
| REQ-007 | 执行原生 question reply delivery | T2, T3, T4 | `test/opencode-tui-bridge.test.js`；`test/opencode-hook-installer.test.js`；`test/opencode-driver.test.js`；`test/integration-feishu-question.test.js` 用例1/5 | PASS |
| REQ-008 | 同步本地 TUI 抢先回复 | T1, T2, T6, T7 | `test/agent-driver-schema.test.js`；`test/opencode-tui-bridge.test.js`；`test/question-handler.test.js`；`test/integration-feishu-question.test.js` 用例2 | PASS |
| REQ-009 | 同步拒绝事件 | T1, T6, T7 | `test/agent-driver-schema.test.js`；`test/question-handler.test.js`；`test/integration-feishu-question.test.js` 用例2 | PASS |
| REQ-010 | 幂等与并发保护 | T6, T7 | `test/question-handler.test.js`；`test/integration-feishu-question.test.js` 用例2 | PASS |
| REQ-011 | 提交失败安全收敛 | T2, T3, T4, T6, T7 | `test/opencode-tui-bridge.test.js`；`test/opencode-hook-installer.test.js`；`test/opencode-driver.test.js`；`test/question-handler.test.js`；`test/integration-feishu-question.test.js` 用例3 | PASS |
| REQ-012 | 保持 permission 链路兼容 | T4, T6, T7 | `test/opencode-driver.test.js`；`test/permission-handler.test.js`；`test/integration-feishu-question.test.js` 用例6 | PASS |
| REQ-013 | 保留飞书路由隔离 | T6 | `test/question-handler.test.js` | PASS |
| REQ-014 | Bridge 协议能力门禁 | T2, T3, T4, T7 | `test/opencode-tui-bridge.test.js`；`test/opencode-hook-installer.test.js`；`test/opencode-driver.test.js`；`test/integration-feishu-question.test.js` 用例4 | PASS |
| REQ-015 | 卡片发送失败降级 | T5, T6 | `test/feishu-cards.test.js`；`test/question-handler.test.js` | PASS |
| REQ-016 | 用户可见的幂等反馈 | T5, T6 | `test/feishu-cards.test.js`；`test/question-handler.test.js` | PASS |
| REQ-017 | 状态有界保留 | T6 | `test/question-handler.test.js` | PASS |
| REQ-018 | 挂起会话可接收回复 | T2, T3, T7 | `test/opencode-tui-bridge.test.js`；`test/opencode-hook-installer.test.js`；`test/integration-feishu-question.test.js` 用例5 | PASS |

**REQ 覆盖结论**：18/18 REQ 均有对应测试覆盖，全部 PASS。

---

## 3. 测试统计摘要

| 指标 | 全量回归 | 集成测试（定向） | 插件能力探测 |
| --- | --- | --- | --- |
| 命令 | `npm test` | `node --test test/integration-feishu-question.test.js` | `node --test test/opencode-hook-installer.test.js` |
| 退出码 | 0 | 0 | 0 |
| suites | 63 | 1 | 1 |
| tests | 995 | 6 | 40 |
| pass | 995 | 6 | 40 |
| fail | 0 | 0 | 0 |
| cancelled | 0 | 0 | 0 |

**REQ 覆盖**: 18/18 PASS

---

## 4. Evidence 完整性

| 项 | 值 |
| --- | --- |
| 文件 | `specs/2026-07-16-sse-events-forwarding/evidence/test.log` |
| 存在 | 是 |
| 字节数 | 912324 |
| SHA-256 | `7ab6620fe78ab4927e23ab62b3099ec10b65bb7add94d5aa2501e6c0100bf878` |
| 末尾汇总匹配 | 是（`# tests 995 / # pass 995 / # fail 0 / # cancelled 0`） |

---

## 5. 判定

**verdict: PASS**

判定依据：

1. **全量回归 PASS**：`npm test` 995/995 通过，退出码 0。
2. **集成测试 PASS**：`test/integration-feishu-question.test.js` 6/6 通过，覆盖主成功路径、TUI 抢答/拒绝、accepted 前后失败收敛、v3 降级、嵌套父 prompt、permission 回归六大场景。
3. **插件能力探测 PASS**：SDK 缺少 `question.reply` 时结构化降级为不可重试、不标记 SDK 已调用。
4. **REQ 覆盖完整**：18/18 REQ 有对应测试覆盖。
5. **Evidence 真实存在且哈希匹配**：`evidence/test.log` 字节数 912324，SHA-256 `7ab6620fe78ab4927e23ab62b3099ec10b65bb7add94d5aa2501e6c0100bf878`，末尾汇总与报告统计一致。
