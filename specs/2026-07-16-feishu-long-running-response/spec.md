# 飞书长任务响应可靠性修复 - 需求规格

## 1. 概述

**需求来源**：用户反馈飞书消息处理超过 120 秒后报失败，且 OpenCode 后续完成结果无法再送达飞书。

**需求类型**：跨模块缺陷修复与 TUI Bridge 协议升级。

**选定方案**：完整租约协议。升级 Walker 与内置 OpenCode TUI plugin 的 Bridge 协议，统一执行截止、传输空闲检测、断流恢复和迟到结果处理。

### 1.1 已确认根因

1. HTTP/SSE prompt 使用默认 `120000ms` 固定总时长计时器，收到 SSE 数据不会续期，长任务被误判为失败。
2. HTTP/SSE prompt 失败后会把 watcher 游标推进到最后一条仍未完成的 assistant message；该 message 原地完成后不再位于游标之后，polling 无法补投。
3. TUI Bridge prompt 超时后删除 `deliveryId`；plugin 后续上报 final 时被判定为 `unknown TUI delivery`。
4. transport 超时直接传播到 `MessageDispatcher`，被当成业务执行失败；项目已有的 `WALKER_MAX_TURN_TIME_MINS` 未成为唯一整轮硬截止。
5. `OPENCODE_PROMPT_TIMEOUT_MS=0` 无法关闭超时，因为配置解析不接受 0，构造函数中的 `|| 120000` 也会回退到 120 秒。

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | 统一整轮执行截止 | P0 | 给定 `WALKER_MAX_TURN_TIME_MINS=0`，当任务执行超过 120 秒时，不因 Walker transport 固定总时长而失败；给定正数配置，只有该截止到期或用户取消时才终止任务。 |
| REQ-002 | SSE 超时语义拆分 | P0 | SSE 建连、prompt HTTP 提交和 SSE 空闲分别配置；SSE 收到任意数据 chunk 时重置空闲计时器；不再存在默认 120 秒整流总时长计时器。 |
| REQ-003 | SSE 断流结果恢复 | P0 | prompt 已成功提交后发生 SSE 空闲超时或连接断开时，不立即判定业务失败；通过 session message polling 等待对应 assistant message 完成，并只返回一次最终事件。 |
| REQ-004 | watcher 游标正确性 | P0 | transport 失败或恢复期间，游标只能推进到已投递的 completed message；同一 assistant message 从 pending 原地变成 completed 后能够被识别和投递。 |
| REQ-005 | TUI Bridge v3 租约 | P0 | plugin 领取 prompt 后上报 accepted，执行期间按固定间隔上报 heartbeat，完成时上报 final；Bridge 每次 accepted/heartbeat 后续租，活跃任务超过 120 秒不失败。 |
| REQ-006 | TUI 迟到 final 处理 | P0 | delivery 不因旧的固定超时被直接遗忘；未知但可识别的迟到 final 不抛 `unknown TUI delivery`。可恢复 transport 中断后的 final 转交 session watcher；用户取消或整轮截止后的 final 被抑制。 |
| REQ-007 | 升级窗口兼容 | P1 | Bridge 可接收协议 v2 plugin 的原有 final 上报；v2 不具备 heartbeat 时不施加旧的 120 秒固定总时长，仍由用户取消、runtime dispose 或整轮截止结束。 |
| REQ-008 | 可取消的 transport 等待 | P0 | Dispatcher 为每轮创建取消信号；用户 `/cancel`、`/stop` 或整轮截止后，SSE、恢复 polling、TUI pending/lease 均停止等待，并且迟到输出不修改已取消轮次。 |
| REQ-009 | 配置支持 0 | P1 | 允许声明可关闭的超时配置使用 `0`；配置传递使用显式 `undefined` 判断或 `??`，不再把 0 回退为默认值。 |
| REQ-010 | 错误可诊断 | P1 | 建连超时、HTTP 提交超时、SSE 空闲超时、整轮截止、TUI runtime 断开具有不同错误码或稳定错误类型，日志能够区分 transport 恢复与业务失败。 |

