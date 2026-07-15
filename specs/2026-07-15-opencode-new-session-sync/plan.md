# OpenCode 新会话同步修复实现计划

**目标：** 修复 OpenCode TUI 执行 `/new` 或选择已有会话后，Walker 仍绑定旧会话导致飞书双向同步中断的问题。

**架构：** 仅修改生成的 TUI bridge 插件模板。插件以事件维护 `activeSessionId`，由现有 register API 触发 Walker 服务端的路由加入、焦点切换和 watcher enrollment；服务端 bridge 与 API 均保持不变。回归测试直接加载生成插件并驱动 OpenCode 事件，验证滞后 route 不会覆盖事件确认的新会话。

**技术栈：** Node.js CommonJS、生成的 ESM OpenCode TUI plugin、`node:test`、loopback HTTP mock。

---

## 文件结构

| 文件 | 操作 | 职责 |
| ---- | ---- | ---- |
| `src/opencode-hook/plugin-template.js` | 修改 | 生成版本 2 插件；维护活动会话、处理会话切换事件并按活动会话注册/轮询/执行 delivery |
| `test/opencode-hook-installer.test.js` | 修改 | 运行生成插件，覆盖 `/new`、选择已有会话、子会话过滤、双向事件归属和版本升级 |

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | 实现事件驱动的新会话重新绑定 | 插件集成 | 中等 | 无 | `tasks/T1.md` |

## 依赖关系

T1

## 验证策略

1. 先在 `test/opencode-hook-installer.test.js` 增加运行级失败测试，固定 `api.route.current=ses_old` 并触发 `session.created(ses_new)`。
2. 修改模板后运行目标测试，确认 register、poll、prompt 和 events 全部使用正确会话。
3. 运行 `npm test`，执行项目完整语法检查和测试套件，防止生成插件及 installer 行为回归。
