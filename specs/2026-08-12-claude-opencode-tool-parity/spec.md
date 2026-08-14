# Claude 工具接入向 OpenCode 对齐 — 需求规格

## 1. 概述

**需求来源**：用户反馈 Claude 工具接入存在大量问题，要求分析当前支持状态、查阅资料并全面向 OpenCode 方向对齐。
**需求类型**：修改 / 跨模块能力增强 / 兼容性修复。
**选定方案**：方案 A — 保留长期 Claude TUI，补齐统一启动配置、结构化事件与真实能力诊断。

本项目已经确定 Claude 会话由 Walker 持有长期 ConPTY，并通过本地 sidecar/attach 让飞书和外部终端共享同一个 Claude 进程。此次不改写这条架构主线，而是在它之上修复配置未传入 TUI、过期权限默认值、transcript 丢失工具事件、配置面与管理面缺项等问题。

“向 OpenCode 对齐”定义为：相同业务能力使用统一的 Walker 语义；Claude Code 2.1.228 能可靠提供的能力应接入；Claude TUI 没有结构化协议的能力必须显式标记为降级或不支持，不伪造 HTTP、permission reply 或 question reply。

## 2. 现状与能力矩阵

| 能力 | OpenCode 当前状态 | Claude 当前状态 | 本次目标 |
| ---- | ----------------- | --------------- | -------- |
| 长期会话与 TUI | server/TUI bridge | 长期 ConPTY + sidecar | 保持现有架构与单进程语义 |
| model/agent | 可按 agent 配置 | driver 有配置但 TUI 启动未使用 | 统一传入 create/resume |
| tools allow/deny | `allow/ask/deny` 规则 | CLI allowed/disallowed tools | 接入 Claude 原生规则并说明非同构边界 |
| tool set | 按工具权限启停 | CLI `--tools` 未接入 | 支持显式工具集合 |
| custom agents | primary/subagent 配置 | CLI `--agents` 未接入 | 支持 JSON 配置并预校验 |
| MCP | local/remote/OAuth/agent 规则 | CLI `--mcp-config` 未接入 | 支持一个或多个配置及 strict 模式 |
| settings | OpenCode 配置层 | `configDir` 被错误当作 `--settings` | 拆分 transcript 根与 settings 文件 |
| plugins | plugin/tool 生态 | CLI plugin 参数未接入 | 支持本地 plugin 目录，远程 URL 不默认开放 |
| permission mode | 结构化 once/always/reject | 默认值 `default` 已失效 | 合法枚举、旧值迁移、安全模式保护 |
| permission reply | HTTP/TUI protocol v5 | 无可靠结构化 TUI reply | 保持不支持并输出明确诊断 |
| question reply | TUI protocol v4 | 无可靠结构化 TUI reply | 可观察时转发事件，不伪造 reply |
| reasoning/tool use | 统一 AgentEvent | transcript 只保留文本 | 解析 thinking、tool_use、tool_result 及关联 ID |
| hooks/subagent | 可观察丰富事件 | CLI 支持但当前长期 TUI 未接入 | 仅在数据源真实提供时映射，不重复事件 |
| session history | server session list | 正在补齐 transcript 扫描 | 保留并兼容当前未提交实现 |
| capabilities/admin | provider catalog 可查询 | Claude 字段不完整 | 暴露配置、限制和降级原因 |

## 3. 方案比较

### 方案 A：扩展现有长期 TUI 架构（推荐）

架构思路：
- 建立唯一的 Claude 启动参数构造逻辑，由 driver 配置产生 create/resume 参数，并交给 PTY broker 使用。
- 配置按 Claude CLI 的真实能力分组：通用启动参数、仅 stream-json 可用参数、危险参数和 Walker 内部参数。
- 增强 transcript content block 解析，将可证明存在的 Claude 事件映射为统一 `AgentEvent`。
- provider catalog、配置加载、bootstrap 和管理面共用同一能力描述，显式报告 unsupported/degraded 能力。

