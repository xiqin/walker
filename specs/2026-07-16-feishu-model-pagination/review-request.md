# 飞书模型卡片分页代码审查请求

**功能**：飞书 `/model` 模型列表分页与原卡片更新  
**审查基准**：当前 worktree 相对 `HEAD`（`ed2ee6e`）的未提交差异  
**规格来源**：`specs/2026-07-16-feishu-model-pagination/spec.md`

## Standards

- 无阻断发现。分页职责保持在飞书卡片渲染、消息分发和 bootstrap API 挂载边界内，没有修改模型目录接口或引入新的持久化状态。
- `src/platform/feishu/cards.js` 在分页前构造稳定且全局去重的模型序列，再按每页 20 个切片；导航按钮不占模型按钮限额。
- `src/dispatch/message-dispatcher.js` 仅对 `/model --page` 豁免普通命令去重，直接模型切换仍保留原去重和 session 更新语义。
- `src/app/bootstrap.js` 复用既有 `patchCard()` 更新原卡片，首次 `/model` 仍通过 `replyCard()` 创建卡片。
- 测试覆盖卡片层、dispatcher、bootstrap 以及卡片 action 到 `patchCard` 的持久化跨模块链路。
- 非阻断关注：当前 worktree 同时包含前序飞书交互、Loom memory/compliance 和两个 spec 目录的未提交变更，提交时需要按预期范围统一整理。

## Spec

- 无阻断发现。
- REQ-001：每页最多 20 个模型，53 个模型形成 20、20、13 三页，并显示页码。
- REQ-002：导航动作使用 `cmd:/model --page <页码>`，并透传 `routeKey`。
- REQ-003：分页使用触发卡片原始 `messageId` 调用 `patchCard()`，不额外发送新卡片或纯文本。
- REQ-004：完整顺序为当前模型、Recent、配置模型、其余 provider 模型，跨页无遗漏和重复。
- REQ-005：缺失、非法、小于 1 和超范围页码均归一化到有效页，且不更新 `session.model`。
- REQ-006：同一卡片可在页面间往返，分页请求绕过普通命令去重。
- REQ-007：直接模型切换以及卡片不可用、返回空值或抛错时的纯文本 fallback 保持兼容。

## 预审查摘要

- Standards findings: 0 个阻断，worst: none。
- Spec findings: 0 个阻断，worst: none。

## 变更统计

当前 worktree 相对 `HEAD`：

```text
13 tracked files changed, 1275 insertions(+), 54 deletions(-)
```

该统计包含前序飞书消息交互功能和 Loom 产物变更。分页功能的核心增量集中在：

- `src/platform/feishu/cards.js`
- `src/dispatch/message-dispatcher.js`
- `src/app/bootstrap.js`
- `test/feishu-cards.test.js`
- `test/message-dispatcher.test.js`
- `test/bootstrap.test.js`

## 主要变更

1. 模型列表先按优先级生成完整稳定去重序列，再按每页 20 个模型分页。
2. 卡片增加页码、上一页和下一页导航，导航命令复用现有 `cmd:` 回流协议。
3. dispatcher 将 `/model --page N` 识别为列表分页，不进入模型切换路径，并允许同一卡片页面往返。
4. bootstrap 在分页时调用 `patchCard()` 更新原卡片，首次打开模型列表仍发送新卡片。
5. 新增持久化跨模块测试，覆盖卡片 action 到原卡片更新的完整应用内链路。

## 自测情况

- [x] `npm run check` 退出码为 0。
- [x] 756 个测试通过，0 个失败，49 个 suites。
- [x] `git diff --check` 通过。
- [x] 本次 spec、源码和测试范围未完成标记扫描无命中。
- [x] CodeGraph 抽查分页命令、卡片渲染和 `patchCard` 调用链，接口一致。
- [x] `test-report.md` 和 `verify-report.md` 结论均为 PASS。
- [ ] 尚未在真实飞书租户人工点击分页按钮。

验证证据：

- 日志：`specs/2026-07-16-feishu-model-pagination/evidence/verification.log`
- SHA-256：`E53F9874D7A6DDE52F40C57D8F2539732302879CA0151FB47BA5BAE1AB7F1757`
- 自动产物校验 WARN：本机 Loom 工具链缺失 `artifact-checker.js`，已用手工产物核验、全量测试和调用链抽查补足。

## 变更详情

| 文件 | 说明 |
| --- | --- |
| `src/platform/feishu/cards.js` | 稳定模型序列、全局去重、页码归一化、分页切片和导航按钮。 |
| `src/dispatch/message-dispatcher.js` | 分页命令识别、dedup 豁免、分页参数传递和纯文本 fallback。 |
| `src/app/bootstrap.js` | 根据 `updateMessageId` 选择 `patchCard()` 或 `replyCard()`。 |
| `test/feishu-cards.test.js` | 20/20/13 分页、排序去重、页码边界、导航协议测试。 |
| `test/message-dispatcher.test.js` | 分页列表语义、页面往返、模型切换兼容和 fallback 测试。 |
| `test/bootstrap.test.js` | 卡片 action 到原卡片 `patchCard()` 的跨模块集成测试。 |

## 审查重点

- [ ] 完整模型序列在分页前的排序和全局去重是否符合产品语义。
- [ ] `/model --page` 的 dedup 豁免是否只影响分页，不削弱普通模型切换去重。
- [ ] 卡片回调 `messageId` 是否始终对应需要更新的原模型卡片。
- [ ] `patchCard()` 失败后的纯文本 fallback 是否符合用户可见性要求。
- [ ] 当前 agent driver、多 agent 扩展和直接模型切换是否保持兼容。

## 相关产物

- `specs/2026-07-16-feishu-model-pagination/spec.md`
- `specs/2026-07-16-feishu-model-pagination/plan.md`
- `specs/2026-07-16-feishu-model-pagination/test-report.md`
- `specs/2026-07-16-feishu-model-pagination/verify-report.md`
