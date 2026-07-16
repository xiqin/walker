# SSE 事件全量覆盖 — 需求规格

## 1. 概述

**需求来源**：用户确认 OpenCode 1.17.20 SSE 事件中大量类型未转发到飞书，尤其是 `permission.updated`（权限确认请求）被丢弃导致飞书用户无法响应。
**需求类型**：修改
**选定方案**：方案 A — 在 mapSSEEvent 适配层全量映射未覆盖事件，按重要性分级在飞书侧展示，权限请求通过飞书卡片按钮交互回调 OpenCode 答复端点。

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | permission.updated 映射到 TYPE_PERMISSION AgentEvent | P0 | 给定 SSE 收到 permission.updated 事件，当 mapSSEEvent 处理时，则返回 TYPE_PERMISSION AgentEvent，data 包含 id/type/title/metadata/sessionID/messageID |
| REQ-002 | 飞书权限确认卡片渲染 | P0 | 给定 TYPE_PERMISSION AgentEvent，当 _renderCardProgress 处理时，则发送飞书 interactive 卡片，包含权限标题、元信息、允许/拒绝按钮，按钮 value 携带 permissionId 和 sessionRef |
| REQ-003 | 权限卡片按钮回调 OpenCode 答复端点 | P0 | 给定用户点击允许/拒绝按钮，当 onCardAction 处理时，则调用 OpencodeDriver.replyPermission(sessionRef, permissionId, response)，response 为 "allow" 或 "deny"，飞书侧更新卡片状态为已处理 |
| REQ-004 | permission.replied 映射到 TYPE_PERMISSION_REPLIED | P1 | 给定 SSE 收到 permission.replied 事件，当 mapSSEEvent 处理时，则返回 TYPE_PERMISSION_REPLIED AgentEvent，data 包含 permissionId 和 response |
| REQ-005 | todo.updated 映射到 TYPE_TODO 并在进度卡片显示 | P1 | 给定 SSE 收到 todo.updated 事件，当 mapSSEEvent 处理时，则返回 TYPE_TODO AgentEvent，data 包含 todos 列表；进度卡片 formatAgentEvent 显示待办条目数和完成状态 |
| REQ-006 | session.compacted 映射到 TYPE_COMPACTED 并在进度卡片提示 | P1 | 给定 SSE 收到 session.compacted 事件，当 mapSSEEvent 处理时，则返回 TYPE_COMPACTED AgentEvent；进度卡片显示"上下文已压缩"提示条目 |
| REQ-007 | file.edited 映射到 TYPE_FILE_EDITED 并折叠摘要显示 | P1 | 给定 SSE 收到 file.edited 事件，当 mapSSEEvent 处理时，则返回 TYPE_FILE_EDITED AgentEvent，data 包含文件路径；进度卡片累计显示"已编辑 N 个文件"摘要 |
| REQ-008 | session.diff 映射到 TYPE_SESSION_DIFF 并折叠摘要 | P2 | 给定 SSE 收到 session.diff 事件，当 mapSSEEvent 处理时，则返回 TYPE_SESSION_DIFF AgentEvent；进度卡片折叠显示 diff 摘要 |
| REQ-009 | message.part.updated 未识别 part.type 分级处理 | P1 | 给定 SSE 收到 message.part.updated 携带 part.type 为 file/step-start/step-finish/snapshot/patch/agent/retry/compaction/subtask，当 mapSSEEvent 处理时，则 step-start/step-finish 映射到 TYPE_STEP 显示进度，file/patch 映射到 TYPE_FILE_EDITED 显示摘要，snapshot/agent/retry/compaction/subtask 静默记录不展示在卡片 |
| REQ-010 | message.removed / message.part.removed 映射到 TYPE_MESSAGE_REMOVED | P2 | 给定 SSE 收到 message.removed 或 message.part.removed 事件，当 mapSSEEvent 处理时，则返回 TYPE_MESSAGE_REMOVED AgentEvent；该事件不展示在卡片，仅用于清理内部状态 |
| REQ-011 | command.executed 映射到 TYPE_COMMAND_EXECUTED | P2 | 给定 SSE 收到 command.executed 事件，当 mapSSEEvent 处理时，则返回 TYPE_COMMAND_EXECUTED AgentEvent，data 包含 command 和 exitCode；进度卡片显示命令执行结果摘要 |
| REQ-012 | session.created/updated/deleted 映射到 TYPE_SESSION_LIFECYCLE | P2 | 给定 SSE 收到 session.created/updated/deleted 事件，当 mapSSEEvent 处理时，则返回 TYPE_SESSION_LIFECYCLE AgentEvent，data 包含 action 和 sessionInfo；用于 walker 内部 session 状态同步，不展示在卡片 |
| REQ-013 | server.connected 映射到 TYPE_SERVER_CONNECTED | P2 | 给定 SSE 收到 server.connected 事件，当 mapSSEEvent 处理时，则返回 TYPE_SERVER_CONNECTED AgentEvent；仅记录日志，不展示在卡片 |
| REQ-014 | 其余事件（installation/lsp/vcs/file.watcher/tui/pty）静默丢弃 | P2 | 给定 SSE 收到 installation.updated/lsp.*/vcs.branch.updated/file.watcher.updated/tui.*/pty.* 事件，当 mapSSEEvent 处理时，则 return null 丢弃并记录 debug 日志 |
| REQ-015 | AgentEvent 类型体系扩展 | P0 | 给定新增事件类型，当 AgentEvent 类加载时，则 TYPE 常量、DATA_SCHEMAS 均已声明，不影响现有 6 种类型 |
| REQ-016 | ProgressCard formatAgentEvent 扩展 | P0 | 给定新增 AgentEvent 类型，当 formatAgentEvent switch 处理时，则各类型有对应 case 返回显示文本，default 仍返回 '' |
| REQ-017 | OpencodeDriver.replyPermission 方法 | P0 | 给定 sessionRef 和 permissionId 和 response，当 replyPermission 调用时，则向 OpenCode server 发送 POST /session/:id/permissions/:permissionID，body 为 { response, remember?: false } |
| REQ-018 | /permit 命令注册 | P0 | 给定用户输入 /permit 命令，当 parseCommand 解析时，则识别为 permit 命令，参数为 permissionId 和 allow/deny；命令注册在 COMMANDS 表中 |

