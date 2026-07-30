# 日志体积优化需求规格

## 背景

当前项目根目录 `logs/` 下的运行日志已经增长到约 169MB。现有日志链路中，`src/core/logger.js` 会把结构化日志写到 `stderr`，同时默认写入 `logs/walker.log`；daemon 模式还会把进程 `stdout` 和 `stderr` 分别追加到 `logs/walker.out.log` 与 `logs/walker.err.log`。这会造成日志文件长期增长，并可能产生结构化日志重复落盘。

## 目标

- 控制单个日志文件大小，避免继续增长到百 MB 级别。
- 默认减少重复持久化，保留排障所需的 stderr/stdout 日志。
- 在 Admin 活动与日志页面提供清空日志能力。
- 保持现有日志查看能力和旧日志文件名兼容行为。

## 非目标

- 不引入外部日志服务、数据库或第三方日志框架。
- 不实现按日期查询、全文搜索、压缩归档或远程上传。
- 不改变现有业务日志字段结构。

## 已确认方案

采用项目内置日志轮转方案：

- 单个日志文件达到 `10MB` 时轮转。
- 每类日志最多保留 `5` 个归档。
- `walker.log` 默认关闭，避免与 daemon 捕获的 `stderr` 重复持久化。
- 保留环境变量开启 `walker.log` 文件写入的能力。
- Admin 页面增加清空日志按钮。

## 需求

### REQ-001 日志文件大小轮转

系统必须对项目运行日志执行大小轮转，覆盖 daemon 管理的 `logs/walker.out.log`、`logs/walker.err.log`，以及显式启用时的 `logs/walker.log`。

验收标准：

- 当目标日志文件大小达到或超过 `10MB` 时，下一次写入前必须进行轮转。
- 每类日志最多保留 `5` 个归档文件。
- 轮转后当前日志文件继续以原文件名写入。
- 轮转操作失败时不得导致主业务流程崩溃。

### REQ-002 默认关闭 walker.log 文件写入

结构化 logger 默认不得额外写入 `logs/walker.log`，避免与 daemon 捕获 `stderr` 后生成的 `logs/walker.err.log` 重复持久化。

验收标准：

- 未设置环境变量时，`createLogger()` 仍输出到 `stderr`，但不创建或追加 `logs/walker.log`。
- 设置 `WALKER_LOG_FILE=true` 时，`createLogger()` 写入 `logs/walker.log`。
- 设置 `WALKER_LOG_FILE=false` 时，`createLogger()` 不写入 `logs/walker.log`。
- 日志级别过滤和敏感字段脱敏行为保持不变。

### REQ-003 Admin 清空日志

Admin 活动与日志页面必须提供清空日志能力，用于清空当前项目日志目录中的运行日志。

验收标准：

- 页面展示“清空日志”按钮。
- 点击后调用 Admin 后端清空日志接口。
- 清空成功后页面刷新日志内容，并展示空日志或最新内容。
- 清空失败时页面展示错误反馈，不破坏现有筛选、导出、自动刷新功能。

### REQ-004 日志清空接口安全与幂等

后端必须提供仅限管理端使用的清空日志接口，清理项目日志目录中的当前日志与归档日志。

验收标准：

- 接口只处理允许列表中的日志文件：`walker.out.log`、`walker.err.log`、`walker.log` 及其归档文件。
- 接口不得删除 `logs/` 外的任何文件。
- 日志文件不存在时，接口仍返回成功。
- 部分文件清理失败时返回明确错误信息，不静默宣称全部成功。

### REQ-005 Admin 日志读取兼容性

日志读取能力必须保持现有兼容行为，并适配轮转后的文件布局。

验收标准：

- 默认日志页仍读取当前日志文件的最近内容。
- 继续兼容旧文件名 `walker-out.log` 和 `walker-err.log`。
- 当 `dataDir/logs` 无日志且 Admin 路由开启 cwd fallback 时，仍能读取项目根 `logs/` 下日志。
- 不要求本次实现读取归档文件内容。

## 影响范围

- `src/core/logger.js`：默认文件写入策略与显式启用 `walker.log` 的轮转。
- `src/cli/daemon.js`：daemon stdout/stderr 日志文件轮转。
- `src/admin/file-admin.js`：清空日志后端能力和读取兼容性。
- `src/admin/maintenance-routes.js`：新增清空日志路由。
- `src/admin/public/js/pages/logs.js`：新增清空日志按钮和交互。
- `test/`：补充 logger、daemon、Admin 接口、Admin UI 测试。

## 方案比较

### 方案 A：内置轮转 + 默认关闭 walker.log（推荐）

数据流：业务 logger 写 `stderr`，daemon 捕获到 `walker.err.log`；stdout 写到 `walker.out.log`；两个 daemon 文件由内置轮转保护。仅当 `WALKER_LOG_FILE=true` 时，logger 额外写 `walker.log` 并同样轮转。

优点：减少重复日志，代码依赖少，部署无额外要求。

缺点：不提供跨归档搜索；排障时主要查看当前文件与归档文件。

### 方案 B：仅轮转现有文件

数据流不变，只为 `walker.log`、`walker.out.log`、`walker.err.log` 增加轮转。

优点：行为变更最小。

缺点：结构化日志仍可能重复持久化，磁盘增长速度仍偏高。

### 方案 C：只调低日志级别

通过环境变量或默认值减少 info 日志输出。

优点：改动最小。

缺点：不能解决长期运行文件无限追加问题，也不能解决重复落盘问题。

## 测试计划

- 单元测试：验证轮转命名、保留数量、超过 10MB 时触发轮转。
- 单元测试：验证 `WALKER_LOG_FILE` 默认关闭、显式开启、显式关闭行为。
- 单元测试：验证清空日志只处理允许列表且幂等。
- 路由测试：验证 Admin 清空日志接口返回成功和错误路径。
- UI 测试：验证清空按钮调用接口、刷新日志、失败反馈。

## 风险与约束

- Windows 上正在被打开的日志文件可能无法直接重命名或删除，轮转与清空需要容错。
- daemon 使用文件描述符作为子进程 stdio，启动前轮转可以生效；运行中的 stdout/stderr 文件描述符不适合由外部直接移动。清空当前文件应优先使用截断方式。
- 不应使用破坏性路径拼接，所有清理必须限定在项目日志目录内。
