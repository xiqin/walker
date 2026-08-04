# Claude Provider 功能完善规格

## 背景

Walker 当前在 provider catalog 中声明了 `claude`，但实际 driver 仍是 stub，管理端会将其标记为不可用。用户要求完善 Claude provider，使其功能完整性尽可能与现有 `opencode` provider 一致。

本规格以当前可验证资料为实现基线：

- 本机 `claude --version` 返回 `2.1.196 (Claude Code)`。
- `npm view @anthropic-ai/claude-code` 显示当前 `latest` 为 `2.1.220`、`stable` 为 `2.1.212`。
- 本机 `claude --help` 确认支持 `--print`、`--output-format text|json|stream-json`、`--input-format text|stream-json`、`--include-partial-messages`、`--resume`、`--session-id`、`--model`、`--fallback-model`、`--agent`、`--agents`、`--permission-mode`、`--allowed-tools`、`--disallowed-tools`、`--add-dir`、`--settings`、`--mcp-config`、`--bare`、`--safe-mode`、`--no-session-persistence`、后台 `agents` 命令等。
- 官方网页抓取在当前环境返回传输错误，因此实现不得依赖未验证的旧 HTTP API 或网页内容；必须优先依赖运行时 CLI 探测、命令帮助和可测试行为。

## 目标

1. 将 `claude` 从 stub driver 升级为可用 driver，并在 registry、bootstrap、admin/API/CLI provider 状态中体现已注册、可检测、可诊断。
2. 对齐 `AgentDriver` 与 `opencode` 的核心行为：就绪检查、创建/恢复会话、发送 prompt、取消/停止、删除/清理、模型/当前配置摘要、会话事件映射、错误诊断。
3. 保持 Claude Code 能力边界真实：OpenCode 的 HTTP server、OpenCode 本地 sqlite 会话库不能被假装存在；Claude provider 需要在已验证 Claude/kscc CLI 能力上实现与 OpenCode 等价的 Walker 会话链路，包括 `/new` 后拉起终端窗口、窗口生命周期、飞书消息交互与可观测同步。
4. 新增配置集中进入现有配置系统，避免隐藏全局状态和硬编码。

## 非目标

1. 不实现或模拟 Claude Code 未公开、未验证的 HTTP server API。
2. 不假装 Claude/kscc 存在 OpenCode HTTP/TUI bridge 协议；若需要窗口/TUI 链路，应通过 Claude/kscc CLI 自身的交互式终端进程实现 Walker 等价行为，而不是伪造 OpenCode 内部协议。
3. 不引入新的 npm 运行时依赖，除非执行阶段证明内置 `child_process` 无法满足需求并重新评审。
4. 不改变 `opencode` provider 现有行为。
5. 不默认启用 `--dangerously-skip-permissions` 或 `--allow-dangerously-skip-permissions`。

## 推荐方案

采用新增 `ClaudeDriver` 的最小适配方案：

1. 新增 `src/drivers/claude-driver.js`，继承 `AgentDriver`。
2. 使用 `child_process.spawn`/`execFile` 调用 `claude` CLI。
3. `ensureReady()` 执行 `claude --version`，返回结构化诊断错误。
4. `createSession()` 生成 Walker 可保存的 `agentRef`，包含 `provider: 'claude'`、`claudeSessionId`、`cwd`、`createdAt`、可选 `model`、`agent`、`permissionMode`。若用户或调用方传入合法 UUID，则传给 `--session-id`；否则由 driver 生成 UUID。
5. `prompt()` 使用 `claude --print --output-format stream-json` 执行非交互 prompt；对已有会话追加 `--resume <claudeSessionId>` 或 `--session-id <uuid>`，对模型/agent/权限/工具配置映射对应 CLI 参数。
6. 将 stream-json 输出映射为 `AgentEvent`：文本、reasoning、tool_use、permission/status、error、done；未知事件保留为 status/debug 级别，不中断成功输出。
7. `stop()`/`cancel()` 通过 `AbortController` 或保存的子进程句柄终止当前 prompt；`delete()` 清理 driver 内 pending 状态，不删除 Claude Code 用户目录中的历史数据。
8. `listModels()` 返回可配置模型摘要，而不是伪造远端模型目录。默认提供 `sonnet`、`opus` 等 CLI help 提到的 alias 入口，并合并 `CLAUDE_MODEL`、`CLAUDE_FALLBACK_MODEL`。
9. bootstrap 注册真实 `claude` driver，替换 `stubClaudeDriver()`；保留 `codex` stub。

