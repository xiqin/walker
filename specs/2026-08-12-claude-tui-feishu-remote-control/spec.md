# Claude 原生 TUI 与飞书单进程协同 — 需求规格

## 1. 概述

**需求来源**：用户实测 Claude/kscc 会话绑定飞书后，飞书消息会拉起新窗口，且新窗口因历史 ANSI 字节回放出现欢迎语、历史输入和重复状态栏混杂。
**需求类型**：Claude provider 运行时与 attach 行为修复
**选定方案**：改良单一 PTY runtime。Walker 保持唯一长期 Claude/kscc TUI 进程，飞书通过受控输入事务操作该进程；自动恢复与打开观察窗口解耦；attach 改为显式、无历史 ANSI 回放。

当前 Claude provider 已由 Walker 持有长期 ConPTY，并让外部终端通过 `walker claude attach <runtime-id>` 连接。问题来自两处耦合：飞书发现 runtime 不活跃时，`resumeSession()` 在恢复 PTY 后无条件打开 attach 窗口；新 attach 客户端又接收 broker 保存的历史 TUI 原始字节，而这些字节不是当前屏幕快照，无法在新终端可靠重建状态。

本次改造不引入第二个 Claude 进程，不恢复每轮 `--print`，不逆向 Claude Remote Control 私有客户端协议。配置 `CLAUDE_CMD=claude` 或 `CLAUDE_CMD=kscc` 均使用相同的单 PTY 行为。官方 Remote Control 仅作为已调查但不采用的方案：公开 SDK 提供 worker 端能力，没有第三方客户端向现有原生 TUI worker 投递飞书消息的稳定公开 API；kscc 公司后端当前也明确拒绝 Remote Control。

### 1.1 方案比较

| 方案 | 优点 | 代价与风险 | 结论 |
| ---- | ---- | ---------- | ---- |
| 单一 PTY + 显式无回放 attach | 保留原生 TUI、飞书实时操作同一进程；最小修复弹窗和乱码根因 | 重连窗口只显示连接后的实时输出，不承诺恢复当前屏幕 | 采用 |
| PTY + 终端模拟器屏幕快照 | 重连时可恢复当前屏幕 | 引入完整 VT/xterm 状态机、resize 和 alternate-screen 维护，范围与依赖显著扩大 | 本次不采用 |
| Claude Remote Control Bridge | 理论上提供结构化事件 | 公开 SDK 是 worker 端；第三方客户端 API 未公开；kscc 当前后端不支持 | 不可用 |
| 每轮 `claude/kscc --print --resume` | 结构化输出易处理 | 产生第二进程并与原生 TUI 并发恢复同一会话 | 禁止 |

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | 单 runtime 所有权 | P0 | 每个活动 Walker Claude 会话最多存在一个 Claude/kscc PTY 进程，飞书 prompt 不启动第二进程 |
| REQ-002 | 恢复与窗口解耦 | P0 | 飞书触发 runtime 恢复时不打开新终端；仅新建会话或显式 attach 打开窗口 |
| REQ-003 | 无历史 ANSI 回放 | P0 | 新 attach 客户端不接收连接前的 TUI 原始字节，不出现历史欢迎语、输入和状态栏拼接 |
| REQ-004 | 飞书输入安全仲裁 | P0 | 飞书 prompt 仅在安全输入状态以完整事务写入同一 PTY；本地编辑、权限界面和忙碌状态不被污染 |
| REQ-005 | 精确 transcript 回复 | P0 | 飞书回复只来自绑定 cwd 与 Claude UUID 的本轮 JSONL assistant 事件，不从屏幕抓取 |
| REQ-006 | 生命周期与诊断 | P1 | attach 失败、PTY 退出、队列拒绝和不可恢复状态均返回明确诊断且不泄露敏感信息 |
| REQ-007 | 兼容与回归边界 | P0 | `claude` 与 `kscc` 命令配置均遵循相同行为，OpenCode provider 和既有会话语义不变 |

## 3. 接口与组件设计

### 3.1 ClaudeDriver 恢复语义

- `createSession()` 创建唯一 PTY runtime，并允许为新会话打开一次初始 attach 窗口。
- `resumeSession()` 只保证 PTY runtime 可写，不得隐式调用打开窗口逻辑。
- dispatcher 为飞书普通消息恢复 Claude agentRef 时使用无窗口恢复语义。
- 显式用户操作通过现有或新增的 attach 命令打开窗口；重复显式 attach 可以创建观察客户端，但不得创建第二个 Claude/kscc 进程。
- `prompt()` 必须写入 agentRef 指向的唯一活动 runtime，不得回退到 `--print`、后台 agent 或第二个 `--resume` 进程。

### 3.2 attach 语义

- attach server 新连接默认 `replay: false`。
- broker 可以保留有限诊断缓冲供内部日志或未来终端快照实现使用，但不得把历史 TUI 原始字节自动发送给新客户端。
- attach 成功后只转发连接时刻之后的 PTY 数据、运行状态和关闭原因。
- attach 客户端不得尝试解析、去 ANSI 或拼接历史屏幕；stdout 仍原样输出实时 PTY 字节。
- 本次不承诺重连时立即显示当前完整 TUI 屏幕。用户可等待下一次 TUI 刷新或在安全情况下通过本地操作触发刷新；Walker 不自动注入 `Ctrl+L` 等按键。

### 3.3 输入事务与状态门禁

