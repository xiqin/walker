# 移除 Claude 集成 — 需求规格

## 1. 概述

**需求来源**：用户要求清理 Claude 的集成和接入，并确认保留历史 specs 与合规记录，不改动 Codex 和 OpenCode。
**需求类型**：修改
**选定方案**：方案 A — 硬删除运行时接入，并对仍指向 Claude 的命令和会话失败关闭。

Walker 当前把 Claude Code CLI 作为真实 provider 接入：`ClaudeDriver`、PTY broker、bridge sidecar、attach server、transcript 扫描、`walker claude attach`、飞书 `/new claude` 与 `/attach claude`、管理端 `CLAUDE_*` 配置和 provider catalog 都会启动或探测 Claude。本次把这些运行时接入从当前代码、配置样例、管理界面和测试中移除。

已确认的边界：

- 删除 Claude 运行时模块和接线，启动与关闭都不再创建 Claude 进程、bridge 端口或 attach 终端。
- 飞书、CLI、Admin 和 provider doctor 不再把 `claude` 当作可用 agent。
- 已保存的 `agent=claude` 会话记录不自动删除、不迁移到 OpenCode。
- 不改写用户现有 `.env`。残留的 `CLAUDE_*` 被忽略。
- 保留 `specs/` 历史规格、`.loom/compliance/history.json` 和 `.loom/memory/`。
- 不继续实现 `specs/2026-08-21-claude-tui-feishu-shared-session`。
- 不删除、不弱化 Codex stub 和 OpenCode 实现。
- OpenCode 模型 ID `claude-sonnet-4` 是模型名，不是 Claude Code 接入，保持不变。

### 1.1 方案比较

| 方案 | 思路 | 取舍 | 结论 |
| ---- | ---- | ---- | ---- |
| A. 硬删除并失败关闭 | 删除 Claude 模块和接线；`claude` 命令与新会话在调用 driver 前拒绝 | 接入面消失；旧会话不能继续对话，但记录仍可读 | 选定 |
| B. 退回 stub driver | 删除 PTY/bridge，保留 `stubClaudeDriver` 注册 | 仍在 registry、帮助和测试中暴露 Claude，不符合清理接入 | 否决 |
| C. 配置开关禁用 | 保留代码，默认不启动 | 死代码和测试仍构成接入面，开关打开后即可恢复 | 否决 |

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | 删除 Claude 运行时模块和启动接线 | P0 | 给定当前源码，当创建和关闭应用，则不加载 Claude 模块、不监听 bridge、不启动 Claude 进程 |
| REQ-002 | CLI 与 provider 目录不再提供 Claude | P0 | 给定 `walker claude attach` 或 `providers doctor claude`，当执行命令，则非零退出或返回未知 provider，且不连接、不执行 `claude` |
| REQ-003 | 配置不再解析或编辑 Claude 设置 | P0 | 给定残留 `CLAUDE_*` 或 `WALKER_DEFAULT_AGENT=claude`，当加载或保存配置，则忽略残留键、拒绝默认 agent，且不改写原 `.env` |
| REQ-004 | 飞书命令和消息不再接入 Claude | P0 | 给定 `/new claude`、`/attach claude` 或绑定到旧 Claude 会话的普通消息，当处理请求，则返回 `claude_removed`，不创建会话、不扫描 transcript |
| REQ-005 | 旧会话记录只保留本地只读和本地删除 | P0 | 给定已保存的 `agent=claude` 记录，当列出、停止、删除或发送 prompt，则记录不被启动迁移，prompt 不调用任何 Claude driver |
| REQ-006 | OpenCode 与 Codex 行为保持 | P0 | 给定 OpenCode 创建/纳入路径和 Codex stub，当执行回归，则二者仍按原语义工作 |
| REQ-007 | 当前文档和管理界面不再宣传 Claude 接入 | P1 | 给定 README、帮助和管理端连接页，当查看当前说明，则不再把 Claude 列为可用或预留接入 |
| REQ-008 | 测试与静态扫描证明接入已移除 | P0 | 给定清理后的 `src/` 与 `test/`，当运行检查和扫描，则不再引用已删除模块，且不把真实 `claude` 进程当作测试手段 |

## 2.1 结构化需求清单 requirements.json

同目录 `requirements.json` 与上表 `REQ-001` 到 `REQ-008` 一一对应。每个 requirement 声明 `types`、`required_categories` 和带 `test_plan` 的 behaviors。

统一错误契约：

