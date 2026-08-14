# 飞书引用回复会话路由实现计划

**目标：** 让飞书引用回复按被引用机器人消息所属 Walker 会话投递，直接回复继续按当前聊天焦点投递。

**架构：** 在 `SessionService` 中维护持久的飞书消息到会话映射，平台层负责把飞书 `parent_id` 透传到入站事件，调度层负责解析引用目标并统一记录成功发送的新飞书消息。引用命中只影响本次投递和回复上下文，不修改 route 的 `focusSessionId`。

**技术栈：** Node.js CommonJS、内置 `node:test`、现有 Feishu platform adapter、`MessageDispatcher`、`SessionService`。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | 平台消息索引状态 | core state | medium | 无 | REQ-003, REQ-005 | REQ-003-B06, REQ-005-B01, REQ-005-B02, REQ-005-B03, REQ-005-B04, REQ-005-B05 | `tasks/T1.md` |
| T2 | 飞书引用上下文透传 | platform adapter | low | 无 | REQ-004 | REQ-004-B01, REQ-004-B02, REQ-004-B03 | `tasks/T2.md` |
| T3 | 引用路由与出站绑定集成 | dispatcher integration | high | T1, T2 | REQ-001, REQ-002, REQ-003 | REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B04, REQ-001-B05, REQ-001-B06, REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04, REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-003-B04, REQ-003-B05 | `tasks/T3.md` |

## 依赖关系

T1 与 T2 可并行执行；T3 依赖 T1、T2 的接口落地后执行。

## 文件结构

| 文件 | 计划改动 |
| ---- | -------- |
| `src/core/session-service.js` | 新增 `platformMessages` 容器初始化、记录、解析、容量剪枝、删除 session 清理 |
| `test/session-service.test.js` | 覆盖平台消息映射状态行为与边界 |
| `src/platform/feishu/platform.js` | text/command 顶层事件透传 `parentId` |
| `test/feishu-platform.test.js` | 覆盖 text/command `parentId` 透传和缺失字段兼容 |
| `src/dispatch/message-dispatcher.js` | 新增入站 target resolver，引用路由优先于焦点和 thread fallback；成功发送后记录飞书消息绑定 |
| `test/message-dispatcher.test.js` | 覆盖引用命中、降级、thread fallback 优先级、出站记录和记录失败 |

## Traceability 初始映射

planning 阶段已在 `traceability.json` 中把每个 `REQ-xxx` 和 `REQ-xxx-Bnn` 映射到负责 task。`tests` 与 `evidence` 在 executing 阶段补齐真实测试名和报告证据。

## 执行顺序

1. 执行 T1，先让状态层具备可测试的记录和解析能力。
2. 执行 T2，使飞书入站事件携带 dispatcher 需要的引用字段。
3. 执行 T3，集成引用路由和出站记录，并补齐端到端调度测试。

## 验证策略

- T1：`node --test test/session-service.test.js`
- T2：`node --test test/feishu-platform.test.js test/feishu-events.test.js`
- T3：`node --test test/message-dispatcher.test.js test/message-dispatcher-platform-event.test.js test/permission-handler.test.js`
- 全量回归：`npm test`

## 风险控制

- 引用解析只在 `parentId` 映射有效且 `chatId` 一致时生效，避免跨聊天误投递。
- 引用命中不调用 `setFocus` 或 `bindRoute`，避免改变用户当前焦点。
- 飞书发送成功后的映射记录被异常保护，记录失败只写日志，不影响用户可见回复。
- 映射容量剪枝只在写入路径执行，入站解析保持常量级查找。
