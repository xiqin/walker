# 代码审查请求

**功能：** 飞书模型切换修复（移除全局副作用、模型目录验证、`/new` 继承、类型统一、TUI clear 直接传 model）
**分支：** 当前工作分支（未单独开 feature 分支，基于 `b0a19fd`）

## 变更统计

```
 .loom/compliance/history.json      |  11 ++
 src/core/session-service.js        |   5 +-
 src/dispatch/message-dispatcher.js | 127 +++++++++++++++----
 src/opencode-tui-bridge/bridge.js  |   8 +-
 test/message-dispatcher.test.js    | 253 ++++++++++++++++++++++++++++++++++++-
 test/opencode-tui-bridge.test.js   |   8 +-
 test/session-service.test.js       |  32 +++++
 7 files changed, 405 insertions(+), 39 deletions(-)
```

## 主要变更

1. **`SessionService.createSession`** 接受 `model` 参数，创建时浅复制保存为 `{ providerID, modelID }` 对象，避免跨 session 共享可变引用。
2. **`MessageDispatcher._cmdModel`** 移除 `driver.updateConfig()` 全局配置调用，改为调用 `driver.listModels()` 验证模型目录，通过 `_resolveModelRef()` 规范化模型引用（含/不含 provider、唯一补全、无匹配拒绝、跨 provider 重名提示），仅更新当前 Walker session。
3. **`MessageDispatcher._cmdNew`** 新增 `_resolveInheritedModel(current)`，优先继承当前焦点 session 模型，否则使用规范化 `defaultModel`，同时传给 driver 和 sessionService 的 createSession。
4. **`MessageDispatcher._enqueuePrompt`** 改用 `_resolveSessionModel(session)`，兼容历史 string 类型 session.model（读取边界规范化），defaultModel 规范化为对象，不再向 driver 传裸 string。
5. **`OpencodeTuiBridge._tryCompleteClear`** 创建新 Walker session 时直接在 createOpts 传 `model`，删除二次 `updateSessionField` 继承；已存在 session 分支保留兜底更新。
6. **新增测试**：SessionService 复制/无 model；dispatcher `/model` 补全/拒绝/歧义/完整 ID 无匹配、`/new` 继承 3 用例、prompt 边界 5 用例；bridge prompt/clear 改为对象 model。

## 重点关注

1. **架构合规性**：变更严格遵循现有分层（dispatcher→driver/SessionService，bridge→SessionService），未新增架构层。`_resolveModelRef`/`_resolveSessionModel`/`_normalizeDefaultModel`/`_resolveInheritedModel` 均为 dispatcher 私有辅助方法，符合 constitution 核心原则 1「遵循现有架构边界」。
2. **安全性**：移除 `updateConfig` 全局副作用，避免 `/model` 修改影响其他会话和 OpenCode 全局配置；模型目录验证防止写入不存在或已废弃的模型引用。
3. **性能影响**：`/model` 命令新增一次 `listModels()` 网络调用，仅在切换时执行，不影响 prompt 路径。`_resolveModelRef` 为内存过滤，O(n) 且 n 通常 <50。

## 自测情况

- [x] 编译通过（BUILD_CMD N/A — Node.js 项目无编译步骤）
- [x] 静态分析通过（VET_CMD N/A — constitution 未定义）
- [x] 测试通过（TEST_CMD `npm test` → 724 pass / 0 fail，exit 0）
- [x] 代码符合编码红线（constitution 编码红线未显式定义，参照编码行为准则 5 项原则人工核验通过）
- [x] 图后端索引查询跳过（`.loom/graph.config.json` 未启用图后端）

## 变更详情

| 文件 | 变更类型 | 说明 |
| ---- | -------- | ---- |
| src/core/session-service.js | 修改 | `createSession` 新增 `model` 参数，浅复制保存对象 |
| src/dispatch/message-dispatcher.js | 修改 | `_cmdModel` 移除全局配置+验证目录；`_cmdNew` 继承模型；`_enqueuePrompt` 规范化；新增 4 个辅助方法 |
| src/opencode-tui-bridge/bridge.js | 修改 | `_tryCompleteClear` 创建时直接传 model，删除二次更新 |
| test/session-service.test.js | 修改 | 新增 model 复制和无 model 2 个测试 |
| test/message-dispatcher.test.js | 修改 | `/model` 补全/拒绝/歧义 4 用例、`/new` 继承 3 用例、prompt 边界 5 用例 |
| test/opencode-tui-bridge.test.js | 修改 | prompt 和 clear 测试 model 改为对象 |

