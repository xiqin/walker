# T1 独立规格与七维质量审查

## 最终判定：FAIL（不通过）

- **SPEC 结果：规格偏差**。正常路径、精确查询、数据库只读、超时及认证复用基本符合批准计划，但真实 HTTP 边界存在中文标题损坏及失败正文日志泄漏两项严重偏差。
- **质量结果：质量不通过**。BLOCKER：2；WARNING：0；建议：0。
- 本结论不因 T2/T3 尚未完成、尚无端到端或实机飞书证据而判定 T1 失败；阻断均由 T1 新增业务读取路径的独立运行证据支持。

## 身份、范围与取证边界

审查日期：2026-11-17。审查者是与实现者分离的独立执行者，**并非操作系统安全隔离的执行环境**；共享工作树，不能把代理身份或本报告视为独立权限边界。

根目录：`H:/walker/.worktree/2026-11-17-feishu-real-session-title`。完整读取并遵照 `C:/Users/tianxiqin/.config/opencode/skills/loom-subagent-driven-development/combined-reviewer-prompt.md`，没有以简化检查替代模板。

本次只写本报告；没有修改业务代码、测试、traceability、任务状态或其他证据，没有提交、推送或启动真实 OpenCode 服务，没有读取用户真实标题。网络探针只监听 `127.0.0.1` 随机端口，使用合成标题及合成标记。测试中的服务启动日志来自既有替身（例如 `test/opencode-driver.test.js:247` 的 `runtime.spawn`），不是真实服务启动。

没有查询主仓库 CodeGraph 回落索引；本树没有独立索引，依靠本树源码、源码搜索、真实 diff 和命令输出判断影响范围，因此不声称具备完整图索引证明。

### 批准来源与差异快照

已读取 `tasks/T1.md`、`requirements.json` 中 REQ-001/REQ-003 原文及相关 behavior 的 acceptance/test_plan、`traceability.json` 中 T1 的逐行为映射、`plan.md` 的驱动接口/只读/认证/预算约束、`spec.md` 的 REQ-001/REQ-003 与安全条目、`engineering-facts.md`、`.loom/contexts/subagent-context.md` 和 `.loom/rules/constitution.md`。宪章中的技术栈占位项没有被当作事实。

实际差异：`src/drivers/opencode-driver.js` 新增 56 行，`test/opencode-driver.test.js` 新增 148 行；另有本规格未跟踪目录。生产与测试修改落在 T1 owns 内，未见无关业务重构。共享账本由主执行者维护，符合 `plan.md:24`；驱动验证报告及测试日志均实际存在。

审查时 HEAD：`db54556bc0be99478114c6c809dc78efa6edc31a`。文件 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `src/drivers/opencode-driver.js` | `66ACD7C8B2F07DE6E0337A2D45B900C963084FE38100C91051389F592934B40D` |
| `test/opencode-driver.test.js` | `E6747795778039942C9F3BF9BE290FC0A937FD50E53F36DEA0AE3D5119CAC603` |
| `src/core/http-helper.js` | `E57B56B9556C6D0927776592E3402C0714D87C27931BB599D13F02A78A8DE547` |

## 第一部分：规格审查

### 批准行为与逐行为映射

以下“通过”仅表示 T1 驱动职责通过，不代表跨层完整需求已验收。每项映射已核查对应持久化测试名称、源码及 `traceability.json` behavior 级 tests/evidence；不是仅核对 REQ 级字段。