## 3. 接口/API 设计

### 3.1 OpencodeDriver.replyPermission

- **调用方式**：内部方法，调用 OpenCode server HTTP 端点
- **描述**：回复权限请求，将用户选择（allow/deny）发送到 OpenCode server
- **签名**：`async replyPermission(sessionRef, permissionId, response, remember)`

| 参数 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| sessionRef | Object | 是 | 包含 opencodeSessionId 和可选 serverUrl |
| permissionId | string | 是 | 权限请求 ID |
| response | string | 是 | "allow" 或 "deny" |
| remember | boolean | 否 | 是否记住选择，默认 false |

- **HTTP**：`POST /session/:opencodeSessionId/permissions/:permissionId`，body `{ response, remember }`

### 3.2 权限卡片按钮 value 编码

- **格式**：`cmd:/permit <permissionId> <allow|deny> [sessionId]`
- **示例**：`cmd:/permit perm_abc123 allow wks_bound1`
- **解析**：复用现有 `parseCardAction` 提取 action.value.action，经 `onCardAction` 转为 `handleCommand` 调用

### 3.3 AgentEvent 新增类型

| TYPE 常量 | 值 | data 字段 |
| --------- | -- | --------- |
| TYPE_PERMISSION | "permission" | id, type, title, metadata, sessionID, messageID, callID? |
| TYPE_PERMISSION_REPLIED | "permission_replied" | permissionId, response |
| TYPE_TODO | "todo" | todos: [{ id, content, status, activeForm }] |
| TYPE_COMPACTED | "compacted" | sessionID |
| TYPE_FILE_EDITED | "file_edited" | path, action, linesAdded?, linesRemoved? |
| TYPE_SESSION_DIFF | "session_diff" | diff, filesCount, linesAdded, linesRemoved |
| TYPE_STEP | "step" | partType: "step-start"/"step-finish", stepId? |
| TYPE_MESSAGE_REMOVED | "message_removed" | messageId, partId? |
| TYPE_COMMAND_EXECUTED | "command_executed" | command, exitCode |
| TYPE_SESSION_LIFECYCLE | "session_lifecycle" | action: "created"/"updated"/"deleted", session |
| TYPE_SERVER_CONNECTED | "server_connected" | (无额外字段) |

## 4. 数据设计

### 4.1 mapSSEEvent 事件映射表

| SSE 事件 | AgentEvent TYPE | 优先级 | 飞书展示 |
| -------- | --------------- | ------ | -------- |
| permission.updated | TYPE_PERMISSION | P0 | 权限确认卡片（带按钮） |
| permission.replied | TYPE_PERMISSION_REPLIED | P1 | 卡片标记已处理 |
| todo.updated | TYPE_TODO | P1 | 进度卡片条目 |
| session.compacted | TYPE_COMPACTED | P1 | 进度卡片"上下文已压缩" |
| file.edited | TYPE_FILE_EDITED | P1 | 进度卡片折叠摘要 |
| session.diff | TYPE_SESSION_DIFF | P2 | 进度卡片折叠 diff 摘要 |
| message.part.updated (step-start) | TYPE_STEP | P1 | 进度卡片显示步骤开始 |
| message.part.updated (step-finish) | TYPE_STEP | P1 | 进度卡片显示步骤完成 |
| message.part.updated (file) | TYPE_FILE_EDITED | P1 | 进度卡片折叠摘要 |
| message.part.updated (patch) | TYPE_FILE_EDITED | P1 | 进度卡片折叠摘要 |
| message.part.updated (snapshot/agent/retry/compaction/subtask) | 静默记录 | P2 | 不展示 |
| message.removed | TYPE_MESSAGE_REMOVED | P2 | 不展示（内部状态清理） |
| message.part.removed | TYPE_MESSAGE_REMOVED | P2 | 不展示（内部状态清理） |
| command.executed | TYPE_COMMAND_EXECUTED | P2 | 进度卡片命令结果摘要 |
| session.created | TYPE_SESSION_LIFECYCLE | P2 | 不展示（内部同步） |
| session.updated | TYPE_SESSION_LIFECYCLE | P2 | 不展示（内部同步） |
| session.deleted | TYPE_SESSION_LIFECYCLE | P2 | 不展示（内部同步） |
| server.connected | TYPE_SERVER_CONNECTED | P2 | 不展示（仅日志） |
| installation.*/lsp.*/vcs.*/file.watcher.*/tui.*/pty.* | null（丢弃） | P2 | 不展示 |

