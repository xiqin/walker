# Walker 演进路线

> 状态：方向稿，持续更新
> 当前实现区间：opencode + 飞书 单链路打通

## 1. 技术栈决策

**继续 Node.js，不重写 Go。**

| 维度 | Node.js（当前） | Go（opendray / cc-connect） |
|------|-----------------|------------------------------|
| 飞书 SDK | `@larksuiteoapi/node-sdk` 官方成熟 | 需自写或用第三方 |
| PTY 操作 | `node-pty` 跨平台兼容性弱 | `creack/pty` 一流 |
| 并发模型 | 单线程异步 I/O，消息分发足够 | goroutine 天然并发 |
| 部署 | 需 Node 运行时 | 单二进制 |
| 迁移成本 | 0 | 全量重写 |

理由：
- 已有 458 通过测试的代码基础，重写到 Go 的 ROI 极低
- 当前 opencode driver 走 HTTP REST 不依赖 PTY，避开了 Node 最大短板
- 真正需要 PTY 时走**混合架构**：Node 主进程 + Go 侧进程做 PTY 管理（通过子进程通信），比全量重写代价小得多
- 飞书官方 SDK 是 Node 生态最大优势点

## 2. 核心目标

walker 当前最大的差异化优势是**多 session 精准分发和回调**：routeKey 三模式（thread/user/channel）将飞书消息线索精准绑定到本地 Agent session，完成 message → session → agent → 飞书回调的完整闭环。

演进的核心是**守住并深化这个优势**，同时按可插拔接口预留扩展：

```
[当前]  飞书 ←→ walker ←→ opencode
[目标]  多平台 ←→ walker ←→ 多 Agent CLI
```

## 3. 多 session 分发与回调优化清单

基于完整代码调研，按严重程度排序。所有引用的行号基于调研时版本。

### 3.1 P0 严重（直接影响核心体验）

#### P0-1：卡片回调 thread 模式 routeKey 错误

- **问题**：卡片回调经 `parseCardAction` 只拿到 `{chatId, messageId, openId}`，无 rootId/parentId。`bootstrap.js:120` 用 `buildRouteKey(action, 'thread')` 必然退到 `feishu:chatId:root:chatId`，与原 thread 不一致。
- **影响**：话题群/帖子中点 /use、/stop、/delete、/list 按钮时操作失效或错绑；/use 按钮点击后用户感觉「没切换」。
- **涉及**：`src/app/bootstrap.js:115-131`、`src/platform/feishu/events.js:60-71`、`src/core/route-key.js:13-16`、`src/platform/feishu/cards.js:27-29`
- **修复方向**：在卡片 button value 里携带 rootId 或完整 routeKey，parseCardAction 透传；回调时直接用嵌入的 routeKey，不重建。

#### P0-2：JsonStore read-mutate-write 无锁，并发 lost update

- **问题**：`JsonStore.update` 非原子（`json-store.js:61-65`），SessionService 所有写无锁。并发 markRunning/bindRoute/deleteSession/createSession 会互相覆盖，丢状态或丢绑定。
- **影响**：多群同时 prompt、连点按钮、admin API 与 dispatcher 并发写时 session 状态错乱。
- **涉及**：`src/core/json-store.js:61-65`、`src/core/session-service.js:47/49/77/94/157/162/178`
- **修复方向**：JsonStore 内部加异步互斥（每文件一个 mutex，update 排队执行）；或单线程写队列；或带版本号的 read-modify-write + 重试。

#### P0-3：同一 session 并发 prompt 无串行化/背压

- **问题**：平台层不 await handler（`platform.js:45`），多条消息并发打同一 opencode session，多次并发 prompt、多张进度卡、idle 误判。
- **影响**：用户连发消息、群多人同时 @ 时，opencode 同 session 并发 prompt 行为未定义，体验混乱。
- **涉及**：`src/platform/feishu/platform.js:44-48`、`src/dispatch/message-dispatcher.js:48-122`、`src/drivers/opencode-driver.js:151`
- **修复方向**：dispatcher 内每 sessionId 维护单飞队列（in-flight 锁 + 排队），对「已 running」session 的后续消息做排队/拒绝/合并；给 prompt 加背压上限。

### 3.2 P1 高（影响健壮性）

#### P1-1：dedup 不持久化、不覆盖命令、不校验陈旧消息

