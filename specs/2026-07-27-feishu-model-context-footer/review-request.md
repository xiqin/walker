# 代码审查请求

**功能：** 飞书消息模型与上下文页脚
**固定点：** `HEAD` 到当前工作树中本需求相关文件的 diff
**范围说明：** 本审查请求覆盖飞书发送链路、相关测试与 `specs/2026-07-27-feishu-model-context-footer/` 产物；当前工作树中的 admin 相关改动、`.loom/compliance/history.json` 与未归属 `~/` 不属于本次飞书页脚审查范围。

## 预审查 Findings

## Standards

- 无 blocker 发现。本地预审查确认 runtime metadata 只从调用 context、session 与默认模型读取，不新增 driver/listModels/外部 API 调用；`_callFeishu` 的 retryable 列表、重试次数与 fallback 语义保持不变；进度卡片 wrapper 已透传 runtime 到底层 `replyCard`/`patchCard`。
- 残余风险：全量 `npm test` 当前仍有 2 个 admin UI 配置页测试失败，失败文件为 `test/admin-ui-workspaces.test.js`，栈指向 `admin/public/js/pages/config.js` DOM 过滤逻辑；该路径不在本次飞书发送链路改动范围内。

## Spec

- 无 blocker 发现。实现覆盖 `spec.md` 的 REQ-001 至 REQ-004：文本、Markdown、reply card、patch card 与进度卡片 wrapper 路径均由 `FeishuApi` 统一追加 `模型` 和 `上下文` 页脚；模型缺失、上下文缺失或解析异常时降级为 `unknown`，不阻塞发送。
- 残余风险：`addReaction` 是表情回应 API，不属于文本/Markdown/卡片消息正文，未追加页脚；这与 spec 中“文本、Markdown 和卡片消息”范围一致。

## 预审查摘要

- Standards findings: 0 blocker，worst: none。
- Spec findings: 0 blocker，worst: none。

## 变更统计

```text
src/app/bootstrap.js               |   8 +--
src/dispatch/message-dispatcher.js |  58 ++++++++++++++---
src/dispatch/progress-renderer.js  |  10 +--
src/platform/feishu/api.js         | 113 ++++++++++++++++++++++++++++++----
test/feishu-api.test.js            |  95 ++++++++++++++++++++++++++--
test/message-dispatcher.test.js    | 123 ++++++++++++++++++++++++++++++-------
6 files changed, 351 insertions(+), 56 deletions(-)
```

注：`specs/2026-07-27-feishu-model-context-footer/` 为本次 Loom 需求、计划、测试和验证产物，未纳入上述源码 diff stat。

## 主要变更

1. `src/platform/feishu/api.js` 增加 runtime footer 构建、模型格式化、上下文大小格式化、幂等检测与卡片 footer 注入。
2. `replyText`、`sendText`、`replyMarkdown`、`sendMarkdown` 在分片前统一追加页脚，确保长文本继续遵守 `MAX_TEXT_CHARS` 分片限制。
3. `replyCard` 与 `patchCard` 在 `body.elements` 末尾追加 markdown footer，并避免已有 footer 重复叠加。
4. `src/dispatch/message-dispatcher.js` 在 `_callFeishu` 中为支持页脚的飞书方法追加 runtime metadata，来源为 context、当前 session 和 `defaultModel`。
5. `src/dispatch/progress-renderer.js` 与 watch progress 路径补充 `{ sessionId }` context，避免旧模型-only footer 拼接，让 `FeishuApi` 统一渲染 `模型` 与 `上下文`。
6. `src/app/bootstrap.js` 的 `sendProgressCard` 与 `updateProgressCard` wrapper 接收 runtime 并透传给 `replyCard`/`patchCard`。
7. `test/feishu-api.test.js` 与 `test/message-dispatcher.test.js` 覆盖文本、Markdown、卡片页脚、幂等、模型/上下文边界、分片和 retry/fallback 不变。

## 自测情况

- [x] 相关回归通过：`node --test "test/feishu-api.test.js" "test/message-dispatcher.test.js" "test/progress-card.test.js"`，结果 `tests 207`、`pass 207`、`fail 0`。
- [x] 静态分析通过：`npm run lint`。
- [x] Loom 产物校验通过：`node "I:\nvmNodejs\nodejs\node_modules\loom-engineering\skills\loom-verification-before-completion\scripts\verify-artifacts.mjs" --spec-dir "specs/2026-07-27-feishu-model-context-footer"`。
- [x] Traceability 闭环通过：每个 REQ 和 behavior 均有 tasks/tests/evidence，evidence 文件存在。
- [x] 验证报告已写入：`specs/2026-07-27-feishu-model-context-footer/verify-report.md`，verdict 为 PASS。
- [ ] 全量 `npm test` 未完全通过：`tests 1182`、`pass 1180`、`fail 2`，失败为 admin UI 配置页既有/无关路径，已在 `verify-report.md` 标记为 known-warning。
- [ ] 所有变更尚未提交；本审查请求基于当前工作树 diff。

## 变更详情

| 文件 | 变更类型 | 说明 |
| ---- | -------- | ---- |
| `src/platform/feishu/api.js` | 修改 | 增加 runtime footer helper，并在文本、Markdown、reply card、patch card 发送入口统一注入。 |
| `src/dispatch/message-dispatcher.js` | 修改 | `_callFeishu` 为支持方法追加 runtime metadata；watch progress 卡片创建/更新传入 session context。 |
| `src/dispatch/progress-renderer.js` | 修改 | 完整回复、legacy 回复和进度卡片更新不再拼接旧模型 footer，改为传原始文本与 session context。 |
| `src/app/bootstrap.js` | 修改 | 进度卡片 wrapper 透传 runtime 到底层卡片发送/更新 API。 |
| `test/feishu-api.test.js` | 修改 | 覆盖 footer 追加、幂等、unknown fallback、卡片结构和长文本分片。 |
| `test/message-dispatcher.test.js` | 修改 | 覆盖 runtime metadata 传递、无额外 driver 调用、retry/fallback 不变和旧 footer 断言迁移。 |
| `specs/2026-07-27-feishu-model-context-footer/` | 新增 | Loom spec、plan、tasks、traceability、test/verify report、evidence 和 handoff 产物。 |

## 审查重点

- [ ] `FeishuApi.appendRuntimeFooter` 与 `withRuntimeFooterCard` 的幂等规则是否会误删或误判用户正文中自然出现的 `---\n模型：...` 段落。
- [ ] `_withFeishuRuntime` 的支持方法列表是否完整覆盖当前飞书文本、Markdown、卡片和进度卡片发送路径。
- [ ] `ProgressRenderer` 与 watch progress 的 `{ sessionId }` context 传递是否覆盖新建、更新、patch 失败重发和 done 更新路径。
- [ ] 上下文大小字段优先级 `contextSize/contextTokens/tokens/tokenUsage/usage` 是否符合实际 driver/session 元数据约定。
- [ ] 测试是否足够覆盖正文保持、页脚唯一性、模型切换后读取最新 session、缺失数据 unknown 和 retry/fallback 不变。

## 证据路径

- `specs/2026-07-27-feishu-model-context-footer/test-report.md`
- `specs/2026-07-27-feishu-model-context-footer/verify-report.md`
- `specs/2026-07-27-feishu-model-context-footer/evidence/test-run-feishu-footer.log`
- `specs/2026-07-27-feishu-model-context-footer/evidence/verification-pass.log`
