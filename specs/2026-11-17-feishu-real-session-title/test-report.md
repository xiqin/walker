# 飞书真实会话标题 — 测试报告

## 最终验证阶段补记（2026-11-17）

以下原执行阶段报告与失败记录保留。既有失败不是本阶段新失败：原首审FAIL不撤销，后续`evidence/T3-review-round2.md`已独立复审PASS并关闭R1/R2；`evidence/converge-semantic-review.md`另对16/16行为给出独立语义覆盖PASS。因此下文“复审完成前”的叙述属于出具报告时的历史状态，不代表当前仍阻断。原报告受审SHA-256为`f75f9c9038b9c5724df28584dcb6aae0cae9aaef8b9fd60fcf73554b896f40b7`；本次只增加本补记及版本绑定，不改原动态日志、期待值、收据或审查报告。

版本绑定在最终验证时实测：生产及测试文件须与既有独立审查指纹一致后才复用原动态证据，不冒充原测试运行器当时生成的绑定。Git树为HEAD树，差异哈希按机械校验器口径排除本规格目录，包含既有`.loom/compliance/history.json`，并非仅本功能源码；不能仅凭此哈希证明历史执行来源或隔离。

- evidence-git-tree: `e506636f6a0698cd43367ac1ffe4d2bf8b259397`
- evidence-diff-sha256: `cdbcb46dd40b5d1ffa460593978034baf3e51c27af8e6b852241b88a6b91a2b9`

审查准备阶段绑定补记：宿主推进verification后追加`.loom/compliance/history.json`，其中把保留原基线和历史失败的叙述登记为违规；该记录完整保留，非新增产品反例。上次整体差异绑定为`c3203dc47bb975495fd9cdbd9e3c82bdf3ab9ba4b47a187bf6106b7629d41f83`；本次仅更新上述绑定，三生产/七测试与五份动态证据指纹仍一致，实际静态复核见`evidence/review-static.log`。刷新前报告原字节另存`evidence/review-prior-test-report.md`，原独立审查及所有失败记录不变。当前绑定不冒充原业务运行时快照。

## 判定与范围

本地自动化验证PASS：隔离修复后57项集成、381项定向、6项question及完整1578/1578回归均通过，REQ-001、REQ-002、REQ-003及16项行为有当前证据。T3首次独立审查`evidence/T3-review.md`仍保留FAIL原结论，R1为8处旧TUI夹具未隔离默认用户数据库，R2为本报告此前不成立的“未读取用户数据库”声明；本轮修复及新证据独立复审完成前不关闭T3、不进入converge。本报告的PASS仅指主执行者本地验证，不冒充独立审查。原56/56、381/381及1577/1577计数和哈希真实，但不能证明安全隔离。

未执行实机飞书人工验收，未启动真实OpenCode服务；没有提交、合并、推送、部署或重启。必须纠正：完整测试命令及独立重跑均触发旧真实TUI驱动的默认用户数据库查询路径，不能再声称这些历史运行未访问用户库。不另外检查数据库存在性、内容或是否被创建/修改，也不清理用户路径。工作树无独立CodeGraph索引，不使用主仓库回落索引代表本树，也没有擅自初始化。

## 设计审查与测试边界

T1/T2实现及局部重构先于持久化行为测试，独立预期来自批准规格及原探针失败观察。生产仅增加驱动业务标题接口及调度身份缓存；T3没有生产改动、依赖、测试专用注入或通用框架。

新增六项跨层夹具使用真实`SessionService`、`JsonStore`、`OpencodeDriver`、`MessageDispatcher`、`FeishuApi`，只拦截不可回滚的飞书外网发送；SQLite场景使用真实CLI及临时库。历史运行中8处旧驱动未隔离，现文件内全部9处真实驱动均提供临时库、`modelState: null`、禁用宿主服务发现及真实SQL路径守卫，清理阶段再次检查越界尝试。新添1项路径守卫测试，不把静态9/9探针当作动态安全证明。上下文为运行时快照字段，不调用持久字段接口写入；请求方法/URL、冻结快照、持久文件和临时库字节比较只证明各自覆盖的路径。

本轮验收命令统一通过`evidence/run-isolated.cjs`设置临时HOME/USERPROFILE/XDG/APPDATA，启动前由Node子进程确认实际`os.homedir()`，正常结束只清理新建目录。它仅隔离默认用户路径，不是OS安全沙箱，不拦截任意硬编码路径或网络。获用户批准后，question夹具另显式提供合成服务地址及临时库并禁用宿主服务发现，不恢复用户service.json、不改生产契约；详见`question-isolation-scope-amendment.md`、`evidence/isolation-remediation.md`。

