# converge 独立语义与遗漏审查

## 结论

**PASS：3 项需求、16 项行为均为 `covered`；语义阻断 0，`missing` 0、`partial` 0、`contradicts` 0、未获批准的 `unrequested` 0。保留历史证据编码警告 1 项。**

这是对当前源码、真实差异、持久化断言和既有动态证据的独立审查，不沿用旧审查 PASS，也不把自动工具的 16/16 `mapped` 当作语义验证。结论仅支持本地自动化范围内的收敛，不代表已经完成 verification、人工实机验收或流水线推进。

## 边界与取证方法

- 日期：2026-11-17。工作树：`H:/walker/.worktree/2026-11-17-feishu-real-session-title`；规格根：`specs/2026-11-17-feishu-real-session-title`。
- 先读取 `loom-converge`、`loom-omission-hunter`、指定的 `combined-reviewer-prompt.md`、项目精简上下文和宪章，再读取批准的 `spec.md`、`requirements.json` 全部类别/描述/验收/测试计划、`tasks/T1.md`～`T3.md`、真实 `traceability.json` 和计划。不从实现摘要反推需求。
- `requirements.json` 没有单独的 `must_preserve` 字段；本次以其 `intent.invariants`、规格“不变量与安全”和批准计划中的保持约束作为不变量，不杜撰额外义务。
- 核对三个生产文件、七个测试文件的真实 `git diff`，并检查未修改的 HTTP 客户端、飞书格式化、问题处理器、进度渲染器和 bootstrap 调用方。无本树独立 CodeGraph 索引，未调用主树回落索引、未初始化；影响分析是源码搜索与差异分析，不声称图遍历完备。
- 仅只读检查源码、现成日志、哈希及 `git diff --check`（通过）；**未运行测试、动态探针、账本脚本或真实服务**。动态结果均来自已保存日志，本审查不冒称独立重跑。
- 仅新增本文件，不修改需求、计划、状态、主报告、追溯、收据或原证据；不提交、推送、合并、部署、重启。未检查用户数据库的存在性、内容或后果，也未清理用户路径。独立上下文不是操作系统权限隔离。

## 证据口径与版本

以下简称仅用于本报告；测试/源码路径相对工作树根，日志路径相对本规格 `evidence/`：

| 简称 | 真实文件 |
| --- | --- |
| 驱动 | `src/drivers/opencode-driver.js` |
| 调度 | `src/dispatch/message-dispatcher.js` |
| HTTP | `src/core/http-helper.js` |
| 飞书 | `src/platform/feishu/api.js` |
| D / M / I / F | `test/opencode-driver.test.js` / `test/message-dispatcher.test.js` / `test/integration-feishu-tui-sync.test.js` / `test/feishu-api.test.js` |
| 定向日志 | `targeted-isolated.log`，381/381，退出 0 |
| 集成日志 | `integration-isolated.log`，57/57，退出 0 |
| 问题日志 | `question-isolated-fixed.log`，6/6，退出 0 |
| 完整日志 | `full-isolated-retry.log`，1578/1578，退出 0 |

四份成功日志均有启动命令和尾部 `isolated_home_verified: true`，失败/取消/跳过均为 0。完整日志第 1～17 行包含 `npm test`、`eslint .`、112 个源码文件语法检查成功；第 11479～11492 行为测试计数和退出收据。不是用报告摘要代替原日志。

本轮实际计算的 SHA-256 与当前 `test-report.md` 五份收据一致：

| 文件 | SHA-256 |
| --- | --- |
| `targeted-isolated.log` | `F9FD4E8058C3E0B755E7B357F7D9B1362270F9EF92747CA3D4455C0310F3C4B9` |
| `integration-isolated.log` | `3036E5300CF7DE714C21980FF6E49D505C41EF9754CCE102E9C87B0F6D7955D5` |
| `question-isolated-fixed.log` | `11839E437BFC2E1E0BE81B243EB092847E886E69F5940F04908AA6E9F9B7DCA8` |
| `full-isolated-retry.log` | `844048330C3A66529F1CF179577422AAAED2D1E8D0A8A26D5B14572E9DB1909E` |
| `fixed.json` | `DFC1E576E4E248F15F7CAC1119340CAE56945AC0518968C0CDEBB9927A730A8B` |

