# T6 PlatformDriver 测试证据

## 范围

- 任务：T6 PlatformDriver 轻 adapter 与兼容收口
- 覆盖需求：REQ-004、REQ-007
- 覆盖行为：REQ-004-B01 至 REQ-004-B06，REQ-007-B01 至 REQ-007-B06

## 变更摘要

- 新增 `src/platforms/platform-driver.js`，定义 PlatformDriver 方法边界与标准 platform event 校验。
- 新增 `src/platforms/platform-registry.js`，管理平台 driver 状态，并禁止 Telegram、Slack 等真实外部平台接入。
- 新增 `src/platforms/feishu-platform-driver.js`，将飞书消息转标准事件，并代理发送、更新、卡片和附件能力。
- 扩展 `src/platform/feishu/events.js` 与 `src/platform/feishu/platform.js`，飞书长连接入口经 adapter 生成标准事件，同时保持原有回调兼容。
- 扩展 `src/dispatch/message-dispatcher.js`，新增 `handlePlatformMessage(event)`，复用既有 dedup、route、session、turn 状态机。
- 更新 `README.md`，说明 PlatformDriver 边界、新 API、doctor/init/WS 使用方式和兼容约束。

## 验证命令

```text
node --test test/platform-driver.test.js test/feishu-platform-driver.test.js test/message-dispatcher-platform-event.test.js test/feishu-platform.test.js test/message-dispatcher.test.js
```

结果：PASS，198 tests passed, 0 failed。

```text
npm run check
```

结果：PASS，1319 tests passed, 0 failed。

## 行为映射

- REQ-004-B01：`test/feishu-platform-driver.test.js` 验证飞书消息转换为字段完整的标准事件。
- REQ-004-B02：`test/message-dispatcher-platform-event.test.js` 验证 invalid event 返回 `BAD_REQUEST` 且不调用 agent driver。
- REQ-004-B03：`test/message-dispatcher-platform-event.test.js` 和 `test/message-dispatcher.test.js` 验证标准事件复用 dedup、route、session、turn 状态机。
- REQ-004-B04：`test/feishu-platform.test.js` 和 `test/message-dispatcher.test.js` 验证现有飞书长连接、命令、卡片路径未回退。
- REQ-004-B05：`test/feishu-platform-driver.test.js` 和 `test/message-dispatcher-platform-event.test.js` 验证平台接收、发送失败、adapter 错误可观察。
- REQ-004-B06：`test/platform-driver.test.js` 验证禁止注册/启动真实 Telegram、Slack 等外部平台接入。
- REQ-007-B01：`test/message-dispatcher.test.js`、`test/feishu-platform.test.js` 和全量 check 验证飞书命令、`/agents` 与 Admin 兼容路径保持可用。
- REQ-007-B02：`test/message-dispatcher.test.js` 与全量 check 中 session-service 相关用例验证 route/session 状态迁移和恢复未受影响。
- REQ-007-B03：`test/platform-driver.test.js` 验证平台抽象不新增真实外部接入；全量 check 验证既有安全边界测试继续通过。
- REQ-007-B04：`test/feishu-platform-driver.test.js` 与 `test/message-dispatcher-platform-event.test.js` 验证兼容错误、发送失败、adapter 异常可定位。
- REQ-007-B05：`test/message-dispatcher-platform-event.test.js` 验证 dispatcher 异常被捕获并返回结构化错误，主进程不退出。
- REQ-007-B06：`test/platform-driver.test.js` 与 README 兼容说明验证未删除现有 env、CLI、Admin API 入口。
