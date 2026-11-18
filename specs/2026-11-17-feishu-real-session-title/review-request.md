# 飞书真实会话标题 — 代码审查请求

日期：2026-11-17。分支：`feature/2026-11-17-feishu-real-session-title`。

审查固定基准：`db54556bc0be99478114c6c809dc78efa6edc31a`（当前HEAD，也是本需求基线）。审查对象为该基准之上的**未提交工作区差异**和本规格目录，未为发起审查自动提交或创建PR。

## Standards

- **W1／非阻断警告：历史证据编码。**`evidence/isolation-baseline.log`、`isolation-fixed.log`、`ledger-validation-retry.log`为UTF-16LE，另有历史中文乱码。依据`evidence/converge-semantic-review.md:127–140`；原字节、哈希和历史判定均保留，新验收依据另存的隔离日志，不能宣称全部日志均为UTF-8。
- 未发现当前需要修复的标准阻断。按`.loom/rules/constitution.md`及实际差异核对既有分层、最小改动、错误分类、日志、安全、资源边界和测试行为：读取留在驱动、缓存归属留在调度，格式化复用飞书层，无新架构层、依赖或配置。
- 坏味道检查未发现新增循环依赖、共享全局缓存、测试反向依赖、无界队列、通用框架或未解释的临时兼容层。缓存集中为一个有界Map和一个完成函数；测试分层替身与真实HTTP/临时SQLite互补，不把替身结果冒充实机。
- 具体代码依据：`src/drivers/opencode-driver.js:219–270`、`src/dispatch/message-dispatcher.js:2139–2243,2465–2472`、`src/core/http-helper.js:54–84`；测试与七维独立预审查依据`evidence/converge-semantic-review.md:60–119`。本请求由主执行者整理，不冒充新的独立审查或独立重跑。

## Spec

- 无当前规格偏差或阻断。来源为`spec.md`、`requirements.json`和已重新获批的`plan.md`；对照REQ-001真实标题、REQ-002一对多归属及缓存、REQ-003降级与兼容，独立收敛为16/16语义覆盖。
- 范围追加有明确依据：`http-scope-amendment.md`允许共享HTTP解码与日志修复；`guard-scope-amendment.md`允许解除驱动相对HEAD无差异断言但保留Claude禁接入；`question-isolation-scope-amendment.md`允许question夹具补显式合成依赖。没有通过削弱业务断言或提交代码绕过旧守卫。
- 非目标保持：不回写本地或远端标题，不枚举最近会话，不改插件协议、schema或管理命令；没有提交、合并、推送、部署、重启或启动真实OpenCode服务。无本树独立图索引，已跳过图查询，不使用主树回落索引或擅自初始化。

## Spec 遗漏自审

检查3项需求、16项行为。以下逐项与实际源码、持久化断言及`traceability.json`映射核对；完整独立语义矩阵见`evidence/converge-semantic-review.md:64–81`。本阶段已完成一次遗漏辅助检查，结果`evidence/review-omission-hunter.json`：16行为、0发现、0阻断。该工具仅辅助确认引用，不把它的通过代替语义审查。

| 行为 | 实现及观察点 | 对应测试文件／已有证据 |
| --- | --- | --- |
| REQ-001-B01 | 精确真实标题经runtime进入八发送入口及问题创建/更新，模型上下文不变 | 驱动、调度、跨层测试；定向、集成日志及原fixed探针 |
| REQ-001-B02 | 过滤空白、非字符串、所属ID和精确自动名，省略无效会话行 | 调度无效输入矩阵、跨层响应ID错配；定向及集成日志 |
| REQ-001-B03 | 只读URI及安全SQL精确ID，HTTP编码ID，标题安全折叠转义 | 驱动临时SQLite、调度真实请求体、跨层库字节及路径守卫；定向及集成日志 |
| REQ-002-B01 | 先固定消息所属身份，不受聊天焦点切换影响 | 调度并发、跨层真实HTTP A/B逆序；定向及集成日志 |
| REQ-002-B02 | HTTP origin+ID、数据库绝对路径+runtime+ID隔离，同键合并 | 调度异端点晚完成、四种TUI身份结果与请求计数、跨层同键一次GET；定向及集成日志 |
| REQ-002-B03 | 成功和失败均从完成起算30秒TTL | 调度29999/30000边界、跨层403到期恢复；定向及集成日志 |
| REQ-002-B04 | 重复进度共享读取，销毁唤醒、清空缓存定时器且拒绝迟到结果 | 调度销毁与多入口计数、跨层四入口只一次GET；定向及集成日志 |
| REQ-002-B05 | 128/129 LRU及16/17读取上限，饱和不排队、不挪用标题 | 调度容量与挂起上限测试；定向日志 |
| REQ-003-B01 | HTTP/数据库故障受控降级，不阻断正文 | 驱动错误矩阵、跨层缺库与挂起连接关闭；定向及集成日志 |
| REQ-003-B02 | 旧记录直接补读，页脚替换/正文去重/参数补位兼容 | 调度、飞书、跨层及question夹具；定向、集成、问题及完整日志 |
| REQ-003-B03 | 显式失效身份不借焦点，只精确读取、不写标题状态 | 调度禁止调用和冻结对象、跨层state字节及GET断言；定向及集成日志 |
| REQ-003-B04 | 同身份历史真实标题→当前有效本地标题→省略，本地不入共享缓存 | 调度降级组合及同远端不同本地名、跨层真实403；定向及集成日志 |
| REQ-003-B05 | 失败缓存到期可恢复，无需重新纳入 | 调度首次失败恢复、跨层403恢复；定向及集成日志 |
| REQ-003-B06 | 单一2秒截止，真实HTTP销毁/子进程终止，不只停止等待 | 调度精确2000毫秒、驱动真实HTTP及Node替换进程、跨层实际连接关闭；定向及集成日志 |
| REQ-003-B07 | 固定失败分类和身份日志，不泄漏原异常或响应正文，不重复放大 | 调度debug捕获、HTTP日志断言、跨层403正文；定向及集成日志 |
| REQ-003-B08 | 沿用关联认证和原来源，权限拒绝不换源或启动服务 | 驱动认证/401/403/EACCES、调度显式地址优先、跨层唯一认证GET；定向及集成日志 |

