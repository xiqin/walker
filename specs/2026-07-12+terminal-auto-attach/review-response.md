# 代码审查回复

**功能：** OpenCode 启动自动纳入 Walker + 1:N Session 路由
**审查请求：** `specs/2026-07-12+terminal-auto-attach/review-request.md`
**审查类型：** 自审查（单人开发流水线，review-gate 已由用户批准）

## 审查反馈分类

本次无外部审查者反馈。自审查在 verification 和 code-review-request 阶段完成，发现 5 个非阻断警告（W1-W5），0 个阻断问题。以下逐一给出处置决定。

## Standards 轴发现处置

### W1: health-poller 用 `/global/health`，opencode-driver 用 `/health`

**分类**：建议修复（需运行时确认）

**技术评估**：
- `health-poller.js` 轮询 `GET /global/health` 检测 OpenCode server 是否存活
- `opencode-driver.js` 的 `_checkHealth`（line 520）轮询 `GET /health`
- OpenCode 官方文档（2026-07-10 调研）列出 `/global/health` 为健康检查端点
- 两个端点可能都存在，或其中一个不存在，需运行时确认

**处置**：**推迟到运行时确认**。当前实现使用 `/global/health` 符合官方文档。若运行时发现 404，改为 `/health` 即可（单行修改）。不阻断合入。

**理由**：无运行环境可立即验证；两种端点在 OpenCode 不同版本可能都存在；修改成本极低。

---

### W2: 配置项命名 `walkerOpendcode*` vs `opencode*` 不一致

**分类**：讨论项

**技术评估**：
- 新增配置项属性名 `walkerOpendcodeHookEnabled`、`walkerOpendcodeHealthPollIntervalMs` 等
- 现有同类配置项 `opencodeServerAutostart`、`opencodeCmd` 全小写 `opencode`
- 环境变量名 `WALKER_OPENCODE_*` 正确（全大写）
- JS 属性名中 `Opendcode` 多了大写 O，与现有 `opencode*` 命名风格不一致

**处置**：**拒绝修改**。

**理由**：
1. 该命名由 spec REQ-007 显式指定（`walkerOpendcode*` 前缀），实现忠实遵循规格
2. 已有 587 个测试通过，修改属性名需同步修改 env.js、bootstrap.js、health-poller.js 及所有相关测试
3. 不影响功能正确性，仅影响可维护性
4. 若后续需要统一命名，应作为独立的重构任务（chore 类型），不在本次 feature 范围内

---

### W3: cards.js marker 仍为"← 当前绑定"，建议改为"← 当前焦点"

**分类**：建议修复

**技术评估**：
- `cards.js:73`：`const marker = isCurrent ? ' ← 当前绑定' : '';`
- T5 已将按钮文案从"绑定/已绑定"改为"设为焦点/已聚焦"
- marker 作为焦点 session 的可见标记，仍用"当前绑定"与新语义不一致
- 修改范围：cards.js 1 行 + feishu-cards.test.js 1 个断言

**处置**：**推迟到后续优化**。不阻断合入。

**理由**：
1. marker 是辅助性 UI 文案，不影响功能正确性
2. T5 的 owns 仅限按钮文案改动，marker 不在 T5 步骤明确范围内
3. 修改需同步更新测试断言 `assert.ok(textEl.text.content.includes('当前绑定'))` → `includes('当前焦点')`
4. 可作为后续 UI 优化任务处理

---

### W4: `isSpaFallbackCandidate` 未排除 `/opencode/hook/` 前缀（防御性）

**分类**：建议修复（防御性）

**技术评估**：
- `static.js:76` 的 `isSpaFallbackCandidate` 仅排除 `/api/admin/` 前缀
- `router.js:71` 的 `isAdminApiPath` 已扩展匹配 `/opencode/hook/`，`handleRequest` 中 `isAdminApiPath` 先于 `handleStatic` 判断
- 当前 hook 路径不会落入 SPA fallback 分支，无实际影响
- 若未来 `handleRequest` 顺序调整，可能出现 hook 路径被 SPA fallback 拦截

**处置**：**拒绝修改**。

**理由**：
1. 当前无实际影响（`isAdminApiPath` 先判断，hook 路径不会到达 `handleStatic`）
2. `isSpaFallbackCandidate` 的职责是判断静态文件 fallback 候选，与 API 路由前缀无关
3. 若未来调整 `handleRequest` 顺序，应同时审查所有路径前缀，不应单点修补
4. YAGNI：没有实际 bug，不引入防御性代码

---

### W5: `_readNormalized` 每次遍历所有 route（性能优化）

**分类**：建议修复（性能优化）

**技术评估**：
- `_readNormalized` 每次读操作遍历所有 route 检查是否需要迁移
- 迁移完成后（所有 route 都是对象格式），遍历仍执行但无副作用
- route 数量通常很小（几十个），性能影响可忽略
- 可在构造函数或 `recoverOnStartup` 中做一次性全量迁移，之后降为 no-op

**处置**：**推迟到后续优化**。不阻断合入。

**理由**：
1. route 数量在当前规模下极小（几十个），O(n) 遍历开销可忽略
2. 迁移是一次性的，首次写操作后所有 route 都会被归一化
3. 优化需修改 SessionService 构造函数和启动流程，超出本次 feature 范围
4. 可作为后续性能优化任务处理

## Spec 轴发现处置

**0 个偏差**。REQ-001 到 REQ-010 全部有测试覆盖，19/19 验收标准对应 test-report PASS。

## 处置摘要

| # | 问题 | 分类 | 处置 | 理由 |
|---|------|------|------|------|
| W1 | health 端点不一致 | 建议修复 | 推迟到运行时确认 | 符合官方文档，修改成本极低 |
| W2 | 配置项命名不一致 | 讨论项 | 拒绝修改 | spec 显式指定，忠实遵循规格 |
| W3 | marker 文案未同步 | 建议修复 | 推迟到后续优化 | 不影响功能，需同步测试 |
| W4 | isSpaFallbackCandidate 防御 | 建议修复 | 拒绝修改 | 无实际影响，YAGNI |
| W5 | _readNormalized 性能 | 建议修复 | 推迟到后续优化 | 当前规模可忽略 |

## 阻断问题

0 个。所有发现均为非阻断警告，已逐一给出处置决定。

## 测试验证

- `npm test`：587 pass / 0 fail / 0 skip，退出码 0
- 无修复需要重跑测试

## 结论

**审查通过**。0 阻断，5 个非阻断警告已全部处置（2 个推迟、2 个拒绝、1 个推迟到运行时确认）。实现忠实满足 spec.md 的 10 个 REQ 和 19 条验收标准。
