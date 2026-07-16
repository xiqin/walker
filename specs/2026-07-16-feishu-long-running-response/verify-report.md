# 验证报告 — 飞书长任务响应可靠性修复

> 阶段：verification | 日期：2026-07-16 | Verdict: **PASS**

## 1. 前置产出核验

- `specs/2026-07-16-feishu-long-running-response/test-report.md`：Verdict=PASS，829 tests / 829 pass / 0 fail / 0 cancelled。
- 无 combined-reviewer 报告（code-review 阶段尚未执行）。

## 2. 编译/语法验证

- 构建命令：`npm run check`（项目使用 `node --check` 逐文件语法检查 + `node --test test/`）
- 退出码：0
- 证据文件：`evidence/verification.log`
- SHA-256：`4657573EA414673831B2FBFD7D6CA4F11A8AFC2BC363B163120B896D16E74595`
- 结果摘要：`# tests 829 # pass 829 # fail 0 # cancelled 0`

> constitution.md 未声明 BUILD_CMD/VET_CMD/TEST_CMD（均未填写），以 package.json 的 `npm run check` 为准。

## 3. 占位符扫描

- 扫描范围：`specs/2026-07-16-feishu-long-running-response/**`、`src/**/*.js`
- 扫描模式：匹配常见占位符标记（含待定、稍后实现、类似任务等）
- 结果：无匹配。源码和规格无占位符残留。

## 4. 类型/接口一致性检查

| 调用点 | 签名 | 一致性 |
|--------|------|--------|
| `MessageDispatcher._enqueuePrompt` → `driver.prompt(agentRef, text, { model, signal })` | `AgentDriver.prompt(sessionRef, text, options)` 接收 `options.signal` | ✅ |
| `OpencodeDriver.prompt` → `sseClient.connect(url, token, { idleTimeoutMs, signal })` | `sseConnect(url, token, { idleTimeoutMs, signal })` 已实现 | ✅ |
| `OpencodeTuiBridge.prompt(sessionRef, text, options)` 接收 `options.signal` | 已实现 abort 监听 + cancelled tombstone | ✅ |
| `OpencodeDriver` 构造 `promptRequestTimeoutMs`/`sseIdleTimeoutMs` | bootstrap.js 使用 `??` 注入 | ✅ |
| `OpencodeTuiBridge` 构造 `leaseTimeoutMs`/`heartbeatIntervalMs` | bootstrap.js 使用 `??` 注入 | ✅ |
| plugin-template `bridgeProtocolVersion: 3` + `deliveryState` | Bridge `reportEvents` 按 `deliveryState` 分流，v2 无字段按 final | ✅ |
| `_isTransportRecoverableError(err)` 检查 `err.code` | driver/sseConnect 抛出 `SSE_IDLE_TIMEOUT`/`SSE_OPEN_TIMEOUT`/`PROMPT_REQUEST_TIMEOUT`/`TUI_RUNTIME_DISCONNECTED` | ✅ |

## 5. Spec 功能清单 Drift Check

| Requirement ID | 验收标准 | test-report 覆盖 | 实现匹配 |
|----------------|----------|------------------|----------|
| REQ-001 | Dispatcher 唯一硬截止 | ✅ `maxTurnTimeMins=0 无 deadline`、`deadline abort` | ✅ |
| REQ-002 | SSE 超时语义拆分 | ✅ config-env 0 保留、http-helper idle 续期/关闭、driver idleTimeoutMs=300000 | ✅ |
| REQ-003 | SSE 断流结果恢复 | ✅ `SSE 断流恢复`、`transport recovering 不标记 error` | ✅ |
| REQ-004 | watcher completed 游标 | ✅ `失败不推进游标到 pending`、`pending->completed 补投` | ✅ |
| REQ-005 | TUI v3 租约 | ✅ `accepted/heartbeat/final 状态转换`、`v3 长任务完成` | ✅ |
| REQ-006 | TUI 迟到 final | ✅ `transport_lost 补投至多一次`、`cancelled 抑制`、`completed 幂等` | ✅ |
| REQ-007 | v2 兼容 | ✅ `v2 final 兼容完成` | ✅ |
| REQ-008 | 可取消 transport 等待 | ✅ `signal 透传`、`cancel abort`、`deadline abort`、`取消后迟到 final 不渲染` | ✅ |
| REQ-009 | 配置支持 0 | ✅ config-env `0 保留` 测试 | ✅ |
| REQ-010 | 错误可诊断 | ✅ 稳定错误码 + `_isTransportRecoverableError` 分类 | ✅ |

## 6. 非目标检查

- 未修改飞书长连接入口协议 ✅
- 未引入持久化消息队列或外部数据库 ✅
- 未改变 `/clear` 语义 ✅
- 未为其他 Agent driver 新增租约协议 ✅
- 未改变飞书消息展示样式 ✅

## 7. 剩余风险

1. **无 lint 脚本**：`npm run lint` 报 Missing script。代码风格仅靠 `node --check` 语法保证。
2. **无真实端到端飞书集成测试**：集成测试使用 fake driver/mock，未在真实飞书长连接环境验证。建议在部署前做一次真实环境冒烟测试。
3. **旧 `OPENCODE_PROMPT_TIMEOUT_MS` 兼容**：仅在 `OPENCODE_SSE_IDLE_TIMEOUT_MS` 未设置时作为 fallback；用户若同时设置两者，旧值被忽略。

## 8. 结论

所有验证项通过：
- 语法+测试全量 829/829 PASS
- 无占位符残留
- 接口签名跨 task 一致
- spec 10 个 REQ 全部有对应测试覆盖
- 非目标未被违反

实现与 `specs/2026-07-16-feishu-long-running-response/spec.md` 一致，可进入 code-review 阶段。

### Evidence Receipt

- evidence-command: `npm run check`
- evidence-exit-code: `0`
- evidence-file: `evidence/verification.log`
- evidence-sha256: `4657573EA414673831B2FBFD7D6CA4F11A8AFC2BC363B163120B896D16E74595`

verdict: PASS
