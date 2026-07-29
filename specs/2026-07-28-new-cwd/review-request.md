# 代码审查请求

**功能：** `/new` 支持 `--cwd <path>` 指定项目工作目录
**Fixed point：** `HEAD`，审查当前未提交 diff
**流水线阶段：** `code-review-request`
**规格来源：** `specs/2026-07-28-new-cwd/spec.md`

## Standards

- 无发现。实现集中在现有 `MessageDispatcher._cmdNew` 与飞书命令定义中，没有新增抽象层或跨模块副作用；错误路径复用现有 `sendErrorCard` 方式，保持现有命令解析器空白切分策略。

## Spec

- 无发现。实现满足 `REQ-001`、`REQ-002`、`REQ-003`：显式 `--cwd` 会传给 driver 与 Walker session；未提供时保持 `defaultCwd`；第三个裸参数不作为 cwd；缺少 cwd 值时不创建或绑定新 session；帮助、README、调试页已同步展示新语法。

## 预审查摘要

- Standards findings: 0，worst: none
- Spec findings: 0，worst: none
- 变更未提交：当前审查请求用于未提交工作树，尚未执行 git commit。

## 变更统计

`git diff --stat` 针对已跟踪文件：

```text
.loom/compliance/history.json      |  16 ++++
README.md                          |   2 +-
src/dispatch/message-dispatcher.js |  23 ++++-
src/platform/feishu/commands.js    |   2 +-
test/feishu-commands.test.js       |  13 +++
test/message-dispatcher.test.js    | 168 +++++++++++++++++++++++++++++++++++++
walker-console-v2.html             |   2 +-
7 files changed, 219 insertions(+), 7 deletions(-)
```

新增规格与证据目录：`specs/2026-07-28-new-cwd/`。

## 主要变更

1. `src/dispatch/message-dispatcher.js`：在 `_cmdNew` 中解析 `/new` 专属 `--cwd <path>`，移除该选项后继续按原位置参数解析 `agent/title`。
2. `src/dispatch/message-dispatcher.js`：缺少 `--cwd` 值时返回错误卡片并提前结束，不调用 driver 或 `sessionService.createSession`。
3. `src/platform/feishu/commands.js`、`README.md`、`walker-console-v2.html`：同步 `/new [agent] [title] [--cwd <path>]` 用法。
4. `test/message-dispatcher.test.js`、`test/feishu-commands.test.js`：新增 cwd 传递、默认兼容、裸参数非 cwd、缺值错误、帮助文本相关测试。
5. `specs/2026-07-28-new-cwd/`：新增 spec、plan、tasks、traceability、test-report、verify-report、evidence logs 与 handoffs。

## 重点关注

1. `src/dispatch/message-dispatcher.js:496` 到 `src/dispatch/message-dispatcher.js:512`：`--cwd` 选项消费逻辑是否符合“多次使用最后一次、缺值报错、第三裸参数不作为 cwd”的约定。
2. `src/dispatch/message-dispatcher.js:522` 到 `src/dispatch/message-dispatcher.js:529`：同一个 cwd 是否正确传给 `driver.createSession` 与 `sessionService.createSession`。
3. `test/message-dispatcher.test.js`：新增 5 个 `/new --cwd` 行为测试是否过度依赖 mock 实现，是否仍能代表真实业务行为。
4. `README.md:187`、`walker-console-v2.html:792`、`src/platform/feishu/commands.js:3`：用户可见语法是否一致。

## 自测情况

- [x] 目标测试通过：`node --test test\message-dispatcher.test.js test\feishu-commands.test.js`，201/201，通过日志 `specs/2026-07-28-new-cwd/evidence/verification-targeted-tests.log`，sha256 `c146ae0fcbd36622a5fbba183875d7a2b5e93e66e7b13466dfbd1259d5877e42`。
- [x] 全量测试通过：`npm test`，1205/1205，通过日志 `specs/2026-07-28-new-cwd/evidence/verification-npm-test-rerun.log`，sha256 `a0718c4c8daebb1f6b2dfc20656fb698d671090e4ba88297884e2d58bce38755`。
- [x] 首次全量测试瞬时失败复核通过：`node --test test\opencode-hook-installer.test.js`，49/49，通过日志 `specs/2026-07-28-new-cwd/evidence/verification-known-failing-opencode-hook-installer.log`，sha256 `f4b552eb3922243b5a220d3eb1899b9b88baa9e9944e0219b575af03c5fc9ce9`。
- [x] 任务冲突校验通过：`loom tasks --spec-dir "specs/2026-07-28-new-cwd" --validate`。
- [x] 图后端同步跳过：未找到 `.loom/graph.config.json`。
- [x] artifact verifier 未运行成功：本地 skill 安装缺失 `C:\Users\tianxiqin\.config\opencode\src\core\artifact-checker.js`，已记录在 `verify-report.md`。

## 变更详情

| 文件 | 变更类型 | 说明 |
| ---- | -------- | ---- |
| `src/dispatch/message-dispatcher.js` | 修改 | `_cmdNew` 解析显式 `--cwd`，缺值报错，创建 session 时使用选定 cwd。 |
| `src/platform/feishu/commands.js` | 修改 | 更新 `/new` usage，驱动 `/help` 展示新语法。 |
| `test/message-dispatcher.test.js` | 修改 | 覆盖 cwd 传递、默认 cwd、裸参数非 cwd、缺值错误与绑定不变。 |
| `test/feishu-commands.test.js` | 修改 | 覆盖 token 透传、usage 与 formatHelp。 |
| `README.md` | 修改 | 更新飞书命令表。 |
| `walker-console-v2.html` | 修改 | 更新调试页命令参考。 |
| `.loom/compliance/history.json` | 修改 | loom 验证门禁记录了一次机械扫描误判上下文。 |
| `specs/2026-07-28-new-cwd/` | 新增 | 规格、计划、任务、追踪账本、测试报告、验证报告、证据日志与 handoff。 |

## 审查重点

- [ ] 架构合规性：是否应继续把 `/new` 专属解析放在 dispatcher，而不是扩展通用 `parseCommand`。
- [ ] 代码质量：`--cwd` 解析是否足够清晰且不影响 agent/title 兼容语义。
- [ ] 行为覆盖：测试是否覆盖所有已声明 requirement behavior。
- [ ] 用户体验：缺值错误文案和帮助语法是否足够明确。

## 残余风险

- 首次全量 `npm test` 曾在未触及的 `test/opencode-hook-installer.test.js` 出现一次时序失败；单独重跑该文件与第二次全量均通过，已在 `verify-report.md` 记录为非阻断残余风险。
- 当前变更尚未提交；如果审查流程要求 commit 后审查，需要先由用户确认提交策略。