遗漏0项，未实现或矛盾0项，未获批准扩展0项。`requirements.json`的failing字段保留原失败基线含义，不为刷新状态修改已批准需求。旧首审FAIL及原失败日志不被覆盖，原R1/R2关闭依据为`evidence/T3-review-round2.md`。

## 预审查摘要

- Standards发现：1项既有非阻断编码警告，最严重为警告；当前阻断0。
- Spec发现：0，未跳过规格审查。
- Spec遗漏：0，检查16行为；遗漏辅助检查通过。
- 本地自动化适用范围内可提交人工审查；不表示人工审批或实机验收通过。

## 主要变更

1. 驱动新增`getSessionTitle(sessionRef, options)`：按明确关联ID精确HTTP只读GET，或TUI既有SQLite CLI只读`SELECT hex(title)`；实际超时/终止及安全失败分类。
2. 调度在任何异步模型补读前固定身份并启动标题读取；按来源与会话隔离有界缓存，同键合并，2秒预算、30秒成败缓存、128条目及16读取上限，失败确定性降级，销毁拒绝迟到回填。
3. 复用原页脚格式化、模型上下文、进度参数补位及去重。共享HTTP增加跨块UTF-8解码，解析失败日志移除正文预览，保留字节限制和返回契约。
4. 增加驱动、调度、真实源跨层与兼容测试；所有9处真实TUI驱动夹具隔离数据库和宿主服务发现，question夹具补显式合成地址/临时库。移除旧守卫冻结工作区断言，不移除Claude禁接入保护。

## 变更统计与文件

