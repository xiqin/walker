# 测试报告

Verdict: PASS

## Evidence receipt：调度器测试

- evidence-command: `node --test test/message-dispatcher.test.js`
- evidence-exit-code: 0
- evidence-file: `evidence/T1-node-test.log`
- evidence-sha256: 78E6F51FCD5C7BCA72018DEB7BAE8D05FD1ABC6FBE9F732DB6D6495FC9FA18BC
- evidence-git-tree: 9d4b2baec9f9477ea95c30684526680c0afe77d6
- evidence-diff-sha256: f2ae714f318a6d76bfdaed020f382fc51cbf3ca8b6232d72302838c47f9c463b

## Evidence receipt：全量回归

- evidence-command: `npm test`
- evidence-exit-code: 0
- evidence-file: `evidence/T1-npm-test.log`
- evidence-sha256: CD52880FD902A01016D11D7A69AAA3A6A9B1DF313E79101EE78E87C965C14DA8

## 结论

REQ-001、REQ-002 的九个行为义务已由调度器测试覆盖。不同会话在同一生效路由上可独立完成；同会话保持串行；路由命令锁仍保护入队顺序。未连接真实飞书或 Agent 运行时，本次仅验证调度器及仓库自动化测试。

## Evidence receipt

| 命令 | 退出码 | 结果 | 证据 |
| --- | --- | --- | --- |
| `node --check src/dispatch/message-dispatcher.js` | 0 | 语法检查通过 | 本报告 |
| `node --test test/message-dispatcher.test.js` | 0 | 223 通过、0 异常 | `evidence/T1-node-test.log` |
| `npm test` | 0 | ESLint 通过、全量 1511 通过、0 异常 | `evidence/T1-npm-test.log` |

## 行为覆盖

| 需求与行为 | 验证场景 | 证据 |
| --- | --- | --- |
| REQ-001-B01、REQ-001-B02、REQ-001-B03 | 同一路由的引用消息 A 与焦点消息 B 各自携带正确会话和文本；A 未完成时 B 已完成，路由锁已释放 | `evidence/T1-node-test.log` |
| REQ-001-B04 | A 延迟报错时 B 独立成功，各自返回 `error` / `prompted` | `evidence/T1-node-test.log` |
| REQ-002-B01、REQ-002-B03 | A1 报错前 A2 不启动；报错后 A2 正常启动并返回，两个调用不提前完成 | `evidence/T1-node-test.log` |
| REQ-002-B02 | 引用消息使用生效路由键；命令持锁期间引用消息不能入队 | `evidence/T1-node-test.log` |
| REQ-002-B04 | 消息与命令双向排序：命令持锁阻止后续消息入队，已入队消息使随后 `/new` 等待；同会话不重叠 | `evidence/T1-node-test.log` |
| REQ-002-B05 | 同会话两条成功消息依次启动，分别在自身完成后返回 `prompted` | `evidence/T1-node-test.log` |

没有新增公共接口、构造参数或抽象；`_enqueuePrompt` 和命令锁的实现未改动。未覆盖真实飞书、真实 TUI 并发限制（不属于调度器验收范围）。
