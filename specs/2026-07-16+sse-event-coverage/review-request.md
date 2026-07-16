# 代码审查请求

**功能：** SSE 事件全量覆盖 + 权限确认卡片交互
**分支：** main (commit 63e5d15)
**Spec 来源：** specs/2026-07-16+sse-event-coverage/spec.md (18 REQ)

## 变更统计

```
 18 files changed, 843 insertions(+), 80 deletions(-)
```

## 主要变更

1. **AgentEvent 类型体系扩展** (agent-driver.js)：新增 11 种 EVENT_TYPE 常量 + DATA_SCHEMAS + TYPE_* 静态属性
2. **mapSSEEvent 全量映射** (opencode-sse-adapter.js)：覆盖 OpenCode 1.17.20 全部 31 种 SSE 事件，新增 createLogger 修复 logger 问题
3. **replyPermission 方法** (opencode-driver.js)：POST /session/:id/permissions/:permissionId 回复权限
4. **权限卡片渲染** (cards.js)：buildPermissionCard（红 header + 允许/拒绝按钮）+ buildPermissionRepliedCard（灰 header）
5. **进度卡片扩展** (progress-card.js)：formatAgentEvent 新增 11 种 case
6. **/permit 命令** (commands.js)：COMMANDS 表注册 permit 命令
7. **dispatcher 权限处理** (message-dispatcher.js)：_handlePermissionEvent/_handlePermissionRepliedEvent/_cmdPermit
8. **bootstrap API 绑定** (bootstrap.js)：sendPermissionCard/patchPermissionCard

## Standards

- **agent-driver.js**：新增 11 种 EVENT_TYPE 常量、DATA_SCHEMAS 和 TYPE_* 静态属性，模式一致，无发现。
- **opencode-sse-adapter.js**：新增 createLogger 实例修复 logger.debug 不可用问题；事件映射覆盖完整，silentDiscard 列表显式声明避免维护混淆；未知事件 return null + debug 日志。**发现 1**：第 103 行 `permission.updated` 映射中 `props.sessionID || props.sessionId` 两种大小写兼容，OpenCode 1.17.20 类型定义中为 `sessionID`，当前兼容写法无害但可能在未来的严格类型校验中产生歧义。建议保留兼容写法但添加注释说明。
- **opencode-driver.js**：replyPermission 方法遵循现有 _buildUrl + httpClient.request 模式，参数校验充分（sessionRef/permissionId/TUI bridge），remember 默认 false。无发现。
- **cards.js**：buildPermissionCard 逻辑清晰，escapeLarkMd 转义正确，按钮 value 格式 `cmd:/permit <id> allow/deny` 符合现有 buildButtonValue 约定。**发现 2**：buildPermissionRepliedCard 的 header template 用 'default'（灰色），符合飞书模板色规范（非 'grey'）。无发现。
- **progress-card.js**：formatAgentEvent 新增 11 种 case，default 仍返回 ''，符合既有模式。**发现 3**：todo case 中 `t.status === 'completed' || t.status === 'done'` 兼容两种状态值，spec 中 todo item schema 为 `{ id, content, status, activeForm }`，未明确 status 枚举值，当前兼容写法合理。无发现。
- **commands.js**：permit 命令注册格式与现有命令一致。无发现。
- **message-dispatcher.js**：_handlePermissionEvent 使用 require('../platform/feishu/cards') 内联引用而非构造函数注入。**发现 4 (minor)**：第 1339 行和 1349 行在 _handlePermissionEvent 中使用 `require('../platform/feishu/cards').buildPermissionCard` 内联 require，而非通过构造函数注入或模块级 require。这在测试中可能导致 mock 困难。建议改为模块顶部 require 常量。当前测试通过但属于轻微的可测试性坏味道。
- **message-dispatcher.js**：_cmdPermit 错误处理完整，覆盖缺参数/非法 response/无 session/driver 不支持/回复失败场景。无发现。
- **bootstrap.js**：sendPermissionCard/patchPermissionCard 绑定遵循现有模式，requiredFeishuMethods 已添加。无发现。

## Spec

- REQ-001 ~ REQ-018：全部 18 个 REQ 有对应代码实现和测试覆盖（test-report.md 确认）。无遗漏。
- **发现 5 (spec drift)**：spec 规则 3 要求 "file.edited 和 session.diff 事件在同一个 session 生命周期内累计计数，进度卡片显示聚合摘要"。当前 formatAgentEvent 对 file_edited 返回 `📝 已编辑 <path>`，显示单条路径而非聚合计数。实现未做累计计数。建议确认是否需要后续补充聚合逻辑，或在 spec 中标注"本次仅显示单条，聚合计数为后续增强"。

## 预审查摘要

- Standards findings: 4（1 个 minor 可测试性坏味道 + 3 个无实质问题的兼容写法注释建议），worst: minor
- Spec findings: 1（file.edited 聚合计数未实现），worst: minor drift

## 自测情况

- [x] 编译通过（无独立构建步骤，require 加载正常）
- [x] 静态分析通过（无 lint 配置，代码风格一致）
- [x] 测试通过（TEST_CMD: npm test, 900/900 通过, exit 0）
- [x] 代码符合编码红线
- [x] 图后端已跳过（.codegraph 未启用）

## 变更详情

| 文件 | 变更类型 | 说明 |
| ---- | -------- | ---- |
| src/drivers/agent-driver.js | 修改 | 新增 11 种 EVENT_TYPE + DATA_SCHEMAS |
| src/drivers/opencode-sse-adapter.js | 修改 | mapSSEEvent 全量映射 + createLogger |
| src/drivers/opencode-driver.js | 修改 | 新增 replyPermission 方法 |
| src/platform/feishu/cards.js | 修改 | 新增 buildPermissionCard/buildPermissionRepliedCard |
| src/platform/feishu/progress-card.js | 修改 | formatAgentEvent 新增 11 种 case |
| src/platform/feishu/commands.js | 修改 | COMMANDS 新增 permit |
| src/dispatch/message-dispatcher.js | 修改 | 权限卡片渲染+回调+/permit 命令处理 |
| src/app/bootstrap.js | 修改 | sendPermissionCard/patchPermissionCard 绑定 |
| test/opencode-sse-adapter.test.js | 新增 | 27 个测试覆盖全部事件映射 |
| test/opencode-driver.test.js | 修改 | 6 个 replyPermission 测试 |
| test/progress-card.test.js | 修改 | 14 个 formatAgentEvent 测试 |
| test/feishu-cards.test.js | 修改 | 权限卡片结构测试 |
| test/feishu-commands.test.js | 修改 | 3 个 /permit 命令测试 |
| test/message-dispatcher.test.js | 修改 | 7 个权限处理测试 |
| test/bootstrap.test.js | 修改 | 2 个 API 绑定测试 |

## 审查重点

- [ ] 架构合规性：AgentEvent 类型体系扩展是否影响现有 6 种类型行为
- [ ] 代码质量：message-dispatcher.js 内联 require 的可测试性
- [ ] 安全性：权限卡片按钮回调链路是否安全（cmd:/permit 命令注入风险）
- [ ] 性能影响：mapSSEEvent 新增分支的匹配性能（线性 if 链）
- [ ] Spec 一致性：file.edited 聚合计数未实现的 drift
