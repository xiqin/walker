# /new 支持项目路径

## 背景

当前 Walker 的 `/new` 命令只支持 `/new [agent] [name]`，创建 OpenCode 会话时固定使用服务默认工作目录 `defaultCwd`。用户需要在飞书命令中为新会话指定要启动的项目路径。

## 目标

- 允许 `/new` 通过显式选项指定新会话工作目录。
- 保持现有 `/new`、`/new <agent>`、`/new <agent> <title>` 行为兼容。
- 将指定目录同时传递给底层 agent session 和 Walker session 状态。
- 在帮助文档和测试中覆盖新语法。

## 非目标

- 不支持第三个裸参数作为路径，例如 `/new opencode title H:\project`。
- 不改变全局 `defaultCwd` 配置。
- 不为除 `/new` 外的命令新增路径参数。
- 不新增复杂 shell 风格引号解析；沿用现有空白切分规则。

## 方案

采用显式选项：

```text
/new [agent] [title] --cwd <projectPath>
```

示例：

```text
/new --cwd H:\project
/new opencode my-session --cwd H:\project
```

解析规则：

- `--cwd` 后必须跟一个非空参数。
- `--cwd` 和路径从位置参数中移除后，再按原规则解析 `agent` 与 `title`。
- 未提供 `--cwd` 时继续使用 `defaultCwd`。
- 多次出现 `--cwd` 时使用最后一次，避免新增错误类型影响已有宽松命令风格。
- `--cwd` 缺少值时返回错误卡片，不创建会话。

## 需求

### REQ-001：/new 接受显式 cwd 参数

`/new` 必须支持 `--cwd <projectPath>`，并在创建底层 agent session 和 Walker session 时使用该路径。

验收标准：

- `/new --cwd H:\project` 使用默认 agent、空标题、cwd 为 `H:\project`。
- `/new opencode my-session --cwd H:\project` 使用 agent `opencode`、标题 `my-session`、cwd 为 `H:\project`。
- 未提供 `--cwd` 时 cwd 仍为 `defaultCwd`。

### REQ-002：无效 cwd 参数不创建会话

当 `/new` 包含 `--cwd` 但没有路径值时，必须返回用户可见错误，并且不得调用 driver 创建会话或写入 Walker session。

验收标准：

- `/new --cwd` 返回错误。
- 错误路径不改变当前绑定 session。
- 错误路径不会调用底层 driver `createSession`。

### REQ-003：帮助与文档展示新语法

命令帮助、README 和调试页面必须展示 `/new [agent] [title] [--cwd <path>]` 或等价语法。

验收标准：

- `/help` 的 `/new` usage 包含 `--cwd <path>`。
- README 的命令表包含 `--cwd <path>`。
- 管理端调试命令说明包含 `--cwd <path>`。

## 测试计划

- 增加命令解析单元测试，确认 `/new --cwd H:\project` 保持 token 传递。
- 增加 MessageDispatcher `/new` 测试，断言 driver 和 sessionService 均收到指定 cwd。
- 增加 MessageDispatcher 无效 `--cwd` 测试，断言返回错误且不创建会话。
- 运行项目现有检查命令。