- **问题**：(a) dedup 仅内存，重启丢失；(b) `handleCommand` 无去重，按钮重复点击重复执行 delete/stop；(c) 不用 `createTime` 拒绝陈旧重投。
- **影响**：walker 重启窗口内飞书重投已处理文本→重复执行；用户连点删除按钮→多次 driver.delete。
- **涉及**：`src/core/message-dedup.js:18`、`src/dispatch/message-dispatcher.js:129-152`、`src/app/bootstrap.js:115-131`
- **修复方向**：dedup 改为可持久化；handleCommand 入口加 dedup（用 action+messageId+timestamp 作 key）；增加基于 createTime 的陈旧消息过滤。

#### P1-2：/new、/attach 并发产生孤儿 session

- **问题**：并发 `_cmdNew`/`_cmdAttach` 各自远程建 session 并覆盖 route，旧 walker session 变孤儿，opencode 侧留下无人管理 session。
- **影响**：用户连发 /new、快速双击卡片「新建会话」按钮。
- **涉及**：`src/dispatch/message-dispatcher.js:157-185`、`190-256`、`src/core/session-service.js:47-50`
- **修复方向**：每 routeKey 一个互斥令牌（同一 routeKey 命令串行化）；/new 前检查 routeKey 已有未 deleted 的 session（提示是否覆盖）；覆盖前 stop+delete 旧 session。

#### P1-3：createSession 中 session 写入与 route 绑定非事务

- **问题**：先 `sessionsStore.update` 再 `routesStore.update`（`session-service.js:47-50`），两文件两步，中途崩溃产生孤儿。
- **影响**：进程异常退出、断电。
- **涉及**：`src/core/session-service.js:32-54`
- **修复方向**：合并 sessions.json 与 routes.json 为单文件 Store（一次原子写）；或提供启动时孤儿扫描 + 清理。

### 3.3 P2 中（提升可靠性）

#### P2-1：thread 模式 parentId 退路导致跨子树误关联

- **问题**：rootId 缺失退 parentId，群聊非帖子「回复某消息」会被绑到 `feishu:chatId:root:<被回复消息id>`。
- **涉及**：`src/core/route-key.js:13-16`
- **修复方向**：明确 thread 模式仅在话题社区生效；群聊无 root 时退 channel 或 user 模式。

#### P2-2：重启后 session 状态不校准、watcher/进度卡/dedup 不恢复

- **问题**：重启后 session.status 仍为重启前值（可能卡 running）；watcher 不自动恢复→终端操作无回传；progressCards 清空→旧进度卡变「卡死处理中」。
- **涉及**：`src/app/bootstrap.js:79`、`src/dispatch/message-dispatcher.js:535-572`
- **修复方向**：bootstrap 启动后对所有未终态 session 做 opencode 健康探测并校准 status；自动重启 watcher；保留未完成进度卡为「会话已中断」占位。

#### P2-3：脏 route 无主动全量清理

- **问题**：`getCurrent` 只在被访问时懒清理，从未访问的脏 route 永留 routes.json。
- **涉及**：`src/core/session-service.js:71-79`、`153-169`
- **修复方向**：启动时或周期性做一次 routes → session 校验扫描。

#### P2-4：飞书 API 调用无重试/限流，错误静默丢弃

- **问题**：`_callFeishu` 出错只 warn 返回 fallback，`FeishuApi` 无重试无令牌桶。
- **涉及**：`src/dispatch/message-dispatcher.js:574-593`、`src/platform/feishu/api.js:124-130`
- **修复方向**：对 patchCard/reply 加指数退避重试；全局加并发上限或令牌桶;关键错误有用户可见反馈。

### 3.4 P3 低（优化与整洁）

#### P3-1：routeKey 在 platform 与 dispatcher 重复构建

- **涉及**：`src/platform/feishu/platform.js:72`、`src/dispatch/message-dispatcher.js:61`
- **修复方向**：dispatcher 直接用传入的 `event.routeKey`，去掉重建。

#### P3-2：error 状态非终态、errorMessage 不清空

- **涉及**：`src/core/session-service.js:128-130`、`177-188`
- **修复方向**：markIdle/markRunning 时显式清空 errorMessage；明确 error 是否终态的产品语义。

#### P3-3：dedup cleanup 全量扫描

- **涉及**：`src/core/message-dedup.js:51-57`
- **修复方向**：按过期时间分桶或设阈值才清理。

#### P3-4：feishuApiRef 缺方法无显式校验

- **涉及**：`src/app/bootstrap.js:78`、`src/dispatch/message-dispatcher.js:578-593`
- **修复方向**：定义 feishuApi 接口清单，bootstrap 显式校验所有方法已挂载。

