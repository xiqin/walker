## 索引更新报告

**时间：** 2026-10-19 14:18
**触发原因：** OpenCode V2 终端桥接插件可靠性修复完成
**图后端：** codegraph（类型：code graph）
**索引方式：** `loom index --check`（路径 A）

### 图后端状态

- [x] 后端可用。MCP 未暴露 `loom_graph_sync`，已用 `loom index --check` 确认索引为最新。
- **支持能力：** explore、definition、references、impact
- **新鲜度：** up to date（198 个文件，2690 个节点，15105 条边）
- **置信度：** 索引状态由 codegraph 报为最新；审查阶段用 codegraph explore 核对了安装器和插件入口。
- **降级路径：** 无

### 使用过的查询能力

- [x] codegraph explore — 查询 `installHookPlugin`、V2/V1 入口、表单回填和桥接 `setup`。
- [ ] 未使用图查询（本次变更无需图后端辅助）

### 结构化 Memory 更新

- [x] 踩坑记录：新增 `968f7566`。v2.0.32 不执行裸 JS 文件 URL，必须注册 `walker-tui-plugin` 包目录；无会话时不能把未观察到的 `/register`、`/poll` 写成连通。
- [x] 已执行 `loom memory export`。
- [ ] 用户偏好：无新增

### AGENTS.md 更新

- 无需更新。没有新增命令或开发流程约定。

### 未覆盖风险

- 真实飞书往返仍未验证。
- 变更尚未提交。