| 行为 | 账本验收与 test_plan 原文 | 当前落点、证据与结论 |
| --- | --- | --- |
| REQ-001-B01 | 验收：“文本、Markdown、进度卡、问题卡包含真实标题，不包含默认名称。”策略：“驱动只读边界与真实发送边界验证”；输入：“本地默认名称；关联会话有有效真实标题”；预期：“页脚显示真实标题；模型和上下文原样保留”；目标：“标题源到页脚”。 | `opencode-driver.js:225-260`；持久化测试“按关联地址精确编码ID，沿用认证并读取官方双层响应”（测试文件:25-39）及直接响应测试（:41-55）。traceability 第6行的定位真实存在，指向的 `driver-validation.md` / `driver-tests.log` 存在。但独立分块探针返回损坏标题，**T1 部分不通过，B1**。发送边界由 T2/T3 承担。 |
| REQ-001-B03 | 验收：“SQL ID 安全转义并只读；HTTP 不修改远端；多行及标签字符不改变卡片结构。”策略：“捕获 SQL、HTTP 请求及卡片结构”；输入：“含引号的会话ID；多行与飞书标签标题”；预期：“只读精确查询；无额外SQL或远端写入；标题展示安全”。 | HTTP 路径编码/GET 在源码:246-249；SQL 转义、只读 URI、hex 解码在:234-244。测试“真实临时SQLite精确转义ID并完整读取中文多行标题且不改数据库”（:106-123）核对字节未变与缺文件不创建。traceability 第8行定位与证据真实。**T1 所负责的只读、安全查询通过**；HTTP 中文完整性问题另见 B1。卡片转义不是 T1 的责任，留 T2/T3。 |
| REQ-003-B01 | 验收：“使用同身份最近有效标题或非默认本地标题，否则省略；真实请求或子进程有超时控制。”策略：“故障注入与真实超时参数验证”；输入：“非成功HTTP、挂起读取、数据库命令失败”；预期：“发送成功；不显示自动名称；无遗留无限等待任务”。 | 源码:250-265 提供固定错误分类；不更换来源。401/403/404/500 测试（:68-82）、数据库缺文件（:118-122）和权限测试（:125-140）存在且通过。traceability 第24行双测试定位及证据真实。**T1 故障分类与底层终止通过**；实际发送降级留 T2/T3。失败日志另见 B2。 |
| REQ-003-B06 | 验收：“挂起标题源不会无限等待；多来源降级共用总预算。”策略：“超时与取消边界测试”；输入：“挂起HTTP；挂起数据库进程；多来源依次失败”；预期：“2秒预算内结束标题等待；底层超时或取消受控”。 | 源码:228-230 限制预算，:238-239 设置进程 timeout/SIGKILL/maxBuffer，:247-248 传剩余预算；`http-helper.js:87-93` 实际销毁请求。挂起 HTTP（测试:84-93）、预算上限（:95-104）与真实 Node 子进程包装（:142-155）均通过；traceability 第29行引用存在。**T1 通过**；没有伪称诱发真实 SQLite 内部挂起，也没有把跨层降级总预算提前算作通过。 |
| REQ-003-B08 | 验收：“复用现有HTTP客户端认证语义；401、403或数据库权限拒绝仅按既定顺序降级，不枚举连接、切换焦点或启动服务绕过。”策略：“关联HTTP客户端请求捕获与权限故障注入”；输入：“现有认证连接；HTTP 401/403；数据库只读权限拒绝”；预期：“不新增认证机制或泄漏凭据；只查询原关联身份；失败仍发送且不尝试其他身份”。 | 现有 `_applyAuthHeaders`（源码:102-106）、关联地址 `_buildUrl`（:1051-1053）均未改动；HTTP 授权透传、权限拒绝不换源测试真实存在。traceability 第31行定位与证据真实。但 401 非 JSON 错误正文经过现有客户端会进入日志，违背“不泄漏凭据”的失败边界，**T1 部分不通过，B2**。 |

### T1 步骤、接口与禁止副作用

- 固定接口 `Promise<string|null>`、无有效 ID 不查询、空/非字符串标题返回 null、成功状态检查、官方双层及直接响应、存在响应 ID 时强校验均有代码和持久化测试。
- TUI 按 transport 直接选择库，不依赖 bridge 存活；使用 `pathToFileURL`、`mode=ro`、精确 SQL 单引号双写、`hex(title)` 与 UTF-8 解码，没有 `-readonly` 或 JSON 扩展依赖。
- 新路径没有调用 `ensureReady`、会话枚举、状态写入、远端写入或焦点解析，没有 HTTP/数据库相互回退。未改基类、原消息读取、模型或认证机制。
- 生产新增一个已批准业务方法及固定分类错误帮助函数，无新增构造注入、测试专用公开接口或通用策略。当前生产调用方尚待 T2 接入，是批准的串行依赖，不因这一点判定抽象多余。
- T1 五项行为都有真实 tests/evidence；不是只填 REQ 级映射。`driver-validation.md` 正确限制结论为驱动层，没有把基线完整测试冒充本次实现完整回归。
- **遗漏自审**：现有新增 HTTP 测试用单次 `res.end(JSON.stringify(...))`，无法覆盖 UTF-8 跨网络分块；错误测试同样只发送合法 JSON，无法覆盖在驱动捕获之前发生的底层原始正文日志。两者均是实际依赖路径，不是为满足检查表虚构的场景。

