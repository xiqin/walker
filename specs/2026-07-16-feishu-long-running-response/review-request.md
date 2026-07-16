# 代码审查请求

**功能：** 飞书长任务响应可靠性修复（超过 120 秒不丢消息）
**分支：** 当前工作分支（未提交，待用户决定提交策略）
**Spec：** `specs/2026-07-16-feishu-long-running-response/spec.md`

## 变更统计

```
21 files changed, 2126 insertions(+), 110 deletions(-)
```

主要文件改动量：
- `src/opencode-tui-bridge/bridge.js` +212/-（v3 租约 + tombstone）
- `src/drivers/opencode-driver.js` +171/-（断流恢复 + completed 游标）
- `test/opencode-tui-bridge.test.js` +582（21 新增测试）
- `test/integration-feishu-tui-sync.test.js` +362（5 新增集成测试）
- `test/message-dispatcher.test.js` +249（9 新增测试）
- `test/opencode-driver.test.js` +197（6 新增测试）
- `src/core/http-helper.js` +45（idle timeout 原语）
- `src/dispatch/message-dispatcher.js` +34（AbortController + recovering 分类）
- `src/opencode-hook/plugin-template.js` +50（v3 心跳协议）
- `src/drivers/opencode-session-watcher.js` +41（completed-only 游标）
- `src/config/env.js` +26（新配置 + 0 语义）

## 主要变更

1. **HTTP/SSE 超时拆分**：`sseConnect` 固定总时长 timer 改为 idle timeout（每个 chunk 重置），独立的 HTTP request timeout，SSE open timeout 保持。新增稳定错误码 `SSE_IDLE_TIMEOUT`/`SSE_OPEN_TIMEOUT`/`PROMPT_REQUEST_TIMEOUT`/`ABORT_ERR`。
2. **Driver 断流恢复**：prompt 提交后 SSE 中断不再直接失败，进入 `_recoverFromDisconnection` polling 查找 baseline 之后的 completed assistant message，恢复期间 watcher 保持暂停。只有 `promptCompleted` 才推进 watcher 游标，且只推进到 completed assistant message（修复 pending 原地 completed 越过游标的 bug）。
3. **watcher completed-only 游标**：polling 只投递 completed assistant message，pending 消息不推进游标，同 ID pending->completed 在后续 poll 可被找到。
4. **TUI Bridge v3 租约协议**：`queued -> leased -> completed` 状态机，`accepted/heartbeat/final` 三段上报，租约 timer 续期，超时转 `transport_lost` tombstone。v2 无 `deliveryState` 按 final 兼容。
5. **有界 tombstone**：`completed` 幂等忽略，`transport_lost` 迟到 final 转交 watcher 至多一次，`cancelled`/`deadline` 迟到 final 抑制。容量 100 + TTL 5 分钟。
6. **内置 plugin v3**：`bridgeProtocolVersion: 3`，先上报 accepted 再 promptAsync，周期 heartbeat，final 后 stopHeartbeat，dispose 清理所有 timer。
7. **Dispatcher 取消集成**：每轮 AbortController，signal 传给 driver.prompt，`_isTransportRecoverableError` 区分 transport 中断（recovering，不标记 error）与业务失败。deadline/cancel 先 abort 再清理。
8. **配置 0 语义**：`parseNonNegativeInt` 允许 0 关闭超时，`??` 替代 `||` 避免把 0 回退。新增 `OPENCODE_PROMPT_REQUEST_TIMEOUT_MS`/`OPENCODE_SSE_IDLE_TIMEOUT_MS`/`OPENCODE_TUI_LEASE_TIMEOUT_MS`/`OPENCODE_TUI_HEARTBEAT_INTERVAL_MS`，旧 `OPENCODE_PROMPT_TIMEOUT_MS` 废弃但兼容 fallback。

## 重点关注

