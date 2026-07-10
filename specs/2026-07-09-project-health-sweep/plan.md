# Project Health Sweep 实现计划

**目标：** 修复本轮审计确认的 13 类高置信运行时缺陷，并用聚焦测试防止回归。

**架构：** 按 Walker 现有 CommonJS 分层推进：先修复 core store/http 基础设施，再修复 Feishu 平台适配、session 状态边界、OpenCode driver 事件流，最后收紧 Windows/WSL 终端命令转义并跑完整检查。计划保持最小改动，不引入新框架，不回滚当前工作区已有修改。

**技术栈：** Node.js CommonJS、`node:test`、内置 `http`/`https`、`@larksuiteoapi/node-sdk`、现有 runtime/driver/platform 模块。

---

## Requirement 映射

| Requirement ID | 规格条目 |
| -------------- | -------- |
| REQ-001 | 飞书 API 错误处理不完整 |
| REQ-002 | 进度卡片更新不可靠 |
| REQ-003 | 飞书 WebSocket 事件处理可能超过 3 秒 ACK 要求 |
| REQ-004 | 异步飞书回复缺少可靠捕获 |
| REQ-005 | `JsonStore` 默认值会被 `update()` 原地污染 |
| REQ-006 | 删除会话可被重新绑定或被脏 route 命中 |
| REQ-007 | prompt 结束状态可能覆盖已停止或已删除状态 |
| REQ-008 | HTTP/SSE 边界处理不严 |
| REQ-009 | OpenCode driver 对创建 session 的响应校验不足 |
| REQ-010 | 目录级 SSE 事件可能串流或提前终止 |
| REQ-011 | Windows/WSL 终端打开命令拼接存在命令注入和参数破坏风险 |
| REQ-012 | 群聊 @ 机器人命令识别不稳 |
| REQ-013 | `FeishuPlatform.start()` 未等待 WSClient 启动结果 |

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | Core store 与 HTTP/SSE 边界 | core | high | 无 | `tasks/T1.md` |
| T2 | Feishu API、卡片与平台事件边界 | platform | high | T1 | `tasks/T2.md` |
| T3 | Session 删除与终态保护 | core | medium | T1 | `tasks/T3.md` |
| T4 | MessageDispatcher 异步错误与状态收敛 | dispatch | high | T2, T3 | `tasks/T4.md` |
| T5 | OpenCode driver 响应校验与跨 session SSE 过滤 | driver | high | T1, T3 | `tasks/T5.md` |
| T6 | Windows/WSL terminal 命令转义与完整验证 | runtime | medium | T1, T2, T3, T4, T5 | `tasks/T6.md` |

## 依赖关系

T1 → T2 → T4 → T6

T1 → T3 → T4 → T6

T1 → T3 → T5 → T6

## 并行边界

T2、T3、T5 在 T1 完成后可并行探索，但 T4 依赖 T2 和 T3 的接口结果。T6 是收尾任务，必须在前序任务通过其局部测试后执行。

## 验证策略

每个任务先新增或更新针对性 `node:test` 用例，再实现修复。每个任务完成后运行对应测试文件；全部任务完成后运行 `npm run check`。
