## 索引更新报告

**时间：** 2026-07-16 09:55
**触发原因：** feishu-long-running-response 功能开发完成
**图后端：** codegraph（类型：knowledge-base）
**索引方式：** 图后端实时查询（路径 A）

### 图后端状态

- [x] 后端可用，codegraph_explore 确认索引已包含最新代码
- **支持能力：** explore, definition, references, impact
- **新鲜度：** fresh（文件 watcher 自动同步，lag ~1s）
- **置信度：** 高（codegraph_explore 返回的源码与磁盘一致，包含 _recoverFromDisconnection、recoveryWindowMs、sseIdleTimeoutMs、idleTimeoutMs、signal 等新增代码）
- **降级路径：** 无需降级

### 使用过的查询能力

- [x] `codegraph_explore` — 确认 OpencodeDriver.prompt、_recoverFromDisconnection、sseIdleTimeoutMs、recoveryWindowMs 等新增符号已索引且源码与磁盘一致

### 结构化 Memory 更新

- [x] 决策记录：新增"飞书长任务超时架构重构"决策（四超时拆分、parseNonNegativeInt、Dispatcher 唯一硬截止）
- [x] 决策记录：新增"TUI Bridge v3 租约协议"决策（queued/leased/completed 状态机、accepted/heartbeat/final、有界 tombstone、plugin 升级）
- [x] 踩坑记录：新增"OpencodeSessionWatcher 游标语义 bug"踩坑（pending 被写成游标导致 completed 后永久跳过）

### AGENTS.md 更新

- 无需更新（未引入新约定或开发流程调整）

### 未覆盖风险

- 变更尚未 git commit（项目策略不主动提交）
- 无真实飞书端到端冒烟测试（集成测试用 fake driver/mock）
- 无 lint 脚本（项目仅 `npm run check` = `node --check` + `node --test`）