## 3. 接口/API 设计

### 3.1 `POST /opencode/tui-bridge/register`

plugin 注册时将 `bridgeProtocolVersion` 从 `2` 升级为 `3`。

### 3.2 `POST /opencode/tui-bridge/events`

保留现有 `events`、`error` 和 `control` 字段，新增 prompt delivery 生命周期字段：

| 参数 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| `runtimeId` | string | 是 | TUI runtime 标识。 |
| `sessionId` | string | 是 | OpenCode session 标识。 |
| `deliveryId` | string | prompt 生命周期上报时是 | Bridge delivery 标识。 |
| `deliveryState` | string | v3 prompt 上报时是 | `accepted`、`heartbeat` 或 `final`。 |
| `events` | array | final 时否 | 最终 Agent 事件。 |
| `error` | object/string | final 失败时否 | 执行错误。 |

业务规则：

1. `accepted` 表示 plugin 已领取并准备执行，Bridge 将 delivery 从 queued 转为 leased。
2. `heartbeat` 仅续租，不 resolve prompt，也不向 watcher 投递 Agent 事件。
3. `final` 清理租约并 resolve prompt；重复 final 返回幂等成功，不重复投递。
4. 协议 v2 未提供 `deliveryState` 时，带 `deliveryId` 的原有上报按 final 处理。
5. runtime、session 与 delivery 不匹配时仍返回明确错误，不能把结果投递到其他会话。

## 4. 状态与数据设计

### 4.1 Dispatcher turn 状态

每轮增加 `AbortController`，其 signal 传入 `driver.prompt()`。以下动作触发 abort：

- 用户取消或停止。
- `WALKER_MAX_TURN_TIME_MINS` 正数配置到期。
- session 被明确删除或 runtime dispose。

### 4.2 SSE prompt 状态

```text
connecting -> submitted -> streaming -> completed
                         -> recovering -> completed
connecting/submitted -> failed
任意非终态 -> cancelled
```

- 只有 prompt HTTP 提交成功后才允许进入 recovering。
- recovering 通过 message polling 查找 prompt 基线之后的 completed assistant message。
- 恢复期间 watcher 保持暂停，避免恢复 polling 与 watcher polling 重复投递；driver 得到 final 后再按既有去重规则推进 completed 游标并 resume watcher。
- 提交前的网络失败属于请求失败，不进入结果恢复。

### 4.3 TUI delivery 状态

```text
queued -> leased -> completed
queued/leased -> cancelled
leased -> lease_lost -> late_completed
```

pending 项至少保存：`deliveryId`、`runtimeId`、`sessionId`、状态、最近续租时间、resolve/reject、timer 和取消原因。

Bridge 保存有界 tombstone，用于识别重复或迟到 final：

- `completed`：重复 final 幂等确认并忽略。
- `transport_lost`：迟到 final 转交对应 session watcher，且最多一次。
- `user_cancelled` 或 `turn_deadline`：迟到 final 幂等确认但抑制输出。

tombstone 必须有数量上限或过期清理，不能无限增长。

## 5. 配置规则

| 配置 | 默认值 | 0 的语义 | 用途 |
| ---- | ------ | -------- | ---- |
| `OPENCODE_SSE_OPEN_TIMEOUT_MS` | `1000` | 关闭该层超时 | SSE 建连截止。 |
| `OPENCODE_PROMPT_REQUEST_TIMEOUT_MS` | `30000` | 关闭该层超时 | `/prompt_async` HTTP 提交截止。 |
| `OPENCODE_SSE_IDLE_TIMEOUT_MS` | `300000` | 关闭该层超时 | SSE 建立后无任何 chunk 的空闲截止，收到 chunk 后重置。 |
| `OPENCODE_TUI_LEASE_TIMEOUT_MS` | `90000` | 关闭租约失联检测 | accepted/heartbeat 后的租约有效期。 |
| `OPENCODE_TUI_HEARTBEAT_INTERVAL_MS` | `30000` | 不允许为 0 | v3 plugin heartbeat 周期，必须小于 lease timeout。 |
| `WALKER_MAX_TURN_TIME_MINS` | `0` | 不设整轮硬截止 | Dispatcher 统一整轮截止。 |