- 错误码：`claude_removed`
- 用户可见英文消息：`Claude integration has been removed.`
- CLI 退出码：`1`
- 飞书返回：`{ error: 'claude_removed' }`，并通过现有错误卡片发送上述消息
- Admin/API 返回：`{ ok: false, error: { code: 'claude_removed', message: 'Claude integration has been removed.' } }`
- provider doctor 对已删除的 id 继续使用现有未知 provider 结果：`{ ok: false, error: { code: 'NOT_FOUND', message: 'unknown provider: claude' } }`
- 比较 agent 名时只把精确小写 `claude` 视为已移除接入。`Claude` 或其他大小写按未知 agent 处理，并且仍然不得执行 `claude` 可执行文件。

## 3. 接口/API 设计

### 3.1 CLI

- **调用方式**：`walker claude`、`walker claude attach <runtime-id>`
- **描述**：不再进入 attach 命令。
- **输入**：任意 `claude` 子命令和参数。
- **输出**：stderr 或现有 CLI error 输出包含 `Claude integration has been removed.`，退出码 `1`。不得读取 `WALKER_CLAUDE_ATTACH_URL`，不得打开 WebSocket，不得 spawn。
- **帮助**：`walker help` 不再出现 `walker claude attach`。

### 3.2 Provider

- **调用方式**：`walker providers list`、`walker providers doctor claude`
- **描述**：catalog 只保留 `opencode`、`codex`、`shell`。
- **输出**：list 不含 id `claude`。doctor 返回 `NOT_FOUND`，检测函数不被调用。

### 3.3 飞书命令

- **调用方式**：`/new claude [title]`、`/attach claude [session-id|--page|--search]`
- **描述**：在 `driverRegistry.get()` 和 session 写入之前拒绝。
- **输出**：错误卡片含统一消息，返回 `claude_removed`。不调用 `ensureReady`、`createSession`、`resumeSession`、`listSessions`。

### 3.4 普通消息与提问回复

- **调用方式**：当前绑定会话的 `agent` 为 `claude` 时收到普通文本、取消、提问回复或 watch。
- **描述**：在 driver 调用前拒绝。
- **输出**：返回 `claude_removed`。即使测试注入名为 `claude` 的 driver，也不得调用其 `prompt`、`replyQuestion`、`watchSession`、`cancel`、`resumeSession`。

### 3.5 Admin / API 创建与 prompt

- **调用方式**：Admin `createSession({ agent: 'claude' })`、`sendPrompt()` 指向 `agent=claude` 的会话。
- **描述**：新创建在 `sessionService.createSession()` 之前拒绝。已有会话的 prompt 在 `registry.get()` 之前拒绝。
- **输出**：`claude_removed`。创建拒绝不产生新 session id。prompt 拒绝不记录成功的 `web prompt sent`。
- **鉴权**：既有 Admin 鉴权保持在前；未认证请求仍返回原有 `401`，不因本次改动放宽。

### 3.6 配置

- **调用方式**：`loadEnvConfig()`、`GET/PATCH /api/admin/config`
- **描述**：配置对象不再包含 `claudeCmd`、`claudeModel` 及其他 `claude*` 字段。管理端摘要不再包含 id 为 `claude` 的分组，allowlist 不再包含任何 `CLAUDE_*`。
- **输入**：`.env` 中残留的 `CLAUDE_*` 被忽略。`WALKER_DEFAULT_AGENT=claude` 抛出 `code=claude_removed` 的错误。
- **输出**：成功加载时默认 agent 仍为 `opencode`，除非显式配置为其他非 `claude` 值。PATCH `CLAUDE_*` 返回现有非法字段错误，目标 `.env` 字节不变。

## 4. 数据设计

不新增表，不迁移 JSON store。

已有 session 记录保持原字段，包括 `agent: "claude"` 和 `agentRef.claudeSessionId`。启动时不扫描、不改写、不删除这些记录。

本地停止和删除只修改 Walker session store：

- `stop`：将会话标记为 stopped，不调用 driver。
- `delete`：删除 Walker 记录，不调用 driver，不删除用户机器上的 Claude transcript 或 `~/.claude`。

`~/.claude`、`CLAUDE_CONFIG_DIR` 和 transcript JSONL 不读取、不监听、不编码路径。

## 5. 业务规则

