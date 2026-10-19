# 代码审查请求

**功能：** OpenCode V2 终端桥接插件可靠性修复
**分支：** feature/2026-10-19-opencode-v2-cli-plugin-fixes
**固定点：** `HEAD` 到当前工作树中本次插件相关文件的 diff
**范围说明：** 只审查 `src/opencode-hook/installer.js`、`src/opencode-hook/plugin-template.js`、对应测试，以及 `specs/2026-10-19-opencode-v2-cli-plugin-fixes/`。工作区里的 HTTP/SSE 驱动、`health-poller.js` 的 `/api/info` 改动、CHANGELOG 和其他未归属文件是原有未提交改动，不属于本次审查。

## Standards

- 无 blocker。V2 入口只调用真实 `Plugin.define`，导入失败不会改走伪定义或 V1 入口。安装器对非法 `cli.json` 和非数组 `plugins` 直接返回错误，不覆盖原文件。写入使用临时文件和失败回滚。
- 安装日志和插件 `bridgeLog` 只记录路径、端口、delivery 元数据。令牌、飞书密钥和消息正文没有进入这些日志。
- 残余风险：`installHookPlugin` 及一批安装辅助函数没有函数注释，和宪章的注释要求不一致。行为已有测试，不阻断审查。
- 残余风险：`isWalkerOwned`、`commitWrites` 没有直接单测，覆盖来自安装器行为测试。

## Spec

- 无 blocker。实现对应 `spec.md` 的 REQ-001 至 REQ-006。
- REQ-001：基线读取失败时记录 `startedAt`，完成事件只采纳不早于该时间的助手消息；上报失败不提前删除当前 delivery。
- REQ-002：V2 入口是包目录里的 `tui.js`，V1 入口仍是独立文件并复用同一个 `setup`。
- REQ-003：可见字段按 `key` 回填；隐藏字段不占位；数值保持数字，非法值返回错误而不是假装成功。
- REQ-004：显式 `opencodeConfigDir` 优先于 `XDG_CONFIG_HOME` 和 `~/.config/opencode`；其他插件保留。
- REQ-005：日志脱敏由安装器和 `bridgeLog` 实现。
- REQ-006：模拟回归、lint、全量检查和隔离 CLI 的 `setup` 已取证。真实 `/register`、`/poll` 未观察到，真实飞书往返未验证，报告没有把它们写成通过。
- 本次插件文件没有改 `OPENCODE_SERVER_URL` 或 HTTP/SSE 驱动，符合非目标。

## Spec 遗漏自审

- 检查条目: 6 个 REQ、25 个 behavior
- 遗漏: 无
- omission-hunter: pass，blocker_count 为 0

## 预审查摘要

- Standards findings: 0 blocker，worst: none
- Spec findings: 0 blocker，worst: none
- Spec 遗漏: 0，worst: none

## 变更统计

```text
 src/opencode-hook/installer.js           | 301 ++++++++++++--
 src/opencode-hook/plugin-template.js     | 665 ++++++++++++++++++++++++++-----
 test/integration-feishu-question.test.js |  12 +-
 test/opencode-hook-installer.test.js     | 427 ++++++++++++++++++--
 test/opencode-plugin-template.test.js    |  32 +-
 5 files changed, 1247 insertions(+), 190 deletions(-)
```

另有未跟踪文件 `test/opencode-v2-cli-plugin.test.js` 和本规格目录。`specs/2026-10-19-opencode-v2-cli-plugin-fixes/` 不计入上面的源码统计。

## 主要变更

1. 安装器把 V2 插件注册成 `walker-tui-plugin/` 包目录，入口是其中的 `tui.js`。v2.0.32 不执行裸 JS 文件 URL。
2. 共享桥接仍写 `walker-tui-bridge.js`。V1 入口写 `walker-tui-plugin-v1.js`，不作为 V2 导入失败的回退。
3. 旧的裸 `walker-tui-plugin.js` 只在确认是 Walker 生成物时删除。
4. 回复完成前先取助手消息基线；基线失败时用 `startedAt` 过滤旧回复。
5. 表单答案按可见字段键构造 `Form.Answer`，并保留布尔、数值和多选类型。
6. 定向测试、安装器测试和隔离 CLI 探针覆盖上述行为。

## 自测情况

- [x] 宪章未声明 BUILD_CMD。等价检查 `npm run check` 退出码 0，1598 项通过。
- [x] 宪章未声明 VET_CMD。等价检查 `npm run lint` 退出码 0。
- [x] 定向 `node --test` 退出码 0，98 项通过。
- [x] 图后端 codegraph 已查询安装器、V2/V1 入口和桥接符号。本阶段没有改产品代码，未执行图索引同步。
- [x] Spec 遗漏自审通过。
- [ ] 变更尚未提交。用户要求未经明确指示不提交，本请求基于工作树 diff。

## 变更详情

| 文件 | 变更类型 | 说明 |
| ---- | -------- | ---- |
| `src/opencode-hook/installer.js` | 修改 | 包目录注册、配置保护、原子写入、旧入口清理和日志脱敏。 |
| `src/opencode-hook/plugin-template.js` | 修改 | 桥接版本 18、双入口、回复基线、表单回填和运行日志字段限制。 |
| `test/opencode-v2-cli-plugin.test.js` | 新增 | 回复竞态、双入口、表单和协议回归。 |
| `test/opencode-hook-installer.test.js` | 修改 | 包目录、非法配置、非 Walker 文件保留。 |
| `test/opencode-plugin-template.test.js` | 修改 | 模板入口和清单。 |
| `test/integration-feishu-question.test.js` | 修改 | 飞书提问模拟回归。 |
| `specs/2026-10-19-opencode-v2-cli-plugin-fixes/` | 新增 | 规格、计划、证据、测试报告和验证报告。 |

## 审查重点

- [ ] `tui.js` 使用相对路径 `../walker-tui-bridge.js`，包目录被移动或改名后是否仍能加载。
- [ ] `isWalkerOwned` 是否只会替换带 Walker 标记或完整 V2 入口特征的文件，不会误删同名第三方插件。
- [ ] 条件字段用字段 `default` 判断 `when`，而不是用用户刚提交的值；这是否符合 V2 表单契约。
- [ ] 无会话的 headless CLI 不会进入 `/register` 和 `/poll`。这已记录为未观察到，不应在审查中补写成桥接连通。
- [ ] 真实飞书往返仍未验证。

## 证据路径

- `specs/2026-10-19-opencode-v2-cli-plugin-fixes/test-report.md`
- `specs/2026-10-19-opencode-v2-cli-plugin-fixes/verify-report.md`
- `specs/2026-10-19-opencode-v2-cli-plugin-fixes/evidence/T2-cli-load.json`
- `specs/2026-10-19-opencode-v2-cli-plugin-fixes/evidence/T2-node-test.log`
- `specs/2026-10-19-opencode-v2-cli-plugin-fixes/findings/omission-hunter.json`