`OPENCODE_PROMPT_TIMEOUT_MS` 标记为废弃兼容配置，不再作为 prompt 整轮固定总时长。若新配置未提供，可仅作为旧部署的 SSE 空闲超时兼容输入；值为 0 时必须保持关闭语义。

## 6. 业务规则

1. Walker 不以 120 秒或其他 transport 固定总时长判断 Agent 业务失败。
2. SSE 空闲超时表示事件流不可继续信任，不表示 OpenCode 任务已停止。
3. watcher 游标表示最后已投递的 completed message，不表示最后观察到的 message。
4. 同一最终文本可由 prompt SSE、恢复 polling 或 session watcher 三条路径观察，但只能向飞书投递一次。
5. TUI heartbeat 只维护租约，不作为用户可见进度事件；飞书进度卡片仍由现有 Dispatcher heartbeat 更新。
6. runtime 明确 dispose、连续租约丢失或无法恢复时可报告 transport 错误；不得伪装成 Agent 业务执行错误。
7. 取消优先级高于迟到结果。取消信号产生后，该轮任何 transport 的迟到 final 都不能恢复已取消状态。

## 7. 异常与边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| SSE 连续产生 chunk 超过 120 秒 | 空闲计时器持续续期，任务正常完成。 |
| SSE 无数据达到 idle timeout，但 OpenCode 仍在运行 | 进入 recovering，轮次保持 running，不发送失败卡片。 |
| 恢复时最后一条 assistant message 为 pending | 不推进到该 message；继续 polling，原 ID completed 后返回 final。 |
| SSE final 与 polling 几乎同时到达 | 通过 message ID/最终文本去重，只投递一次。 |
| TUI v3 执行超过 120 秒且 heartbeat 正常 | Bridge prompt 保持 pending，最终 final 正常 resolve。 |
| TUI heartbeat 短暂失败后恢复 | 在 lease timeout 内恢复则继续执行，不报错。 |
| TUI lease 丢失后 final 迟到 | 根据 tombstone 原因补投一次或抑制，接口不返回 unknown delivery。 |
| 使用 v2 plugin | 不要求 heartbeat，不使用旧 120 秒总时长；原 final 格式仍可完成 delivery。 |
| 用户取消后 final 迟到 | 返回幂等成功但不向飞书投递，不改变 session 已取消状态。 |
| `WALKER_MAX_TURN_TIME_MINS` 到期 | abort 所有 transport 等待，调用 driver cancel/stop，后续输出被抑制。 |

## 8. 验收测试

1. `sseConnect` 收到 chunk 后重置 idle timeout；固定总时长超过旧阈值不会失败。
2. prompt HTTP 提交使用独立 request timeout。
3. prompt 已提交后 SSE 断开，pending assistant 原 ID 后续 completed，driver 恢复并返回 final。
4. prompt 失败时 watcher 游标不推进到 pending message。
5. watcher polling 对 pending -> completed 原地更新能够投递一次。
6. TUI v3 accepted、多个 heartbeat、final 的租约状态转换正确。
7. TUI v3 超过旧 120 秒阈值仍完成；测试使用缩短的虚拟阈值验证同等时序。
8. v2 final 兼容完成，不要求 heartbeat。
9. transport_lost tombstone 的迟到 final 转交 watcher一次；重复 final 不重复投递。
10. user_cancelled/turn_deadline tombstone 的迟到 final 被抑制。
11. 配置项 0 可正确传入 Driver 与 Bridge，不被 `||` 改写。
12. 定向测试、集成测试和项目全量测试全部通过。

## 9. 非目标

- 不修改飞书长连接入口协议。
- 不引入持久化消息队列或外部数据库。
- 不改变现有 `/clear` control delivery 的业务语义；仅复用通用的幂等和 timer 清理模式。
- 不为其他 Agent driver 新增租约协议。
- 不改变飞书消息展示样式，只修复状态和投递可靠性。