原失败证据保留：`full-isolated.log` 为 1572/1578、退出 1，哈希 `00D30C3F60BE4C7A6CF17D7243C106D186498917FCFC437EED9EA1FC30395BB0`；`question-isolated-baseline.log` 为 0/6、退出 1，哈希 `6578B384E1788F9743748CB37D7151B61F3965BC562DC5EF460B494F28B8EEB2`。后者第 10～16 行直接定位缺少 `serverUrl` 的驱动构造错误，而非标题断言失败。旧 `T3-review.md` 的 FAIL 不被新结论覆盖。

`ledger-validation-retry.log` 实际旧输出是 3 REQ、16 behavior、**4** 份收据；不能冒称它证明当前 5 份。当前 5 份由本轮逐文件哈希与主报告核对，行为引用由实际追溯逐项审查。`check-ledger.cjs` 的源码也只做工作树账本、名称及哈希检查，不提供业务语义证明；本轮未执行它。

当前生产文件指纹：

| 文件 | SHA-256 |
| --- | --- |
| 驱动 | `66ACD7C8B2F07DE6E0337A2D45B900C963084FE38100C91051389F592934B40D` |
| HTTP | `34BC7C0FF4C43E2DECB5C72B23AB373795A5085402709A6FFD56BC8363BCB0F1` |
| 调度 | `883919180319E37626255B251CAE335B8151DD71D75608FAF8E5A714CEF3EF72` |

写入本报告前，对当前受跟踪差异文件和本规格全部既有文件（排除本报告）共 100 个按“排序路径:文件 SHA-256”聚合，指纹为 `9df901c242f19ce1488d8175270696182ef2e7dcbb5a6045f256638cf9ddc3d8`。该指纹用于检查本轮没有改变受审材料，不证明测试的独立来源或 OS 级隔离。

## 16 项行为语义矩阵

每行的测试均来自真实 `traceability.json` 映射或其映射文件内的补充断言；不是仅确认文件存在。T3 确实映射全部 16 项，T2 映射全部 16 项，T1 映射其驱动职责的 5 项。

