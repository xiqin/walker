# V2 飞书真实会话标题修复验证

## 结论

2026-11-18：最终代码完整隔离检查及合并前复跑通过，1585 项测试通过、失败 0、取消 0；包含 ESLint 和语法检查。按用户明确确认跳过流水线，本报告不表示流水线审批或状态门禁通过。

## 修复范围

- 插件版本 21，通过所属 TUI 的 `api.data.session.get(sessionId)` 获取明确会话的标题；注册、事件和清空关联注册携带标题元数据。协议版本仍为 5。
- Bridge 按 runtime、会话及标题 ID 校验内存快照，事件通知前更新；不持久化真实标题。清空关联注册先暂存，待 control/register 汇合后更新，兼容两种到达顺序。
- V2 标题缺失返回空，不查询旧 SQLite 表或默认 HTTP 服务；旧版本无标题元数据时保留 SQLite 兼容路径。
- 未修改调度器原有两秒预算、缓存容量/TTL、销毁保护或非焦点正文标记。

## 证据

命令前缀：`node specs/2026-11-18-feishu-v2-session-title/evidence/run-isolated.cjs`。日志路径相对此目录；所有运行均使用全新日志及隔离用户目录，不启动真实服务。

| 命令参数 | 退出码 | 结果与日志 |
| --- | --- | --- |
| `probe …/baseline.log` | 1 | 修复前标题为空、SQLite 读取 1 次；`evidence/baseline.log` |
| `probe …/fixed-02.log` | 0 | 同一探针期待值不变，返回真实标题、SQLite 读取 0 次；`evidence/fixed-02.log` |
| `focused …/focused-02.log` | 0 | 定向 588 项通过（清空时序补强前）；`evidence/focused-02.log` |
| `full …/full-02.log` | 0 | 最终代码 1585 项通过，包含清空两种到达顺序；`evidence/full-02.log` |
| `full …/pre-merge.log` | 1 | 1584 项通过；旧插件测试清理临时目录时出现 Windows `ENOTEMPTY`，堆栈位于 `test/opencode-v2-cli-plugin.test.js:1051`，不是业务断言失败 |
| `full …/pre-merge-02.log` | 0 | 未修改实现或测试，再次全新隔离运行，1585 项全部通过 |

历史首轮 `evidence/focused.log` 保留：4 项跨层测试因直接修改 JSON 存储读出副本而缺少模型/上下文失败。夹具现通过正式模型更新接口、插件 `session.step.ended` 用量事件提供数据，原模型、上下文及标题断言未放宽。`evidence/full-01.log` 等中间结果亦保留。

SHA-256：

- `baseline.log`：`50747203B468CD39AFC6EABE854A13274716F82063DB66B6CE4A9323D4E24A0D`
- `fixed-02.log`：`61FB43CECB77157B67D6986B41A765E6D85C4E4C42161D5B608B3E4CDA6D4552`
- `focused-02.log`：`4AA25E49370A7C9BEE83F2E8EDA3E643D4D64BA76EB76218E1AE37F636B12312`
- `full-02.log`：`8A3658F3284166F5323551C89673A8477A81A97D7A1B0A1977F2B4813E06B69F`
- `pre-merge.log`：`470C41324DBE56323504AC098C1AC7994C838DB39622DA57A29D2A5213E4834D`
- `pre-merge-02.log`：`CAD247FCE9DF0ED671DF73F981FA2D0AF9241B78F9F4703FFD6A8AB69A3A70A0`

附加检查：`git diff --check` 退出 0；`codegraph sync` 退出 0，索引已同步。

## 能力与限制

- 跨层测试使用真实插件生成源码、Bridge、驱动、调度器和飞书请求体组装；覆盖同聊天、同 OpenCode ID 不同 runtime、非焦点并发输出及标题更新。请求拦截在 Bridge 动作入口，不能据此声称验证了 HTTP 认证中间件。
- 错配 ID、缓存读取抛错、空标题均为合成故障；验证正文、模型、上下文保留，不泄漏其他标题，也不查询 SQLite 或默认服务。
- Bridge 测试覆盖事件更新顺序、无持久化标题副作用、外来广播、会话切换、dispose 和旧版兼容；清空测试覆盖 control/register 两种汇合顺序。有限资源清理观察不代表长期无泄漏。
- 验证时未进一步查询用户数据库，未部署或重启。后续用户已授权提交并合并到本地 `main`；不含推送、部署或重启授权。当前运行中的 Walker/插件未更新，不能据此宣称实机页脚已恢复；实机生效与验收仍需单独授权。
