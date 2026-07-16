# 测试报告

> 阶段：executing | 日期：2026-07-16

## 概述

飞书长任务响应优化（超过 120 秒失败问题）的全量实现与验证。T1-T6 六个任务全部完成。

## 变更范围

| Task | 文件 | 测试新增 |
|------|------|----------|
| T1 配置解析与注入 | env.js, bootstrap.js, installer.js, plugin-template.js, opencode-driver.js, bridge.js | 9 |
| T2 HTTP/SSE 超时原语 | http-helper.js, opencode-http-client.js | 6 |
| T3 Driver 断流恢复+游标 | opencode-driver.js, session-watcher.js, agent-driver.js | 6 |
| T4 TUI Bridge v3 租约 | bridge.js | 21 |
| T5 plugin 心跳协议 | plugin-template.js | 18 |
| T6 Dispatcher 取消集成 | message-dispatcher.js | 14 |

## 测试结果

### 全量测试

```
npm test
# tests 829
# pass 829
# fail 0
# cancelled 0
```

### 定向测试覆盖

| 测试文件 | 用例数 | 覆盖场景 |
|----------|--------|----------|
| test/config-env.test.js | 7+ | 0 保留、旧 fallback、新优先、无效回落、heartbeat<lease 校验、lease=0 不校验 |
| test/http-helper.test.js | 5+ | idle 续期、idle 超时、idle=0 不触发、abort signal、HTTP timeout code |
| test/opencode-http-client.test.js | 1 | timeoutMs=0 不被覆盖 |
| test/opencode-driver.test.js | 6+ | SSE open timeout、提交前失败不恢复、断流恢复、失败不推进游标到 pending、abort signal、sseOpenTimeoutMs=0 |
| test/opencode-tui-bridge.test.js | 21 | queued/leased/completed/cancelled/lease_lost、accepted/heartbeat/final、v2 兼容、tombstone 容量/TTL/补投/抑制 |
| test/opencode-plugin-template.test.js | 18 | protocol v3、accepted/heartbeat/final、startHeartbeat/stopHeartbeat、dispose 清理、clear 不走 v3 |
| test/opencode-hook-installer.test.js | 2+ | heartbeat interval 内嵌和透传、bridgeProtocolVersion=3 |
| test/message-dispatcher.test.js | 9+ | signal 透传、cancel abort、deadline abort、recovering 不标记 error、SSE_OPEN_TIMEOUT/TUI_RUNTIME_DISCONNECTED recovering、业务错误仍标记 error、maxTurnTimeMins=0 无 deadline、取消后迟到 final 不渲染 |
| test/integration-feishu-tui-sync.test.js | 5 | v3 长任务、v2 兼容、transport_lost 补投至多一次、cancelled 抑制、prompt+watcher 去重 |

## 验收映射

| Requirement ID | 验收标准 | 状态 |
|----------------|----------|------|
| REQ-001 | Dispatcher 是唯一整轮硬截止 | ✅ |
| REQ-003 | SSE transport recovering 不立即标记业务失败 | ✅ |
| REQ-004 | watcher 补投与 prompt final 只投递一次 | ✅ |
| REQ-005 | v3 长任务 heartbeat 活跃时完成 | ✅ |
| REQ-006 | 迟到 final 按 tombstone 原因补投或抑制 | ✅ |
| REQ-007 | v2 plugin final 仍可完成 | ✅ |
| REQ-008 | cancel/deadline abort 所有 transport 等待 | ✅ |
| REQ-009 | 显式零配置在集成构造中生效 | ✅ |
| REQ-010 | deadline、transport 与业务错误展示可区分 | ✅ |

## 结论

**Verdict: PASS**

全量 829 个测试通过，0 失败。超过旧 120 秒阈值的等价时序不再失败，最终消息至多投递一次。无未完成占位内容。

## 证据

- 命令：`npm test`
- 退出码：0
- 结果摘要：`# tests 829 # pass 829 # fail 0 # cancelled 0`
- 证据文件：`test-report.md`
- SHA256：`BDB134B9106C07FD4C002667B525C330CAF186BB878BBB8451659AD63DF043E9`
