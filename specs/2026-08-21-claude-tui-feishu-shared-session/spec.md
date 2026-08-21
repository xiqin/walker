# Claude TUI 与飞书共享会话 — 需求规格

## 1. 概述

**需求来源**：用户要求“飞书和 TUI 可以同时操作同一个会话，就像 OpenCode 一样，Claude 要支持同等功能”，并明确要求“不要破坏 OpenCode 的功能”。

**需求类型**：新增能力与现有 Claude 路径改造。

**选定方案**：方案 A — Walker 托管 Claude TUI PTY，同步本地 attach 与飞书输入，使用 hook/transcript 协同发现 `AskUserQuestion`，以真实 `tool_result` 确认答案。

当前 Claude 支持问题的根因边界已经明确：外部裸 `claude` 的 ConPTY 输入句柄属于启动它的系统终端，Walker 只能通过 transcript 观察，不能事后接管输入；`claude --resume <UUID>` 会创建另一个进程，不是原问题窗口。因此，本次落地的可靠路径是让 Claude 会话从启动时由 Walker 创建并持有 PTY，所有本地和飞书输入都经 Walker 仲裁后进入同一个 Claude 进程。

## 2. 方案比较

| 方案 | 架构思路 | 优点 | 缺点 | 结论 |
| ---- | -------- | ---- | ---- | ---- |
| A. Walker 托管 Claude TUI PTY | Walker 启动 Claude 原生 TUI 并持有 PTY；本地终端 attach 到该 PTY；飞书也写同一 PTY；hook/transcript 管问题事件与 ACK | 满足本地 TUI 与飞书同进程、同上下文；避免重复 resume；保留 Claude 原生 TUI 体验 | `AskUserQuestion` 回答仍需受控键盘/输入操作，可靠性依赖 TUI 状态，需状态机和 ACK 防误报 | 选定 |
| B. Headless stream-json 宿主 | 使用 `--print --input-format stream-json --output-format stream-json --permission-prompt-tool stdio` 管 Claude | `AskUserQuestion` 可结构化 request/response，最可靠 | 不保留原生 Claude TUI，不满足用户“飞书和 TUI 同时操作”的目标 | 不采用 |
| C. 接管外部裸 Claude | 根据 cwd/sessionId/PID 找到用户已启动的裸 Claude 并写入 | 用户无需改变启动方式 | Windows ConPTY 输入句柄不可事后接管；`--resume` 会创建第二进程；会误报成功 | 明确禁止 |

## 3. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | Walker 托管 Claude TUI runtime | P0 | 给定从 Walker 启动的 Claude，会话必须由 Walker 持有 runtimeId、claudeSessionId、PTY 输入输出句柄；本地 attach 和飞书输入写入同一 runtime；不得通过 `--resume` 创建第二进程来回答当前问题。 |
| REQ-002 | 本地 TUI attach 与会话绑定 | P0 | 给定已托管 runtime，本地终端 attach 后可看到 replay 输出、继续接收实时输出并写入同一 PTY；detach 不应丢失 Claude 进程；重新 attach 可继续同一会话。 |
| REQ-003 | 飞书 route 与托管 Claude 会话绑定 | P0 | 给定飞书 route 已记录 cwd 或显式 `/new claude`，系统应绑定到 Walker 托管 Claude session；外部裸 Claude 只能标记为只读观察，不得宣称可飞书回复。 |
| REQ-004 | 实时捕获 Claude `AskUserQuestion` | P0 | 给定 Claude 触发 `AskUserQuestion`，系统应优先通过 hook/早期事件捕获 requestID/toolUseId/questions，并在 2 秒内向飞书发送问题卡片；transcript watcher 作为补偿路径。 |
| REQ-005 | 飞书答案写回同一托管 TUI | P0 | 给定飞书提交问题答案且原 runtime 仍可写，系统应把答案转换为当前问题界面可消费的输入序列或文本输入，写入产生该问题的同一 runtime；runtime 不可写时必须明确失败，不得 resume 新进程并误报成功。 |
| REQ-006 | 真实 `tool_result` ACK 状态机 | P0 | 飞书提交答案后不得立即标记最终成功；必须等待 transcript/hook 中出现匹配 toolUseId/requestID 的真实 `tool_result`，再将卡片置为已回答；超时需显示等待或失败状态。 |
| REQ-007 | 本地与飞书输入仲裁 | P0 | 当本地用户与飞书同时操作问题或普通 prompt 时，系统必须串行化输入，防止键序列与本地按键交错；首次被真实 `tool_result` 确认的答案获胜，迟到答案显示已由另一端回答。 |
| REQ-008 | OpenCode 功能不回归 | P0 | OpenCode TUI bridge 注册、cwd route 绑定、Feishu 出站、question reply、permission reply 和 upstream_error 推送行为必须保持现有测试通过；本次 Claude 改造不得改变 OpenCode driver/bridge 协议。 |
| REQ-009 | 可观测性与降级提示 | P1 | 关键阶段必须有结构化日志：runtime 托管/attach/detach、question detected、card sent、answer submitted、input written、tool_result confirmed、runtime unavailable、external readonly。用户可从日志判断失败断点。 |
| REQ-010 | 兼容与迁移 | P1 | 已存在外部裸 Claude transcript 关联继续可读；系统必须清晰展示该会话为只读或 degraded，提示用户改用 Walker 托管启动方式；不得自动停止或接管外部进程。 |

## 4. 接口/API 设计

### 4.1 Claude 托管 runtime

- **调用方**：Claude driver、飞书命令、未来本地 attach shim。
- **职责**：创建、列出、attach、detach、停止 Walker 托管的 Claude TUI runtime。
- **核心字段**：

