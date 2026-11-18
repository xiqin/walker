# T1 修复复审（第二轮）

## 最终判定：PASS

**SPEC 结果：规格合规（T1 责任范围）；质量结果：质量通过。BLOCKER：0；WARNING：0。** 原 B1、B2 均已修复，有当前源码、持久化测试及原反例复测共同支持，可进入下一个任务。本判定不代表 T2/T3、完整需求或实机飞书验收已完成。

## 身份与范围

- 日期：2026-11-17。审查者是与实现者分离的独立执行者，**不是操作系统安全隔离环境**，共享工作树；不以代理身份充当授权边界。
- 严格遵照本会话已经完整读取的 `combined-reviewer-prompt.md`，执行规格、逐行为及七维质量审查；沿用已读取的宪章与子代理上下文，不把其中技术栈占位符当作事实。
- 仅复审 T1 及其获批共享 HTTP 修复；未审查 T2 实现，未运行全量 `npm test`。不因后续发送、缓存或实机验收尚未完成而否定 T1。
- 仅新增本报告，未修改业务代码、测试、账本、状态、既有证据或原 `T1-review.md`；没有提交推送、启动真实 OpenCode 服务或读取真实标题。
- 本树无独立 CodeGraph 索引，不使用主仓库回落索引作为事实。依据本树 diff、当前源码和真实证据审查；未声称完成全仓依赖图验证。

## 批准基线与归属核查

重新读取当前 `tasks/T1.md`、`plan.md`、`requirements.json` 中相关行为原文及 acceptance/test_plan、`traceability.json` 的 T1 映射、`evidence/driver-validation.md`，并读取规格根目录的 `http-scope-amendment.md`。批准补充文件位于规格根目录，不在 evidence 目录。

用户本轮指令与补充文件明确授权 `src/core/http-helper.js`、`test/http-helper.test.js`；当前 T1 owns 和计划第21行均已纳入这两个文件。范围仅为原两项阻断，保留认证、原始字节限制、超时销毁和返回契约，不新增客户端或测试接口。

当前 Git 差异包含四个受审源文件/测试文件：驱动新增56行、驱动测试新增185行、共享 helper 增10行删3行、helper 测试新增44行，均在修订后的 owns 内。驱动文件 SHA256 与首轮一致，说明本轮未借修复改动标题来源、SQL、身份、认证或错误分类。

| 当前文件 | SHA256 |
| --- | --- |
| `src/core/http-helper.js` | `34BC7C0FF4C43E2DECB5C72B23AB373795A5085402709A6FFD56BC8363BCB0F1` |
| `src/drivers/opencode-driver.js` | `66ACD7C8B2F07DE6E0337A2D45B900C963084FE38100C91051389F592934B40D` |
| `test/http-helper.test.js` | `F916349DBC3ECD154C0304FBCEA45ECBCE47438AD2F96BAEE9C8BCC60BE2F86E` |
| `test/opencode-driver.test.js` | `1A98E27CC0CF507216B88EEC9407389D4044F6B11836C597625AE7480F72DDD1` |

原 `T1-review.md` 复审开始时 SHA256 为 `8CE763D2199F05C0AFC51E8699D52765AB4F97CF3F82D728EB55D6F6B3F16B94`，本轮不覆盖其首轮 FAIL 历史结论。

## 第一部分：规格审查

### 原阻断闭环

| 原问题 | 当前实现与持久化测试 | 复审结论 |
| --- | --- | --- |
| B1：跨 UTF-8 分块损坏中文标题 | `http-helper.js:54-55,68,74` 每个响应使用自己的 `StringDecoder('utf8')`，经 `decoder.write` 流式解码并在结束时 `decoder.end()`；没有逐块隐式字符串转换。`opencode-driver.test.js:57-70` 在中文及四字节表情内部先后切块并精确断言原文；`http-helper.test.js:7-19` 验证共享返回形状与跨块标题。 | **已修复**。原口径探针独立复测 `titleIntact=true`，不只是新测试自证。 |
| B2：非 JSON 权限响应正文进入日志 | `http-helper.js:79-84` 删除 `bodyPreview`，仅保留 `statusCode` 和原始字节 `bodyLength`；没有以全局禁用日志掩盖问题。驱动测试:72-92 覆盖200/401/403，既断言安全日志仍存在，也检查合成凭据、正文标记及 bodyPreview 不出现；helper 测试:34-49 保留403/空数据返回契约并检查字节长度。 | **已修复**。原口径探针独立复测 `leakedSyntheticMarker=false`，权限错误仍为 `TITLE_FORBIDDEN`。 |

### 逐行为规格映射

以下为 T1 驱动层判定。账本中的完整发送、展示转义和跨层降级义务仍由批准的 T2/T3 补齐，不以单层通过将 REQ 或 behavior 状态提前改成完成。

