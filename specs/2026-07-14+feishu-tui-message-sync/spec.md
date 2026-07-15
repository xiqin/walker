# 飞书与 OpenCode TUI 消息同步修复

## 背景

用户已将 OpenCode 会话与 walker attach，但飞书和 OpenCode TUI 之间的双向消息同步存在事件延迟。

## 问题

1. 从飞书发送到 OpenCode 的消息没有显示在 TUI 中。
2. 在 OpenCode TUI 中回复后，消息不会立即推送到飞书；必须从飞书再发送一条消息后，上一条回复才会被推送。

## 目标

- **REQ-001：** 飞书入站消息应立即进入已 attach 的 OpenCode 会话，并在 TUI 中可见；线程消息在自身 route 未绑定时，应复用同一群聊已 attach 的根 route。
- **REQ-002：** OpenCode TUI 的回复应在产生后立即推送到对应飞书会话，不依赖下一条飞书入站消息触发；watcher 经 prompt 的 suspend/resume 后必须继续使用原始事件回调。
- **REQ-003：** 保持现有 attach、路由、消息去重、焦点 session 和非 TUI 消息链路行为不变。

## 验收标准

1. 建立可重复运行的失败反馈环，能覆盖两个故障中的事件时序。
2. 修复前回归测试失败，修复后通过。
3. 飞书入站消息无需额外事件即可在 TUI 会话中显示。
4. TUI 回复无需下一条飞书消息即可发送到飞书。
5. 相关定向测试和项目全量测试通过。
