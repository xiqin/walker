# SSE 事件全量覆盖 实现计划

**目标：** 将 OpenCode 1.17.20 全部 31 种 SSE 事件映射到 AgentEvent 体系，权限确认请求通过飞书卡片按钮交互回调 OpenCode 答复端点，其余事件按重要性分级在进度卡片展示。

**架构：** 在现有 mapSSEEvent 适配层新增事件映射分支，扩展 AgentEvent 类型体系（6→17 种 TYPE），ProgressCard.formatAgentEvent 增加展示 case，OpencodeDriver 新增 replyPermission HTTP 调用，飞书侧新增权限卡片（独立于进度卡片）和 /permit 命令处理按钮回调。

**技术栈：** Node.js (CommonJS), 飞书 Lark SDK 卡片 JSON, OpenCode HTTP/SSE API

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | AgentEvent 类型体系扩展 | 数据/模型 | 中等 | 无 | `tasks/T1.md` |
| T2 | mapSSEEvent 全量 SSE 事件映射 | 适配层 | 高 | T1 | `tasks/T2.md` |
| T3 | OpencodeDriver.replyPermission 方法 | 驱动层 | 简单 | T1 | `tasks/T3.md` |
| T4 | 进度卡片 + 权限卡片渲染扩展 | 展示层 | 中等 | T1 | `tasks/T4.md` |
| T5 | /permit 命令注册 | 命令层 | 简单 | 无 | `tasks/T5.md` |
| T6 | MessageDispatcher 权限卡片渲染与按钮回调 | 分发层 | 高 | T1,T2,T3,T4,T5 | `tasks/T6.md` |
| T7 | bootstrap.js API 绑定扩展 | 入口配置 | 简单 | T4,T6 | `tasks/T7.md` |

## 依赖关系

```
T1 ──→ T2
T1 ──→ T3
T1 ──→ T4
T5（独立）
T1+T2+T3+T4+T5 ──→ T6
T4+T6 ──→ T7
```

可并行：T2、T3、T4、T5 在 T1 完成后可并行执行（owns 无交集）。

## Requirement ID 覆盖映射

| Task | 覆盖 REQ |
| ---- | --------- |
| T1 | REQ-015 |
| T2 | REQ-001, REQ-004, REQ-005, REQ-006, REQ-007, REQ-008, REQ-009, REQ-010, REQ-011, REQ-012, REQ-013, REQ-014 |
| T3 | REQ-017 |
| T4 | REQ-016, REQ-002 |
| T5 | REQ-018 |
| T6 | REQ-002, REQ-003 |
| T7 | REQ-002, REQ-003 |