## 第二部分：七维质量审查

| 维度 | 适用性与证据 | 结论 |
| --- | --- | --- |
| 1. 架构合规（阻塞） | 适用。按宪章:43 及计划两层边界，仅驱动新增能力，复用已有 HTTP/进程依赖；新增依赖为 Node 标准库 `node:url`，未增加跨层引用或可见循环依赖。宪章架构占位符不作为额外规则。 | 通过。 |
| 2. 代码质量（阻塞） | 适用。方法职责和控制流清晰；固定错误分类可供下游降级，原始异常被替换。但调用方信任的“标题原文”已被实际传输解码破坏（B1），不能用测试全绿替代正确性。 | 不通过：B1。 |
| 3. 安全风险（阻塞） | 适用。SQL 双写和只读 URI、execFile 非 shell、固定 GET、既有认证和受控返回错误均符合要求；但底层失败响应日志会泄漏原始正文（B2），驱动 catch 无法撤销已经发生的日志。这里没有新增浏览器渲染、CSRF 入口或数据库写事务；飞书结构转义留 T2/T3。 | 不通过：B2。 |
| 4. 性能隐患（警告） | 适用。2秒上限与剩余预算、HTTP 总时钟销毁、SQLite 真实 SIGKILL/64KiB 缓冲均有实证；HTTP 使用既有10MiB响应体上限，无无界响应累积。单 ID 单源读取，无 N+1/新增集合缓存。128/16 容量与缓存清理归 T2，不据此否定 T1。 | 未发现警告。 |
| 5. 规范一致性（警告） | 适用。CommonJS、命名、分号/单引号与既有源码/ESLint 一致；公开方法中文参数说明、固定错误帮助函数中文说明存在。独立执行语法与定向 ESLint 均退出0。不把宪章 TODO 当作编译/测试命令。 | 未发现警告。 |
| 6. 变更影响范围（阻塞） | 适用。源码搜索确认生产实例由 `src/app/bootstrap.js:129-147` 构造；新方法尚无 T2 生产调用，现有 `_feishuRuntimeContext` 仍用本地标题，符合当前依赖阶段。关键依赖链为新方法→DefaultHttpClient.request→httpRequest→logger，B1/B2 均在真实链路复现。没有改原接口参数/共享 schema，T1 与 T2 owns 不重叠。图索引缺失限制已披露。修复共有层需先扩充批准写入范围，不能直接越权。 | 影响已识别；B1/B2 需要跨当前 owns 协调修复。 |
| 7. 复杂度与必要性（阻塞） | 适用。未新增仅为 mock 服务的构造参数/接口；测试使用现有 httpClient/execFile 替换边界，真实网络和不可控进程故障有明确业务理由。真实临时库经项目依赖执行并清理；一个生产用途的标题方法来自批准接口，不机械要求两个调用场景。没有泛化框架或无逻辑转发层。 | 通过。 |

## 独立验证与新增反例

### 已独立重跑

| 命令 | 结果 |
| --- | --- |
| `node --check src/drivers/opencode-driver.js` | 退出0。 |
| `node node_modules/eslint/bin/eslint.js src/drivers/opencode-driver.js test/opencode-driver.test.js` | 退出0。 |
| `node --test --test-concurrency=1 test/opencode-driver.test.js` | 退出0；105测试、17组、105通过、0失败/取消/跳过，耗时5318.537毫秒。新增标题组12项通过。 |

