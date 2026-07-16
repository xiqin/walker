# 飞书消息与指令交互增强测试报告

## 结论

- Verdict：PASS
- 集成检查：PASS
- 回归测试：PASS
- Spec 验证：PASS
- 生产代码修改：无
- 测试文件修改：无；现有单元/集成测试已覆盖 REQ-001 至 REQ-007，无需新增测试。

## 执行证据

- 命令：`npm run check`
- 日志：`specs/2026-07-16-feishu-message-interactions/evidence/test.log`
- SHA-256：`DBAAE7BFDA92354BF012220054DC4820A6BABA84946CB0DC34C526D5B8C1C570`
- 结果摘要：743 tests passed, 0 failed, 49 suites, duration_ms 8349.1061

## Spec 覆盖核对

| Requirement | 覆盖来源 | 覆盖判断 |
| -- | -- | -- |
| REQ-001：普通 Agent 最终文本底部包含 `模型：...` footer，解析不到模型时显示 `未指定`。 | `handoffs/T3.json`；`test/message-dispatcher.test.js` 覆盖模型 footer。 | PASS |
| REQ-002：`/model` 无参数返回模型卡片，支持 Recent 最多 5 个、总按钮最多 20 个、超限提示。 | `handoffs/T2.json`、`handoffs/T3.json`；`test/feishu-cards.test.js` 覆盖 `renderModelListCard`、Recent、过滤和超限提示；`test/message-dispatcher.test.js` 覆盖 dispatcher 卡片发送。 | PASS |
| REQ-003：模型按钮 action 可回流为 `/model <provider>/<id>`，点击后更新当前会话 `model` 字段。 | `handoffs/T3.json`；`test/message-dispatcher.test.js` 覆盖按钮命令路径与 session model 更新；现有飞书事件测试覆盖卡片 action/routeKey 解析。 | PASS |
| REQ-004：`/help` 返回命令帮助卡片，包含 `/new`、`/attach`、`/list`、`/model` 等命令按钮。 | `handoffs/T2.json`、`handoffs/T3.json`；`test/feishu-cards.test.js` 覆盖 `renderHelpCard` 与关键命令按钮；`test/message-dispatcher.test.js` 覆盖 `/help` 卡片优先。 | PASS |
| REQ-005：dispatcher 通过当前 agent driver 获取统一模型目录；OpencodeDriver 输出统一模型视图并映射 OpenCode Recent。 | `handoffs/T1.json`、`handoffs/T3.json`；`test/opencode-driver.test.js` 覆盖统一模型视图与 Recent 映射；`test/message-dispatcher.test.js` 覆盖当前 session agent driver 取模型列表且不固定回退 OpenCode。 | PASS |
| REQ-006：同一卡片点击不同模型按钮不能被 `messageId + name` 去重误判。 | `handoffs/T3.json`；`test/message-dispatcher.test.js` 覆盖去重 key 纳入命令参数。 | PASS |
| REQ-007：保持已有纯文本命令解析与无卡片能力 fallback 行为。 | `handoffs/T2.json`、`handoffs/T3.json`；`test/feishu-commands.test.js` 覆盖纯文本命令解析；`test/message-dispatcher.test.js` 覆盖无卡片能力 fallback。 | PASS |

## Handoff 核对

- T1：PASS。`AgentDriver.listModels()` 默认不支持契约、`OpencodeDriver.listModels()` 统一模型视图和 Recent 映射已有测试覆盖。
- T2：PASS。模型列表卡片、帮助卡片、命令元数据导出、bootstrap 发送能力已有测试覆盖。
- T3：PASS。dispatcher 模型列表接入、卡片优先/fallback、模型 footer、参数化 dedup 已有测试覆盖。

## FAIL 修复指令

无 FAIL，无需修复指令。