数据流：
- 环境变量或管理配置进入统一 config schema，完成类型和安全校验。
- bootstrap 构造 `ClaudeDriver`；driver 生成经过校验的 launch options；broker 用相同选项启动 `--session-id` 或 `--resume` TUI。
- Claude JSONL transcript 由 watcher 按精确 cwd + UUID 读取，解析文本、思考、工具调用、工具结果和已知系统事件，再送入统一分发链路。
- 管理面读取 provider catalog，展示实际生效项和不支持项，不根据 OpenCode 能力推断 Claude 已支持。

Trade-off：
- 优点：修复核心配置失效问题；保留长期 TUI、sidecar 重连和单进程约束；改动可由单元测试覆盖；不会引入第二套 Claude 会话模型。
- 缺点：Claude TUI 的 permission/question 交互仍不可能达到 OpenCode 结构化协议同等水平；部分 stream-json 专属事件只能声明不可用。

### 方案 B：把 Claude 改为长期 headless stream-json worker

架构思路：以 `--input-format stream-json --output-format stream-json` 运行后台 Claude 进程，通过结构化流统一工具、hook、permission 和 question 事件。

Trade-off：
- 优点：结构化事件最完整，协议形态更接近 OpenCode server。
- 缺点：破坏已批准的共享原生 TUI 架构；同一进程不能同时作为完整交互 TUI；会重写 attach、恢复和输入仲裁，回归风险过高。本次不采用。

### 方案 C：仅补配置参数，不增强事件和诊断

架构思路：直接把现有 driver 参数传给 broker，并增加少量环境变量。

Trade-off：
- 优点：改动最少。
- 缺点：tool_use/tool_result 仍丢失；管理面继续误报能力；权限和 question 的差异无法诊断；不能满足“功能全面向 OpenCode 方向对齐”。本次不采用。

## 4. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | 统一 Claude create/resume 启动配置 | P0 | 给定有效 Claude 配置，创建和恢复长期 TUI 时均使用同一参数语义，且只启动一个 Claude 进程 |
| REQ-002 | 工具、agent、MCP、settings 与 plugin 配置接入 | P0 | 给定各类配置，CLI 参数准确、顺序稳定、输入经过校验，Walker 内部路径不再冒充 settings 文件 |
| REQ-003 | 权限配置安全化与兼容迁移 | P0 | 合法模式正确生效，旧 `default` 被兼容为省略参数并告警，危险跳权不能被普通配置意外启用 |
| REQ-004 | transcript 结构化事件完整性 | P0 | Claude JSONL 中的文本、thinking、tool_use、tool_result 能被解析、关联并按统一事件顺序输出 |
| REQ-005 | permission/question/hook 能力诚实降级 | P0 | 数据源有可靠事件时可观察；没有结构化回复通路时 capability 明确为 unsupported/degraded，调用返回稳定错误 |
| REQ-006 | 配置、provider catalog 与管理面一致 | P1 | 新配置可从集中配置进入 driver，provider/admin 展示实际支持项、有效值和限制 |
| REQ-007 | 长期 TUI、sidecar、历史会话与 OpenCode 回归兼容 | P0 | 不产生第二 Claude 进程，不破坏重连/attach/精确 transcript/历史列表，OpenCode 行为不变 |
| REQ-008 | 可诊断性与版本漂移保护 | P1 | 非法或当前模式不支持的参数在启动前失败或告警，日志不泄密并能定位最终参数类别与降级原因 |

## 5. 接口与配置设计

### 5.1 Claude 启动配置

继续通过项目集中配置系统注入 `ClaudeDriver`，新增或纠正以下逻辑字段；具体环境变量名称在 planning 阶段按现有命名规则确定：

