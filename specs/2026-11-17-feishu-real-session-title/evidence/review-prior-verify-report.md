# 飞书真实会话标题 — 最终验证报告

## 结论与范围

**本地自动化最终验证PASS，3项需求、16项行为闭环，无当前阻断。** 本结论不等于整条流水线完成或实机验收；后续仍有审查准备及人工审查门禁。

日期：2026-11-17。工作树：`H:/walker/.worktree/2026-11-17-feishu-real-session-title`。本阶段不改生产或产品测试、不重跑业务测试或原探针，不提交、合并、推送、部署、重启或启动真实OpenCode服务，也不检查或清理用户数据库。

## 前置产出与版本

- 已读取`test-report.md`、`traceability.json`、`spec.md`、`evidence/T3-review-round2.md`和`evidence/converge-semantic-review.md`。原R1/R2已独立复审关闭，收敛独立语义结论为16/16 covered，missing/partial/contradicts/未获批unrequested均0。自动引用完整性不代替语义覆盖。
- 本轮实际逐一比对3份生产及7份测试文件的SHA-256，与T1/T2交接及T3独立复审指纹全部一致；当前没有测试后新增产品差异。已有隔离集成57/57、定向381/381、question 6/6及完整1578/1578可以复用，不冒称本阶段独立重跑。
- 原完整日志开头实测为`npm test`→`npm run lint && npm run check`，包含ESLint及112源码文件语法检查；尾部为1578通过，失败/取消/跳过均0，退出0及`isolated_home_verified: true`。
- 当前账本脚本实际通过：3 REQ、16 behavior、5份文件哈希收据。每个behavior均具备真实任务、测试（含具体名称）及证据引用；原探针baseline=false、fixed=true，输入和期待值相同。`requirements.json`保留的failing是原基线状态，不擅改已批准需求。
- `test-report.md`仅新增历史状态澄清和本次版本绑定；受审原哈希及原审查报告保持记录，不声称补记后的报告字节仍等于旧哈希。版本绑定为本阶段实测，不伪装为原运行器生成；HEAD树加排除本规格目录的差异哈希包含既有`.loom/compliance/history.json`，不能单独证明历史执行来源或安全隔离。

## 构建、检查与一致性

