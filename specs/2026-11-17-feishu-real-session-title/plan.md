# 飞书真实会话标题实现计划

**目标：** 按消息实际关联的 OpenCode 会话读取真实标题，一对多绑定、并发和焦点切换均不串标题，失败不阻断发送。

**架构：** 只改既有驱动和调度器两层：驱动提供精确只读标题查询，调度器管理身份隔离缓存、降级和页脚上下文。沿用飞书格式化与安全转义，不增加插件协议、配置项或通用缓存框架。

**技术栈：** Node.js >=22.11.0、CommonJS、既有 HTTP 客户端、SQLite CLI、Node.js 内置测试与 ESLint。事实和核实局限见 `engineering-facts.md`。

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | 精确只读标题能力 | 驱动 | medium | 无 | REQ-001、REQ-003 | 001-B01/B03；003-B01/B06/B08 | `tasks/T1.md` |
| T2 | 归属、缓存与页脚接入 | 调度 | high | T1 | REQ-001～003 | 001-B01～B03；002-B01～B05；003-B01～B08 | `tasks/T2.md` |
| T3 | 行为闭环与回归证据 | 验证 | high | T1、T2 | REQ-001～003 | 全部16项 | `tasks/T3.md` |

表中简写均指完整 `REQ-xxx-Bnn`；完整映射见各 task frontmatter 和 `traceability.json`。

## 文件结构与独占写入

- T1 独占修改 `src/drivers/opencode-driver.js`、既有 `test/opencode-driver.test.js`，并产出本规格 `evidence/driver-validation.md`：新增 `getSessionTitle(sessionRef, options)` 及实现后的驱动行为验证，不修改基类、不调整现有消息读取或认证机制。独立审查发现共享HTTP层两项阻断后，用户另行批准扩大owns至 `src/core/http-helper.js` 和 `test/http-helper.test.js`，仅修复UTF-8跨块解码和解析失败正文日志；详见 `http-scope-amendment.md`，保留字节上限、超时与既有返回契约。
- T2 独占修改 `src/dispatch/message-dispatcher.js`、既有 `test/message-dispatcher.test.js`，并产出本规格 `evidence/dispatch-validation.md`：标题身份快照、缓存、降级、精确归属、销毁清理及实现后验证；不新增架构层。
- T3 独占既有 `test/feishu-api.test.js`、`test/integration-feishu-tui-sync.test.js` 及本规格 `evidence/fixed.json`、`test-report.md`：补充集成与兼容回归。这些既有文件仅为互斥归属声明；具体新测试、断言与隔离方式均在实现重构后确定，不预设计测试 seam。不得调整不相关测试或覆盖失败基线。
- 共享 `traceability.json`、任务状态和结构化收据由主执行者按任务完成时串行维护，属于流水线元数据，不并行派发写入；`requirements.json` 的状态仅在确有相应证据时更新，并刷新受影响交接。

T3追加获批测试隔离范围：`test/integration-feishu-question.test.js`，只为`createFixture`补显式合成服务地址、临时数据库及禁用宿主服务发现；不改原6项断言和生产契约，见`question-isolation-scope-amendment.md`。

## 驱动接口与读取约束

T1追加批准范围：`test/claude-removal-guard.test.js`，仅解除历史测试对驱动工作区改动的冻结，保留Claude禁接入保护；见 `guard-scope-amendment.md`。

1. `getSessionTitle(sessionRef, options = {}) -> Promise<string|null>`：只接受明确的非空 `opencodeSessionId`；`options.timeoutMs` 是剩余预算，正数且最多2000毫秒。无关联 ID 不发起读取；失败抛出可分类错误，由调度器处理。
2. 普通连接复用 `this.httpClient.request('GET', url, null, {timeoutMs})`，路径为 `/api/session/` 加编码 ID；目标使用已关联地址，不能通过 `ensureReady`、枚举会话或启动服务猜测。只接受成功响应，优先解析官方包装 `resp.data.data`，兼容直接 `resp.data`；若响应携带 ID，必须等于请求 ID。
3. TUI 按 `transport === 'tui-bridge'` 选择已有本地库，即使 bridge 不可用也不改查另一连接。复用 `sqliteCmd`、`execFile`、`opencodeDbPath`；只读 URI、精确安全转义 SQL、`hex(title)` 输出解码；设置 `timeout`、`killSignal: 'SIGKILL'` 和有界输出缓冲。超时或权限失败不尝试其他来源。
4. HTTP 的真实销毁定时器与子进程的真实终止参数必须生效，不只使用调度器竞争等待。一个身份只选一种标题源，不做 HTTP→数据库或数据库→HTTP 的权限绕过。

## 身份快照与展示约束