## 增量范围：Claude/kscc 与 OpenCode 等价链路

用户在飞书实测 `/new claude kscc-test` 后确认会话能创建，但没有像 OpenCode 一样拉起窗口。新增范围要求 `claude` provider 在 Walker 内的用户体验与 OpenCode 对齐：

1. `/new claude <title>` 创建会话后必须启动 Claude/kscc 的交互式终端窗口，并把窗口归属到该 Walker session。
2. 飞书普通消息必须继续路由到当前 Claude session，并与终端中的 Claude/kscc 会话保持同一上下文，不能变成互不相关的后台 prompt。
3. `/current`、`/list`、停止、删除、恢复、watch/refresh 等会话生命周期行为必须有 Claude 等价实现或明确可诊断降级。
4. provider catalog/admin/doctor 必须把 Claude 的 TUI/window 能力展示为真实能力状态，而不是仍标记 `tui:false`。
5. OpenCode 默认链路不得被破坏；Claude 的终端实现不得复用或污染 OpenCode 专属 `opencodeSessionId`、TUI bridge watcher 或 sqlite 语义。

## 方案比较

| 方案 | 思路 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| CLI stream-json driver | 直接适配 `claude --print --output-format stream-json` | 与当前可验证 CLI 能力一致；不需要新服务；易测试 | 不能提供 OpenCode HTTP/TUI bridge 的完全同构能力 | 采用 |
| 后台 agents driver | 用 `claude --background` 和 `claude agents` 管理后台任务 | 接近后台会话体验 | 命令输出与控制协议需要进一步探测，版本差异风险高 | 后续增强，不作为首版核心 |
| 假设 HTTP/SDK API | 复刻 OpenCode HTTP driver | 表面最接近 OpenCode | 当前资料未验证，容易依赖旧信息或不存在 API | 拒绝 |

## 功能需求

### REQ-001：真实注册 Claude Driver

Walker 启动后必须注册真实 `claude` driver。`/api/v1/providers`、admin connections、doctor/list agents 不应再把 `claude` 标记为 stub 未实现。

验收标准：当 `claude` CLI 可执行时，provider 状态显示 installed/healthy 由检测结果决定，并且 `driverRegistered` 为 `true`。

### REQ-002：Claude CLI 能力探测和版本诊断

Claude driver 必须基于运行时 CLI 探测判断可用性，至少支持 `claude --version` 和 `claude --help` 的可诊断失败。

验收标准：缺少 CLI、命令超时、非零退出码时返回明确错误，不泄漏 token、环境变量密钥或完整敏感命令行。

### REQ-003：会话创建与恢复

Claude driver 必须实现 `createSession()`、`resumeSession()`、`listSessions()` 的 Walker 语义。由于 Claude Code 会话持久化由 CLI 管理，Walker 至少保存并恢复 `claudeSessionId`、`cwd`、`model`、`agent`、创建时间等 agentRef 元数据。

验收标准：同一 `agentRef` 多次 prompt 使用相同 `claudeSessionId`；无效或缺失 `agentRef` 会产生明确输入错误。

### REQ-004：Prompt 执行与事件映射

Claude driver 必须通过当前 CLI 支持的 print/stream-json 能力执行 prompt，并将输出转换为 Walker `AgentEvent[]`。

验收标准：文本结果以 `AgentEvent.TYPE_TEXT` 返回，完成状态以 `TYPE_DONE` 返回，错误以 `TYPE_ERROR` 或抛出诊断异常返回；stream-json 中未知事件不导致成功任务失败。

### REQ-005：模型、agent、权限和工具参数映射

Claude driver 必须支持从配置或调用参数传入 `--model`、`--fallback-model`、`--agent`、`--permission-mode`、`--allowed-tools`、`--disallowed-tools`、`--add-dir` 等当前 CLI help 中可验证的参数。

验收标准：参数构造不经过 shell 拼接，空值不传递；危险权限跳过参数默认禁用，只有显式配置时才允许传递。

### REQ-006：取消、停止与进程清理

Claude driver 必须支持取消当前 prompt，避免孤儿进程和重复完成事件。

验收标准：调用 `stop()` 或 AbortSignal 触发后，pending 进程被终止，后续不会再为同一 prompt 投递成功完成事件。

### REQ-007：配置和管理端可见性

