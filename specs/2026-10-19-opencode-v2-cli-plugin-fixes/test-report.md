# 测试报告

## 结论

模拟回归、lint 和全量检查通过。隔离的 OpenCode v2.0.32 已执行安装器注册的 V2 包目录入口。真实飞书往返未验证，不记为通过。

布局修正：官方探针先证明裸 `walker-tui-plugin.js` 文件 URL 不会被 v2.0.32 执行。安装器随后改为注册含 `tui.js` 的包目录，并重新取证。这是为满足真实加载所做的修正，不是把失败探针改写成成功。

## 证据范围

| 范围 | 结果 | 能否当成另一项的成功 |
| --- | --- | --- |
| 模拟测试 | 通过 | 不能代替真实 CLI 或真实飞书 |
| 真实 V2 CLI 加载 | 入口已执行 | 不能代替飞书往返；也未观察到 `/register` 或 `/poll` |
| 真实飞书往返 | 未验证 | 不得写成通过 |

## 修复前失败

known-warning: 下面 2 项是修复前预先存在的 red 证据，不是当前回归结果。当前定向测试、lint 和全量检查均已通过。

命令与输出见 `red-evidence.md`。

- 命令：`node --test --test-name-pattern "完成事件早于新回复进入缓存时不发送旧回复|隐藏字段位于首中尾时按序号回填会错位" test/opencode-v2-cli-plugin.test.js`
- 退出码：`1`
- 结果：2 项测试，0 通过，2 失败
- 失败点：完成事件发送了旧回复；隐藏字段穿插时表单按序号错位

## 回归命令

| 命令 | 退出码 | 结果 | 证据 |
| --- | --- | --- | --- |
| `node --test test/opencode-v2-cli-plugin.test.js test/opencode-hook-installer.test.js test/opencode-plugin-template.test.js test/integration-feishu-question.test.js` | 0 | 98 通过，0 失败 | `evidence/T2-node-test.log` |
| `npm run lint` | 0 | ESLint 无报告 | `evidence/T2-lint.log` |
| `npm run check` | 0 | 1598 通过，0 失败 | `evidence/T2-check.log` |

定向测试覆盖 REQ-001 到 REQ-005 的模拟行为，以及 REQ-006 的回归部分。`integration-feishu-question.test.js` 只证明模拟飞书问答，不是真实飞书往返。

## 真实 CLI 加载

### 修正前诊断

本机 `opencode v2.0.32` 在隔离配置中注册了 `walker-tui-plugin.js` 的文件 URL。15 秒内没有 `/opencode/tui-bridge/register` 或 `/poll`，日志只完成 12 个内置插件对账，阶段为 `entry-not-executed`。该次完整 JSON 未落盘，因此不作为验收哈希证据。

同版本对照实验显示：`cli.json` 指向含 `tui.js` 的目录时，CLI 会读取 `tui.js` 并执行 `stage=setup`。该实验不是安装器产物，只用于定位失败原因。

### 修正后验收探针

- 命令：`node specs/2026-10-19-opencode-v2-cli-plugin-fixes/probe-opencode-v2-cli-load.mjs`
- 探针退出码：`0`
- CLI：`opencode v2.0.32`，`--version` 退出码 `0`
- 启动参数：`--standalone --print-logs --log-level trace`
- 探针阶段：`loaded`
- 证明方式：`cli-setup-log`
- 注册目标：临时配置中的 `walker-tui-plugin` 目录 URL
- 入口：该目录下的 `tui.js`
- 关键日志：`stage=setup plugin=walker-tui-bridge`，目标为上述包目录
- 子进程退出码：`1`。这是取到证据后 `taskkill /T /F` 的结果，不是导入失败。
- `/register` 与 `/poll`：未观察到。隔离启动没有会话，`setup` 后的轮询不会发出这些请求。不能把这一点写成桥接已连通。
- 证据：`evidence/T2-cli-load.json`

探针使用临时 `XDG_CONFIG_HOME`、`HOME` 和 `USERPROFILE`，并删除 `OPENCODE_SERVER_URL`。没有读取或修改用户主目录配置。摘要中的 `probe-` 只来自临时目录名，不是 Walker 令牌。

## 真实飞书往返

进程环境中的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN`、`FEISHU_ENCRYPT_KEY` 均未设置。仓库存在 `.env`，但本次没有读取它，也没有用其中的凭据发起飞书请求。

真实飞书往返未验证。

## 需求覆盖

| Requirement | 结果 | 说明 |
| --- | --- | --- |
| REQ-001 | 模拟通过 | 定向测试与全量检查覆盖回复竞态和恢复 |
| REQ-002 | 模拟通过；真实入口已加载 | V2 `setup` 已执行；真实 `/register` 未观察到 |
| REQ-003 | 模拟通过 | 表单回填由定向测试覆盖 |
| REQ-004 | 模拟通过 | 安装器测试覆盖配置保护；真实 CLI 使用隔离配置 |
| REQ-005 | 模拟通过 | 日志脱敏由定向测试覆盖；本报告不记录正文或凭据 |
| REQ-006 | 记录完成 | 回归、真实加载和未验证项分开记录 |

## 行为结果

| Behavior | 结果 | 证据 |
| --- | --- | --- |
| REQ-006-B01 | PASS | 上表三条回归命令及 `red-evidence.md` |
| REQ-006-B02 | PASS | `evidence/T2-cli-load.json` 的 setup 日志 |
| REQ-006-B03 | PASS | 本报告明确区分模拟往返与未验证的真实往返 |
| REQ-006-B04 | PASS | 修正前入口未执行已记录；无安全飞书认证，未声称真实往返通过 |

## Evidence Receipt

- evidence-command: `node --test test/opencode-v2-cli-plugin.test.js test/opencode-hook-installer.test.js test/opencode-plugin-template.test.js test/integration-feishu-question.test.js`
- evidence-exit-code: `0`
- evidence-file: `evidence/T2-node-test.log`
- evidence-sha256: `b12b15cfee93dd43b96823969d7eb93e354220acca18861f90b8963bb0aa4713`

- evidence-command: `npm run lint`
- evidence-exit-code: `0`
- evidence-file: `evidence/T2-lint.log`
- evidence-sha256: `db109dbf42d030a230ebfd971b09c768893f1ad272205ccec27be0d2cc393a32`

- evidence-command: `npm run check`
- evidence-exit-code: `0`
- evidence-file: `evidence/T2-check.log`
- evidence-sha256: `22b8e35fb970f42fbdd7e93a7dc8307d1097d850931a60ceba5e19ef45d30d5e`

- evidence-command: `node specs/2026-10-19-opencode-v2-cli-plugin-fixes/probe-opencode-v2-cli-load.mjs`
- evidence-exit-code: `0`
- evidence-file: `evidence/T2-cli-load.json`
- evidence-sha256: `079f2dbe2828ebaa91274cb7ca619b5925d54762d873c7ee28314d3c911a3c31`
- evidence-git-tree: 5c03c9f99a0d3d3fa78cce4fb6a0bf841b9e412d
- evidence-diff-sha256: 079039bcc735a348e6a32674abaf85f444a813d154f2505961d3ac196fc883de

verdict: PASS
