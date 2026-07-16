# 代码审查请求

**功能：** 飞书消息与指令交互增强  
**审查基准：** 当前 worktree 相对 `HEAD` 的未提交 diff  
**流水线阶段：** code-review-request

## Standards

- 无阻断发现。
- 预审查已覆盖架构分层、错误回退、测试质量和多 agent 边界。当前实现保持驱动层、飞书平台层、dispatcher 集成层的职责边界：驱动层输出统一模型视图，飞书卡片层只消费统一字段，dispatcher 只调用当前会话 agent driver。
- 非阻断关注点：`.loom/compliance/history.json` 是验证工具写入的合规历史副产物，其中记录了本机 loom/opencode skill 验证脚本缺失依赖的 WARN；它不属于业务实现，但出现在 worktree diff 中，提交前建议决定是否纳入本次变更。
- 非阻断关注点：`src/platform/feishu/cards.js` 的 Recent 排序对纯数字字符串会先尝试 `Date.parse()`，现有测试和需求可接受；若后续真实 OpenCode 返回纯数字时间戳，可再增强排序归一化。
- 非阻断关注点：`src/dispatch/message-dispatcher.js` 的纯文本模型列表 fallback 过滤 deprecated，但未显式过滤 `enabled === false`；OpenCode driver 当前已在驱动层过滤 disabled，若未来其它 agent driver 不过滤，可再收紧 fallback 展示逻辑。

## Spec

- 无阻断发现。
- REQ-001 已覆盖：普通 Agent 最终回复通过 `src/dispatch/message-dispatcher.js` 的模型 footer 追加 `模型：<model>`，无模型时显示 `未指定`。
- REQ-002 已覆盖：`src/platform/feishu/cards.js` 新增模型选择卡片，Recent 最多 5 个，总按钮最多 20 个，超限提示用户使用精确 `/model <provider>/<model_id>`。
- REQ-003 已覆盖：模型按钮使用现有 `cmd:/model <provider>/<id>` 回流协议，dispatcher 点击路径会更新当前 session 的 `model` 字段。
- REQ-004 已覆盖：`/help` 优先返回命令帮助卡片，按钮通过 `cmd:/<name>` 回流。
- REQ-005 已覆盖：dispatcher 使用当前会话 agent driver 的模型目录，不固定回退 OpenCode；OpenCode driver 输出统一模型视图并映射 Recent。
- REQ-006 已覆盖：命令去重 key 已包含参数，避免同一卡片不同模型按钮被误判重复。
- REQ-007 已覆盖：纯文本命令解析保留；卡片发送能力不存在或发送失败时回退纯文本响应。

## 预审查摘要

- Standards findings: 0 个阻断，worst: none
- Spec findings: 0 个阻断，worst: none

## 变更统计

```text
.loom/compliance/history.json      |  11 ++
src/app/bootstrap.js               |   8 +-
src/dispatch/message-dispatcher.js |  94 ++++++++----
src/drivers/agent-driver.js        |   8 ++
src/drivers/opencode-driver.js     |  41 +++++-
src/platform/feishu/cards.js       | 137 ++++++++++++++++++
src/platform/feishu/commands.js    |  10 +-
test/feishu-cards.test.js          |  58 ++++++++
test/message-dispatcher.test.js    | 285 +++++++++++++++++++++++++++++++++++--
test/opencode-driver.test.js       |  79 ++++++++++
10 files changed, 683 insertions(+), 48 deletions(-)
```

## 主要变更

1. 新增 agent driver 模型目录契约：`AgentDriver.listModels()` 默认给出可诊断的不支持错误，`OpencodeDriver.listModels()` 输出统一模型视图并映射 OpenCode Recent 元数据。
2. 新增飞书模型列表卡片和帮助卡片：支持 Recent 分组、provider 分组、按钮数量上限、routeKey 透传和 `cmd:/...` 回流协议。
3. dispatcher 集成 `/model` 和 `/help`：优先发送交互卡片，卡片能力不可用或发送失败时保留纯文本 fallback。
4. 普通 Agent 最终回复追加模型 footer，footer 语义为 Walker 本次请求指定给 agent 的模型。
5. 命令去重 key 纳入命令参数，解决同一卡片多个模型按钮互相误判重复的问题。

## 自测情况

- [x] `npm run check` 已通过，证据日志：`specs/2026-07-16-feishu-message-interactions/evidence/verification.log`
- [x] 证据 SHA-256：`24C0DE2081370B37CAADD79C7977D31ECF7457E4FCE450B003C47089D353A4AD`
- [x] 测试摘要：743/743 tests passed，49 suites
- [x] `test-report.md` Verdict：PASS
- [x] `verify-report.md` Verdict：PASS
- [x] 本次 spec/src/test 范围未完成标记扫描无命中
- [x] CodeGraph 抽查接口一致性通过
- [x] `verify-artifacts.mjs` 因本机 loom/opencode skill 工具链缺失 `artifact-checker.js` 无法运行，已记录为 WARN，并用手工核验补足

## 变更详情

| 文件 | 类型 | 说明 |
| ---- | ---- | ---- |
| `src/drivers/agent-driver.js` | 修改 | 增加统一模型目录能力默认契约。 |
| `src/drivers/opencode-driver.js` | 修改 | 将 OpenCode 模型 API 响应规范化为统一模型视图，映射 Recent 元数据。 |
| `src/platform/feishu/cards.js` | 修改 | 新增模型列表卡片、帮助卡片和模型卡片常量。 |
| `src/platform/feishu/commands.js` | 修改 | 导出 `COMMAND_LIST`，保持命令解析和纯文本帮助兼容。 |
| `src/app/bootstrap.js` | 修改 | 挂载 `sendModelList` 与 `sendHelpCard` 到 Feishu API target。 |
| `src/dispatch/message-dispatcher.js` | 修改 | 集成 `/model`、`/help` 卡片优先逻辑、模型 footer、参数化 dedup 和多 agent 模型目录约束。 |
| `test/opencode-driver.test.js` | 修改 | 覆盖模型目录默认不支持、统一模型视图、Recent 映射和过滤行为。 |
| `test/feishu-cards.test.js` | 修改 | 覆盖模型卡片、Recent/provider 分组、routeKey、过滤与帮助卡片按钮。 |
| `test/message-dispatcher.test.js` | 修改 | 覆盖 `/model`、`/help` 卡片/fallback、模型切换、多 agent 约束、footer 与 dedup。 |
| `.loom/compliance/history.json` | 修改 | loom 验证阶段自动写入的合规历史记录。 |

## 审查重点

- [ ] 多 agent 约束是否清晰：dispatcher 不应固定回退 OpenCode。
- [ ] 飞书卡片按钮回流协议是否与现有 `cmd:/...` 事件解析保持一致。
- [ ] 模型 footer 文案是否准确表达“Walker 本次请求指定模型”。
- [ ] 卡片发送失败后的纯文本 fallback 是否覆盖用户可见响应。
- [ ] 新增测试是否覆盖主要行为和失败路径，且没有过度耦合实现细节。

## 相关产物

- Spec：`specs/2026-07-16-feishu-message-interactions/spec.md`
- Plan：`specs/2026-07-16-feishu-message-interactions/plan.md`
- Test Report：`specs/2026-07-16-feishu-message-interactions/test-report.md`
- Verify Report：`specs/2026-07-16-feishu-message-interactions/verify-report.md`
- Verification Evidence：`specs/2026-07-16-feishu-message-interactions/evidence/verification.log`