| 完整行为 ID／类别／任务 | 当前代码符号与验收事实 | 持久化测试及具体断言 | 既有动态证据 | classification |
| --- | --- | --- | --- | --- |
| REQ-001-B01／happy-path／T1,T2,T3 | 驱动 `getSessionTitle:225–260` → 调度 `_feishuRuntimeContext:2139–2156` → 飞书 `buildRuntimeFooter`；默认本地名称不阻止取得真实标题，模型/上下文保持。 | D:28–39 精确标题；M:47–70 八方法及参数数组不变，M:96–112 问题创建和更新；I:115–142 四入口真实请求体、`p/m` 与 123 tokens、一次认证 GET、state 字节不变。 | 定向:145–155、2175；集成:100–103；`fixed.json:4–7` 保留同预期并由默认名变为真实标题。 | covered |
| REQ-001-B02／invalid-input／T2,T3 | 调度 `validSessionTitle:30` 过滤空白、非字符串、所属 ID 和精确自动名；无有效值不构造 `sessionTitle`。 | M:114–130 空值/对象/数字/完整及短 ID 自动名矩阵，正常 session 前缀不误删；I:241–255 对真实源各无效值及他人响应 ID 断言完整文本只剩正文、模型和上下文。 | 定向:159–163；集成:138–142。 | covered |
| REQ-001-B03／security／T1,T2,T3 | 驱动:234–249 只读 URI、单引号双写、精确 `SELECT hex(title)`、编码 ID 的 GET；HTTP:55–74 流式 UTF-8；飞书 `formatSessionTitle:88–95` 折叠/转义。 | D:28–39 请求方法和 URL；D:143–160 注入外形 ID、多行中文、临时库字节不变、缺失库不创建；M:72–94 卡片标签/Markdown 转义、正文保留；I:208–239 两库不变及真实发送安全，I:52–65 路径守卫边界。 | 定向:47–59、150–153、2175、2240–2242；集成:89、125–128。 | covered |
| REQ-002-B01／happy-path／T2,T3 | 调度 `_sessionFromFeishuContext` 先取明确所属，`_feishuRuntimeContext` 固定快照；键使用所属 `agentRef.opencodeSessionId`，没有按聊天/cwd/焦点共用标题。 | M:132–153 A/B 并发、一次 route-only 入口解析及逆序返回；I:144–174 A 挂起、焦点切 B、B 先发，按每条正文验证仅其所属标题、焦点仍 B。 | 定向:164–168；集成:110–114。 | covered |
| REQ-002-B02／concurrency／T2,T3 | 调度 `_feishuSessionTitle:2170–2188` 结构化 HTTP origin+session 或绝对库路径+runtime+session 键；同键 pending 合并。调用真实驱动前没有 await，驱动同步固定源和认证。 | M:155–174 模型补读前已发起旧身份读取；M:176–187 同 ID 换端点、旧响应后完成不覆盖新缓存；M:203–216 缺 runtime→A→B→换库共四次、四个结果；I:144–174 同键两条发送合并成一次实际 GET。 | 定向:169–188；集成:110–114。I 的相同 runtime 标题本身不作独立隔离证明，采用 M 的不同结果及计数。 | covered |
| REQ-002-B03／state-transition／T2,T3 | 调度 `_startSessionTitleRead.finish:2214–2228` 在完成时写 `completedAt`；`age < 30000` 命中，成败都按完成时间缓存，非从开始计时。 | M:218–234 开始 1000、完成 1500，31499 命中、31500 刷新；I:176–206 真实 403 后 60999 命中、61000 恢复，实际 GET 从 2 到 3。 | 定向:189–203；集成:116–120。 | covered |
| REQ-002-B04／performance／T2,T3 | 调度常量:21–24、`_feishuSessionTitle` 单一 Map 计入成功/失败/历史/pending；`destroy:2465–2472` 先置销毁标志、唤醒并清空；finish 的 settled/身份检查拒绝迟到发布。 | M:47–70 多入口只读一次；M:289–320 容量/读取上限；M:340–355 销毁立即完成等待、Map 为 0、推进时钟及迟到后不再读取/回填。I:115–142 四入口只有一次 GET。 | 定向:145、209–228；集成:101。底层按原预算结束，不把清 Map 冒充已取消网络。 | covered |
| REQ-002-B05／boundary／T2,T3 | 调度:2191–2202 在 16 项读取饱和时立即按本身份降级；128 项时仅淘汰最旧已完成条目，无额外队列或隐藏历史表。 | M:289–301 128/129 身份、触碰 0 后保留 0、淘汰 1 后不得取隐藏历史；M:303–320 第 17 个挂起身份立即本地降级、真实读取仍 16、释放后重读；M:218–234 精确 TTL 边界。 | 定向:189–193、209–218。16 读取上限使 128 项全部 pending 不可达，不伪造此状态作验收。 | covered |
| REQ-003-B01／external-failure／T1,T2,T3 | 驱动 `getSessionTitle` 将 HTTP 401/403/404/500、DB 失败和超时转换为受控失败；调度 finish 保留同身份历史，调用级本地降级，不中断正文。 | D:107–130 状态矩阵、实际挂起 HTTP 关闭；D:143–177 缺库及 EACCES；M:236–269 降级及恢复；I:208–239 缺库后正文仍发，I:258–273 实际关闭后发送且重复不再请求。 | 定向:194–203、2209–2247；集成:117、126、154–158。EACCES 为替身，不称 OS 权限实测。 | covered |
| REQ-003-B02／compatibility／T2,T3 | 旧记录只需既有 agentRef；调度 `_withFeishuRuntime:2118–2125` 复制参数且补 initialEvent 空位；飞书 `appendRuntimeFooter/withRuntimeFooterCard` 沿用，正文去重路径未改。 | M:47–70、96–112 八入口/问题更新，M:969–998 真实进度渲染及显式/省略初始事件；F:77–86 历史文本/卡片去默认会话行，F:102 起幂等替换；M:1926–1983 delta/最终重复快照，M:2049 起 watch 不重复已送正文；I 旧默认名直接补读。 | 定向:145–158、392–400、766–790；集成:11–29、101；问题日志:46、129、203、229、324、393；完整日志1578/1578。 | covered |
| REQ-003-B03／forbidden-behavior／T2,T3 | 调度 `_sessionFromFeishuContext:2261–2273` 对显式失效身份立即返回，不落到焦点；无关联不查标题；驱动只有精确只读 GET/SELECT，无启动/枚举/写标题调用。既有模型补读更新不等同标题写入。 | M:271–287 失效 sessionId、null/非法显式 session、无关联的焦点读取与标题读取均 0，route-only 仅一次；setup:18–31 将枚举、启动、标题状态写入设为禁止调用；I:115–142 state 字节不变、冻结对象，唯一远端 GET。 | 定向:204–208、388；集成:101、126。既有正文路由回退未被错误扩大为标题查询回退。 | covered |
| REQ-003-B04／happy-path／T2,T3 | 调度:2188–2204、2221–2228 只把真实有效标题放共享 entry，本地标题只在每个调用 `.then` 降级；优先同身份历史→有效本地→省略。 | M:236–252 历史优先本地；M:254–269 同远端身份不同 Walker 名称分别甲/乙，不共享本地降级；M:114–130 仅默认名省略；I:176–206 真实权限失败仍历史优先，其他页脚不丢。 | 定向:159–163、194–203；集成:117、139、155。 | covered |
| REQ-003-B05／recovery／T2,T3 | 调度失败也写完成时间，TTL 到期再请求；没有永久失败哨兵、重新纳入要求或负缓存之外的额外状态。 | M:254–269 初次失败→期限内仅一次→到期恢复；M:236–252 历史保留后恢复；I:176–206 真实 403 期限内不重读、到期得到新标题和第三次 GET，沿用原 session。 | 定向:194–203；集成:116–120。 | covered |
| REQ-003-B06／performance／T1,T2,T3 | 调度:2208–2243 单 2000ms 截止及剩余预算；驱动:228–249 限制预算并传 HTTP timeout 或 execFile timeout/SIGKILL；HTTP:91–98 真正 destroy。每个身份只选一源，不存在跨源重置预算。 | M:322–338 1999 未完成、2000 降级，迟到不能发布；D:121–141 实际 HTTP 关闭及预算上限；D:179–192 真实 Node 替换子进程被终止且退出；I:258–273 实际网络关闭、发送继续。 | 定向:219–223、2230–2237、2253–2255；集成:154–158（2013.9516ms 含调度余量）。3500ms 测试容差不被当成业务预算。 | covered |
| REQ-003-B07／observability／T2,T3 | 调度:2223–2226 仅固定分类、关联 ID、transport，白名单错误码不传原异常；HTTP:79–84 只记录状态和字节数，无正文预览；失败缓存避免每次进度重复查询/日志。 | M:357–375 捕获 debug、注入异常文本及非法 code，恰好一次降级日志，关联 ID 正确，无原文/URL/认证；D:73–91 的200/401/403 非JSON矩阵；HTTP测试:34–48；I:176–206 真实403错误正文及口令不泄漏。 | 定向:56–59、229–233、2189–2202；集成:117。I 的 warn 捕获不替代 M 的 debug 身份诊断。 | covered |
| REQ-003-B08／authorization／T1,T2,T3 | 驱动复用既有 `DefaultHttpClient` 的同步 headers 快照和 `_buildUrl` 的关联地址优先规则；失败不换源、枚举连接或 ensureReady。TUI runtime 仅为缓存身份，不冒充权限令牌。 | D:28–39 实际认证头/关联 URL；D:107–119 401/403 不启动、不转DB；D:162–177 EACCES 不转HTTP、只读参数；M:189–201 显式关联地址优先；I:115–142 唯一精确认证 GET。 | 定向:180、2175、2210–2217、2245；集成:101。没有新增认证机制或权限绕过。 | covered |