进度卡覆盖真实`ProgressCard.render()`→调度`replyCard`→真实API请求体，不声称启动了完整bootstrap进度适配器；进度专用方法参数补位和多次更新由T2持久化测试及本轮381项重跑覆盖。问题卡通过真实`QuestionHandler.handleAsked`，创建/处理更新另由T2测试覆盖。缓存极限、销毁和端点替换复用已审查的T2测试，T3重新实际运行，不复制假实现。

## 新增跨层测试

`test/integration-feishu-tui-sync.test.js`新增6项，均PASS：

1. **HTTP官方响应到四入口**：跨UTF-8分块的中文/表情标题进入文本、Markdown、进度及问题卡；4次发送只有1次精确GET，认证沿用，模型/上下文保留，本地state文件不变。
2. **A/B逆序响应**：同聊天同cwd、切焦点到B后A才完成；同键A并发合并，A/B正文各自只有所属标题，焦点未被读取逻辑改写。
3. **HTTP权限失败与恢复**：真实403及错误正文，历史真实标题优先；29999毫秒仍命中失败缓存，30000毫秒后恢复真实标题，原错误正文及口令不泄漏。只模拟Date，不替换网络超时定时器。
4. **真实SQLite到发送**：含引号及SQL注入外形ID精确读取，多行/飞书标签/Markdown字符安全展示，数据库来源切换结果隔离，旧记录缺runtime可读取；两库文件不变，缺失数据库不被创建。runtime键隔离的独立判定采用T2计数/不同结果测试，不把本测试相同标题当作独立证明。
5. **真实HTTP无效值及ID错配**：非字符串、空白、关联ID、默认名称、他人响应ID均不进入会话页脚，模型/上下文仍发送。
6. **真实挂起HTTP**：约2秒预算结束后发送无会话行，服务端观察连接确实关闭，重复发送不再次GET；测试允许本地调度余量到3500毫秒，不把余量当作业务预算放宽。精确2000毫秒边界另由T2可控时钟测试证明，SQLite实际进程终止另由驱动测试证明。

`test/feishu-api.test.js`新增1项，PASS：标题失效后历史文本/卡片页脚会话行被移除，不留下默认名称、旧模型或重复页脚。

## 命令与实测结果

所有命令在`H:/walker/.worktree/2026-11-17-feishu-real-session-title`运行，Node.js v22.11.0。

下表为历史运行，原文件保留，但未满足本轮完整默认用户路径隔离条件，不能代替新验收：

| 命令 | 退出码 | 结果 | 日志（本规格evidence/下） |
| --- | --- | --- | --- |
| `npx eslint test/integration-feishu-tui-sync.test.js test/feishu-api.test.js` | 0 | 无诊断 | `integration-lint.log` |
| `node --test --test-concurrency=1 test/integration-feishu-tui-sync.test.js test/feishu-api.test.js` 首轮 | 1 | 50通过/6失败；测试准备错误，非业务反例 | `integration-first.log` |
| 相同定向命令修正夹具后 | 0 | 56/56通过 | `integration-retry.log` |
| `node --test --test-concurrency=1 test/claude-removal-guard.test.js test/http-helper.test.js test/opencode-driver.test.js test/message-dispatcher.test.js` | 0 | 381/381通过 | `final-targeted.log` |
| `npm test` | 0 | ESLint、语法检查及1577/1577测试通过 | `final-full-regression.log` |
| `node specs/2026-11-17-feishu-real-session-title/evidence/title-source-probe.cjs "H:/walker/.worktree/2026-11-17-feishu-real-session-title" "H:/walker/.worktree/2026-11-17-feishu-real-session-title/specs/2026-11-17-feishu-real-session-title/evidence/fixed.json"` | 0 | 原探针通过，期待值未改 | `final-probe.log`、`fixed.json` |

### 新隔离验收

以下以`R`简写`node specs/2026-11-17-feishu-real-session-title/evidence/run-isolated.cjs`，以`E/`简写`specs/2026-11-17-feishu-real-session-title/evidence/`；完整可执行命令见收据。

