# 飞书长任务响应可靠性修复实现计划

**目标：** 消除 Walker transport 的固定 120 秒总时长限制，并确保 SSE 断流、TUI 租约波动和取消场景下的最终消息可靠、幂等地送达或抑制。

**架构：** 保持现有 Dispatcher、OpenCode Driver、Session Watcher、TUI Bridge 和内置 plugin 分层。Dispatcher 通过 `AbortSignal` 统一控制整轮生命周期；HTTP/SSE 将建连、提交和空闲超时拆分；Driver 在提交后断流时通过 completed message polling 恢复；TUI Bridge 与 plugin 使用 v3 `accepted/heartbeat/final` 租约协议并兼容 v2 final。

**技术栈：** Node.js CommonJS、Node.js `http`/`https`、Server-Sent Events、`AbortController`、`node:test`。

---

## 接口契约

- `driver.prompt(sessionRef, text, options)` 接收 `options.signal`，HTTP/SSE 与 TUI Bridge 均响应取消。
- `sseConnect()` 使用 `idleTimeoutMs` 表示已连接事件流的空闲截止，任意 data chunk 都会续期；不再使用固定整流总时长。
- `/prompt_async` 使用独立 `requestTimeoutMs`，只有提交成功后才能进入 polling 恢复。
- watcher 游标只表示最后已投递的 completed assistant message；pending message 不得成为游标。
- TUI Bridge v3 使用 `deliveryState: accepted | heartbeat | final`；v2 缺少 `deliveryState` 的 delivery 上报按 final 处理。
- transport 错误通过稳定 `error.code` 区分：`SSE_OPEN_TIMEOUT`、`PROMPT_REQUEST_TIMEOUT`、`SSE_IDLE_TIMEOUT`、`TURN_DEADLINE_EXCEEDED`、`TUI_RUNTIME_DISCONNECTED`。

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 配置解析与依赖注入 | 配置/装配 | 中等 | 无 | `tasks/T1.md` |
| T2 | HTTP/SSE 超时原语 | 基础设施 | 中等 | 无 | `tasks/T2.md` |
| T3 | Driver 断流恢复与 completed 游标 | 驱动/业务逻辑 | 高 | T1、T2 | `tasks/T3.md` |
| T4 | TUI Bridge v3 租约与 tombstone | Bridge/业务逻辑 | 高 | T1 | `tasks/T4.md` |
| T5 | 内置 TUI plugin 心跳协议 | 集成协议 | 中等 | T1 | `tasks/T5.md` |
| T6 | Dispatcher 取消集成与端到端验证 | 调度/集成 | 高 | T3、T4、T5 | `tasks/T6.md` |

## 依赖关系

```text
T1 ──┬──> T3 ──┐
     ├──> T4 ──┼──> T6
     └──> T5 ──┘
T2 ─────> T3
```

## 执行批次

| 批次 | Tasks | 并行边界 |
| ---- | ----- | -------- |
| 1 | T1、T2 | 文件无交集，可并行；T1 固化配置与构造参数，T2 固化底层 timeout/signal 语义。 |
| 2 | T3、T4、T5 | 前置依赖完成后文件无交集，可并行；共同遵守本计划接口契约。 |
| 3 | T6 | 串行集成 Dispatcher、两种 transport 与最终验收。 |

## 验证策略

1. 每个 Task 先运行其定向失败测试，再实施最小代码改动使测试通过。
2. 每个批次结束运行相关测试文件，确认跨 Task 接口一致。
3. T6 运行 `npm test`，覆盖语法检查和全量 `node:test` 测试。
4. 使用缩短的毫秒级测试阈值模拟超过旧 120 秒边界的时序，不在自动测试中真实等待 120 秒。