| 行为 | 批准验收/test_plan 核查要点 | 当前代码、持久化测试与证据 | T1 结果 |
| --- | --- | --- | --- |
| REQ-001-B01 | 验收要求各统一页脚显示真实标题而非默认名；test_plan 从“本地默认名称；关联会话有有效真实标题”验证驱动读取到真实发送，模型和上下文保持原样。 | 驱动:225-260 不使用本地名称；测试“按关联地址精确编码ID，沿用认证并读取官方双层响应”（:28-39）及直接响应/错误身份（:41-55）存在；新增中文/表情跨块（:57-70）修复原偏差。traceability 第6行 test 定位真实，evidence 指向实际存在的 driver-validation.md/driver-tests.log；验证报告已追加本轮日志。 | **通过**；发送端由下游验收。 |
| REQ-001-B03 | 验收要求 SQL 安全转义且只读、HTTP 不写远端、多行/标签不改卡片结构；test_plan 捕获 SQL/HTTP/卡片，输入含引号 ID、多行和飞书标签，预期精确只读且无额外写入。 | 驱动:234-244 使用只读 URI、精确单引号双写和 hex 解码；:246-249 仍为编码 ID 的 GET。真实临时 SQLite 测试（:143-160）检查完整多行标签标题、数据库字节不变、缺文件不创建；HTTP 编码测试保留。traceability 第8行 test/evidence 引用实际存在。 | **通过**；卡片展示转义不属 T1。 |
| REQ-003-B01 | 验收要求按历史/本地/省略降级且真实源有超时；test_plan 注入非成功 HTTP、挂起读取和数据库失败，预期仍发送且无无限等待。 | 驱动:250-265 保留安全错误分类；HTTP 401/403/404/500（测试:106-119）、缺库及数据库权限拒绝（:156-177）与真实超时测试仍在。新增非 JSON200返回 null、401/403保持权限分类，保留失败契约。traceability 第24行定位和证据真实；本轮122项日志覆盖回归。 | **通过**；降级顺序和发送留 T2/T3。 |
| REQ-003-B06 | 验收要求挂起不无限等待，多来源降级共享预算；test_plan 为挂起 HTTP/数据库和依次失败，预期2秒内结束新增标题等待且实际终止受控。 | 驱动:228-230 限定预算，:238-239 设置进程 timeout/SIGKILL/64KiB，:247-248 传剩余预算；共享 helper:91-97 原定时销毁未改。驱动挂起 HTTP（测试:121-130）、预算上限（:132-141）、真实挂起 Node 子进程包装（:179-192）保留；helper:21-32 新增原始字节超限实际关闭，:51-65 既有超时仍在。traceability 第29行双定位和证据真实。 | **通过**；不把 Node 包装进程声称为真实 SQLite 内部死锁，不提前验收跨层总预算。 |
| REQ-003-B08 | 验收要求复用既有认证/数据库权限，401/403或权限拒绝不换连接、焦点或启动服务；test_plan 捕获现有认证并注入权限失败，预期不泄漏凭据、不换身份且发送可继续。 | 认证透传（测试:28-39）、拒绝启动/换源（:106-119,162-177）保留。新增非 JSON 安全日志测试（:72-92）以及 helper:79-84 消除底层原始正文日志。traceability 第31行原 test/evidence 仍有效，driver-validation.md:31-44 已追加本轮修复证据。 | **通过**；实际降级发送由下游完成。 |

### 接口、任务步骤和遗漏自审

- 保留批准的 `getSessionTitle(sessionRef, options) -> Promise<string|null>`、无有效 ID 不读取、成功状态和响应身份校验、官方包装/直接响应支持及空标题 null 契约。
- 仍由 transport 选定单一来源；没有启动服务、枚举会话、借用焦点、切换来源、状态写入或新增远端写请求。数据库只读、安全转义和消息/模型读取实现不变。
- 新共享修复未改变公共参数、返回结构、认证配置或数据库 schema。失败解析仍返回 `{status, data:{}}`；200无标题仍为 null，不为了测试强制变成异常。
- 逐条检查五项 behavior 的代码、持久化测试与 behavior 级 tests/evidence，而非仅检查 REQ 映射。新证据由原映射中的 driver-validation.md 引用；没有要求审查者改账本来满足门禁。
- 新测试补齐首轮明确遗漏的跨字节中文/表情及非 JSON 错误页，并专门防止把原始字节上限误改成字符数。独立预期仍来自批准规格与原反例，没有降低期待值或仅改变 mock 返回结构。
- 未新增测试专用生产参数、接口、方法或框架；测试写入仅既有隔离临时库，网络仅合成服务。T1 职责无遗漏或额外业务实现。

## 第二部分：七维质量审查

