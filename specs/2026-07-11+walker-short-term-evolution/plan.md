# Walker 短期演进实现计划

**目标：** 在现有 Feishu + OpenCode 桥接架构上，交付可配置心跳、远程取消、状态查看、单轮超时和重复推送防护。

**架构：** 采用最小增量方案，保留当前 `MessageDispatcher` 作为命令和 turn 生命周期协调中心。新增配置仍从 `src/config/env.js` 读取，并通过 `src/app/bootstrap.js` 注入 dispatcher，避免业务逻辑散落读取环境变量。OpenCode 第一版取消语义复用现有 `driver.stop(agentRef)`，Walker session 保留并回到 `idle`。

**技术栈：** Node.js CommonJS、`node:test`、飞书长连接、OpenCode HTTP/SSE 驱动。

---

## Requirement 映射

| ID | 需求摘要 |
| --- | --- |
| REQ-001 | 心跳参数环境变量化，默认行为保持一致 |
| REQ-002 | `/cancel` 取消当前 turn 并保留 session |
| REQ-003 | `/status` 与 `/ps` 展示当前绑定和运行状态 |
| REQ-004 | `WALKER_MAX_TURN_TIME_MINS` 超时自动取消当前 turn |
| REQ-005 | 补强重复推送和取消/超时残留输出防护 |
| REQ-006 | README 更新新增命令、配置项和长任务行为 |

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 配置入口与注入 | 配置/启动 | 中等 | 无 | `tasks/T1.md` |
| T2 | 命令注册与帮助文案 | 平台命令 | 低 | 无 | `tasks/T2.md` |
| T3 | turn 生命周期控制 | 调度/业务逻辑 | 高 | T1, T2 | `tasks/T3.md` |
| T4 | 文档与验收验证 | 文档/验证 | 低 | T1, T2, T3 | `tasks/T4.md` |

## 依赖关系

T1 → T3 → T4

T2 → T3 → T4

## 文件结构计划

| 文件 | 计划变更 |
| --- | --- |
| `src/config/env.js` | 新增四个 Walker 长任务配置项解析，默认值与 spec 一致。 |
| `src/app/bootstrap.js` | 将新配置注入 `MessageDispatcher` 构造参数。 |
| `src/platform/feishu/commands.js` | 注册 `/cancel`、`/status`、`/ps` 并更新帮助输出。 |
| `src/dispatch/message-dispatcher.js` | 实现 cancel/status/ps、turn token、超时看门狗、残留事件抑制和状态格式化。 |
| `README.md` | 补充新增配置、命令和长任务行为说明。 |
| `test/config-env.test.js` | 覆盖默认值和环境变量覆盖。 |
| `test/bootstrap.test.js` | 覆盖 bootstrap 注入 dispatcher 的新配置。 |
| `test/feishu-commands.test.js` | 覆盖新增命令解析和命令表。 |
| `test/message-dispatcher.test.js` | 覆盖 cancel/status/timeout/重复残留输出场景。 |

## 串行边界

`src/dispatch/message-dispatcher.js` 是本轮核心共享热点，所有涉及该文件的业务逻辑集中在 T3 中完成，避免多个任务同时写同一文件。T1 和 T2 可以先后执行，也可以在明确不共享文件时并行执行；T3 必须等 T1、T2 完成后执行。

## 验证计划

1. T1 后运行 `node --test test/config-env.test.js test/bootstrap.test.js`。
2. T2 后运行 `node --test test/feishu-commands.test.js`。
3. T3 后运行 `node --test test/message-dispatcher.test.js`。
4. T4 后运行 `npm test`。
5. 全部通过后运行 `codegraph sync .`。
