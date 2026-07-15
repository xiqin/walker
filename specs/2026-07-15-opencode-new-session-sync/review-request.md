# 代码审查请求

**功能：** OpenCode `/new` 后飞书与 TUI 双向同步修复  
**分支：** `main`  
**审查固定点：** `HEAD` (`ec09a7b`)  
**变更状态：** 工作树未提交；审查范围仅限本计划声明的两个代码文件

## Findings

### Standards

- 无阻断项。变更集中在生成插件模板和对应运行级测试，未新增配置、依赖、服务端接口或架构层。
- 低风险测试证据偏差：`test/opencode-hook-installer.test.js:54` 的升级测试夹具标记为版本 0，而 REQ-005 明确描述版本 1。installer 使用生成内容完整比较，版本 1 旧模板同样会被覆盖，因此不影响生产行为，但该测试未精确复现版本 1 文件。

### Spec

- REQ-001 至 REQ-004：无发现。`src/opencode-hook/plugin-template.js:123-222` 与 `test/opencode-hook-installer.test.js:263-345` 覆盖滞后 route 下的新根会话切换、新会话双向事件归属、已有会话选择及子会话过滤。
- REQ-005：生产实现无发现；模板已升级为版本 2，installer 的完整内容比较会覆盖版本 1。精确测试夹具偏差同 Standards 所述，严重度为低。
- 非目标范围无漂移：未修改飞书 reaction、服务端 route/session/bridge、loopback API 数据模型或非 TUI driver。

### 预审查摘要

- Standards findings: 1，worst: 低风险测试夹具未精确使用版本 1
- Spec findings: 1，worst: REQ-005 精确回归夹具缺口，不影响生产行为
- Blocker: 0

## 变更统计

```text
 src/opencode-hook/plugin-template.js | 35 ++++++++++++---
 test/opencode-hook-installer.test.js | 83 +++++++++++++++++++++++++++++++++++-
 2 files changed, 112 insertions(+), 6 deletions(-)
```

## 主要变更

1. 生成插件升级为版本 2，并维护事件驱动的 `activeSessionId`。
2. 根级 `session.created` 和 `tui.session.select` 会切换活动会话、重新注册并轮询 Walker。
3. 带 `parentID` 或 `parentId` 的内部子会话不会抢占活动会话。
4. delivery、idle 和 error 按事件所属会话处理，允许旧会话仍在执行的 delivery 正常收尾。
5. 新增运行级回归测试，在 `api.route.current` 持续滞后为 `ses_old` 时验证新会话 register、poll、prompt、idle、error 和已有会话选择。

## 变更详情

| 文件 | 变更类型 | 说明 |
| ---- | -------- | ---- |
| `src/opencode-hook/plugin-template.js` | 修改 | 模板版本升至 2；增加活动会话状态与会话事件处理 |
| `test/opencode-hook-installer.test.js` | 修改 | 更新版本断言并增加滞后 route 的运行级回归测试 |

## 自测情况

- [x] `npm test`：639 项通过，0 项失败；证据见 `evidence/verification.log`
- [x] `node --test test/opencode-hook-installer.test.js`：15 项通过，0 项失败；证据见 `evidence/target-test.log`
- [x] `git diff --check`：退出码 0
- [x] REQ-001 至 REQ-005 与非目标范围已完成 Drift Check
- [x] CodeGraph 已用于当前源码、调用方和影响范围预审查
- [ ] 真实飞书与交互式 OpenCode TUI 人工 E2E 未执行
- [ ] 变更尚未提交；未在未经用户要求的情况下创建 commit

## 审查重点

- [ ] `selectSession` 与正在运行的 `tick` 并发时，下一轮是否稳定使用最新活动会话
- [ ] `session.idle` 和 `session.error` 是否仅归属活动会话或仍有 delivery 的旧会话
- [ ] `session.created` 的根会话判定是否兼容 OpenCode 1.17.20 事件字段
- [ ] 模板版本升级与 installer 幂等行为
- [ ] REQ-005 是否需要把升级测试夹具从版本 0 精确改为版本 1

## 已知限制

- 本机 `verify-artifacts.mjs` 缺少其依赖的 `artifact-checker.js`，无法启动；必需产物、占位符、测试结论和证据收据已手工核验并记录在 `verify-report.md`。
- 工作树包含其他既存改动，本次审查不包含这些文件，也未对其进行回退或修改。