`requirements.json` 中 REQ 和 behavior 的 `status: failing` 为保留的原失败基线字段，不是当前 16 项测试的新失败。上述结论以当前断言、日志和哈希为依据；本阶段不为刷新该字段要求改规格、重新审批或修改账本。

## 八项负空间审查

| 维度 | 对抗性检查与取证 | 结论 |
| --- | --- | --- |
| 1．代码符号 | 16 项均落到真实的驱动读取、调度身份/缓存/降级、既有飞书展示符号；逐行核对真实追溯的任务、测试和证据，而非复述自动 mapped。 | 未发现应有符号缺失。 |
| 2．测试 | 源、真实发送、并发逆序、端点/runtime、成功/失败 TTL、容量饱和、销毁、迟到、授权、转义及兼容均有可观察断言。401 模板测试的实际名称在定向日志:2209–2217 存在，未因源码不是展开字符串误报缺失。 | 未发现验收分支缺口。 |
| 3．预期副作用 | 唯一新增业务效果为可选 runtime 标题/实际页脚；I:115–142 验证标题进入四入口。缓存完成、刷新及失败日志可观察；没有数据库/远端写入义务，不能因没有写事件而杜撰遗漏。 | 预期展示与内存效果存在。 |
| 4．禁止副作用 | SQL只读、精确ID；GET不写标题；显式失效身份不借焦点；不枚举、不启动；冻结对象及state字节比较检验标题不写本地。已有模型补读更新保持，不将其误判为标题写入。 | 未发现禁止操作。 |
| 5．失败处理 | HTTP/DB不可用、权限拒绝、畸形/空响应、实际挂起均降级；单截止及底层终止；历史→本地→省略；失败到期恢复，不从另一连接绕过权限。 | 未发现吞掉发送或永久等待路径。 |
| 6．公共API及范围 | 新增的驱动 `getSessionTitle` 有实际调度调用方，属于批准接口；无新必填构造参数、配置、插件协议、schema或外部公开端点。HTTP共享层、旧守卫及question范围分别有批准追加。 | 无未获批公开API变更。 |
| 7．不变量与并发 | 单线程同步选键/建pending后才等待；同键合并，HTTP origin+session，TUI绝对数据库+runtime+session；本地不进共享缓存；完成起TTL；128 Map/16读取/无队列；销毁先标志，settled及entry身份阻止迟到重填。 | 不需要写事务或跨进程锁；已有并发保护符合只读内存场景。 |
| 8．可观测性 | 固定失败分类和关联身份可定位；原异常/URL/认证/正文不进入标题日志；HTTP共享解析失败日志也移除正文。重复故障只实际刷新一次。既有非标题runtime日志不被冒称已全部重构或脱敏。 | 标题路径无已发现泄漏或日志放大。 |