1. **架构设计**：SSE 超时从单一固定 timer 拆为 open/request/idle 三段，断流后 polling 恢复而非直接失败——这是核心架构变更，需确认恢复窗口（当前硬编码 5 分钟）与 watcher 暂停/恢复时机的正确性。
2. **状态机一致性**：TUI Bridge v3 `queued/leased/completed/cancelled/lease_lost` 状态转换与 plugin 上报的 `accepted/heartbeat/final` 时序需严格匹配，尤其 accepted 必须在 promptAsync 之前。
3. **游标语义**：watcher 游标从"最后观察到 message"改为"最后已投递 completed assistant message"，这是防止 pending 原地 completed 越过游标的关键——需确认初始无 baseline 时的投递逻辑不会重复。
4. **错误分类**：`_isTransportRecoverableError` 用 err.code 精确匹配 + message 正则兜底，需确认所有 transport 错误路径都带正确 code，避免误判为业务失败。
5. **兼容性**：v2 plugin 无 `deliveryState` 按 final 兼容；旧 `OPENCODE_PROMPT_TIMEOUT_MS` 在新 idle 配置缺失时 fallback——需确认升级用户不会因配置缺失回归 120 秒。

## 自测情况

- [x] 编译通过：`npm run check` 退出码 0
- [x] 静态分析：项目无 lint 脚本，`node --check` 逐文件语法通过
- [x] 测试通过：829 tests / 829 pass / 0 fail / 0 cancelled
- [x] 代码符合编码红线：中文注释、配置集中、错误可诊断、最小改动
- [x] 图后端已同步：CodeGraph 索引确认接口签名一致（loom_graph_sync 未运行，因 `.loom/graph.config.json` 未启用）
- [x] Standards + Spec 双轴预审查完成

## 变更详情

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/config/env.js` | 修改 | 新增 `parseNonNegativeInt`、4 个新配置、lease/heartbeat 校验 |
| `src/app/bootstrap.js` | 修改 | Bridge/Driver 构造注入新配置，`??` 替代 `||`，plugin 传 heartbeat |
| `src/core/http-helper.js` | 修改 | `sseConnect` idle timeout + signal + 稳定错误码 |
| `src/drivers/opencode-driver.js` | 修改 | prompt 断流恢复、completed 游标、signal、错误分类 |
| `src/drivers/opencode-session-watcher.js` | 修改 | completed-only 游标，pending 不推进 |
| `src/drivers/opencode-http-client.js` | 修改 | `idleTimeoutMs` 优先，`timeoutMs` 派生兼容 |
| `src/drivers/agent-driver.js` | 修改 | prompt() options 文档 |
| `src/opencode-tui-bridge/bridge.js` | 修改 | v3 租约状态机 + tombstone + signal |
| `src/opencode-hook/plugin-template.js` | 修改 | protocol v3，accepted/heartbeat/final |
| `src/opencode-hook/installer.js` | 修改 | 传 heartbeatIntervalMs |
| `src/dispatch/message-dispatcher.js` | 修改 | AbortController + recovering 分类 |
| `test/*.test.js`（7 文件） | 修改/新增 | 共 61 个新增测试 |
| `.env.example` | 修改 | 5 个新配置示例 |
| `README.md` | 修改 | 新配置说明 + 长任务控制章节 |

## 审查重点

- [ ] 架构合规性：SSE 超时拆分与断流恢复是否符合分层约束
- [ ] 代码质量：错误码补丁正则、恢复窗口硬编码、游标初始投递
- [ ] 安全性检查：无密钥泄露、无注入风险
- [ ] 性能影响：idle timer 每个 chunk 重置的开销、tombstone 容量
- [ ] 兼容性：v2 plugin 升级路径、旧配置 fallback

## 预审查 findings

### Standards

1. **`opencode-driver.js` 恢复窗口硬编码**：`_recoverFromDisconnection` 中 `maxRecoveryMs=300000` 未配置化，建议新增 `OPENCODE_RECOVERY_WINDOW_MS`（非 blocker）
2. **`opencode-driver.js` 错误码补丁脆弱**：用正则匹配 message 字符串补 code，依赖错误消息文本，建议在各抛出点直接设置 code（部分已做，残余正则可逐步移除）
3. **`opencode-session-watcher.js` 初始投递 suspended 检查**：无 baseline 时投递 completed assistant 的 for 循环中，`suspendedWatches` 检查在循环外，循环中途 suspend 仍会继续投递（低风险）

### Spec

- 10 个 REQ 全部有实现覆盖，5 个非目标均未被违反
- 无 spec drift

### 预审查摘要

- Standards findings: 3，worst: 错误码补丁正则脆弱（非 blocker）
- Spec findings: 0，worst: none
