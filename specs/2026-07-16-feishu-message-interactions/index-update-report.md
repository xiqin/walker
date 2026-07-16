# 索引更新报告

**时间：** 2026-07-16
**触发原因：** 飞书消息模型 footer、`/model` 模型选择卡片、`/help` 命令卡片功能完成并通过验证
**索引方式：** codegraph（路径 A，实时查询）

## codegraph 状态

- 已执行 `loom index`：codegraph 后端同步完成，结果为 `Already up to date`。
- 已执行 `loom index --check`：索引状态为 `[OK] Index is up to date`。
- 索引统计：88 files、991 nodes、5,537 edges、DB size 6.33 MB。

## 结构化 Memory 更新

- 已新增决策：飞书模型交互增强采用统一 agent 模型视图，`driver.listModels()` 输出 `id/name/provider/status/enabled/source/groups/lastUsedAt`，飞书卡片层只依赖统一字段；OpenCode Recent 来自模型接口元数据；`/model` 不固定回退 `opencode`。
- 已新增决策：飞书普通 Agent 回复底部模型 footer 表示 Walker 本次请求指定给 agent 的模型，不承诺 TUI 内部实际最终使用模型。
- 已新增踩坑：当前环境的 `verify-artifacts.mjs` 缺失 `artifact-checker.js`，需用手工核验、`npm run check` 日志和 SHA-256 证据补足。
- 已执行 `loom memory export`，导出视图更新到 `.loom/memory/MEMORY.md`。

## 入口文件更新

- 本次未新增入口程序、快速命令或开发流程约定，无需更新入口文件。

## 变更范围确认

- 业务代码变更集中在飞书平台卡片/API、消息分发器、agent driver 模型目录契约和 OpenCode driver 模型规范化。
- 测试覆盖集中在 `test/opencode-driver.test.js`、`test/feishu-cards.test.js`、`test/message-dispatcher.test.js`。
- 规格、计划、执行、验证、审查与同步报告保存在 `specs/2026-07-16-feishu-message-interactions/`。

## 结论

索引同步、结构化记忆更新和入口文件检查已完成。图后端可用且索引最新。