本阶段实际`git diff HEAD --stat`：11个已跟踪文件，新增1092行、删除29行。包含`.loom/compliance/history.json`的21行元数据，不把它算作生产实现。`specs/2026-11-17-feishu-real-session-title/`尚未跟踪，规格、任务、收据、日志、报告及交接不在该统计中，仍属于审查材料。

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/drivers/opencode-driver.js` | 修改 | 精确只读标题源与底层超时终止 |
| `src/dispatch/message-dispatcher.js` | 修改 | 归属快照、缓存、降级与生命周期 |
| `src/core/http-helper.js` | 修改 | UTF-8分块解码及日志脱敏 |
| `test/opencode-driver.test.js` | 修改 | 认证、ID、响应、权限、临时库与真实终止 |
| `test/message-dispatcher.test.js` | 修改 | 发送、并发、TTL、容量、降级、销毁和日志 |
| `test/integration-feishu-tui-sync.test.js` | 修改 | 六项真实源跨层、路径守卫及旧夹具隔离 |
| `test/integration-feishu-question.test.js` | 修改 | 显式合成依赖，原六项业务断言不变 |
| `test/feishu-api.test.js` | 修改 | 历史页脚无效标题兼容 |
| `test/http-helper.test.js` | 修改 | 跨块中文、字节上限实际关闭及安全日志 |
| `test/claude-removal-guard.test.js` | 修改 | 仅移除工作区冻结断言和无用Git代码 |
| `.loom/compliance/history.json` | 已有元数据差异 | 含审批过期历史和宿主启发式合规记录，完整保留 |
| 本规格目录 | 未跟踪新增 | 批准意图、计划、追溯、真实证据及本审查请求 |

## 自测情况与版本证据

- 构建：无独立build/类型编译命令；宪章构建与检查命令为既有模板。实际按`package.json`脚本及`scripts/check.js`模式核验，不伪造构建通过。
- 静态：已有本阶段`evidence/review-static.log`退出0，包含`npm run lint`、112源码文件按正确CommonJS/浏览器ESM模式语法检查、占位扫描、`git diff --check`及3REQ/16行为/5收据账本。
- 动态：复用已读及核实的隔离集成57/57、定向381/381、question 6/6及完整1578/1578；完整日志失败/取消/跳过均0，退出0。不为本次生成请求重新运行产品测试、原探针或真实服务。
- 图：本工作树没有独立CodeGraph索引，已明确跳过查询；不能把主树回落索引算成本树已同步。
- 版本：`evidence/review-version-receipt.json`及本次`evidence/code-review-request-snapshot.json`确认产品差异和报告/证据字节不变。产品差异SHA-256为`1b2d948de4e821383b1d0bceee3fe5aec1a2038bbf976995f0e7bf30f06be2de`。
- 整体差异SHA-256为`cdbcb46dd40b5d1ffa460593978034baf3e51c27af8e6b852241b88a6b91a2b9`，按既有校验器口径排除本规格目录、包含合规历史；它是当前快照，不证明原运行器执行来源，也不覆盖未跟踪规格内容。报告和证据分别用文件哈希绑定。
- 两报告因宿主合规历史变化而刷新绑定，旧报告和四份旧交接均逐字备份，详见`evidence/review-metadata-refresh.md`；正式刷新后机械校验ok:true，四份交接审计通过。首版附加审计误要求T3输入指纹包含其输出报告的准备错误已保留于`evidence/review-handoff-audit.json`，不是产品失败。

核心证据路径均相对本规格目录：

| 证据 | 结果 | SHA-256 |
| --- | --- | --- |
| `evidence/full-isolated-retry.log` | 1578/1578，退出0 | `844048330c3a66529f1cf179577422aaaed2d1e8d0a8a26d5b14572e9db1909e` |
| `evidence/review-static.log` | 静态/语法/账本/差异通过，退出0 | `a775970c8b72a56e8479222ef848f5d748dc2d56b2b5b889f11d4e1014f1a94e` |
| `evidence/T3-review-round2.md` | 原R1/R2独立复审通过 | `42cce9feb25b1295f1bfdd793e13a0c65e3192a1001370e756e57e4ce49f4fa5` |
| `evidence/converge-semantic-review.md` | 独立16/16语义覆盖 | `01f3863c548c49287c1b9afe4a6211999083ea36c4e3c389f0756486b28ed1c2` |
| `verify-report.md` | 最终验证通过，当前绑定已续补 | `64840d8e8c629f26d040e5e234d9a998e39c3028877215d0537be5deeb8c0b79` |

## 请审查者重点确认

- [ ] **归属与并发：**同一飞书聊天绑定多个会话、焦点切换、端点/runtime变化及旧请求逆序完成时，不借用另一身份标题。
- [ ] **安全与权限：**精确编码ID、安全转义只读SQL、关联客户端认证；权限失败不换源或启动服务，标题/日志不泄漏凭据和正文。
- [ ] **性能与资源：**完成起算TTL、128/16上限、饱和立即降级、底层实际终止、销毁唤醒与迟到拒绝；不把清Map当立即取消网络。
- [ ] **兼容：**八发送入口、问题创建和更新、进度参数补位、模型/上下文、页脚替换及正文去重。
- [ ] **测试可信度：**真实HTTP与临时SQLite证据、隔离范围、保留原失败、当前产品指纹与复用证据一致性，以及以下尚未验收项。

## 验收限制及人工反馈

未做实机飞书、真实OpenCode、SQLite挂起或OS权限配置验收。正常数据库读取使用真实临时SQLite，EACCES为替身，实际被终止的是Node替换子进程；真实HTTP挂起有服务端连接关闭证据。进度跨层是实际渲染到发送体，不是完整bootstrap实机链路。

默认目录重定向不是OS沙箱，不保证拦截硬编码路径或任意网络，路径守卫不提供符号链接攻击防护。历史旧测试走过默认用户库查询路径的风险不撤销，也不检查或清理用户数据库。Node v22.11.0低于所装ESLint声明支持范围，实际lint通过不等于官方兼容保证。有限资源测试不等于长期无泄漏或实机负载承诺。

请人工给出通过或具体修改意见；本请求不伪造`review-feedback.md`或代替人工审批。按用户最新要求，不再请求压缩、不设置compression_confirmed、不推进阶段。生成本请求并写交接后，状态仍为code-review-request；后续review-gate须按实际状态与用户明确授权处理，不自动批准。
