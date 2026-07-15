# 代码审查请求

**功能：** 飞书 /clear 命令 — 在当前 TUI 内创建空上下文并切换焦点
**分支：** 当前工作分支（未提交，工作区变更）
**Fixed point：** HEAD (8ec1572)

## 变更统计

```
 .loom/compliance/history.json            |  12 +
 README.md                                |   1 +
 src/dispatch/message-dispatcher.js       |  84 +++-
 src/drivers/opencode-driver.js           |  19 +
 src/opencode-hook/plugin-template.js     | 186 ++++++++-
 src/opencode-tui-bridge/bridge.js        | 263 +++++++++++-
 src/platform/feishu/commands.js          |   1 +
 test/feishu-commands.test.js             |  21 +
 test/integration-feishu-tui-sync.test.js | 471 +++++++++++++++++++++
 test/message-dispatcher.test.js          | 326 +++++++++++++++
 test/opencode-driver.test.js             |  66 +++
 test/opencode-hook-installer.test.js     | 678 ++++++++++++++++++++++++++++++-
 test/opencode-tui-bridge.test.js         | 425 +++++++++++++++++++
 13 files changed, 2532 insertions(+), 21 deletions(-)
```

## 主要变更

1. **Bridge clear 协议与汇合状态机**（`src/opencode-tui-bridge/bridge.js`）：prompt delivery 增加 `type:'prompt'`；新增 `clearSession` 投递 clear delivery；同 runtime 并发 clear 拒绝；带 `controlDeliveryId` 的 register 仅暂存元数据（不创建 Walker session、不改 currentSessionId、不设焦点）；单一完成函数 `_tryCompleteClear` 原子提交（control result 与关联 register 任意顺序汇合）；超时/cancel/dispose/close 清理 pending；迟到 control/register 不提交。
2. **Driver 委托**（`src/drivers/opencode-driver.js`）：`clearSession` 仅委托 TUI bridge，拒绝非 TUI ref，不调用 HTTP create 或 openTerminal。
3. **TUI 插件 clear 控制**（`src/opencode-hook/plugin-template.js`）：版本 3→4；`extractSessionId` 支持 4 种 SDK 返回形态；`executeDelivery` 按 type 分派；`executeClearDelivery` 实现 create→navigate→关联 register+control 上报→更新/回滚全流程；create 前缓冲 `session.created`/`tui.session.select`；抑制新 ID 自动注册；失败最佳努力回滚+手工切回提示。
4. **飞书命令与调度**（`src/platform/feishu/commands.js`、`src/dispatch/message-dispatcher.js`）：COMMANDS 增加 `/clear`，formatHelp 自动包含；`_preflightClear` 锁外快速检查（无绑定/running/turn/prompt queue）立即回复；`_cmdClear` 锁内重新读取 current 并完整复检；仅调用 `driver.clearSession`；成功回复旧新 Walker session ID；不调用 createSession/openTerminal/stop/delete/updateConfig。
5. **测试**：6 个测试文件共新增约 2000 行测试，覆盖 REQ-001..010 全部场景。
6. **文档**（`README.md`）：命令表新增 `/clear` 说明。

## 重点关注

1. **并发与竞态**：clear pending 的两阶段提交（control result + 关联 register 汇合）是否在所有路径下正确清理（成功/超时/cancel/dispose/close/迟到事件）。
2. **焦点不变性**：失败或超时是否保证旧 route 焦点不被切换；普通 register/手工切换是否会误完成 clear。
3. **非目标边界**：`/new` 行为是否完全未改；旧 session 是否保留（不 stop/delete/移出 route）；是否不修改全局配置、不打开新终端。

## 自测情况

- [x] 编译通过（`npm test` 内含 `node --check` 全量语法检查）
- [x] 静态分析通过（同上，项目无独立 VET_CMD）
- [x] 测试通过（`npm test` 710/710 pass / 0 fail / 0 skipped）
- [x] 代码符合编码红线（无占位符、无调试语句残留、无硬编码密钥）
- [x] 图后端索引查询跳过（未启用图后端）

## 变更详情

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/opencode-tui-bridge/bridge.js` | 修改 | clear delivery 投递、pending 汇合状态机、原子提交、超时清理、模型继承 |
| `src/drivers/opencode-driver.js` | 修改 | 新增 `clearSession()` 委托 bridge，拒绝非 TUI |
| `src/opencode-hook/plugin-template.js` | 修改 | 版本 4，clear 控制全流程，事件缓冲，自动注册抑制，回滚 |
| `src/platform/feishu/commands.js` | 修改 | COMMANDS 增加 /clear |
| `src/dispatch/message-dispatcher.js` | 修改 | `_preflightClear` 锁外检查，`_cmdClear` 锁内复检与执行 |
| `test/opencode-tui-bridge.test.js` | 修改 | 13 个 clear 单元测试 |
| `test/opencode-driver.test.js` | 修改 | 3 个委托测试 |
| `test/opencode-hook-installer.test.js` | 修改 | 13 个插件 clear 测试 |
| `test/feishu-commands.test.js` | 修改 | /clear 解析与帮助文本测试 |
| `test/message-dispatcher.test.js` | 修改 | 13 个 dispatcher 测试 |
| `test/integration-feishu-tui-sync.test.js` | 修改 | 21 个跨层集成测试 |
| `README.md` | 修改 | 命令表新增 /clear |
| `.loom/compliance/history.json` | 修改 | loom 合规记录自动更新 |

## 审查重点

- [ ] 架构合规性（bridge→driver→dispatcher→plugin 分层）
- [ ] 代码质量（命名、错误处理、清理路径完备性）
- [ ] 安全性检查（无注入、无信息泄露、跨 runtime 篡改防护）
- [ ] 性能影响（pending O(1) 查找、timer unref、无内存泄漏）
- [ ] Spec 合规（REQ-001..010 全部满足、非目标范围未越界）

## 预审查结果

### Standards

- W1：T2 `executeClearDelivery` 关联 register 与 control 为顺序 await 发送而非并发（bridge 支持任意顺序到达，功能不受影响）
- W2：`executeClearDelivery` 失败路径少量重复代码可抽取为 helper

### Spec

- 无发现。REQ-001..010 全部满足；非目标范围确认（`/new` 未改、旧 session 不删除/停止/移出、不修改全局配置、不打开新终端）

### 预审查摘要

- Standards findings: 2，worst: warning
- Spec findings: 0，worst: none