- 规则 1：删除且不再引用这些文件：`src/drivers/claude-driver.js`、`src/drivers/claude-pty-runtime.js`、`src/drivers/claude-pty-broker.js`、`src/drivers/claude-bridge-sidecar.js`、`src/drivers/claude-attach-server.js`、`src/drivers/claude-transcript.js`、`src/cli/claude-attach-command.js`。
- 规则 2：`createApp()` 不再构造 `ClaudeDriver` 或 `ClaudeBridgeSidecar`，registry 不再注册 `claude`。关闭路径不再调用 Claude connection release 或 bridge `stop`。
- 规则 3：删除 `WindowsRuntime.openClaudeAttachTerminal()`。不得再 spawn `walker claude attach` 或写入 `WALKER_CLAUDE_ATTACH_URL` / `WALKER_CLAUDE_ATTACH_TOKEN`。
- 规则 4：删除 `stubClaudeDriver`。`stubCodexDriver` 继续导出。
- 规则 5：provider catalog 删除 `claude` 项。`provider-health.js` 不再因为 `CLAUDE_CMD` 改写检测命令。
- 规则 6：飞书帮助改为只描述 OpenCode attach：`/attach [session_id]`。卡片不再生成 `cmd:/attach claude` 或 `cmd:/new claude`。
- 规则 7：旧 Claude 会话出现在列表或状态中时，可以显示其原 agent 值，但不得提供会触发接入的按钮。状态文本包含 `Claude integration has been removed.`。
- 规则 8：cwd 自动绑定 Claude 历史会话的逻辑删除，不再调用 `listSessions` 扫描。
- 规则 9：日志可以记录 `claude_removed`、session id 和 route key，不得记录 prompt 正文、attach token、transcript 内容或完整 attach URL。
- 规则 10：当前文档删除“Claude 为预留扩展点”和“provider 示例包含 claude”的现行说明。CHANGELOG 的 `[Unreleased]` 增加移除记录。历史 `specs/` 不改写。

## 6. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| `walker claude attach` 缺少 runtime id | 退出码 1，消息为统一移除文案，不提示旧用法 |
| `walker claude attach rt_1` 且环境变量含 attach URL 和 token | 不读取 URL，不连接，退出码 1，输出不含 token |
| `providers doctor claude` 且本机存在 `claude` 可执行文件 | 返回 `NOT_FOUND`，检测器调用次数为 0 |
| `WALKER_DEFAULT_AGENT=claude` 且同时存在有效飞书凭据 | 配置加载失败，`createApp()` 不被调用 |
| `.env` 仅残留 `CLAUDE_CMD=claude`，默认 agent 为 `opencode` | 配置加载成功，结果对象不含 `claudeCmd`，文件字节不变 |
| Admin PATCH 只提交 `CLAUDE_CMD` | 返回非法字段错误，`.env` 字节不变 |
| `/new Claude` 或 `/new codex` | `Claude` 按未知 agent 返回原有 driver not found；`codex` 仍走 Codex stub。两者都不执行 `claude` |
| 并发两次向同一旧 Claude 会话 prompt | 两次都返回 `claude_removed`，注入 driver 的 `prompt` 调用次数为 0 |
| 重复执行 `/new claude` | 每次都拒绝，session 总数不增加 |
| 启动时 store 已有 `agent=claude` 记录 | 记录 id、agentRef 和状态保持原值 |
| 删除该记录 | 只删除 Walker 记录；注入 driver 的 `delete` 调用次数为 0 |
| 未认证 Admin 创建 `agent=claude` | 仍返回原有 401，不返回成功 session |
| OpenCode `/new` 与 `/attach` | 仍创建或纳入 OpenCode 会话，不返回 `claude_removed` |

## 7. 非目标

- 不删除或改写 `specs/` 下已有 Claude 规格、证据和流水线状态。
- 不删除 `.loom/compliance/history.json` 与 `.loom/memory/` 中的历史决策。
- 不实现或恢复 `specs/2026-08-21-claude-tui-feishu-shared-session`。
- 不卸载本机 Claude Code / kscc CLI，不清理用户 `~/.claude`。
- 不把旧 Claude 会话迁移、导入或绑定到 OpenCode。
- 不改写用户现有 `.env`、数据目录或 session JSON。
- 不改变 OpenCode 模型名 `claude-sonnet-4`、`claude-opus-4` 的存储和展示。
- 不移除 Codex、shell provider，不改变飞书长连接和 OpenCode HTTP/TUI 协议。

## 8. 实现注记

需要修改的现行接线包括：

- `src/app/bootstrap.js`
- `src/index.js`
- `src/config/env.js`
- `src/providers/provider-catalog.js`
- `src/providers/provider-health.js`
- `src/drivers/stub-drivers.js`
- `src/runtime/windows-runtime.js`
- `src/dispatch/message-dispatcher.js`
- `src/dispatch/question-handler.js`
- `src/admin/config.js`
- `src/admin/config-editor.js`
- `src/admin/session-admin.js`
- `src/admin/public/js/pages/connections.js`
- `src/platform/feishu/cards.js`
- `src/platform/feishu/commands.js`
- `.env.example`
- `README.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `walker-console-v2.html`
- 仍断言 Claude 接入存在的 `test/*.js`

专用测试文件与被删模块一起删除，不保留跳过用例。共享测试改为断言移除后的行为。