| 维度 | 适用性、当前证据与结论 |
| --- | --- |
| 1. 架构合规（阻塞） | **适用，通过。** 驱动继续依赖已有 HTTP 客户端，流式解码修复位于现有 HTTP 基础层；新增依赖仅 Node 标准库 StringDecoder，无跨层反向引用、额外客户端或可见循环。共享层改动已获批准并归属 T1，符合宪章极简与精准修改原则。 |
| 2. 代码质量（阻塞） | **适用，通过。** 解码器生命周期与单个响应一致，结束显式 flush；错误分类保持清晰，安全日志仍保留状态与原始字节长度。B1不再由上层拿到损坏字符串，B2不再先输出正文再试图靠 catch 脱敏。控制流和资源销毁未被无关重构。 |
| 3. 安全风险（阻塞） | **适用，通过。** 仍为精确只读 SQL/GET 和既有认证；解析失败日志不输出原始正文/认证标记。驱动200/401/403与共享层403真实网络测试覆盖；探针独立确认不泄漏合成标记。无新增浏览器入口、数据库写事务或授权机制，因此 CSRF、浏览器渲染和写事务审查不适用；飞书展示转义留后续任务。 |
| 4. 性能隐患（警告） | **适用，无警告。** `chunk.length` 在解码前累计原始字节，超过既有上限仍立即销毁；StringDecoder仅保留不完整字符，不新增响应 Buffer 集合或无界队列。2秒标题预算、实际 HTTP 总时钟销毁和子进程终止均保持。缓存容量与调度销毁不在本轮范围内。 |
| 5. 规范一致性（警告） | **适用，无警告。** CommonJS、既有命名/风格与中文原因注释一致；没有新增配置。日志继续采用项目结构化 logger，仅有意删除危险预览，长度明确为字节，符合批准修订。当前四文件定向 ESLint 独立执行退出0。 |
| 6. 变更影响范围（阻塞） | **适用，通过。** 真实链路仍为 getSessionTitle→DefaultHttpClient.request→httpRequest→logger；共享 httpRequest 的消费者均受正确解码和安全元数据变化影响，因此检查其返回契约、字节限制与超时，且核查包含 helper 的122项定向回归。SSE实现正文在diff中未改，虽同文件已有局部StringDecoder使用，不形成行为变化。未改接口/schema，亦无 T2 owns 重叠。没有以此宣称全仓回归已完成或扩展审查 T2。 |
| 7. 复杂度与必要性（阻塞） | **适用，通过。** 修复使用标准库解码器直接处理真实网络边界，不为测试引入注入参数、敏感响应选项、插件策略或额外抽象。已有 httpClient/execFile 替换边界服务于真实外部IO/不可控进程，测试通过现有依赖和临时目录验证，不存在仅为 mock 的生产设计。 |

## 实际验证与证据区分

### 本轮独立执行

1. `node specs/2026-11-17-feishu-real-session-title/evidence/http-title-review-probe.cjs`：**退出0**，Node v22.11.0；`expectedTitle` 与 `actualTitle` 均为合成“中文标题”，`titleIntact=true`、`failure=TITLE_FORBIDDEN`、`leakedSyntheticMarker=false`。已读探针源码，确认仍按中文第一个字节后分块，401合成敏感正文捕获完整日志，断言不被削弱；服务记录读取明确置空，文件日志关闭。
2. `node node_modules/eslint/bin/eslint.js src/core/http-helper.js src/drivers/opencode-driver.js test/http-helper.test.js test/opencode-driver.test.js`：**退出0**。

### 核查主执行者已保存的实际输出

- `evidence/driver-http-fixed.log`：汇总122测试、19组、122通过、0失败/取消/跳过，耗时6184.4437毫秒；对应 `node --test --test-concurrency=1 test/opencode-driver.test.js test/http-helper.test.js`。本轮核查日志与当前测试内容，没有将其写成审查者重新运行122项。
- `evidence/http-review-baseline.log`：保留旧反例 `titleIntact=false`、`leakedSyntheticMarker=true` 以及断言失败；`http-review-fixed.log`：同口径变为 true/false、权限分类不变，与本轮独立执行结果一致。旧失败证据没有被覆盖。
- `evidence/driver-coverage.log`：核查已有覆盖率汇总，驱动行覆盖86.74%、分支76.47%、函数91.43%；仅作为首轮驱动测试覆盖信息，不当作本轮共享层新增行为或全系统覆盖证明。
- `driver-validation.md:31-44` 如实追加修复边界、122项命令和探针证据，未把旧105项报告覆盖，也未声称完成发送边界。

### 验证限制

本轮没有运行全量 `npm test`、T2测试、原飞书端到端探针或实机验收；没有对真实用户数据库制造权限/锁故障。按计划这些不阻止当前 T1 驱动职责通过，仍需后续各阶段完成并保留证据。requirements/behavior 的全局 failing 状态属于尚未完整验收的跨层账本，本轮不修改且不误报为已完成。

## 阻断问题（0）

无。首轮 B1、B2 均关闭。

## 警告（0）

无。

## 建议（0）

无。

## 修复指令

无。本轮为 PASS，无阻断修复项；不授权审查者或实现者据此扩大业务变更、自动更新状态或提交推送。
