# 飞书 `/clear` 当前 TUI 清空上下文实现计划

**目标：** 从飞书执行 `/clear` 时，在当前 OpenCode TUI 窗口内创建并切换到空白顶层 session，同时保留旧会话及其 route 归属。

**架构：** 先扩展 `OpencodeTuiBridge` 的投递协议和带 `controlDeliveryId` 的两阶段汇合状态机，并由 `OpencodeDriver` 暴露最小委托接口；再升级生成的 TUI plugin，使其执行本地 session 创建、导航、关联注册和失败回滚。随后在飞书命令层接入 `/clear`，最后用跨层集成测试验证 route 原子提交、模型继承、错误恢复和“不打开终端”约束。

**技术栈：** Node.js CommonJS、`node:test`、OpenCode TUI plugin SDK、Walker loopback HTTP bridge

---

## 文件结构

| 文件 | 变更职责 |
| ---- | -------- |
| `src/opencode-tui-bridge/bridge.js` | clear 控制投递、关联暂存注册、pending 汇合、超时清理、route 原子提交及模型继承 |
| `src/drivers/opencode-driver.js` | 将 TUI bridge clear 能力暴露给 dispatcher，不触发 HTTP create/openTerminal |
| `src/opencode-hook/plugin-template.js` | 识别 clear delivery，调用本地 SDK 创建顶层 session、导航、关联注册、上报结果并在失败时回滚 |
| `src/platform/feishu/commands.js` | 注册 `/clear` 并纳入帮助文本 |
| `src/dispatch/message-dispatcher.js` | 校验当前会话、串行执行 clear、回复成功或明确错误 |
| `README.md` | 说明 `/clear` 的适用范围、保留旧会话语义及 `/cancel` 前置要求 |

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | Bridge clear 协议与汇合状态机 | 协议/驱动 | 高 | 无 | `tasks/T1.md` |
| T2 | TUI plugin 执行 clear 控制 | TUI 集成 | 中 | T1 | `tasks/T2.md` |
| T3 | 飞书 `/clear` 命令与调度 | 命令/业务 | 中 | T1、T2 | `tasks/T3.md` |
| T4 | 跨层回归与使用文档 | 集成/文档 | 中 | T1、T2、T3 | `tasks/T4.md` |

## 依赖关系

T1 → T2 → T3 → T4

## 关键接口约束

- `OpencodeTuiBridge.clearSession(sessionRef)` 只有在 control result 和相同 `deliveryId + runtimeId + newSessionId` 的关联 `register()` 都完成后才 resolve。
- 带 `controlDeliveryId` 的 register 只暂存新 OpenCode session 元数据，不提前创建持久化 Walker session、不更新 runtime 当前 session、不按 cwd 自动选 route、不设置焦点；control result 与 register 的到达顺序不可假设。
- 单一完成函数负责提交 runtime、新 session route 归属、模型继承和焦点；超时、error、close 和 cancel 路径必须清理 pending，且不得提交部分状态。
- prompt delivery 显式携带 `type: "prompt"`；插件继续把缺少 `type` 的旧 delivery 当作 prompt。
- clear 成功前旧 route 焦点不变；新 Walker session 加入原 route后继承旧 session 的 `model`，旧 session 不删除、不停止、不移出 route。
- 插件抑制 clear 自身触发的普通自动注册；关联注册或控制上报失败时最佳努力导航回旧 session，回滚失败必须明确提示手工切回。
- 同一 runtime 同时只允许一个 clear pending；插件从调用 create 前开始缓冲自动 session 事件，兼容 `session.created` 早于 create Promise 返回的顺序。
- dispatcher 在 route lock 外快速检查、锁内重新读取并复检；运行中的 session、活动 turn 或未完成 prompt queue 必须立即提示先 `/cancel`，不得等待完成后自动 clear。
- TUI plugin 只调用 `api.client.session.create()`、`api.route.navigate()` 和现有 loopback bridge endpoints；不得调用 Walker driver 的 `createSession()` 或 runtime `openTerminal()`。

## 验证策略

- 每个 Task 按 Red-Green-Refactor 执行其定向 `node --test` 命令。
- T4 完成后运行 `npm test`，覆盖语法检查和完整测试集；集成测试必须验证关联 ID 隔离、失败不提交焦点、回滚尝试以及锁外即时拒绝。
- 扫描计划与实现产物，确保没有未完成占位符，并确认 `/new` 行为未被修改。
