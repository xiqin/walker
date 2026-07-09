# Walker 飞书多 Agent CLI 桥接器实现计划

**目标：** 将当前 opendray bridge MVP 重构为不依赖 opendray 的 Walker 本地 Agent Hub，让飞书消息可精准路由到本机 opencode 会话，并保留多 Agent、Windows/WSL 与飞书卡片交互扩展点。

**架构：** 采用 Node.js CommonJS 单进程架构，分为配置/持久化、路由与 session 服务、FeishuPlatform、AgentDriver、Runtime、UI 渲染和入口编排。P0 的 AgentDriver 为 `OpencodeDriver`，通过 `opencode serve` 的 HTTP API 与 SSE 事件流接入；Claude Code 与 Codex 仅保留驱动接口、注册位和文档边界。

**技术栈：** Node.js CommonJS、`@larksuiteoapi/node-sdk` 飞书长连接与 OpenAPI、Node 内置 `node:test`、本地 JSON/JSONL 持久化、`child_process` Runtime 启动、HTTP/SSE 客户端。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 项目骨架、配置与持久化 | 基础设施 | 中等 | 无 | `tasks/T1.md` |
| T2 | 路由与 Walker session 核心 | 业务核心 | 中等 | T1 | `tasks/T2.md` |
| T3 | 飞书平台层与命令解析 | 平台入口 | 高 | T1, T2 | `tasks/T3.md` |
| T4 | 飞书卡片、按钮与进度 UI | UI/交互 | 高 | T2, T3 | `tasks/T4.md` |
| T5 | Runtime 与 OpencodeDriver | Agent 驱动 | 高 | T1, T2 | `tasks/T5.md` |
| T6 | 消息调度、去重、附件与表情 | 集成逻辑 | 高 | T2, T3, T4, T5 | `tasks/T6.md` |
| T7 | 入口替换、脚本与端到端启动 | 应用编排 | 高 | T1, T2, T3, T4, T5, T6 | `tasks/T7.md` |
| T8 | README、配置示例与扩展文档 | 文档/收尾 | 中等 | T7 | `tasks/T8.md` |

## 依赖关系

T1 → T2 → T3 → T4 → T6 → T7 → T8

T1 → T5 → T6

## Requirement 覆盖

| Requirement ID | 覆盖 Task |
| -------------- | --------- |
| REQ-001 | T7, T8 |
| REQ-002 | T3, T7 |
| REQ-003 | T2 |
| REQ-004 | T2, T6 |
| REQ-005 | T2, T3, T5, T6 |
| REQ-006 | T3, T4 |
| REQ-007 | T3, T4 |
| REQ-008 | T2, T3 |
| REQ-009 | T2, T3 |
| REQ-010 | T5, T6 |
| REQ-011 | T5 |
| REQ-012 | T2, T5 |
| REQ-013 | T3, T6 |
| REQ-014 | T4, T6 |
| REQ-015 | T5 |
| REQ-016 | T5 |
| REQ-017 | T2, T4 |
| REQ-018 | T1, T2 |
| REQ-019 | T6 |
| REQ-020 | T2, T5, T6 |
| REQ-021 | T2, T3, T5 |
| REQ-022 | T3 |
| REQ-023 | T6 |
| REQ-024 | T6 |
| REQ-025 | T6 |
| REQ-026 | T5, T8 |
| REQ-027 | T5, T8 |
| REQ-028 | T8 |

## 文件结构规划

```text
src/
  index.js
  app/bootstrap.js
  config/env.js
  core/id.js
  core/json-store.js
  core/logger.js
  core/route-key.js
  core/session-store.js
  core/session-service.js
  core/message-dedup.js
  platform/feishu/api.js
  platform/feishu/events.js
  platform/feishu/platform.js
  platform/feishu/commands.js
  platform/feishu/cards.js
  platform/feishu/progress-card.js
  drivers/agent-driver.js
  drivers/driver-registry.js
  drivers/opencode-driver.js
  drivers/stub-drivers.js
  runtime/windows-runtime.js
  runtime/wsl-runtime.js
  runtime/runtime-factory.js
  dispatch/message-dispatcher.js
  dispatch/attachment-service.js
test/
  *.test.js
```

## 串行与并行边界

本计划按串行执行设计，因为现有实现是单文件 opendray MVP，最终替换入口前需要稳定模块接口。若执行阶段需要并行，最多可在 T3 与 T5 之间并行：T3 只依赖 T1/T2 且不写 driver/runtime 文件，T5 只依赖 T1/T2 且不写飞书平台文件。

## 验证策略

- 每个核心模块使用 `node:test` 覆盖纯函数、持久化、命令与 driver 映射逻辑。
- 所有任务完成后运行 `npm run check`，该命令应覆盖语法检查和单元测试。
- T7 完成后在无 opendray 运行的环境下执行启动冒烟，确认不再连接 `OPENDRAY_*` 配置。
- T8 完成后核对 README 与 `.env.example` 覆盖飞书、opencode、Windows/WSL、命令清单和验收步骤。