- 在 `_feishuRuntimeContext` 的任何异步等待前，确定所属 Walker 会话、驱动、复制 `agentRef` 及有效连接地址，并立即开始标题查询；不得先等待模型补读再用可能已变更的连接发请求。T1 在选择目标与调用既有客户端之间不插入异步等待，确保请求创建时的地址与现有认证上下文一致；标题等待过程中不能再读取焦点或变化后的连接。
- 缓存键用结构化序列化组合：驱动名、transport、有效服务地址（普通连接）或数据库路径＋runtimeId（TUI）、`opencodeSessionId`。不含聊天、cwd、消息正文或凭据；不以聊天或进程作为标题身份。缺失 runtimeId 的旧记录只按明确数据库＋会话 ID 读取，不能借用其他 runtime；补齐 runtimeId 后视为新身份。
- 显式 `context.session` 或显式非空 `sessionId` 无法解析时立即返回无会话，不能继续借用 `routeKey` 焦点；仅缺少显式身份的既有 route-only 调用保留入口处一次焦点解析，不扩大改动到消息路由。
- 真实标题优先；识别空白、非字符串、精确等于 Walker/OpenCode ID 的名称、匹配本会话自动生成 `session <短ID>` / `opencode <短ID>` 的占位名称。不能用宽泛的“以session开头”规则误删正常标题。
- 降级顺序：同身份尚未淘汰的历史真实标题→当前所属会话有效非默认本地标题→省略会话字段。本地降级不写入共享真实标题缓存，避免同底层身份的不同本地名称互相污染。
- 不新增标题状态写入；保留既有模型补读、上下文计算、安全转义、页脚替换、正文去重及进度卡参数补位。2秒预算仅覆盖新增标题读取，不伪称改变既有模型补读耗时。

## 有界缓存与生命周期

- 调度器内部一个最多128项的身份条目集合，成功、失败、历史标题和进行中条目均计入；最多16项进行中读取，不设无限等待队列。
- 条目记录最近有效真实标题、最近读取完成时间和可选进行中 Promise。成功与失败均从读取完成时起缓存30000毫秒；`age < 30000` 命中，`age >= 30000` 刷新。失败可以保留同条目的历史真实标题，不能另建历史表。
- 同键优先复用进行中 Promise；异键独立。缓存满时淘汰最久未使用的已完成条目，不淘汰正在读取的条目；达到16个读取上限或无可淘汰槽位时立即按当前同身份历史/本地/无标题降级，不排队、不挪用其他身份结果。
- 每次读取共享一个2000毫秒截止时间，调度器的有界等待用于兜底，驱动只获得剩余预算；不得每次失败或解析后重新开始2秒。真实源已带实际超时，兜底超时的迟到结果不得发布缓存。
- 销毁清空缓存、进行中引用及等待定时器，唤醒等待者按降级完成；用 `_destroyed` 与条目/请求身份检查阻止迟到结果重新填充。底层请求/进程至迟按原2秒预算终止，不要求为此修改全局 HTTP API。
- 日志只记录关联 Walker/OpenCode ID、传输类型和受控失败分类，不直接记录原始异常文本、URL、数据库输出或认证头；同键失败只在实际刷新时记录一次。饱和降级不逐条打印故障日志。

## 依赖关系与执行边界

`T1 → T2 → T3`，三个任务串行；写入归属互斥，下游 reads 与 depends_on 明确。严格全局读写检查可能因合法上下游读取而报冲突，不能通过删真实 reads 绕过。是否需要隔离执行代理由实施阶段 skill 与适用规则决定，不在规划阶段派发代理。

T1、T2 各自在实现与重构后完成自己层级的持久化行为验证和证据，才交给下游，不依赖 T3 才能关闭前置任务。主执行者为各自承担的每项 behavior 补真实 tests/evidence；跨层行为的完整验收仍由 T3 补强，需求不得因单层实现通过而提前宣称全部完成。

实现计划需先通过产物一致性分析并取得 `approved` 人工审批。之后在 `.worktree/` 创建隔离工作树并验证基线；本轮未提交规格需原样带入，不能覆盖用户工作或假设它们已经在 Git 中。此计划不授权自动提交、合并、推送、部署、重启或启动真实服务。

## 验证与追溯闭环

- 独立预期来自 SRC-001～003、已确认规格及原探针；保留 `evidence/baseline.json`。修复后运行 `node specs/2026-11-17-feishu-real-session-title/evidence/title-source-probe.cjs <工作树绝对路径> <本规格绝对路径>/evidence/fixed.json`，不能修改探针期待值让其通过。
- 驱动验证覆盖官方响应包装、精确编码 ID、认证透传、401/403/404/500、畸形/空标题、SQLite 引号/中文/多行、只读不存在文件、权限失败和真实终止；测试网络只使用隔离测试 HTTP 服务，不启动 OpenCode。
- 发送边界覆盖文本、Markdown、进度卡、问题卡、同聊天同cwd A/B、焦点切换、连接替换逆序返回、同键合并、30秒边界、128/129条目、16/17读取、失败缓存恢复、历史降级及销毁迟到结果。
- 实现后强制做局部重构和测试前设计审查，再编写持久化行为测试。文件操作使用临时目录，网络/进程边界可控，时间使用现有 Node.js 测试时钟能力，不为测试新增生产注入接口。
- 运行相关定向测试，再运行完整 `npm test`；报告确切命令、退出码和测试计数，检查独立可错路径。每个行为填入真实 tests/evidence，REQ 级不能代替 behavior 级。
- `traceability.json` 初始覆盖3项需求和16项行为；本阶段 tests/evidence 留空表示尚未执行，不声称已有通过证据。实现及测试收据绑定实际代码版本；结构化门禁、后续收敛、验证、审查和同步仍按流水线执行。实机飞书验收未执行时必须明确说明。