### 真实调用方与保持项

- `ProgressRenderer._renderEvents/_renderCardProgress`（`src/dispatch/progress-renderer.js:40–85`）显式传所属 session；watch 文本发送（调度:1706）也传 session；watch 进度上下文（:1788–1791）沿用所属 session，不改消息路由和焦点。
- 问题卡通过调度构造器:158–163 的 `runtimeFor` → `QuestionHandler._runtime`；创建和处理更新均用该所属身份。不是只测缓存私有字段或只测问题卡 builder。
- HTTP `DefaultHttpClient.request:17–24` 在任何等待前复制认证头；`buildUrl:50–55` 使用绝对 API 路径，因此 origin 是实际请求目标的缓存维度。TUI 则在驱动第一个 await 前固定绝对数据库 URI 和精确 ID。
- `_withFeishuRuntime` 的参数数组复制和 initialEvent 补位未改；飞书标题单行化、标签/Markdown转义、页脚替换保持；现有 delta/最终快照/watch 完成正文去重断言均在新定向日志通过。新增标题等待只覆盖标题读取，不宣称既有模型/上下文补读也被限制为两秒。

## unrequested 与七维质量判断

1. **架构合规：通过。**源读取留在驱动，归属/缓存留在调度，格式化复用飞书层，无新增架构层、循环依赖或测试反向依赖。
2. **代码质量：通过。**固定常量、有界单一 Map、明确 finish/settled 生命周期和受控错误，故障可恢复；不是无解释吞异常。
3. **安全：通过，限本地自动化证据。**SQL采用安全转义而非谎称绑定参数；无shell拼接执行；只读 URI、关联认证、输出限制和展示转义有断言。没有新增浏览器授权面，CSRF/迁移事务不适用。OS权限与隔离限制见下文。
4. **性能：通过。**128条目、16逻辑进行中读取、无排队、完成后30秒TTL及2秒新增读取预算均有边界证据；不声称已经做实机负载测量。
5. **规范一致性：通过，保留W1。**CommonJS、现有错误/日志机制及中文说明一致；本轮 `git diff --check` 通过，既有完整日志证明lint和语法检查通过。本轮未重新运行lint。
6. **影响范围：通过。**实际生产仅三个已批准文件；七个测试文件均在任务owns或范围追加中。工作树原有 `.loom/compliance/history.json` 差异为既有流水线元数据，不归因于本轮，也不擅自清理。
7. **复杂度与必要性：通过。**`getSessionTitle` 是当前业务所需能力，不是测试接口；没有新增生产构造注入、通用策略或文件系统抽象。临时数据库/execFile/服务记录替换使用既有边界；飞书外网发送的内联替身属于不可回滚外部IO边界。