| 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- |
| `node specs/2026-11-17-feishu-real-session-title/evidence/database-isolation-probe.cjs` 修复前/后 | 1 / 0 | 静态构造缺失9处→0处，不执行SQL | `isolation-baseline.log` / `isolation-fixed.log` |
| `R integration E/integration-isolated.log` | 0 | 57/57通过，含1项新路径守卫 | `integration-isolated.log` |
| `R targeted E/targeted-isolated.log` | 0 | 381/381通过 | `targeted-isolated.log` |
| `R full E/full-isolated.log` | 1 | 1572/1578通过；6项question初始化失败 | `full-isolated.log` |
| `R question E/question-isolated-baseline.log` | 1 | 0/6通过，同样缺serverUrl | `question-isolated-baseline.log` |
| `R question E/question-isolated-fixed.log` | 0 | 6/6通过，仅补夹具依赖 | `question-isolated-fixed.log` |
| `R full E/full-isolated-retry.log` | 0 | ESLint、源码语法检查及1578/1578通过；失败/取消/跳过均0 | `full-isolated-retry.log` |

完整隔离重跑耗时91970.1917毫秒。上述成功计数及收据不覆盖历史失败结论。

### 失败与环境记录

- T3首轮6项都在准备阶段失败：`updateSessionField`不允许`contextTokens`。修正测试构造的运行时快照后，同命令56项通过；未更改生产代码或持久字段白名单，失败原日志保留。
- 原始业务失败`baseline.json`及`dispatch-before.log`保留；同一探针输出从默认名变为“事件触发客户信息同步”，`fixed.json`保留本地默认名、预期、实际页脚和基线commit，工作区代码未提交，因此commit字段单独不能标识完整实现。
- T1旧守卫唯一失败经用户批准仅移除工作区无diff断言，Claude禁接入保护未削弱；原`http-full-regression.log`、`guard-baseline.log`保留，独立`T1-guard-review.md`为PASS。
- T2首次完整回归宿主120秒超时（退出143），`dispatch-full-regression.log`不能算通过；重跑`dispatch-full-regression-retry.log`真实1570项通过。本轮最终回归预算240秒，真实1577项通过，耗时95567.4629毫秒。
- Node.js版本低于已安装ESLint10.7声明支持范围，依赖安装有引擎警告；本轮实际lint和完整测试通过，没有为消除警告变更依赖。
- 隔离完整回归`full-isolated.log`真实退出1，6项均因question夹具`autostart: false`但未配置serverUrl，在构造阶段失败。失败先于业务断言，不算标题反例，也不能豁免为通过。安全定向同口径复现0/6；用户批准新增测试文件范围后补显式依赖，6/6通过，失败文件全部保留。

## 逐行为闭环

下表D指`test/opencode-driver.test.js`，M指`test/message-dispatcher.test.js`，I指`test/integration-feishu-tui-sync.test.js`，F指`test/feishu-api.test.js`；具体持久化测试定位见`traceability.json`及`evidence/dispatch-validation.md`。D/M当前证据为`targeted-isolated.log`，I/F为`integration-isolated.log`；完整隔离回归状态见上表。

| 行为 | 测试落点及观测 | 状态 |
| --- | --- | --- |
| REQ-001-B01 | D精确标题读取；M统一发送入口/问题创建更新；I四入口真实请求；原探针fixed | PASS |
| REQ-001-B02 | M空值与精确自动名称矩阵；I真实响应无效值及ID错配 | PASS |
| REQ-001-B03 | D只读SQL/编码ID；M格式安全；I临时库、精确含引号ID与安全发送 | PASS |
| REQ-002-B01 | M同聊天焦点切换；I真实HTTP A/B逆序及所属正文 | PASS |
| REQ-002-B02 | M异端点晚完成、库/runtime隔离、模型补读前快照；I同键一次GET | PASS |
| REQ-002-B03 | M完成起算TTL；I真实403失败后29999/30000毫秒刷新恢复 | PASS |
| REQ-002-B04 | M销毁唤醒/清缓存/迟到拒绝；I四种发送只一次GET | PASS |
| REQ-002-B05 | M 128/129已完成LRU与16/17挂起上限，饱和立即同身份降级不排队 | PASS |
| REQ-003-B01 | D真实HTTP、权限错误/数据库故障及终止；I实际挂起连接关闭及缺失库降级 | PASS |
| REQ-003-B02 | M八入口、参数补位、问题更新；F历史页脚去会话行；完整去重回归 | PASS |
| REQ-003-B03 | M显式失效身份不借焦点/无枚举；I仅精确GET、本地状态文件不变 | PASS |
| REQ-003-B04 | M历史→各自本地有效→省略；I真实403时历史优先、仅默认名时省略 | PASS |
| REQ-003-B05 | M首次失败到期恢复；I真实权限故障恢复无需重新纳入 | PASS |
| REQ-003-B06 | D真实HTTP销毁/真实子进程终止；M精确2秒截止；I真实网络不无限挂起 | PASS |
| REQ-003-B07 | M受控分类及身份日志/同键一次；I真实403不泄漏原始错误和凭据 | PASS |
| REQ-003-B08 | D认证透传/权限失败不换源；M显式关联优先；I真实认证GET，无远端写请求 | PASS |

