# 代码审查反馈处理

**来源：** 本地双轴预审查（Standards + Spec），无外部审查者
**审查请求：** `review-request.md`
**日期：** 2026-07-16

## 反馈分类

| # | 类型 | 严重度 | Finding | 处理 |
|---|------|--------|---------|------|
| S1 | Standards | SUGGESTION | `opencode-driver.js` 恢复窗口硬编码 `maxRecoveryMs=300000` | 采纳并修复 |
| S2 | Standards | SUGGESTION | `opencode-driver.js` 错误码正则匹配脆弱 | 保留，加注释说明防御层定位 |
| S3 | Standards | SUGGESTION | `opencode-session-watcher.js` 初始投递 suspended 检查在循环外 | 不适用（描述有误，已在循环内） |
| Spec | Spec | — | 0 finding | 无需处理 |

## 逐项处理

### S1: 恢复窗口硬编码 → 采纳并修复

**问题：** `_recoverFromDisconnection` 中 `maxRecoveryMs=300000` 硬编码，不可配置。

**修复：** 新增 `OPENCODE_RECOVERY_WINDOW_MS` 配置（默认 300000，`0` 禁用恢复直接失败）。

**改动文件：**
- `src/config/env.js`：新增 `opencodeRecoveryWindowMs`，使用 `parseNonNegativeInt` 允许 0
- `src/app/bootstrap.js`：driver 构造传入 `recoveryWindowMs`
- `src/drivers/opencode-driver.js`：构造函数 `this.recoveryWindowMs = options.recoveryWindowMs ?? 300000`；`_recoverFromDisconnection` 使用 `this.recoveryWindowMs`
- `README.md`：新增配置说明
- `.env.example`：新增配置示例
- `test/config-env.test.js`：默认值和零值断言

**验证：** 829/829 测试通过。

### S2: 错误码正则匹配脆弱 → 保留并注释

**问题：** catch 块用正则匹配 message 补 code，依赖错误消息文本。

**评估：** 主要抛出点已直接设置 `err.code`（`SSE_OPEN_TIMEOUT`、`SSE_IDLE_TIMEOUT`、`ABORT_ERR`）。正则兜底仅处理来自底层 `http-helper.js` 或 `sseClient` 未携带 code 的错误，是防御性设计。移除正则会导致这些无 code 错误无法被 `_isTransportRecoverableError` 正确分类，可能误判为业务失败。

**处理：** 保留正则兜底，添加注释说明"防御性兜底：主要抛出点已设置 code，此处为无 code 的错误补 code"。未来可逐步在底层抛出点统一设置 code 后移除正则。

### S3: 初始投递 suspended 检查在循环外 → 不适用

**问题：** 无 baseline 时投递 completed assistant 的 for 循环中 `suspendedWatches` 检查在循环外。

**核实：** 源码 `src/drivers/opencode-session-watcher.js` 第 186 行 `if (self.suspendedWatches.has(sessionId)) return;` 在 `for (const msg of completed)` 循环**内部**，每次迭代都检查。第 221 行同理。finding 描述有误，无需修复。

## 测试验证

```
npm test
# tests 829 # pass 829 # fail 0 # cancelled 0
```

## 结论

- BLOCKER: 0（无）
- SUGGESTION 采纳: 1（S1 恢复窗口配置化）
- SUGGESTION 保留: 1（S2 防御性正则，已注释）
- SUGGESTION 不适用: 1（S3 描述有误）
- Spec finding: 0

所有反馈已处理，测试全量通过。
