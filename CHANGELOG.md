# 变更日志

本文件记录 Walker 项目的显著变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- 补充 LICENSE（MIT）、CONTRIBUTING.md、CHANGELOG.md 项目治理文档

## [0.1.0] - 2026-07

### 首次里程碑发布

Walker 飞书多 Agent CLI 桥接器的首个完整功能版本，实现通过飞书长连接操控本机 opencode agent 会话。

### 新增

#### 核心架构
- Node.js 单进程应用，CommonJS 模块系统
- 入口 `src/index.js` → `src/app/bootstrap.js`（createApp 组装所有组件）
- 分层架构：core / drivers / platform / admin / dispatch / runtime / hook / tui-bridge

#### 飞书平台集成
- 基于 `@larksuiteoapi/node-sdk` 的 WebSocket 长连接客户端
- 事件订阅 `im.message.receive_v1`，5 分钟去重窗口
- routeKey 三种路由模式：`thread`（消息线程）、`user`（用户）、`channel`（群）
- 结构化进度卡片（ProgressCard）实时更新，支持代码块等 markdown 渲染
- 表情回复（`FEISHU_REACTION_EMOJI` / `FEISHU_DONE_EMOJI`）

#### OpenCode 驱动
- 通过 `opencode serve` HTTP API/SSE 控制 OpenCode agent
- SSE 事件流全量覆盖，含权限确认卡片交互
- SSE 断流后自动 polling 恢复（`OPENCODE_RECOVERY_WINDOW_MS`）
- 独立超时控制：建连、提交、空闲超时均可单独配置

#### 1:N Session 路由
- 同一 routeKey 绑定多个 session，焦点 session 机制保证消息精准路由
- 路由结构 schema 版本 3，支持旧格式自动迁移
- `/use <id>` 切换焦点，`/list` 卡片按钮可视化切换
- 非焦点 session SSE 事件主动回卡片到群里，带 `[session: wks_N]` 标识

#### OpenCode 自动纳入（Hook 机制）
- 启动时自动安装 TUI bridge plugin 到 `~/.config/opencode/walker-tui-plugin.js`，并注册到 `~/.config/opencode/tui.json` 的 `plugin` 数组
- 内容一致则跳过写盘，内容变化时更新；旧版 `plugins/walker-hook.js` 自动清理
- 只接受本机 loopback 请求，复用 admin token 保护
- 心跳轮询 `/global/health` 检测 session 存活，连续 2 次失败判定 detached
- detached 后 `cancel` 模式自动取消 turn 并移除 session，`none` 模式仅记录

#### TUI Bridge
- 租约协议桥接 OpenCode TUI 与飞书
- 补 todo/compacted/file_edited/command_executed 事件推送飞书
- `/clear` 命令在当前 TUI 会话新建空上下文并保留旧会话

#### Web 管理端
- HTTP 管理服务含 token 鉴权、静态文件服务
- 22 个管理路由模块：session/route/agent-runtime/file/diagnostics/maintenance 等
- Web Admin Console 静态资源

#### 运行时支持
- `windows`：本机直接运行 Agent CLI
- `wsl`：通过 `wsl.exe -d <distro>` 在 WSL 中运行，自动探测 WSL IP
- runtime-factory 按 `WALKER_DEFAULT_RUNTIME` 选择

#### 长任务控制
- 进度卡片心跳：`WALKER_PROMPT_HEARTBEAT_INITIAL_MS` / `INTERVAL_MS` / `STUCK_MS`
- 单轮硬截止：`WALKER_MAX_TURN_TIME_MINS`，超时自动取消并抑制残留输出
- `/cancel` 取消当前 turn 保留 session 回到 idle

#### 飞书命令
- `/new [agent] [title]`、`/list`（含分页）、`/use <id>`、`/use off`、`/current`
- `/status`（`/ps` 别名）、`/cancel`、`/clear`、`/stop`、`/delete <id>`
- `/agents`、`/help`
- `/model` 模型切换

#### 测试与质量
- 33 个测试文件，907 个测试全部通过
- 单元测试 + 集成测试（feishu-tui-sync、hook-routing）
- 结构化 JSON 日志含敏感字段脱敏
- 全局错误处理统一 + 并发互斥 + parseBody 异步化

#### 工程化
- `.loom/` 工程化流水线配置（8 种流水线类型）
- PowerShell 运维脚本：start/status/stop/logs
- `.env.example` 配置示例（18 项）
- README.md 含 30+ 项环境变量详细说明

### Agent 扩展预留
- `opencode`：P0 已实现，通过 HTTP API/SSE 控制
- `claude`：预留扩展点，Claude Code CLI
- `codex`：预留扩展点，Codex CLI

[Unreleased]: https://github.com/anomalyco/walker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/anomalyco/walker/releases/tag/v0.1.0