新增 Claude 相关配置必须进入现有配置摘要和 allowlist，至少包括 `CLAUDE_CMD`、`CLAUDE_MODEL`、`CLAUDE_FALLBACK_MODEL`、`CLAUDE_AGENT`、`CLAUDE_PERMISSION_MODE`、`CLAUDE_ALLOWED_TOOLS`、`CLAUDE_DISALLOWED_TOOLS`、`CLAUDE_CONFIG_DIR`、`CLAUDE_PROMPT_TIMEOUT_MS`。

验收标准：admin config 可显示和保存非敏感字段；provider catalog 的 `configKeys` 与配置系统一致。

### REQ-008：与现有 OpenCode 行为兼容

新增 Claude provider 不得破坏 OpenCode 既有测试和默认行为。`WALKER_DEFAULT_AGENT` 仍可选择 `opencode` 或 `claude`，默认值保持当前 `opencode`。

验收标准：现有 OpenCode 相关测试继续通过；未配置 Claude 时 OpenCode 默认路径不变。

### REQ-009：测试覆盖和资料新鲜度证据

实现必须有单元测试覆盖 CLI 参数构造、事件映射、错误路径、取消路径、bootstrap 注册、provider catalog/config 变更，并在测试报告中记录 Claude Code 资料基线。

验收标准：测试不依赖真实 Claude 网络调用，使用 fake runtime/spawn；`test-report.md` 记录 `claude --help`、`claude --version`、`npm view @anthropic-ai/claude-code` 的调研结果。

### REQ-010：Claude/kscc 与 OpenCode 等价 TUI 会话链路

Claude provider 必须在 Walker 层实现与 OpenCode 相同的会话体验：`/new claude <title>` 创建会话后拉起交互式终端窗口，飞书消息继续进入同一 Claude/kscc 会话，上下文、停止、删除、恢复、状态展示和 watch/refresh 行为可诊断且不混用 OpenCode 专属协议。

验收标准：在配置 `CLAUDE_CMD` 指向可执行 Claude/kscc CLI 时，飞书 `/new claude kscc-test` 会创建 Walker session 并启动可见终端窗口；随后发送 `只回复 pong` 能进入同一 Claude/kscc 会话并返回结果；`/current`、`/list` 和 provider catalog 显示 Claude 具备真实 TUI/window 能力；OpenCode 的窗口、watch、TUI bridge 行为保持回归通过。

## 数据与接口

### Claude AgentRef

```json
{
  "provider": "claude",
  "claudeSessionId": "uuid",
  "cwd": "H:\\walker",
  "model": "sonnet",
  "agent": "default",
  "permissionMode": "default",
  "createdAt": 1785485931000,
  "updatedAt": 1785485931000
}
```

### 配置键

| 键 | 默认值 | 说明 |
|---|---|---|
| `CLAUDE_CMD` | `claude` | Claude Code CLI 命令 |
| `CLAUDE_MODEL` | 空 | 默认模型，空值使用 Claude Code 默认 |
| `CLAUDE_FALLBACK_MODEL` | 空 | print 模式 fallback model |
| `CLAUDE_AGENT` | 空 | 当前 session agent |
| `CLAUDE_PERMISSION_MODE` | `default` | CLI permission mode |
| `CLAUDE_ALLOWED_TOOLS` | 空 | 允许工具列表 |
| `CLAUDE_DISALLOWED_TOOLS` | 空 | 禁止工具列表 |
| `CLAUDE_CONFIG_DIR` | 空 | Claude 配置目录 |
| `CLAUDE_PROMPT_TIMEOUT_MS` | `120000` | prompt 超时时间，单位 ms |

## 风险与约束

1. Claude Code CLI 版本变化可能改变 stream-json schema。实现必须对未知事件容错，并用测试锁定当前映射策略。
2. 官方网页在当前环境不可抓取。执行阶段如网络恢复，应再次查询官方 docs；若仍失败，以 `claude --help` 和 npm 包元数据作为可审计资料来源。
3. Claude Code 的 TUI/后台 agent 能力不等价于 OpenCode 当前 TUI bridge。增量实现必须基于 Claude/kscc CLI 交互式进程或可验证参数实现窗口链路，不伪造 OpenCode 实时 TUI 注册协议。
4. 真实 CLI 调用可能产生费用。自动测试必须 fake CLI，不得默认调用真实 prompt。

## 验证计划

1. 新增 `test/claude-driver.test.js` 覆盖核心 driver 行为。
2. 更新 provider catalog/config/bootstrap/admin 相关测试。
3. 运行 `npm test`。
4. 在 `test-report.md` 和 `verify-report.md` 中记录资料基线、测试命令和结果。