## 4. 可插拔扩展接口设计

当前只按 opencode + 飞书 实现和验证链路，但所有扩展点预留接口，新接入只需实现接口 + 配置注册。

### 4.1 AgentDriver 接口（已存在雏形）

```
AgentDriver {
  name: string
  createSession(cwd, env) → { agentRef }
  prompt(agentRef, text, onEvent) → AgentEvent[]
  stop(agentRef)
  delete(agentRef)
  watchSession(agentRef, onEvent) → stopWatch()
}
```

当前实现：`src/drivers/agent-driver.js` 接口、`opencode-driver.js` 实现、`stub-drivers.js` 测试桩、`driver-registry.js` 注册表。

后续接入清单（预留，不实现）：
- Claude Code driver（走 ACP 或 PTY）
- Codex driver（走 ACP）
- Gemini CLI driver
- 通用 ACP driver（支持所有 ACP 兼容 agent）

### 4.2 Platform 接口（待从 feishu 抽象）

当前 feishu 实现耦合在 platform.js / events.js / commands.js / cards.js / api.js / progress-card.js。后续抽象为：

```
Platform {
  name: string
  start({ onMessage, onCardAction })
  stop()
  replyText(routeKey, text)
  replyCard(routeKey, card) → cardId
  updateCard(cardId, card)
  sendProgressCard(routeKey, events) → cardId
}
```

后续接入清单（预留，不实现）：
- DingTalk（Stream 长连接，无需公网 IP）
- Telegram（Long Polling，无需公网 IP）
- WeCom（WebSocket）
- Slack（Socket Mode）
- Discord（Gateway）

### 4.3 通用接入点

- `bootstrap.js`：当前只注入 FeishuPlatform + opencode driver + stub drivers。后续改为按配置注入多 Platform 多 Driver。
- `config`：预留 `WALKER_PLATFORMS=feishu` 和 `WALKER_AGENTS=opencode` 配置项，支持逗号分隔多值。
- `route-key.js`：routeKey 前缀 `feishu:` 硬编码，后续改为按 platform.name 动态前缀。

## 5. 演进路线图

### Phase 1：夯实核心链路（当前重点）

目标：opencode + 飞书 链路的生产级可靠性。

- [ ] P0-1 卡片回调 routeKey 修复
- [ ] P0-2 JsonStore 并发锁
- [ ] P0-3 session prompt 串行化
- [ ] P1-1 dedup 持久化 + 命令去重
- [ ] P1-2 /new /attach 并发保护
- [ ] P1-3 session + route 单文件原子写

### Phase 2：可插拔接口落地

目标：AgentDriver 和 Platform 接口抽象完成，新接入只需实现接口。

- [ ] Platform 接口从 feishu 抽象出来
- [ ] routeKey 前缀按 platform.name 动态化
- [ ] bootstrap 按配置注入多 Platform 多 Driver
- [ ] opencode driver 升级为 stream-json（减少轮询）
- [ ] session 重启健康校准 + watcher 自动恢复
- [ ] 脏 route 启动全量清理
- [ ] 飞书 API 重试 + 限流

### Phase 3：多 Agent 多平台扩展

目标：实际接入第二个 Agent 和第二个 Platform，验证接口可插拔性。

- [ ] Claude Code driver（ACP 或 PTY）
- [ ] DingTalk 或 Telegram platform
- [ ] 轻量记忆（读写 agent 指令文件 CLAUDE.md / AGENTS.md）
- [ ] 本地 SQLite 替代 JSON 持久化（可选）

### Phase 4：网关化（长期）

- [ ] Agent Descriptor JSON 注册架构（零代码接 CLI）
- [ ] 多账号池（凭据负载均衡）
- [ ] 通用 ACP driver
- [ ] 混合架构 PTY runtime（Node 主 + Go 侧进程）

## 6. 不做什么

明确排除以下方向，避免过度设计：

- **不追全平台覆盖**：cc-connect 有 13 平台，walker 不照搬，按需求驱动逐个接入。
- **不上 Postgres/pgvector**：当前规模 JSON（Phase 2 后 SQLite）足够，不引入数据库运维负担。
- **不做 Web/Mobile admin 前端**：walker 定位是桥接器不是网关面板，保持轻量。
- **不实现 opendray 式 PTY 长驻 session**：当前 opencode HTTP 链路不依赖 PTY，除非接入 Claude Code 等非 REST agent 才需要。
- **不做多 Agent 编排**：walker 是「一个消息线索绑定一个 agent session」，不做多 agent 对话编排。