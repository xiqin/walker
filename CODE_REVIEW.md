# H:\walker 代码审查报告

审查日期：2026-07-13
审查范围：33+ 源文件，覆盖 src/core/、src/drivers/、src/dispatch/、src/platform/、src/admin/、src/runtime/、src/app/、src/config/、src/opencode-hook/ 全部模块。

## 统计

共发现约 120 个独立问题：
- 严重 8 个（需立即修复）
- 高优先级 14 个（短期修复）
- 中优先级 40+ 个（中期优化）
- 低优先级 50+ 个（长期改进）

---

## 一、严重问题（8 个，需立即修复）

### 1. session-service.js:224-242 — recoverOnStartup 日志 previousStatus 记录错误

`recoverOnStartup` 中先修改 `session.status = 'idle'`，再记录 `previousStatus: session.status`，此时 `session.status` 已是 `'idle'`，日志恒为 idle，丢失了真实的前置状态。

**修复**：在修改前保存 previousStatus。

### 2. message-dedup.js:23-46 — 过期但未清理条目被误判重复

`isDuplicate` 中若 key 已在 entries 中且已过期（`now - entries[key] > windowMs`），但清理阈值未触发（`size < cleanupThreshold` 且 `now - _lastCleanup <= windowMs`），则 `if (this.entries[key])` 仍为 truthy，返回 true 误判重复。

**修复**：在重复判定前检查 `entries[key]` 是否过期，过期则视为未重复。

### 3. opencode-driver.js — 无 cancel(sessionRef) 方法

`message-dispatcher.js:884-888` 的 `_cancelTurn` 调用 `activeDriver.cancel`，但 `OpencodeDriver` 没有 `cancel` 方法。有 `typeof` 守卫会 fallback 到 `activeDriver.stop`，但 `stop()` 是停止整个 session 不是取消当前 turn。用户执行 `/cancel` 取消单次对话却导致 session 终止，需要重新 `/new`。

**修复**：实现真正的 `cancel(sessionRef)` 方法，仅中断当前 prompt 的 SSE，不 stop session。

### 4. attachment-service.js:9-24 — sanitizeFilename 不校验 sessionId 路径穿越

`sanitizeFilename` 只处理 filename 不校验 sessionId。`getInboundPath` 里 `path.join(this.dataDir, 'attachments', sessionId, safeName)`，若 sessionId 含 `..` 或绝对路径（如 `../../etc` 或 `C:\Windows`），`path.join` 会解析出 dataDir 之外的路径，任意路径写入漏洞。

**修复**：对 sessionId 也做 sanitize，或用白名单字符集校验。

### 5. bootstrap.js:124-140 — onCardAction 非 cmd: 前缀路由错误

当 `rawAction` 不以 `cmd:` 开头时，直接 `dispatcher.handleCommand(action)`。但 `action` 是 `{ action, chatId, messageId, openId, routeKey }`，其中 `action` 是类似 `/use wks_xxx` 的字符串。而 `dispatcher.handleCommand` 期望的格式是 `{ name, args, routeKey, ... }`（parseCommand 的输出格式）。传入未解析的 action 对象，`action.name` 和 `action.args` 都不存在，handleCommand 大概率失败。所有非 `cmd:` 前缀的卡片按钮回调都会路由错误。

**修复**：统一走 parseCommand 解析。

### 6. bootstrap.js:82,162-179 — patchCard 失败时 progressCards Map 不 delete 内存泄漏

当 `patchCard` 失败时，`handlePatchFailure` 返回 `{ strategy: 'new_message' }`，但 `progressCards` 中该 cardId 的条目没有被删除。如果调用方收到 `new_message` 策略后创建了新卡片，旧 cardId 的 ProgressCard 对象永远留在 Map 中，长期运行内存泄漏。

**修复**：在 patch 失败时也 `progressCards.delete(cardId)`。

### 7. wsl-runtime.js:7-9,68,70 — WSL 命令注入漏洞

