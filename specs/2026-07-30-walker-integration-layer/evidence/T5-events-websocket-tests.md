# T5 EventBus 与 WebSocket 事件流 Evidence

## 覆盖范围

- REQ-006-B01: 认证客户端连接 `/api/v1/events/stream` 后收到后续 event-store 发布事件。
- REQ-006-B02: 未认证 WebSocket upgrade 返回 401，且不会建立事件流。
- REQ-006-B03: 广播事件前递归脱敏 token、secret、Bearer 等敏感值。
- REQ-006-B04: EventBus publish 异步 fan-out，不等待慢 listener；单 listener 抛错不影响其他 listener，错误可观察。
- REQ-006-B05: close/error/send_failed 后释放订阅，listener count 下降。
- REQ-006-B05: 同一 event-store 被多个 Admin server 复用时，每个活跃 server 的 bus 都会收到后续事件；server stop 后释放当前 bus，不再接收后续事件。
- REQ-006-B06: 连接、订阅、断开、认证失败、发送失败写入 event-store 或日志。
- REQ-007-B03: WS upgrade 复用 admin token 鉴权；Admin HTTP API 回归测试通过。
- REQ-007-B04: WS 错误路径写入 `ws.events.error` / `ws.events.send_failed`。
- REQ-007-B05: WS send/handler 错误被捕获，主流程继续运行。

## 证据命令

```text
node --test test/event-bus.test.js test/events-websocket.test.js test/admin-server.test.js
PASS: 54 tests passed, 0 failed
```

```text
npm run check
PASS: 1321 tests passed, 0 failed.
```

## 变更文件

- `src/events/event-bus.js`
- `src/admin/ws-events.js`
- `src/admin/server.js`
- `test/event-bus.test.js`
- `test/events-websocket.test.js`
- `specs/2026-07-30-walker-integration-layer/traceability.json`
- `specs/2026-07-30-walker-integration-layer/evidence/T5-events-websocket-tests.md`
- `specs/2026-07-30-walker-integration-layer/handoffs/T5.json`

## 实现说明

- `createEventBus()` 提供 `publish`、`subscribe`、`unsubscribe`、`getListenerCount`、`getErrors`。
- `publish()` 使用 `setImmediate` 异步投递，不等待慢 listener；同步 throw 和异步 rejection 都进入可观察错误列表和可选 `onListenerError`。
- `createEventsWebSocketHandler()` 使用 `ws` 的 `noServer` upgrade，路径限定为 `/api/v1/events/stream`，认证复用 `isAuthenticated()`。
- `subscribe` 消息支持 `sessionId`、`routeKey`、`level`、`type` 过滤。
- 发送前通过 `sanitizeEventForWebSocket()` 递归脱敏敏感字段和值。
- 心跳使用 ping/pong；close/error/send_failed/server_close 统一释放订阅。
- `createAdminServer()` 在 owns 范围内为 `eventStore.events.push` 挂接 bus 发布，不修改 `src/admin/event-store.js`、`src/api/v1/events-routes.js`、`src/app/bootstrap.js`。
- Reviewer repair: `eventStore.events.push` 只包装一次，并在非枚举 `__walkerEventBusPublisher` 内维护 bus 集合；每个 `createAdminServer()` 注册当前 bus，`stop()` 注销当前 bus，避免复用同一 event-store 时闭包绑定首个 bus 或泄漏已停止 server。
- T4 入口修复后触发的旧 CLI usage 断言已同步，当前全量 `npm run check` 通过。
