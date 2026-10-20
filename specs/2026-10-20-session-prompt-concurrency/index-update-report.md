# 索引与记忆更新报告

- 图后端配置：`codegraph`（已启用）；本工作树未初始化 `.codegraph/`。`loom index` 返回“CodeGraph not initialized”，`loom index --check` 确认为“Not initialized”。**图后端不可用，图索引同步跳过**；未擅自初始化索引。
- 变更范围：`src/dispatch/message-dispatcher.js`、`test/message-dispatcher.test.js` 与流水线产物；影响判断依据为当前源码、Git 差异及验证报告，不将未同步图索引用于调用链结论。间接调用链的覆盖范围可能不完整。
- 结构化记忆：已在 `.loom/memory/store.json` 记录路由锁只保护入队、会话队列负责串行的架构决策；无新增用户偏好或踩坑。未手动编辑 `MEMORY.md`。
- 入口文档：无新增入口、命令或开发约定，不需更新。
- 未提交、未推送、未发起外部审查请求；真实飞书和 Agent 运行时未接入本次验证。
