# 飞书与 OpenCode TUI 消息同步修复实现计划

**目标：** 修复已 attach 会话的飞书入站路由与 OpenCode TUI 出站 watcher 恢复时序，使双向消息均不依赖下一条飞书消息触发。

**架构：** 保持现有 `MessageDispatcher -> OpencodeDriver -> OpencodeSessionWatcher` 分层。入站侧仅在 thread route 未绑定时回退到同群根 route；出站侧保持 watcher 生命周期不变，只确保 suspend/resume 后轮询继续调用原始 handlers。执行前用当前回归用例对 HEAD 旧实现建立 red 信号，再验证工作区已有改动是否构成最小完整修复。

**技术栈：** Node.js CommonJS、`node:test`、OpenCode HTTP/SSE API、飞书消息路由

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 修复飞书线程消息到已 attach 会话的入站路由 | 业务层 | 中等 | 无 | `tasks/T1.md` |
| T2 | 修复 TUI 回复 watcher 恢复后的即时推送 | 驱动层 | 中等 | 无 | `tasks/T2.md` |
| T3 | 双向链路集成验证与回归检查 | 集成层 | 中等 | T1, T2 | `tasks/T3.md` |

## 依赖关系

```text
T1 ──┐
     ├──> T3
T2 ──┘
```

- **T1 与 T2 可独立执行**：分别拥有 dispatcher 与 watcher/driver 测试文件，不存在写入冲突。
- **T3 串行收口**：只新增独立集成测试并运行全量检查，不修改 T1、T2 拥有的源文件。
- **已有未提交改动保护**：执行时先审阅目标文件现有差异，只增补本需求所需内容，不回退或覆盖其他并行改动。