核对既有 `driver-tests.log` 尾部也是105通过/0失败；文件编码使通用文本读取工具拒绝读取，使用 PowerShell `Get-Content` 核对了实际汇总，没有修改日志。没有独立重跑完整 `npm test`、发送探针或实机飞书；这些未执行项不是本次阻断原因。

### BLOCKER B1：正常 HTTP 分块损坏真实中文标题

- 位置：新增调用 `src/drivers/opencode-driver.js:246-260`；实际根因 `src/core/http-helper.js:52-65`。
- 该依赖对每个 Buffer 执行 `data += chunk`，各块独立按 UTF-8 转字符串。若一个三字节中文字符被分到两个块，JSON 仍可成功解析，但字符变成替换符，驱动将其当成有效真实标题返回。
- 独立使用真实 DefaultHttpClient 和合成服务，返回官方形状 `{data:{id:'ses_A',title:'中文标题'}}`；在“中”的第一个 UTF-8 字节后分块，相隔25毫秒结束响应。
- 实测预期码点 `[20013,25991,26631,39064]`，实际 `[65533,65533,65533,25991,26631,39064]`，相等判断为 `false`；请求始终是 `GET /api/session/ses_A`。
- 这是本次必须支持的有效非 ASCII 真实标题，不是端到端缺失或人为构造无效响应。根因虽位于既有工具，新增标题读取路径直接暴露此偏差；只修驱动 catch 或卡片转义不能恢复已损坏字符。

### BLOCKER B2：权限失败原始正文绕过驱动脱敏进入日志

- 位置：新增调用 `src/drivers/opencode-driver.js:247-265`；实际日志入口 `src/core/http-helper.js:74-80`，日志过滤 `src/core/logger.js:62-75,94-112`。
- 合成服务返回401和非 JSON 正文 `authorization=SYNTHETIC_SECRET_DO_NOT_LOG`。驱动最终确实返回受控 `TITLE_FORBIDDEN`，但在返回前共享 HTTP helper 已输出 `bodyPreview`；logger 只按对象键脱敏，不会过滤 `bodyPreview` 字符串中的认证信息。
- 独立捕获标准错误得到 `scope=http-helper`、`message=response JSON parse failed`、`statusCode=401`、`bodyLength=41` 及原样 `bodyPreview=authorization=SYNTHETIC_SECRET_DO_NOT_LOG`，`leakedSyntheticMarker=true`。
- 标记完全合成，没有发送/记录用户凭据。结论是标题失败路径缺少安全日志边界；不声称正常 JSON 的401响应或请求认证头本身已经泄漏。对应 `REQ-003-B08.test_plan.expected` 的“不新增认证机制或泄漏凭据”，以及计划:49/规格:45 的禁止原始敏感输出。

### 可重复隔离探针

在工作树根目录将下列脚本经标准输入交给 `node` 执行即可；无需写脚本文件。脚本关闭文件日志，覆盖服务记录读取为 null，不访问真实服务或真实数据库；两个反例复用同一合成 HTTP 服务，最后关闭连接。

```javascript
'use strict';
process.env.WALKER_LOG_FILE = 'false';
const http = require('node:http');
const { OpencodeDriver } = require('./src/drivers/opencode-driver');
(async () => {
  const title = '\u4e2d\u6587\u6807\u9898';
  const marker = 'SYNTHETIC_SECRET_DO_NOT_LOG';
  let invalid = false;
  const server = http.createServer((_req, res) => {
    if (invalid) {
      res.writeHead(401);
      res.end('authorization=' + marker);
      return;
    }
    const payload = Buffer.from(JSON.stringify({ data: { id: 'ses_A', title } }));
    const split = payload.indexOf(Buffer.from(title)) + 1;
    res.write(payload.subarray(0, split));
    setTimeout(() => res.end(payload.subarray(split)), 25);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = new OpencodeDriver({
    serverUrl: 'http://127.0.0.1:' + server.address().port,
    readServiceRecord: () => null,
  });
  try {
    const actual = await driver.getSessionTitle({ opencodeSessionId: 'ses_A' });
    console.log(JSON.stringify({
      equal: actual === title,
      expectedCodepoints: Array.from(title, c => c.codePointAt(0)),
      actualCodepoints: Array.from(actual, c => c.codePointAt(0)),
    }));
    invalid = true;
    let captured = '';
    let failure;
    const original = process.stderr.write;
    process.stderr.write = function(chunk) { captured += String(chunk); return true; };
    try {
      await driver.getSessionTitle({ opencodeSessionId: 'ses_A' });
    } catch (error) {
      failure = error.code;
    } finally {
      process.stderr.write = original;
    }
    console.log(JSON.stringify({ failure, leakedSyntheticMarker: captured.includes(marker) }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
```