覆盖率仅引用T2历史`dispatch-coverage.log`：调度器行89.07%、分支79.98%、函数86.67%，不是当前隔离覆盖率测量，不声称全系统100%。独立可错路径已覆盖成功、空/畸形输入、授权拒绝、错误、超时、恢复、并发归属、时间/资源边界和销毁；16读取上限使128条全部挂起无淘汰槽位不可达，仍有防御分支。不适用迁移/事务提交测试：本功能不写远端及数据库、不改schema。EACCES是替身注入；子进程终止测试真实终止的是替换执行命令的Node子进程，不是实机SQLite挂起或OS权限配置验收。

## Evidence Receipt

以下文件均相对本规格目录；SHA-256仅证明当前文件字节一致，不证明独立来源。结构化追溯直接引用原始日志和fixed.json，与以下收据对应。

- evidence-command: `node specs/2026-11-17-feishu-real-session-title/evidence/run-isolated.cjs targeted specs/2026-11-17-feishu-real-session-title/evidence/targeted-isolated.log`
- evidence-exit-code: `0`
- evidence-file: `evidence/targeted-isolated.log`
- evidence-sha256: `F9FD4E8058C3E0B755E7B357F7D9B1362270F9EF92747CA3D4455C0310F3C4B9`

- evidence-command: `node specs/2026-11-17-feishu-real-session-title/evidence/run-isolated.cjs integration specs/2026-11-17-feishu-real-session-title/evidence/integration-isolated.log`
- evidence-exit-code: `0`
- evidence-file: `evidence/integration-isolated.log`
- evidence-sha256: `3036E5300CF7DE714C21980FF6E49D505C41EF9754CCE102E9C87B0F6D7955D5`

- evidence-command: `node specs/2026-11-17-feishu-real-session-title/evidence/run-isolated.cjs question specs/2026-11-17-feishu-real-session-title/evidence/question-isolated-fixed.log`
- evidence-exit-code: `0`
- evidence-file: `evidence/question-isolated-fixed.log`
- evidence-sha256: `11839E437BFC2E1E0BE81B243EB092847E886E69F5940F04908AA6E9F9B7DCA8`

- evidence-command: `node specs/2026-11-17-feishu-real-session-title/evidence/run-isolated.cjs full specs/2026-11-17-feishu-real-session-title/evidence/full-isolated-retry.log`
- evidence-exit-code: `0`
- evidence-file: `evidence/full-isolated-retry.log`
- evidence-sha256: `844048330C3A66529F1CF179577422AAAED2D1E8D0A8A26D5B14572E9DB1909E`

- evidence-command: `node specs/2026-11-17-feishu-real-session-title/evidence/title-source-probe.cjs "H:/walker/.worktree/2026-11-17-feishu-real-session-title" "H:/walker/.worktree/2026-11-17-feishu-real-session-title/specs/2026-11-17-feishu-real-session-title/evidence/fixed.json"`
- evidence-exit-code: `0`
- evidence-file: `evidence/fixed.json`
- evidence-sha256: `DFC1E576E4E248F15F7CAC1119340CAE56945AC0518968C0CDEBB9927A730A8B`

失败原始收据：`integration-first.log`退出1，SHA-256 `1711E054200C9E72A0645D67DF39D9A9D3B356329DB47C60B5F2358496A2F574`；不是业务失败基线。业务基线`baseline.json` SHA-256 `F54C6620C7DADDDA30505E28CE334570F3D762A4B442D5225367439DB1FF3C65`保留，未覆盖。

隔离失败收据：`full-isolated.log`退出1，SHA-256 `00D30C3F60BE4C7A6CF17D7243C106D186498917FCFC437EED9EA1FC30395BB0`；`question-isolated-baseline.log`退出1，SHA-256 `6578B384E1788F9743748CB37D7151B61F3965BC562DC5EF460B494F28B8EEB2`。静态隔离失败/修复`isolation-baseline.log`退出1、SHA-256 `470DF1CAD74FCEF15396049CB2EF80982FD363BD1CE409CB34C4B21AE02F9FCF`，`isolation-fixed.log`退出0、SHA-256 `EB9926CF9D27CBCB0DD1E8AD4DCE8179FB5DEB1610E807A681AA390D295DD202`。

verdict: PASS
