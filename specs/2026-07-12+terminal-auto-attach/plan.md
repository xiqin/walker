# OpenCode 启动自动纳入 Walker — 实现计划

**目标：** 通过 OpenCode plugin hook 机制实现 OpenCode 启动时自动纳入 Walker，支持 1:N session 路由解决同 cwd 多 OpenCode 串会话问题，OpenCode 退出时自动取消 turn 并切换焦点。

**架构：** Walker 启动时自动写入 hook plugin 到 `~/.config/opencode/plugins/walker-hook.js`；plugin 监听 `session.created` 事件并上报到 Walker HTTP 端点；SessionService routes 从单值升级为 `{ focusSessionId, sessions[], cwd }` 结构；Dispatcher 按焦点 session 路由消息，非焦点 session 输出回群带标识；每 session 独立心跳轮询检测 OpenCode 退出。

**技术栈：** Node.js (CommonJS)、node:test 测试框架、飞书 Lark SDK、OpenCode HTTP/SSE API

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | SessionService 1:N routes 升级与迁移 | 数据层 | 中等 | 无 | `tasks/T1.md` |
| T2 | Hook plugin 安装与 receiver 端点 | 接口层 | 中等 | T1 | `tasks/T2.md` |
| T3 | 配置项新增与白名单注册 | 配置层 | 低 | 无 | `tasks/T3.md` |
| T4 | Dispatcher 命令改造与非焦点输出 | 业务层 | 高 | T1 | `tasks/T4.md` |
| T5 | 飞书卡片"设为焦点"按钮 | UI 层 | 低 | T4 | `tasks/T5.md` |
| T6 | 心跳轮询与 OpenCode 退出检测 | 基础设施 | 中等 | T1, T2 | `tasks/T6.md` |
| T7 | README 更新 | 文档 | 低 | T1-T6 | `tasks/T7.md` |

## 依赖关系

```
T1 (routes 升级) ──┬──> T2 (hook receiver)
                   ├──> T4 (dispatcher 改造) ──> T5 (卡片按钮)
                   └──> T6 (心跳轮询)           │
                                                │
T3 (配置项) ──> T2, T4, T6                      │
                                                │
                                    T7 (README) <┘ (依赖全部)
```

- **T1 独立先行**：数据结构升级是所有其他 task 的基础。
- **T3 可与 T1 并行**：配置项不依赖 routes 结构。
- **T2 依赖 T1**：hook receiver 需要调用 `addSessionToRoute` 等新方法。
- **T4 依赖 T1**：dispatcher 命令改造需要 `getCurrent` 返回焦点、`setFocus`、`listSessionsInRoute`。
- **T5 依赖 T4**：卡片按钮复用 dispatcher 的 `/use` 切焦点逻辑。
- **T6 依赖 T1 + T2**：心跳轮询需要 `removeSessionFromRoute`、`setFocus`，且需知道哪些 session 是 hook 纳入的。
- **T7 最后执行**：文档需反映所有已实现功能。