| 检查项 | 实际依据与结果 |
| --- | --- |
| 构建命令 | 宪章中构建/静态/测试命令尚为既有模板，未定义有效BUILD_CMD/VET_CMD/TEST_CMD；`package.json`也没有独立build。按真实脚本进行语法检查，不杜撰构建命令、不修改宪章。 |
| 静态检查 | 本阶段实际执行`npm run lint`，退出0；Node v22.11.0。 |
| 语法检查 | 本阶段实际对112份src/*.js递归执行`node --check`；浏览器模块依照`scripts/check.js`采用`node --input-type=module --check`及文件标准输入，全部通过，不加载执行产品模块。 |
| 测试 | 复用完整隔离日志1578/1578及三份定向日志，文件字节哈希本阶段全部重算一致；未直接调用会重跑测试的`npm run check`。 |
| 占位符 | 新增生产及测试差异逐行扫描占位短语，0项；机械产物校验通过。宪章既有模板占位属于既有文档，不伪称仓库全量无占位符。 |
| 类型及签名 | 直接复核驱动`getSessionTitle(sessionRef, options)`的Promise返回和`timeoutMs`，调度调用及快照字段一致；返回可选`runtime.sessionTitle`沿用飞书格式化。项目为CommonJS JavaScript，无独立类型编译命令。 |
| 参数兼容 | `_withFeishuRuntime`复制原参数、为省略初始事件的进度卡补位；问题创建/处理更新及八发送入口的持久化断言在隔离定向日志通过。 |
| 差异及范围 | 本阶段`git diff --check`退出0；原三个生产及七个测试文件指纹不变，无新业务接口、配置、依赖、协议或schema。HTTP、旧守卫、question夹具均有已批准范围追加。 |

本阶段只读检查入口为`evidence/verification-check.cjs`，它仅运行静态/语法/账本/差异及指纹检查，不运行业务测试。既有失败`evidence/verification-static.log`退出1：首版检查脚本错误地将浏览器ESM按CommonJS解析，未到达后续账本步骤；这是真实检查准备失败，不是产品测试反例，也不豁免成通过。依照现有`scripts/check.js`修正模块解析模式后，使用全新`verification-static-retry.log`实际退出0。原失败日志完整保留，SHA-256为`b1a6f9d12156a10d677feea14455098b5bf653b50ca2c39bf4eb5d0fa801b3b5`。

## 需求覆盖与偏移检查

| 需求 | 当前实现及验收证据 | 结果 |
| --- | --- | --- |
| REQ-001 | 驱动`getSessionTitle`精确HTTP/只读SQLite→调度`_feishuRuntimeContext`→既有飞书页脚；真实标题进入文本/Markdown/进度/问题，过滤默认名、空值及ID错配，安全转义且模型/上下文不变。3项行为见独立收敛矩阵及定向/集成日志。 | PASS |
| REQ-002 | `_feishuSessionTitle`按实际HTTP origin+ID或绝对数据库+runtime+ID隔离；同步快照、同键合并、逆序并发、完成后30秒TTL、128条目/16读取、销毁及迟到防护。5项行为均有边界与调用计数断言。 | PASS |
| REQ-003 | 原身份历史→有效本地→省略，不写标题、不借焦点、不换源绕过权限；失败到期恢复、2秒截止、HTTP销毁/子进程终止、受控诊断；旧会话、页脚替换、正文去重及可选参数保持。8项行为见追溯、独立矩阵和真实动态日志。 | PASS |

逐行为全集为REQ-001-B01～B03、REQ-002-B01～B05、REQ-003-B01～B08，共16项。完整类别、代码符号、断言及动态证据已在`evidence/converge-semantic-review.md`逐项核实，本阶段未发现其后代码漂移。没有把同标题的runtime集成场景当独立隔离证明；该维度采用调度测试不同结果及调用次数。源码中已有模型运行时补写不被误判为新增标题写回。

## 适用能力：失败、恢复和资源

| 能力 | 触发方式／预期／实测与边界 | 实际证据 |
| --- | --- | --- |
| 保存与只读 | 本功能不新增保存、迁移或事务提交，不适用保存失败验收。真实临时SQLite、精确含引号ID、缺失库，以及本地state/两库字节比较验证所测路径无标题写回、缺失库不被创建；不外推到历史用户库。 | 集成日志100～128行；D/I对应持久化断言。 |
| 故障降级 | 合成HTTP服务器真实返回403；正文及模型/上下文继续发送，历史真实标题优先，不把错误正文或口令带入页脚/日志，不切换连接绕权。缺失临时库也降级。EACCES为替身注入，不称操作系统权限实测。 | 集成日志116～128行；定向日志179～203行及驱动错误矩阵。 |
| 恢复 | 同一会话在失败完成后29999毫秒仍命中失败缓存，30000毫秒再次精确GET恢复真实标题，无需重新纳入；首次失败后恢复另有断言。时间由Date控制，HTTP请求实际执行。 | 集成日志116～120行；定向日志189～203行。 |
| 容量及销毁 | 128/129 LRU无隐藏历史；16/17挂起时立即本身份降级、不排队，释放后重读。销毁后等待者完成、Map及定时器清空，迟到结果不回填/重读，不只检查存在destroy方法。 | 定向日志209～228行及对应边界断言。 |
| 实际终止 | 真实挂起HTTP预算后连接确实关闭并继续发送，重复发送不重读；精确2000毫秒由可控时钟证明。子进程包装触发并实际终止的是Node替换进程，不是SQLite实机挂起。 | 集成日志154～158行（含调度耗时2013.9516毫秒）；定向日志219～228行及驱动终止测试。 |

有限测试观察不等于长期无资源泄漏或实机负载保证；调度销毁唤醒与底层按剩余预算终止分别判断，不把清Map当作立即取消底层网络。

## 保留警告与未验证项

- 无实机飞书、真实OpenCode、SQLite挂起或OS权限配置验收；进度跨层验证是ProgressCard渲染→replyCard→真实请求体，不是完整bootstrap实机链。
- 历史默认用户库查询风险、原首审FAIL、所有失败日志及原探针期待值均保留；不调查或清理用户路径，不追认历史运行已隔离。
- 默认用户目录重定向不是OS沙箱，不阻断任意硬编码路径/网络；测试路径守卫不提供符号链接攻击防护。当前测试日志只支持各自覆盖的路径。
- 历史UTF-16LE及乱码警告保留，不重编码旧证据。Node v22.11.0低于所装ESLint声明支持范围，实际lint通过不等于官方兼容保证。
- 宪章存在既有模板命令与技术栈空缺；仅依据真实包脚本与批准方案验证，不越权修改长期规则。
- 无本工作树独立CodeGraph索引，遵循fallback仅用源码、差异和审查，不调用主树回落索引或自行初始化。索引同步及最终流水线闭环仍由后续阶段处理，不声明已完成。

## Evidence Receipt

- evidence-command: `node specs/2026-11-17-feishu-real-session-title/evidence/verification-check.cjs specs/2026-11-17-feishu-real-session-title/evidence/verification-static-retry.log`
- evidence-exit-code: `0`
- evidence-file: `evidence/verification-static-retry.log`
- evidence-sha256: `99114e84600accbee2a3f3caa015bb4d8df756f8c3caecbb09cb6fed5d65275a`
- evidence-git-tree: `e506636f6a0698cd43367ac1ffe4d2bf8b259397`
- evidence-diff-sha256: `c3203dc47bb975495fd9cdbd9e3c82bdf3ab9ba4b47a187bf6106b7629d41f83`

原完整隔离动态收据（本阶段只读核验，不冒称重跑）：

- evidence-command: `node specs/2026-11-17-feishu-real-session-title/evidence/run-isolated.cjs full specs/2026-11-17-feishu-real-session-title/evidence/full-isolated-retry.log`
- evidence-exit-code: `0`
- evidence-file: `evidence/full-isolated-retry.log`
- evidence-sha256: `844048330c3a66529f1cf179577422aaaed2d1e8d0a8a26d5b14572e9db1909e`

其余四份原始收据及其命令、退出码和SHA-256见`test-report.md`；本阶段新日志157～163行重新计算了全部五份动态证据与两份独立报告哈希。

verdict: PASS