探针正常退出0表示取证完成，不表示业务断言通过；本次观察到 `equal=false` 和 `leakedSyntheticMarker=true`。

## 阻断问题（2）

- **B1：真实 HTTP 标题跨 UTF-8 分块时返回损坏内容**，严重度：严重/阻断。
- **B2：标题权限失败的非 JSON 正文进入原始日志**，严重度：严重/阻断。

## 警告（0）

无。T2/T3、完整回归和实机验收未完成是已批准的阶段边界，不作为警告或阻断重复计数。

## 建议（0）

无。

## 修复指令

### 修复项 1

- **问题**：B1，HTTP 网络分块跨越多字节字符时，合法中文标题被损坏后作为有效标题返回。
- **文件**：`src/drivers/opencode-driver.js`、`src/core/http-helper.js`、`test/opencode-driver.test.js`；如修共有层，另覆盖既有 `test/http-helper.test.js`。
- **位置**：`getSessionTitle` 第246-260行；`httpRequest` 第52-65行的响应 Buffer 拼接和第73行 JSON 解析；标题测试第25-55行附近。
- **严重度**：阻断。
- **修复方向**：先由主执行者协调批准对共享 HTTP 层及其测试的写入归属；它们不在当前 T1 owns 内，不能直接越权修改，也不要另造标题专用客户端绕过既定复用约束。保持 Buffer 字节计数/上限和超时销毁语义，将响应按完整 UTF-8 流解码（例如有界累积 Buffer 后统一解码，或正确使用 StringDecoder），不得逐块隐式转字符串。持久化一个真实隔离 HTTP 服务在中文/表情字符字节中间分块的驱动行为测试，断言标题逐字符原样返回；保留现有认证、响应大小、超时与消息读取回归。修复后重跑本报告隔离反例、定向驱动与共有层测试并更新证据；不需改协议或公共接口签名，不应引入破坏性迁移。

### 修复项 2

- **问题**：B2，标题读取的非 JSON 权限错误正文在驱动受控异常转换之前进入 `bodyPreview` 日志，可能携带凭据或其他敏感原文。
- **文件**：`src/drivers/opencode-driver.js`、`src/core/http-helper.js`、`test/opencode-driver.test.js`；如修共有层，另覆盖既有 `test/http-helper.test.js`。
- **位置**：`getSessionTitle` 第247-265行；`httpRequest` 第74-80行的 JSON 解析失败日志。
- **严重度**：阻断。
- **修复方向**：与修复项1共享归属协调，先批准必要共有层变更。确保标题请求在底层解析失败路径也不记录原始响应正文；优先只记录状态、字节长度等安全元数据。如果需要保留其他现有调用的诊断兼容，可用真实标题业务需要的请求选项控制正文预览，但不能为测试添加专用接口、全局临时禁用日志或 monkey-patch logger。新增真实 HTTP 服务返回401/403及畸形成功响应的持久化测试，合成正文同时含认证/消息标记；捕获完整日志，断言标记不出现、错误仍可分类、不换源、不启动服务，合法认证透传保持不变。不要只检查最终 Error.message，因为日志在此之前已经发生。修复后重跑隔离反例与共有层/驱动回归，更新驱动证据；不授权读取真实秘密或扩大日志采集。

两项修复可以在同一次经批准的共享层改动中完成；须由主执行者维护归属、账本与状态，审查者未修改这些文件。
