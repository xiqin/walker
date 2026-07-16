# 飞书模型卡片分页测试报告

**日期**：2026-07-16  
**范围**：集成测试、全量回归、REQ-001 至 REQ-007 spec 验证  
**结论**：PASS

## 摘要

| 类别 | 结果 | 证据 |
| --- | --- | --- |
| 持久化跨模块集成测试 | PASS | `test/bootstrap.test.js` 新增“卡片分页 action 经 onCardAction 和 dispatcher 原地渲染目标页” |
| 全量回归 | PASS | `npm run check`：756 通过、0 失败、0 跳过 |
| Spec 验证 | PASS | REQ-001 至 REQ-007 均有持久化自动化测试与实现路径证据 |
| 生产代码变更 | 无 | 本次 QA 仅修改测试文件并生成 evidence/report |

## 集成测试

在标准测试目录的 `test/bootstrap.test.js` 中新增一条持久化真实跨模块测试，使用真实 `MessageDispatcher`，通过 `createApp` 挂载的真实 `onCardAction` 回调驱动如下链路：

`cmd:/model --page 2` 卡片 action → `onCardAction` → `parseCommand` → `MessageDispatcher.handleCommand` → `_cmdModel` → bootstrap `sendModelList` → `renderModelListCard` → `patchCard`

断言内容：

- `patchCard` 恰好调用一次。
- `patchCard` 使用触发卡片原始 `messageId`：`om_original_model_card`。
- 更新后的卡片显示 `第 2 / 2 页`。
- 目标页包含 `Model 21 (custom)`。
- 未调用 `replyText`，没有额外发送纯文本。
- 未调用 `replyCard`，没有额外创建模型卡片。

单文件预检：`node --test test/bootstrap.test.js`，13 通过、0 失败。

## 边界验证

负数和超范围页码未新增重复测试，现有分层证据足以证明跨层不变式：

- `test/message-dispatcher.test.js` 的“`/model --page 分页请求复用当前 agent 目录并可在同一卡片往返`”证明分页分支不调用 `sessionService.updateSessionField`。
- `test/message-dispatcher.test.js` 的“`/model --page 缺失或非法页码仍交给卡片层归一化且不更新模型`”证明非法分页输入仍走列表路径且不更新 `session.model`。
- `test/feishu-cards.test.js` 的“`renderModelListCard 将无效页码归一化到有效的 1-based 页码`”明确覆盖 `page: -2` 归一到第 1 页、`page: 99` 归一到第 3 页。
- 代码路径上，`src/dispatch/message-dispatcher.js` 将所有首参数为 `--page` 的输入统一进入分页分支，只透传 `args[1]`；`updateSessionField(..., 'model', ...)` 仅位于非分页模型切换分支。因此负数和超范围值均不会更新 `session.model`，随后由卡片层安全归一化。

## Requirement 映射

| Requirement | 结果 | 验证证据 |
| --- | --- | --- |
| REQ-001 | PASS | `test/feishu-cards.test.js` 验证 53 个模型形成 20、20、13 三页，并显示 `第 X / Y 页`；全量回归通过。 |
| REQ-002 | PASS | 卡片测试验证导航 action 为 `cmd:/model --page <页码>` 并透传 `routeKey`；新增 bootstrap 集成测试证明该 action 可真实回流至 dispatcher。 |
| REQ-003 | PASS | 卡片测试验证首页无上一页、末页无下一页；新增集成测试证明使用原 `messageId` 调用 `patchCard`，且不发送 `replyCard` 或纯文本。 |
| REQ-004 | PASS | 卡片测试验证完整顺序为当前模型、Recent、配置模型、其余 provider 模型，53 个按钮跨页并集唯一且完整。 |
| REQ-005 | PASS | 卡片测试覆盖缺失、非数字、负数、超范围和数字字符串；dispatcher 测试与代码路径证明分页输入不更新 `session.model`。 |
| REQ-006 | PASS | dispatcher 测试使用同一 `messageId` 执行第 2 页、第 1 页、第 2 页，三次均刷新目录并发送分页卡片。 |
| REQ-007 | PASS | dispatcher 回归测试覆盖 `/model <provider>/<model_id>` 模型切换、无卡片能力 fallback、卡片返回空值或抛错时纯文本 fallback；全量回归通过。 |

## 全量回归

- 命令：`npm run check`
- 退出码：`0`
- Suites：49
- Tests：756
- Passed：756
- Failed：0
- Cancelled：0
- Skipped：0
- Todo：0

完整命令输出保存在 evidence 文件中，未以摘要替代原始日志。

## Evidence Receipt

| 字段 | 值 |
| --- | --- |
| Evidence 路径 | `specs/2026-07-16-feishu-model-pagination/evidence/test.log` |
| 命令 | `npm run check` |
| 退出码 | `0` |
| 文件大小 | `657482` bytes |
| SHA-256 | `8c3f8a96baf5ace5e7ed1887695996bf294cead97141e8f3d3d2f8ab77fa998f` |
| 日志写入时间 UTC | `2026-07-16T06:34:12.0767384Z` |

## 判定

退出码为 `0`，全量测试无失败，Evidence Receipt 包含重新计算得到的真实 SHA-256，且 REQ-001 至 REQ-007 均已验证。

verdict: PASS