| 字段 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| runtimeId | string | 是 | Walker 生成的 runtime 标识。 |
| claudeSessionId | string | 是 | Claude 会话 UUID。 |
| cwd | string | 是 | 会话工作目录。 |
| transport | string | 是 | `pty-attach` 或 `bridge-sidecar`。 |
| owner | string | 是 | `walker-managed` 或 `external-readonly`。 |
| status | string | 是 | `starting`、`active`、`detached`、`stopped`、`error`。 |
| inputWritable | boolean | 是 | 当前 runtime 是否可写入。 |

### 4.2 本地 attach

- 本地终端 attach 应订阅 runtime replay 和实时输出。
- 本地输入必须通过同一输入仲裁器写入 PTY。
- attach 客户端退出时默认只 detach，不停止 Claude；显式 stop 才终止 runtime。

### 4.3 Claude question coordinator

- **输入事件**：hook `AskUserQuestion`、transcript `AskUserQuestion tool_use`、transcript `tool_result`、飞书卡片 answer、本地输入状态。
- **状态键**：优先使用 `toolUseId`，辅以 `requestID`、`claudeSessionId`、`runtimeId`。
- **状态**：`detected`、`card_sending`、`collecting`、`submitting_feishu`、`awaiting_tool_result`、`answered`、`answered_elsewhere`、`runtime_unavailable`、`expired`、`failed`。

## 5. 数据设计

### 5.1 runtime 归属

Claude session 的 `agentRef` 必须能表达托管能力：

```json
{
  "provider": "claude",
  "transport": "pty-attach",
  "runtimeId": "rt_xxx",
  "claudeSessionId": "uuid",
  "owner": "walker-managed",
  "inputWritable": true
}
```

外部裸 Claude 自动关联只能生成：

```json
{
  "provider": "claude",
  "claudeSessionId": "uuid",
  "owner": "external-readonly",
  "inputWritable": false
}
```

### 5.2 question 状态

问题状态需要保存：

- `runtimeId`
- `claudeSessionId`
- `toolUseId`
- `requestID`
- `questions`
- `cards`
- `answers`
- `submittedBy`
- `submittedAt`
- `confirmedAt`
- `terminalStatus`

## 6. 业务规则

- Walker 托管 runtime 是 Claude 飞书双向操作的唯一可靠写入前提。
- 外部裸 Claude 可以被观察、推送问题卡片，但不能从飞书回答；卡片必须提示只读/本地回答。
- 不得为了回答当前问题调用 `claude --resume <sessionId>` 创建新 runtime。
- 飞书答案写入后，只能进入“等待 Claude 确认”状态；只有真实 `tool_result` 匹配后才能最终显示成功。
- 如果本地 TUI 先回答并产生 `tool_result`，飞书卡片应更新为“已在本地回答”。
- 如果飞书先回答并确认，本地继续操作产生的重复回答应被视为迟到并记录日志。
- OpenCode 的 `opencode-tui-bridge`、OpenCode question/permission reply 与现有飞书推送链路不得被改造为 Claude 专用逻辑。

## 7. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| 外部裸 Claude 被 cwd 自动发现 | 标记只读，允许观察输出和推送问题，不允许飞书回答。 |
| 飞书提交答案时 runtime 不可写 | 卡片显示无法远程回答，请在本地 TUI 回答；不得创建新 Claude 进程。 |
| hook 丢失但 transcript 后续出现 AskUserQuestion | 仍发送飞书卡片，但日志标注来源为 transcript fallback。 |
| transcript 延迟落盘 | 记录 pending/延迟日志，不误判飞书发送失败。 |
| 多选题 | 生成可控多选输入序列，并等待对应 tool_result 确认。 |
| 自定义文本题 | 若 TUI 支持自定义输入路径，则输入文本并确认；无法可靠定位输入框时降级提示本地回答。 |
| 本地和飞书同时回答 | 以第一个匹配 tool_result 的答案为准，另一个端显示已处理。 |
| Claude TUI 改版导致键序列失败 | 超时后显示未确认，保留本地回答提示，并记录可诊断日志。 |
| OpenCode upstream_error | 仍按现有逻辑推送 `OpenCode error: ...`。 |

## 8. 非功能要求

- **安全**：日志不得记录完整 prompt、secret、token 或用户自定义答案的敏感上下文；必要时脱敏。
- **可观测性**：每个跨边界动作必须有结构化日志，包含 requestID/toolUseId/runtimeId/sessionId，但不泄漏隐私内容。
- **兼容性**：保留现有 Claude transcript 观察能力；保留 OpenCode 全部已验证行为。
- **可靠性**：禁止误报 `replied`；最终成功必须绑定真实 Claude 结果。
- **性能**：hook 捕获到问题后 2 秒内调用飞书发卡；飞书提交答案后 10 秒内应进入确认成功、等待中或明确失败状态。

## 9. 非目标

- 不接管已经由系统终端直接启动的裸 `claude` 的 ConPTY 输入。
- 不用 `claude --resume <UUID>` 创建第二进程来回答原窗口问题。
- 不在本阶段实现完整 headless stream-json 替代模式。
- 不修改 OpenCode TUI bridge 协议。
- 不保证 Claude 官方 TUI 未来改版后键盘序列零维护。

## 10. 自审结论

- 本规格聚焦单个实现计划：Walker 托管 Claude TUI 与飞书共享同一会话。
- 规格明确区分托管 Claude 与外部裸 Claude 的能力边界。
- 规格明确 OpenCode 不变量，避免把 Claude 改造扩散到 OpenCode 路径。
- 每个 `REQ-xxx` 均将在 `requirements.json` 中对应声明，并在后续 detail-expansion 阶段展开完整行为义务。