| 字段 | 类型 | CLI 映射 | 规则 |
| ---- | ---- | -------- | ---- |
| `model` | string | `--model` | 可选 |
| `fallbackModel` | string | `--fallback-model` | 可选 |
| `agent` | string | `--agent` | 可选 |
| `agents` | object/JSON | `--agents` | 必须是 JSON object |
| `tools` | string list | `--tools` | 显式工具集合，空数组语义必须可区分未配置 |
| `allowedTools` | string list | `--allowed-tools` | 使用 Claude 原生 pattern，不宣称等价 OpenCode rule |
| `disallowedTools` | string list | `--disallowed-tools` | deny 优先级遵循 Claude CLI |
| `permissionMode` | enum | `--permission-mode` | 仅允许当前 CLI 合法枚举；未配置则不传 |
| `addDirs` | path list | 重复 `--add-dir` | 规范化并保留多值 |
| `mcpConfigs` | path/JSON list | 重复 `--mcp-config` | strict 模式要求至少一项 |
| `strictMcpConfig` | boolean | `--strict-mcp-config` | 默认 false |
| `settingsFile` | path/JSON | `--settings` | 与 transcript `configDir` 完全分离 |
| `settingSources` | enum list | `--setting-sources` | 仅接受 CLI 支持值 |
| `pluginDirs` | path list | 重复 `--plugin-dir` | 本次仅接入本地目录 |
| `bare` | boolean | `--bare` | 默认 false |
| `safeMode` | boolean | `--safe-mode` | 默认 false，不与危险跳权组合 |
| `disableSlashCommands` | boolean | `--disable-slash-commands` | 默认 false |

`configDir` 继续只表示 Claude transcript/config 数据根目录，不再生成 `--settings <configDir>`。

### 5.2 启动参数构造边界

- create 使用 `--session-id <UUID>`，resume 使用 `--resume <UUID>`；公共配置参数在两条路径保持一致。
- 长期 PTY 路径不得添加 `--print`、`--input-format stream-json` 或 `--output-format stream-json`。
- 仅 stream-json 可靠支持的 hook、partial message、forward-subagent-text 参数不得盲目传给长期 TUI。
- 参数以数组传给 spawn，不拼接 shell 命令；密钥、token 和完整 JSON 不写入普通日志。
- 参数构造必须可单独测试，且 driver 与 broker 不各自维护一份规则。

### 5.3 统一 AgentEvent 扩展

Claude 事件映射至少保留：

| Claude block/record | Walker 事件 | 必要关联字段 |
| ------------------- | ------------ | ------------ |
| assistant text | `text` | session/turn 顺序 |
| thinking | `reasoning` | session/turn 顺序 |
| tool_use | `tool_use` phase=`start` | tool name、call ID、input |
| tool_result | `tool_use` phase=`result` | call ID、content、is_error |
| 可识别任务列表 | `task_list` | 原始状态与内容 |
| 可识别 question | `question_asked` | question ID 或稳定降级 ID、选项 |
| hook/system diagnostic | `status` 或专用既有事件 | 原始类型、可脱敏摘要 |

若现有 `AgentEvent` 缺少 tool call 关联字段，应做最小向后兼容扩展；OpenCode 现有生产者和消费者不得因此改变行为。

### 5.4 能力报告

Claude provider 必须区分：
- `supported`：Walker 已有可靠调用和测试。
- `degraded`：可以观察或经 TUI 操作，但没有 OpenCode 等价结构化控制协议。
- `unsupported`：Claude 当前运行模式没有可靠实现。

permission reply 和 question reply 在没有 Claude 官方结构化 TUI 通路时不得标记为 `supported`。管理面应能展示原因，而不是仅显示笼统布尔值。

## 6. 数据与状态规则

- 不新增第二套会话存储；继续使用现有 `agentRef`、精确 Claude UUID 和 canonical cwd。
- 启动配置是 driver/provider 配置，不把完整 agents JSON、MCP 内容或 settings 内容复制进 session 持久化状态。
- tool call ID 只用于事件关联，不作为跨进程恢复依据。
- 历史会话扫描继续以 transcript 元数据为准；本次修改必须兼容工作区中正在进行的历史列表实现。
- 配置为空、未配置和显式空集合的语义必须由测试固定，避免意外恢复 Claude 默认工具集合。

