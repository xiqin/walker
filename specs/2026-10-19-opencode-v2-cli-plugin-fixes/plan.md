# OpenCode 终端桥接插件可靠性修复 实现计划

**目标：** 修复 V2 终端插件的回复错发、表单错位、安装覆盖和日志泄密，并提供可诊断的 V1/V2 双入口。

**架构：** 桥接协议仍由一份生成的 `setup` 实现。V2 入口只做 `@opencode/plugin/tui` 的 `Plugin.define`，导入失败直接暴露，不再回退伪定义。V1 入口是独立文件，复用同一 `setup`，不充当 V2 失败后的替身。安装器只负责选择目录、保护现有配置和注册对应入口。

**技术栈：** Node.js、现有 `node:test`、OpenCode V2 CLI 插件协议。不引入新依赖，不改 HTTP/SSE 驱动。

---

## 执行约束

- 当前工作树已有未提交的 HTTP/SSE 与插件改动。隔离工作树必须包含这些改动；若工作树步骤只会基于 HEAD 生成干净树，停下来改在当前工作树实施，不得丢弃或回退。
- 不提交 Git，不改 `OPENCODE_SERVER_URL` 优先级，不改 register/poll/events/dispose 路径和鉴权协议。
- 两个 task 串行。T1 完成并通过相关测试后才能做 T2。
- 令牌可以继续只存在于生成插件的既有鉴权常量中，但不得写入 `cli.json`、安装返回值、错误文本或运行日志。

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | 修复插件生成与安装保护 | 业务逻辑 | 高 | 无 | REQ-001, REQ-002, REQ-003, REQ-004, REQ-005 | REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B04, REQ-001-B05, REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04, REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-003-B04, REQ-004-B01, REQ-004-B02, REQ-004-B03, REQ-004-B04, REQ-004-B05, REQ-005-B01, REQ-005-B02, REQ-005-B03 | `tasks/T1.md` |
| T2 | 记录回归与真实加载证据 | 验证 | 中等 | T1 | REQ-006 | REQ-006-B01, REQ-006-B02, REQ-006-B03, REQ-006-B04 | `tasks/T2.md` |

## 依赖关系

T1 → T2

不能并行：插件正文、两个入口和安装器测试断言的是同一组生成文件。拆开写入会产生 `owns` 冲突，并让旧测试无法由实际修改者更新。

## 文件边界

| 文件 | 职责 | 所属 task |
| ---- | ---- | --------- |
| `src/opencode-hook/plugin-template.js` | 生成共享 `setup`、严格 V2 入口和独立 V1 入口 | T1 |
| `src/opencode-hook/installer.js` | 解析配置目录、原子更新、按入口注册 | T1 |
| `test/opencode-v2-cli-plugin.test.js` | 回复竞态、表单和 V2 加载失败的行为测试 | T1 |
| `test/opencode-hook-installer.test.js` | 路径、非法配置、原子性、幂等和迁移测试 | T1 |
| `test/opencode-plugin-template.test.js` | 保持既有协议字符串断言与新入口约束一致 | T1 |
| `test/integration-feishu-question.test.js` | 只在断言编码了旧的错位或泄密行为时更新 | T1 |
| `specs/2026-10-19-opencode-v2-cli-plugin-fixes/red-evidence.md` | 修复前失败命令的输出，供报告引用 | T1 |
| `specs/2026-10-19-opencode-v2-cli-plugin-fixes/probe-opencode-v2-cli-load.mjs` | 隔离配置下的真实 CLI 加载探针 | T2 |
| `specs/2026-10-19-opencode-v2-cli-plugin-fixes/test-report.md` | 命令、red/green 和未验证项 | T2 |

`src/drivers/`、`src/opencode-tui-bridge/` 与 `src/cli/init-command.js` 只读。调用方仍传原来的 `installHookPlugin` 选项；未传目录时由安装器内部解析 XDG。

## Traceability 初始映射

planning 阶段的 `traceability.json` 已把每个 REQ 和 behavior 映射到上表中的 task。`tests` 与 `evidence` 留空，由 executing 填入真实文件。
