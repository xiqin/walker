# 索引更新报告

**时间：** 2026-07-28 10:42
**触发原因：** `/new` 支持 `--cwd <path>` 功能开发完成
**图后端：** none
**索引方式：** 图后端不可用，索引同步跳过（路径 B）

## 索引状态

- [x] 未找到 `.loom/graph.config.json`，未启用 loom 图后端配置。
- [x] 未找到 `.codegraph/` marker，当前工作区没有可同步的 CodeGraph 索引。
- [x] 本次影响范围已通过源码读取、CodeGraph 历史上下文、`git diff`、目标测试与全量测试补充确认。

## 变更范围

- `src/dispatch/message-dispatcher.js`：`/new` 仅消费显式 `--cwd <path>`，并将 cwd 传给 driver 与 Walker session。
- `src/platform/feishu/commands.js`：帮助语法更新为 `/new [agent] [title] [--cwd <path>]`。
- `README.md`、`walker-console-v2.html`：命令文档和调试页同步新语法。
- `test/message-dispatcher.test.js`、`test/feishu-commands.test.js`：覆盖 cwd 传递、兼容默认 cwd、第三裸参数非 cwd、缺值错误、帮助输出。
- `.loom/compliance/history.json`：loom 验证门禁记录更新。
- `specs/2026-07-28-new-cwd/`：规格、计划、证据、验证、审查与同步产物。

## 结构化 Memory 更新

- [x] 踩坑记录：无需新增。已有 memory 已记录当前环境 `verify-artifacts.mjs` 缺失 `artifact-checker.js` 的本地安装问题，本次属于同类复现。
- [x] 用户偏好：无新增。
- [x] 架构决策：无需新增。`--cwd` 语法与不改变 `defaultCwd` 的决策已保存在本 feature spec 中。

## 入口文件更新

- [x] `README.md` 已更新 `/new [agent] [title] [--cwd <path>]`。
- [x] `walker-console-v2.html` 已更新飞书命令参考。
- [x] 无需更新其他入口文件。

## 验证证据

- `node --test test\message-dispatcher.test.js test\feishu-commands.test.js`：PASS，201/201。
- `npm test`：PASS，1205/1205。
- `loom tasks --spec-dir "specs/2026-07-28-new-cwd" --validate`：PASS。

## 未覆盖风险

- 图后端未启用，本次未执行图索引同步；影响范围判断以源码、diff 和测试为准。
- 当前变更仍未提交，提交或 PR 操作需用户另行确认。

verdict: PASS