## Standards

- **极简优先**：`_resolveModelRef` 等辅助方法只解决模型解析问题，无推测性抽象；`createSession` 只在 `model && typeof model === 'object'` 时复制，未加额外校验层。符合行为准则 2。
- **精准手术**：只改动模型相关代码路径，未触碰相邻的 `/runtime`、`/agent` 等命令；`_tryCompleteClear` 已存在 session 分支保留原有 `updateSessionField` 兜底，未"顺便优化"。符合行为准则 3。
- **依赖显式传递**：模型通过参数传递，未引入全局状态；`_resolveInheritedModel` 显式取 `current.model`，无隐藏读取。符合核心原则 2。
- **错误可诊断**：`_resolveModelRef` 返回的 error 文案包含输入值和修复建议（`Use /model to list available models.` / `Use provider/modelID`），保留调用上下文。符合核心原则 4。
- **合理注释**：4 个新增辅助方法均有 JSDoc 注释，描述定义和参数说明，使用中文。符合行为准则 5。
- **测试质量**：测试覆盖行为（补全/拒绝/歧义/继承/规范化），未耦合实现细节；mock 只验证传入 driver 和 sessionService 的参数，不断言私有方法调用。
- **坏味道基线**：无重复代码、无过长函数（`_cmdModel` 缩短至 ~40 行，`_resolveModelRef` ~25 行）、无霰弹式修改、无循环依赖、无全局状态、无过度 mock、无临时兼容层（string 兼容为明确声明的向后兼容，非临时）。
- **无发现 blocker**。

## Spec

- **REQ-001**：`_cmdModel` diff 确认删除 `driver.updateConfig` 调用块（原 line 666-676），仅保留 `sessionService.updateSessionField`。测试 `/model <model_id>` 用例未 mock `updateConfig`，`/clear 不修改旧 session model 或全局配置` 用例断言 `updateConfigCalls.length === 0`。✓
- **REQ-002**：`_resolveModelRef` 含 `/` 分支精确匹配 `provider===parts[0] && id===parts.slice(1).join('/')`，命中返回 `{providerID, modelID}`。测试 `/model provider/model_id` 断言 `{providerID:'cpa', modelID:'gpt-5.5'}`。✓
- **REQ-003**：不含 `/` 分支按 `m.id === input` 精确匹配；`matches.length === 1` 补 `matches[0].provider`；`=== 0` 返回 error；`>1` 返回提示完整 ID 的 error。4 个测试用例覆盖。✓
- **REQ-004**：`_cmdNew` 取 `inheritedModel = this._resolveInheritedModel(current)`，同时传 `driver.createSession({..., model: inheritedModel})` 和 `sessionService.createSession({..., model: inheritedModel})`。3 个测试用例覆盖继承当前/default/null。✓
- **REQ-005**：`_enqueuePrompt` 用 `_resolveSessionModel(session)`，string session.model 在读取边界规范化为对象，`_normalizeDefaultModel` 把 string defaultModel 解析为 `{providerID, modelID}`。5 个 prompt 边界测试用例覆盖。✓
- **REQ-006**：`_tryCompleteClear` createOpts 加 `if (clearPending.oldModel) createOpts.model = clearPending.oldModel`，删除二次 `updateSessionField` model 继承；`createSession` 浅复制对象。bridge clear 测试用对象 model 并断言 `deepEqual`。✓
- **REQ-007**：针对性 146/146 + 全量 724/724 通过，覆盖 dispatcher、session service、TUI bridge。✓
- **非目标遵守**：未迁移历史持久化 string（仅在读取边界兼容）；未改变 OpenCode 模型目录接口；未新增全局默认模型命令；未改变飞书以外入口。✓
- **无发现 blocker**。

## 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none

## 审查重点

- [ ] 架构合规性
- [ ] 代码质量
- [ ] 安全性检查
- [ ] 性能影响