### 4.2 进度卡片展示规则

- **权限卡片**：独立卡片，header 红色（需关注），body 显示权限标题和元信息，按钮区"允许"/"拒绝"
- **权限已回复**：更新原权限卡片 header 为灰色，body 标注已处理结果
- **TODO 条目**：进度卡片新增条目 `📋 待办: 3/5 完成`
- **上下文压缩**：进度卡片新增条目 `🗜️ 上下文已压缩`
- **文件编辑**：进度卡片折叠条目 `📝 已编辑 3 个文件`，点击展开文件列表（如飞书支持）
- **步骤进度**：进度卡片条目 `▶ 步骤: 分析代码` / `✅ 步骤: 分析代码 完成`
- **命令执行**：进度卡片条目 `⬇ 命令: npm test (exit 0)`

## 5. 业务规则

- 规则 1：permission.updated 必须在飞书侧渲染为可交互卡片，用户点击按钮后 5 秒内回调 OpenCode 答复端点。
- 规则 2：权限超时不由 walker 侧处理，依赖 OpenCode 自身超时机制；walker 仅负责转发请求和用户响应。
- 规则 3：file.edited 和 session.diff 事件在同一个 session 生命周期内累计计数，进度卡片显示聚合摘要而非逐条展示。
- 规则 4：snapshot/agent/retry/compaction/subtask 等 part.type 映射到 AgentEvent 但不展示在卡片，仅写入 debug 日志，避免卡片信息过载。
- 规则 5：session.created/updated/deleted 事件用于 walker 内部 session 状态同步，不展示在飞书卡片。
- 规则 6：message.removed/message.part.removed 不展示在卡片，仅用于清理 MessageDispatcher 内部已记录的 deliveredText 等状态。
- 规则 7：所有新增 mapSSEEvent 分支必须在 eventBelongsToSession 过滤后处理，避免跨 session 事件误投递。
- 规则 8：进度卡片 entries 上限仍为 20 条，新增事件类型条目计入上限；超出时按现有 FIFO 淘汰。
- 规则 9：permission 卡片与进度卡片为独立卡片，不共享 entries 上限。
- 规则 10：/permit 命令仅接受 allow/deny 两个响应值，其他值返回错误提示。

## 6. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| permission.updated 缺少 title 或 id | 记录 warn 日志，仍渲染卡片但标题显示"未知权限请求" |
| 权限卡片按钮回调时 OpenCode server 不可达 | 飞书侧回复错误卡片提示"回复失败，请重试"，不静默丢弃 |
| 权限已被 OpenCode 超时处理后用户点击按钮 | OpenCode 返回 404 或错误，飞书更新卡片为"权限已过期" |
| file.edited 缺少文件路径 | 记录 warn 日志，计数仍累加但不显示文件名 |
| todo.updated 缺少 todos 数组 | 记录 warn 日志，不更新卡片 |
| session.deleted 对应的 walker session 不存在 | 记录 warn 日志，不抛错 |
| 同一 permissionId 的 permission.updated 重复到达 | 仅渲染一次权限卡片，重复事件更新原卡片而非新建 |
| message.part.updated 携带未知 part.type（未来新增） | return null 丢弃，记录 debug 日志 |
| /permit 命令缺少参数 | 返回用法提示 `/permit <permissionId> <allow\|deny>` |
| /permit 命令的 permissionId 不存在 | 调用 replyPermission 后 OpenCode 返回错误，飞书提示"权限不存在或已过期" |

## 7. 非目标

- 本次不实现飞书侧权限超时自动拒绝机制（依赖 OpenCode 超时）。
- 本次不实现权限"记住选择"功能（remember 字段传 false，UI 不暴露 remember 选项）。
- 本次不实现 session.diff 的完整 diff 展示（仅显示文件数和行数摘要）。
- 本次不实现 installation/lsp/vcs/file.watcher/tui/pty 事件的转发（静默丢弃）。
- 本次不修改现有 6 种 AgentEvent 类型的行为。
- 本次不实现 message.removed 的飞书消息撤回（仅内部状态清理）。
