## 索引更新报告

**时间：** 2026-07-17 13:40
**触发原因：** 飞书交互式问题确认功能开发完成
**索引方式：** codegraph（路径 A，实时查询）

### codegraph 状态

- [x] `.codegraph/` 已初始化，索引新鲜
- [x] 关键符号已确认索引：`replyQuestion`、`buildQuestionCard`、`_cmdAnswer`、`questionReplyStates`、`buildQuestionRepliedCard`、`handleQuestion`、`handleQuestionReplied`
- [x] 调用链验证通过：`_cmdAnswer` → `replyPermission` → `replyQuestion`

### 结构化 Memory 更新

- [x] 决策记录：飞书交互式问题确认功能架构决策（复用 permission 事件通道 + question 回复语义分离）
- [x] 踩坑记录：飞书卡片 `multi_select_static`/`input` 组件首次使用，需实际卡片预览工具验证
- [x] 偏好记录：permission 与 question 路由隔离规则 + patch 卡片策略区分 transport

### AGENTS.md 更新

- 无需更新（未引入新约定、新命令行入口或开发流程调整）

### 变更文件清单

| 文件 | 操作 |
|------|------|
| src/app/bootstrap.js | 修改 |
| src/dispatch/message-dispatcher.js | 修改 |
| src/dispatch/permission-handler.js | 修改 |
| src/drivers/agent-driver.js | 修改 |
| src/drivers/opencode-driver.js | 修改 |
| src/opencode-tui-bridge/bridge.js | 修改 |
| src/platform/feishu/cards.js | 修改 |
| src/platform/feishu/commands.js | 修改 |
| src/platform/feishu/platform.js | 修改 |
| test/agent-driver-schema.test.js | 新增 |
| test/bootstrap.test.js | 修改 |
| test/feishu-cards.test.js | 修改 |
| test/feishu-commands.test.js | 修改 |
| test/feishu-platform.test.js | 修改 |
| test/integration-feishu-question.test.js | 新增 |
| test/message-dispatcher.test.js | 修改 |
| test/opencode-driver.test.js | 修改 |
| test/opencode-tui-bridge.test.js | 修改 |
| test/permission-handler.test.js | 新增 |

### 剩余风险

1. 飞书 `multi_select_static` 和 `input` 组件类型未在代码库中使用过，需卡片预览工具验证实际渲染效果
2. `buildQuestionCard` 中 `options.value` 非空校验由 dispatcher `_cmdAnswer` required 校验兜底，卡片层未单独校验