`escapeCmdArg` 只做了 cmd.exe 的 `^` 转义，没有做 bash 的转义。如果 command 或 args 包含 bash 特殊字符（`$`、`` ` ``、`!`、`*` 等），在 WSL 内会被 bash 解释。例如 arg 为 `$(rm -rf /)`，经过 escapeCmdArg 后 `^` 在 cmd.exe 中被去除，传给 wsl.exe 的是 `$(rm -rf /)`，在 bash 中会执行命令替换。真实的命令注入漏洞。

**修复**：加 bash 层转义。

### 8. auth.js:34-35 — token 比较使用 === 易受时序攻击

`token === config.token` 字符串比较是短路比较（第一个不匹配字符就返回 false），攻击者可以通过测量响应时间逐字符猜测 token。

**修复**：用 `crypto.timingSafeEqual` 做恒定时间比较。

---

## 二、高优先级问题（14 个，短期修复）

### 9. opencode-driver.js:279-295 — SSE 建连超时后仍发 POST，SSE Promise 永挂

`Promise.race([sseOpened, _sleep(sseOpenTimeoutMs)])` 若 1 秒内未开流，`sseOpened` 这个 Promise 永远不会被 resolve，也没有 `.catch` 兜底。紧接着无条件发 POST。若 SSE 实际仍没建立，prompt 已发但 SSE 不会被消费。

**修复**：SSE 建连超时后主动 abort SSE 连接。

### 10. opencode-driver.js:332-366 — watchSession SSE 无 timeoutMs 永不超时泄漏

`watchSession` 中 `sseClient.connect` 没有传 `timeoutMs`，意味着 `sseConnect` 内部 `timeoutMs` 为 undefined，永不超时。如果 SSE 永不结束（服务端 keep-alive 不主动 close），且用户从不调用 `stop()`，SSE 连接 + poll 定时器会与 session 同生命周期泄漏。

**修复**：watchSession SSE 加 timeoutMs 或心跳探活。

### 11. opencode-driver.js:510,528 — stop/delete 用字符串拼接 URL 未编码

`stop()` 和 `delete()` 直接拼接 `this.serverUrl + '/session/...'`，未走 `_buildUrl`，不经过 URL 编码。当 `serverUrl === ''` 时生成 `/session/<id>/stop` 这种相对路径，`http.request` 会以 `localhost` 发起请求，潜在 SSRF/请求错发问题。

**修复**：统一用 `_buildUrl` 构造 URL。

### 12. opencode-driver.js:541-548 — _checkHealth 5xx 当作未启动触发 autostart 端口冲突

`_checkHealth` 中 `resp.status === 200` 才返回 true，5xx 也返回 false。`ensureReady` 在 5xx 时会尝试 autostart 并轮询，但服务其实已经在跑（只是出错），autostart 会再 spawn 一个进程导致端口冲突，老进程仍 5xx 永远启动失败。

**修复**：区分连接拒绝（ECONNREFUSED，未启动）和 HTTP 错误响应（已启动但出错）。

### 13. opencode-driver.js 构造期 — serverUrl 为空时 _buildUrl 崩溃

`this.serverUrl = options.serverUrl || ''`。`_buildUrl` 用 `new URL(pathname, this.serverUrl)`，当 `serverUrl === ''` 时抛 `TypeError [ERR_INVALID_URL]`。

**修复**：构造期对 serverUrl 做校验，缺失时立即抛错。

### 14. message-dispatcher.js:174-184 — _promptQueues reject 时 Map 无限增长内存泄漏

`next.then(() => { if (this._promptQueues.get(sessionId) === next) this._promptQueues.delete(sessionId); })` 只在 resolve 时清理。若 task reject，`_promptQueues` 不会被清理，该 session 的队列指针永远卡在 rejected Promise 上，Map 无限增长。

**修复**：清理逻辑用 `.finally` 或同时挂 resolve+reject handler。

### 15. message-dispatcher.js:834-844 — _stopSessionWatch 不清理所有 Map

`_stopSessionWatch` 只清理 5 个 Map，`_promptQueues`、`_routeLocks`、`cancelledTurnSessions`、`suspendedWatches` 不在清理范围。session 删除时这些结构残留。

**修复**：`_stopSessionWatch` / `deleteSession` 时主动清理所有相关 Map。

### 16. message-dispatcher.js:449-464 — _cmdDelete 无 routeKey 归属校验越权删除

`const targetId = cmd.args[0]`，直接 `this.sessionService.getSession(targetId)`。若用户 A 在 routeKey1 下执行 `/delete <sessionB的id>`，会删除用户 B 的 session。无 routeKey 归属校验。

**修复**：校验 targetId 是否属于当前 routeKey。

### 17. session-service.js:42-49 — _readNormalized 返回旧快照迁移做两次

返回的 state 是 update 之前的旧快照，update 内部又对最新读取的 state 做了迁移。逻辑能 work 但做了两次迁移，且第一次的修改是无用的。

**修复**：重构 `_readNormalized` 单次迁移。

### 18. json-store.js:35-43 — read() 静默吞掉解析错误无日志

`JSON.parse` 失败时直接返回默认值，没有任何日志输出。state.json 若因写入中断损坏，应用会看似正常地用空状态启动，所有 session/route 静默丢失，运维难以察觉。

**修复**：添加 logger 或回调通知损坏文件。

### 19. http-helper.js:43-54 — 响应解析失败静默返回 {} 丢失诊断

空响应体或非 JSON 响应时 `parsedData = {}`，调用方无法区分"无响应体"与"响应体是 {}"。`catch` 完全忽略错误无日志。

**修复**：解析失败时记录日志或返回错误标识。

### 20. logger.js:13-29 — 无日志级别过滤 debug 无条件输出

所有 info/warn/error/debug 都通过 console.log 输出，无级别控制。生产环境无法关闭 debug 日志，无环境变量读取。

**修复**：添加日志级别配置（环境变量）。

### 21. installer.js:34-37 — 端口变更后已存在 plugin 跳过安装导致端口不匹配

如果用户第一次启动 Walker 时端口是 8787，hook plugin 写入端口 8787。之后用户改端口为 9000 重启，installer 发现文件已存在跳过安装，但旧文件里硬编码的是 8787，hook 会向错误端口上报。

**修复**：端口变更时检查并更新 plugin。

### 22. core-routes.js:177-204 — sessionStop/DeleteHandler 缺 .catch 请求 hang

只有 `.then` 没有 `.catch`。如果 `stopSession` 抛错（reject），promise rejection 不会被处理，调用方收不到任何响应，请求 hang 到超时。

**修复**：加 `.catch`。

### 23. api.js:46-62 — getTenantToken 无并发保护竞态

缓存过期时多个并发调用同时进入 `_request`，发起多次重复 token 请求。飞书对 token 接口有速率限制，高频重复请求可能触发限流。

**修复**：引入 inflight promise dedup。

### 24. api.js:209-253 — _request 无超时可能永久 pending

如果飞书服务端无响应（TCP 连接已建立但不返回数据），Promise 会永远 pending，阻塞整个飞书消息处理。

**修复**：为 req 设置 setTimeout 并在超时后 req.destroy() + reject。

---

## 三、中优先级问题（40+ 个，中期优化）

### 安全类

- `windows-runtime.js:7-9` — `escapeCmdArg` 未转义换行符，命令注入风险
- `receiver.js:20-26` — loopback 校验可被反向代理绕过
- `receiver.js:59-62,104-115` — 直接访问 sessionService 私有方法 `_readNormalized` 和 `stateStore.read()`
- `auth.js:73-85` — `parseBody` 无大小限制 DoS 风险
- `auth.js:129` — cookie 无 Secure 属性
- `cards.js:95,193` — title 未转义 Markdown 注入风险
- `plugin-template.js:25-36` — 生成 plugin 无认证，token 配置后 hook 不工作
- `config-editor.js:22-28` — `stringifyEnvValue` 转义不完整，缺少换行符检查
- `file-admin.js:14-20` — `safeResolve` 的 rootDir 尾部分隔符处理

### Bug 类

- `message-dispatcher.js:884-888` — `_cancelTurn` 调不存在的 `driver.cancel` 退化为 stop
- `message-dispatcher.js:536-544` — `_cmdModel` 的 `updateSessionField` 在 `ensureReady` 前执行无回滚
- `message-dispatcher.js:593-611` — `_formatStatus` 死代码
- `message-dispatcher.js:917-959` — `_startPromptHeartbeat` 定时器在 session 删除时可能仍触发
- `message-dispatcher.js:816-832` — `restoreWatches` 并发无限制，文件描述符耗尽风险
- `bootstrap.js:300-309` — stop 顺序错误，应先停 platform 再停 admin
- `bootstrap.js:81-88,143-156` — feishuApiRef 延迟绑定的竞态
- `core-routes.js:404,442` — `module.exports` 重复赋值
- `core-routes.js:130-151` — `sessionsCreateHandler` 的 async handler 不处理 promise rejection
- `core-routes.js:219-227` — `sessionPromptHandler` 错误状态码映射不完整
- `session-admin.js:100-107` — 直接操作 `stateStore.update` 绕过 SessionService
- `agent-runtime-admin.js:93-104` — `checkAgent` catch 返回 `ok:true` 语义混乱
- `event-store.js:164-192` — `buildBuckets` 实为 60 小时桶但注释写 60 分钟，命名误导
- `diagnostics.js:186` — `checkOpenCode` 的 `ensureReady` 可能意外启动 opencode
- `env.js:89-93` — `parseInt` 对负值静默接受，应统一用 `parsePositiveInt`
- `env.js:57-65` — `parsePort` 和 `parsePositiveInt` 逻辑完全相同重复代码
- `env.js:100-103` — 配置项拼写错误 `Opendcode`（多了个 d）
- `attachment-service.js:58-66` — `saveInbound` 同步 IO 阻塞事件循环
- `attachment-service.js:58-66` — `saveInbound` 写入失败无 try/catch
- `receiver.js:34-37` — `normalizePath` 硬编码 Windows 路径不跨平台
- `health-poller.js:31-52` — `track` 重复调用被跳过但旧 timer 不更新
- `server.js:103-106` — start 的 error 事件可能被忽略
- `server.js:131-137` — stop 不处理 in-flight 请求
- `windows-runtime.js:58-65` — `openTerminal` 用 detached + stdio ignore 无法获取错误
- `wsl-runtime.js:100-104` — `resolveServerUrl` 的 hostname -I 解析假设
- `wsl-runtime.js:29-35` — exec 方法丢弃 stderr
- `file-admin.js:47` — `readLogs` 读取整个文件到内存
- `service-control.js:64-66` — `exitProcess` 的 setTimeout 无法被取消

### 设计类

- `session-service.js` 全文 — `_normalizeRoute` 每次写都重跑迁移逻辑
- `session-service.js:152-166` — 状态转换缺少完整合法性校验
- `session-service.js:212-222` — `updateSessionField` 无字段白名单
- `session-service.js:309-327` — `setFocus` 写失败静默返回却日志报成功
- `session-service.js:168-195` — `deleteSession` 先读后写冗余
- `http-helper.js:92-213` — `sseConnect` abort 时 resolve 空数组而非 reject
- `http-helper.js:195` — `buffer += chunk.toString()` 无大小限制可能内存耗尽
- `http-helper.js:195` — 未处理跨 chunk 多字节字符
- `route-key.js:13-17` — thread 模式忽略 parentId
- `id.js:10-15` — `prefix` 未校验
- `message-dispatcher.js:696-712` — `_coalesceDisplayEvents` 去重逻辑脆弱
- `message-dispatcher.js:978-1009` — watch 与 prompt 渲染路径重复投递文本
- `progress-card.js:88-93` — text delta 合并逻辑可能丢失初始内容
- `agent-runtime-admin.js:53-68` — `detectStubDriver` 通过源码字符串检测
- `event-store.js:141-145` — `hourStart` 用 UTC 但展示用本地时间

---

## 四、低优先级问题（50+ 个，长期改进）

### 设计问题

- `opencode-driver.js` — 职责过重（787 行单文件），建议拆分为 OpencodeHttpClient、OpencodeSSEAdapter、SessionPoller 等
- `opencode-driver.js` — DefaultHttpClient/DefaultSSEClient 未通过依赖注入让测试替换
- `agent-driver.js` — 基类用 throw 作为抽象方法不是真正的抽象
- `agent-driver.js` — AgentEvent 没有 data 字段的 schema 约束
- `agent-driver.js` — prompt 基类签名与子类不一致违反 LSP
- `driver-registry.js` — register 不校验重名，get 返回 null 需到处判空
- `stub-drivers.js` — 方法集与真实接口不同步
- `message-dispatcher.js` — 构造函数 14+ 配置项无校验
- `message-dispatcher.js` — handlers 表别名映射无文档
- `json-store.js` — 同步/异步 I/O 混用，`updateAsync` 无生产调用方
- `logger.js` — 无脱敏机制
- `route-key.js` — 硬编码 `feishu:` 前缀
- `id.js` — 非标准 ULID 变体，文档易误导
- `attachment-service.js` — `sendOutbound` 空实现
- `attachment-service.js` — 无文件大小限制、无 MIME 类型校验
- `api.js` — `replyText` 返回类型不一致
- `commands.js` — `parseCommand` 不处理前导空格
- `commands.js` — 未知命令静默当文本处理
- `platform.js` — `stop` 不等待 wsClient 关闭
- `platform.js` — config 字段双重命名
- `bootstrap.js` — `normalizeReplyCtx` 不处理 null
- `bootstrap.js` — `adminConfig` 双重默认值
- `env.js` — `loadDotEnv` 不支持带空格和引号的值
- `runtime-factory.js` — 无类型校验
- `receiver.js` — `normalizePath` 去除尾部斜杠但不去除尾部空格
- `router.js` — `match` 遍历不做 method 预过滤
- `response.js` — `parseQueryString` 在 module.exports 之后定义
- `response.js` — `parseQueryString` 不处理 + 编码
- `event-store.js` — `recordMetric` 参数顺序歧义
- `event-store.js` — `promptDurationsMs` 无上限增长
- `command-simulator.js` — `describeAction` 与 COMMANDS 不同步

### 跨文件/架构级问题

- **资源清理路径不闭合**：`_stopSessionWatch` 清理 5 个 Map，`_promptQueues`、`_routeLocks`、`cancelledTurnSessions`、`suspendedWatches` 不在清理范围
- **错误处理策略不一致**：HTTP 错误 throw，SSE 错误返回事件，飞书 API 错误返回 fallback 值，文件 IO 错误直接 throw
- **并发模型复杂且无显式锁**：`_promptQueues` 和 `_routeLocks` 是两套独立队列不互斥
- **缺少 graceful shutdown**：dispatcher 无 `destroy()` / `close()` 方法
- **日志级别使用不当**：多处用 `logger.info` 打印高频事件

---

## 五、修复优先级

### 立即修复（严重，8 个）
1. `session-service.js:237` previousStatus 在修改前保存
2. `message-dedup.js:23-46` 在重复判定前检查过期
3. `opencode-driver.js` 实现真正的 `cancel(sessionRef)` 方法
4. `attachment-service.js:9-24` 对 sessionId 做路径穿越校验
5. `bootstrap.js:124-140` 统一卡片按钮路由走 parseCommand
6. `bootstrap.js:82,162-179` patchCard 失败时也 delete progressCards
7. `wsl-runtime.js:7-9` 加 bash 层转义
8. `auth.js:34-35` 用 crypto.timingSafeEqual

### 短期修复（高，14 个）
9-24. 见上方高优先级问题列表

### 中期优化（中，40+ 个）
- session-service 统一错误处理策略
- message-dispatcher 资源清理路径闭合
- http-helper.sseConnect 限制 buffer 大小、拆分函数
- env.js 统一用 parsePositiveInt，修复 Opendcode 拼写
- receiver.js loopback 校验 + token 双重防护
- plugin-template.js 生成时注入 token
- cards.js 对 title 做 Markdown 转义
- bootstrap.js 修复 stop 顺序
- windows-runtime.js escapeCmdArg 转义换行符

### 长期改进（低，50+ 个）
- opencode-driver.js 拆分为多个类
- JsonStore 抽象为接口支持多后端
- session-service._normalizeRoute 用版本标记避免重复迁移
- id.js 标准化 ULID 实现或重命名
- AgentEvent 加 schema 约束
- driver-registry 加重名校验
- 各种死代码清理、命名规范、文档完善