- 飞书 prompt 作为单个不可交错事务写入完整文本和一次 Enter。
- attach 本地输入持有 writer lease 时，飞书 prompt 有界排队。
- 已知 Claude 正在执行、处于权限选择或存在未提交本地编辑时，普通飞书文本不得直接注入 PTY。
- 队列达到上限时明确拒绝，不无限增长。
- 中断和权限回复使用专用控制路径；不得把普通文本伪装成选择按键。

### 3.4 transcript 观察

- prompt 写入前为绑定的 `claudeSessionId` 创建精确 transcript cursor。
- 回复仅收集 cursor 之后对应 assistant 事件，并映射为统一 `AgentEvent`。
- transcript 路径由 canonical cwd、配置根目录和精确 UUID 确定，禁止按最新修改时间猜测文件。
- transcript 超时、缺失或出现部分记录时返回明确错误，不读取其他会话文件，也不从 ANSI 屏幕提取回复。

### 3.5 agentRef

持久化引用继续使用现有 Claude agentRef，并明确窗口不是 runtime 活跃性的必要条件：

```json
{
  "provider": "claude",
  "transport": "pty-attach",
  "claudeSessionId": "uuid",
  "runtimeId": "walker-runtime-id",
  "cwd": "canonical path",
  "terminal": {
    "status": "active-or-detached"
  }
}
```

PTY runtime 活跃与终端 attach 客户端在线是两个独立状态。`isSessionRefActive()` 判断可写性时以 runtime 为准，不要求窗口在线。

## 4. 业务规则

- 一个 Walker Claude session 最多有一个主 Claude/kscc PTY 进程。
- 飞书自动恢复不得产生用户可见窗口。
- 新建会话允许打开一次初始窗口；之后窗口只能由显式 attach 操作创建。
- attach/detach 不改变 Claude conversation 所有权，不杀死主进程。
- 新 attach 不回放历史 ANSI 字节。
- 飞书与本地终端共享同一输入仲裁器和同一 Claude conversation。
- `CLAUDE_CMD` 指向 `claude` 或 `kscc` 只决定可执行命令，不改变上述安全约束。
- 不因 `claude` 命令存在 `--remote-control` 参数就宣称 Walker 支持官方结构化多客户端。

## 5. 异常与边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| 飞书消息到达且 runtime 活跃、无窗口 | 直接复用 runtime，不打开窗口 |
| 飞书消息到达且 runtime 已失效但可按 UUID 恢复 | 启动一个新 PTY runtime 并 `--resume <uuid>`，不打开窗口 |
| 用户显式 attach | 打开 attach 客户端，只接收连接后的实时输出 |
| attach 客户端断线后重连 | 主 runtime 保持活动；重连不收到历史 ANSI replay |
| 本地用户正在编辑半行 | 飞书 prompt 排队，不插入当前行 |
| Claude 处于权限界面 | 普通飞书 prompt 排队或拒绝，不作为权限按键写入 |
| 飞书队列已满 | 返回稳定错误和可操作提示，不写 PTY |
| transcript 超时或缺失 | 返回明确失败，不读取其他 session，不使用屏幕输出冒充回复 |
| PTY 进程异常退出 | pending prompt 全部失败完成，runtime 标记 error，不自动弹窗 |
| `CLAUDE_CMD=kscc` | 使用单 PTY 路径；不尝试不可用的 Remote Control |
| `CLAUDE_CMD=claude` 且存在自定义 endpoint | 仍使用单 PTY 路径；不自动修改用户认证或端点环境 |
| OpenCode 会话运行 | 不受 Claude driver、PTY broker 或 attach 改动影响 |

## 6. 可观测性与性能

- 日志记录 runtimeId、脱敏 Claude session ID、输入来源、队列深度、恢复原因、显式 attach/detach 和 PTY 退出原因。
- 日志不得记录完整 prompt、attach token、API key、OAuth token或完整敏感环境变量。
- 飞书 prompt 队列保持固定上限，沿用现有默认值或配置值。
- attach 建立不得发送连接前的 replay 数据，因此连接成本不随历史 TUI 输出增长。
- 不使用固定 sleep 判断轮次完成，以 transcript 边界和现有超时机制为准。

## 7. 兼容性与迁移

- 现有 `transport: pty-attach` agentRef 无需数据迁移。
- Walker 重启后仍可按精确 Claude UUID 恢复新 PTY runtime，但恢复本身不再自动打开窗口。
- 已有显式 `walker claude attach <runtime-id>` 命令保持可用。
- 如当前 attach 协议存在 replay 参数，服务端必须忽略客户端请求的历史 TUI replay，或只允许受控内部诊断用途；用户 attach 默认且强制无 replay。
- 不修改 OpenCode TUI bridge、OpenCode driver、OpenCode session ID 或 watcher 语义。

## 8. 非目标

- 不实现或逆向 claude.ai Remote Control 客户端私有协议。
- 不使用 Agent SDK Bridge 抢占原生 TUI worker epoch。
- 不为 kscc 切换公司后端或修改用户认证配置。
- 不引入 xterm.js、终端模拟器或当前屏幕快照恢复。
- 不在重连时自动注入 `Ctrl+L`、resize 或其他可能改变 TUI 状态的按键。
- 不恢复每轮 `claude/kscc --print --resume` 双进程模式。
- 不支持多个 writer 同时编辑，也不支持网络远程 attach。