三项容易误报的范围已逐项核对真实差异：

- `http-scope-amendment.md` 已批准共享HTTP修复。diff只增加UTF-8流式解码并移除JSON解析失败的bodyPreview，保留字节上限、超时销毁和 `{status,data}` 契约；`test/http-helper.test.js:7–64` 有分块、字节上限实际关闭、脱敏及原超时回归。
- `guard-scope-amendment.md` 已批准解除历史“驱动相对HEAD无diff”冻结。diff只删除对应断言及孤立Git帮助代码；`test/claude-removal-guard.test.js:155–218` 七项守卫中的其余保护保留，定向日志:3–43 全通过，没有通过提交绕过测试。
- `question-isolation-scope-amendment.md` 已批准测试夹具补依赖。`test/integration-feishu-question.test.js:115–122` 仅增加合成地址、临时库和禁用宿主服务发现；bootstrap:129–145 已有这些参数透传，未新增生产契约。原六项业务断言未改，先0/6失败、后6/6及完整1578/1578的证据均保留。

## findings、限制与是否阻断

### 阻断项（0）

未发现须回流 executing 的 `missing`、`partial`、`contradicts` 或未获批 `unrequested`。本报告不新增任务、不改状态、不推进流水线。

### W1／warning／历史日志编码可读性（非阻断，保留）

- **具体位置：**`evidence/isolation-baseline.log`、`evidence/isolation-fixed.log`、`evidence/ledger-validation-retry.log` 的第一个字节起；本轮读取其字节前缀均为 `FF-FE-7B-00`（UTF-16LE BOM及JSON起始），普通文本读取账本日志被识别为二进制。旧审查已披露其他历史中文乱码。
- **影响：**不能笼统声明全部证据均UTF-8，也不能用按UTF-8搜索无命中推断测试不存在。旧日志不重编码、不覆盖；本轮以四份新动态日志、真实源码断言及文件哈希完成判断，所以不阻断当前16项行为。
- **建议：**后续新增日志继续用运行器原始文件描述符保存；历史记录及原哈希保持。

### 明确保留的验收限制

- `run-isolated.cjs:12–25,30–39` 只重定向默认用户目录并验证实际 `os.homedir()`，不是OS沙箱，不保证拦截硬编码路径、任意网络或同权限进程。I文件全部9处真实驱动提供临时库/禁宿主发现/模型覆盖及SQL路径守卫；拒绝会在清理阶段再次断言，避免被降级吞掉。路径守卫不被宣称可抵抗任意符号链接或恶意代码。
- 历史旧运行确实曾走默认用户库查询路径；新运行成功不追认历史无访问。本轮不检查用户库存在与否、内容或是否改变，不作无宿主访问的全范围保证。
- 没有实机飞书、真实OpenCode服务、SQLite挂起或OS权限配置验收。数据库正常读取使用真实临时SQLite；EACCES为替身；真正终止的是替换SQLite命令的Node子进程。挂起HTTP则有服务端实际连接关闭证据。
- 跨层进度场景为真实 `ProgressCard.render()`→`replyCard`→真实飞书格式化请求体，不冒充完整bootstrap进度适配器实机链路；进度专用方法/参数补位由M补足。问题创建/处理更新也有M断言。
- 原 `baseline.json` 和 `fixed.json` 预期、输入、模型/上下文保持一致，但探针驱动为替身，commit字段单独不能识别未提交实现；不替代D/I真实源证据。未声称当前全系统覆盖率为100%。
- Node.js v22.11.0 与已安装ESLint声明支持范围的历史引擎警告保留；现成lint实际通过不等于官方兼容保证，不在本轮越权升级依赖。

**最终：规格合规、质量通过；16/16语义覆盖，PASS，保留上述非阻断警告与实测能力限制。**

verdict: PASS
