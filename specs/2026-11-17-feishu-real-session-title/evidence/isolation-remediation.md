# T3隔离与报告真实性修复

## 原阻断与反馈环

独立审查`T3-review.md`判定FAIL：R1为8处旧TUI测试驱动指向默认用户库，R2为原报告把通过计数误解释为全范围“未读取用户数据库”。主执行者接受两项阻断，先将报告改为FAIL并撤回该声明，再停止普通全文件/全量命令。原运行确实触发默认用户数据库查询路径，不确认文件存在、内容及是否创建/修改，不清理该路径。

安全反馈环`node specs/2026-11-17-feishu-real-session-title/evidence/database-isolation-probe.cjs`只读测试源码，不导入测试或驱动、不运行SQL。修复前退出1，9处构造缺少统一隔离（8处旧构造及新harness），见`isolation-baseline.log`；修复后同命令退出0，9处均配置，见`isolation-fixed.log`。静态探针只是构造边界反馈，不单独证明动态安全。

## 根因及排除

1. **已确认**：旧构造沿用驱动默认数据库、模型状态及服务发现，新增标题查询和既有runtime补读自动使用它们。新六项显式临时库不覆盖旧实例。
2. **已排除**：不是新SQL忽略`mode=ro`，也不是缓存串身份；驱动标题SQL使用只读URI，旧runtime读取却使用普通文件名。因此仅以只读标题SQL推断整条命令无宿主副作用不成立。
3. **已确认**：审查只关注新增场景而未覆盖旧调用方，报告将局部字节不变断言推广到完整回归，属于验证范围判断错误。

## 最小修复

先修改T3拥有的集成测试，不改T1/T2生产或测试；后续question夹具追加范围另经用户批准：

- 9处真实驱动均传入各自临时目录中的`opencodeDbPath`、`modelState: null`和`readServiceRecord: () => null`。
- 复用既有`execFile`选项包装真实SQLite调用，普通路径及file URI均须位于该夹具目录；违规在执行外部进程前阻断，并在清理阶段再次断言，避免被业务降级捕获后测试仍通过。
- 新增持久化路径守卫测试：合法普通路径/只读URI通过；目录穿越、相似前缀及其URI均拒绝，不执行外部SQL。
- 保留全部原业务断言、真实HTTP/SQLite测试和清理，不禁用`getSessionTitle`、不新增生产注入接口。

## 完整回归前的只读风险审视

对`test/`真实OpencodeDriver构造、导入、`execFile`、`opencodeDbPath`及生产默认路径做源码搜索。直接构造集中于集成测试与驱动测试；驱动测试有大量默认服务记录/模型路径，部分watcher回退也会检查默认库，不能直接普通环境全量重跑。显式`C:/Users/test/opencode.db`用例已有execFile替身，不执行该路径；既有`H:/walker/does-not-exist-opencode.db`为显式项目侧watcher缺失夹具，不是默认用户库，不据其名称推断真实宿主文件状态。未访问这些路径确认文件内容。

因此本规格增加证据运行器`run-isolated.cjs`，**只用于本次验收**：整条命令及其子进程的HOME/USERPROFILE/XDG_STATE_HOME/XDG_DATA_HOME/XDG_CONFIG_HOME/APPDATA/LOCALAPPDATA均指向新建临时目录；测试启动前用独立Node子进程验证实际`os.homedir()`解析等于该目录，失败即不运行。正常完成仅清理该次新建目录。此做法隔离默认用户数据路径，不等于OS安全沙箱，也不承诺拦截任意硬编码路径或网络；集成SQL边界另有逐调用守卫。没有改写生产默认路径、全局驱动类或依赖实现。

新日志通过直接文件描述符接收子进程原始输出，不再经过PowerShell文本重编码；历史日志/哈希不覆盖。新命令、计数及收据由`test-report.md`记录，旧日志留作不满足隔离条件的历史观察。原probe及baseline/fixed期待值不改。权限EACCES是替身注入，挂起数据库终止测试实际终止的是替换执行命令的Node子进程，不称为真实sqlite挂起或实机权限验收。

## 当前验证

- 静态隔离探针：退出0，9/9构造具备安全默认选项。
- 集成隔离重跑：`node specs/2026-11-17-feishu-real-session-title/evidence/run-isolated.cjs integration specs/2026-11-17-feishu-real-session-title/evidence/integration-isolated.log`，退出0，57/57通过（新增路径守卫1项）。
- 定向隔离重跑：同运行器`targeted`模式，退出0，381/381通过，见`targeted-isolated.log`。
- 完整隔离回归重跑`full-isolated-retry.log`退出0，1578/1578通过；独立复审结论以`T3-review-round2.md`为准，未返回前不推定T3可关闭。

## 隔离完整回归暴露的question夹具依赖

隔离完整命令`run-isolated.cjs full .../full-isolated.log`退出1，1572/1578通过，6项全部在question夹具构造阶段缺serverUrl；标题断言未失败，但完整验收仍阻断。源码假设及判定：

1. 夹具关闭autostart却不提供地址，依赖宿主服务发现：已确认`createFixture`→`createApp`传空地址→驱动`_configureEndpoint`后构造断言；未读宿主记录。
2. 标题读取HTTP/SQL回归：排除为本次直接原因，错误早于任何标题调用。
3. 默认值由环境解析器注入：排除，测试直接传对象给`createApp`，不经环境解析。

先增加question隔离模式，同口径`question-isolated-baseline.log`0/6、退出1；用户批准扩大T3 owns至`test/integration-feishu-question.test.js`后，仅加合成地址`http://127.0.0.1:1`、夹具临时库及`readOpencodeService: () => null`，不改生产或原断言。`question-isolated-fixed.log`6/6、退出0。不恢复宿主配置、不写合成service.json来掩盖隐藏依赖。完整回归另存`full-isolated-retry.log`，1578/1578、退出0，失败原日志不覆盖。

本修复不检查、修改或清理用户数据库，不提交、推送、部署或启动真实服务，不代替后续converge。