## 7. 业务与安全规则

- 默认权限行为由 Claude CLI 当前安全默认值决定，Walker 未配置时不传过期或自造模式。
- 旧配置值 `default` 仅作为已发布配置的迁移入口：转换为“不传 `--permission-mode`”并记录一次脱敏告警，不继续把它传给 CLI。
- `bypassPermissions` 必须同时具备明确危险开关；仅设置 permission mode 不足以启用，且不得与 `safeMode` 同时使用。
- `allowedTools`/`disallowedTools` 使用 Claude 原生匹配语义，不转换成声称完全等价的 OpenCode `allow/ask/deny` 规则。
- MCP strict 模式、settings 来源、agents JSON 等组合在 spawn 前校验；失败不得创建部分 runtime 或覆盖活跃 runtime。
- 普通飞书文本在已知 permission UI 或本地编辑 lease 状态下仍不得直接注入为选择按键。
- 不通过解析终端 ANSI 文本猜测并自动批准权限或回答问题。
- sidecar 必须继续只绑定 loopback、校验 token，并对日志和错误做敏感信息脱敏。

## 8. 异常与边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| `permissionMode=default` | 不传 permission mode，记录迁移告警，启动继续 |
| 未知 permission mode | 启动前返回明确配置错误，不创建 runtime |
| `bypassPermissions` 未提供危险确认 | fail closed，不启动 Claude |
| `safeMode` 与危险跳权同时配置 | 返回冲突错误，不静默选择其中一个 |
| agents JSON 畸形或不是 object | 启动前拒绝并指出字段，不把原文写入日志 |
| strict MCP 开启但未配置 MCP | 启动前拒绝 |
| settings 指向目录 | 明确拒绝；`configDir` 仍只用于 transcript |
| transcript 出现未知 content block | watcher 继续运行，产生可诊断但有界的状态信息，不丢失同记录中的已知 block |
| tool_result 先于或缺少 tool_use | 保留 call ID 和结果事件，标记 orphan，不崩溃也不错误关联 |
| transcript 部分 JSONL 行 | 等待后续写入或跳过当前不完整行，不能终止 watcher |
| permission/question 无 reply 通路 | 事件可观察时转发；reply API 返回稳定 unsupported 错误，不向 TUI 注入普通文本 |
| Claude CLI 新版本移除参数 | 启动错误包含参数类别和版本诊断，不泄露敏感参数值 |
| 同一会话连续 prompt | 始终复用同一 PTY/runtime，spawn 次数不增加 |

## 9. 非目标

- 不把 Claude 长期 TUI 替换为 headless stream-json worker。
- 不为 Claude 伪造 OpenCode HTTP server、permission reply 或 question reply 协议。
- 不实现跨机器 Claude TUI 控制或远程 attach。
- 不自动批准 MCP、工具权限、project trust 或 settings trust 提示。
- 不接入未经安全评估的远程 plugin URL。
- 不改变 OpenCode driver、TUI bridge 和插件协议语义。
- 不重做正在开发的 Claude 历史会话列表，只保证兼容并补充必要回归测试。

## 10. 完成标准

- 所有 `REQ-001` 至 `REQ-008` 的行为义务均有真实测试和证据映射。
- Claude create/resume 的参数快照测试覆盖有效配置、无配置、旧值迁移、非法组合和危险模式。
- transcript fixture 覆盖 text、thinking、tool_use、tool_result、错误结果、未知 block 和部分行。
- provider/config/admin 测试证明展示值与实际 driver 行为一致。
- Claude PTY、sidecar 重连、attach、历史会话和 OpenCode 相关回归测试全绿。
- 实现 diff 不包含对用户现有未提交改动的回退。
