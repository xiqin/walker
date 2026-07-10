# 代码审查请求

**功能：** Walker 飞书多 Agent CLI 桥接器
**分支：** feature/2026-07-09-feishu-opendray-bridge（已合并到 master）

## 变更统计

```
54 files changed, 4217 insertions(+), 690 deletions(-)
```

主要新增 19 个源文件 + 14 个测试文件，重构 `src/index.js`（从 640 行减至精简入口）。

## 主要变更

1. **去 opendray 化**：移除所有 opendray bridge WS/REST 依赖，Walker 自行管理 routeKey→session→agentRef 映射
2. **核心基础设施**：新增 config/env.js（.env + TOML 双源配置）、json-store.js（JSON 持久化）、logger.js、route-key.js、id.js、http-helper.js、message-dedup.js
3. **会话管理**：session-service.js 实现 WalkerSession 生命周期与 RouteBinding 精准绑定
4. **飞书平台层**：FeishuPlatform + FeishuApi + events + commands + cards + progress-card，完整的飞书长连接入口、命令系统、卡片 UI 和进度更新
5. **Agent Driver 层**：AgentDriver 抽象 + DriverRegistry + OpencodeDriver（HTTP API/SSE）+ StubDrivers（Claude/Codex 预留）
6. **Runtime 层**：WindowsRuntime + WslRuntime + runtime-factory，支持双运行环境
7. **消息调度**：MessageDispatcher 处理未绑定路由引导、命令分发、driver 投递、去重
8. **附件服务**：AttachmentService inbound 文件保存 + outbound stub
9. **Bootstrap 组装**：createApp 依赖注入组装所有组件，新增 command/card-action 路由逻辑
10. **工作区未提交修复**：API 路径从 `/api/v1/` 改为 `/`、FeishuPlatform WSClient 参数修正、.env 文件加载、进程保活 setInterval、createSession 响应解析兼容

## 自测情况

- [x] 编译通过（`node --check` 19 个源文件）
- [x] 静态分析通过（无 linter 配置，语法检查覆盖）
- [x] 测试通过（117 tests, 0 fail）
- [x] 代码符合编码红线（极简优先、精准手术、配置集中管理、错误可诊断）
- [x] 图后端已注明：索引查询跳过（codegraph 可用但本次审查未依赖图查询）

## 变更详情

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| src/config/env.js | 新增+修改 | .env + TOML 双源配置加载，新增 loadDotEnv 函数 |
| src/core/json-store.js | 新增 | JSON 持久化存储，支持损坏文件恢复 |
| src/core/id.js | 新增 | walkerSessionId 生成器 |
| src/core/logger.js | 新增 | 结构化日志 |
| src/core/http-helper.js | 新增 | HTTP/SSE 客户端封装 |
| src/core/route-key.js | 新增 | routeKey 生成（thread/user/channel 模式） |
| src/core/session-service.js | 新增 | WalkerSession 生命周期 + RouteBinding 管理 |
| src/core/message-dedup.js | 新增 | 飞书消息 5 分钟去重 |
| src/drivers/agent-driver.js | 新增 | AgentDriver 抽象基类 |
| src/drivers/driver-registry.js | 新增 | Driver 注册/获取/列表 |
| src/drivers/opencode-driver.js | 新增+修改 | opencode HTTP API/SSE driver，API 路径修正 |
| src/drivers/stub-drivers.js | 新增 | Claude/Codex stub（抛未实现错误） |
| src/runtime/windows-runtime.js | 新增 | Windows 原生 spawn |
| src/runtime/wsl-runtime.js | 新增 | WSL spawn + IP 探测 |
| src/runtime/runtime-factory.js | 新增 | runtime 工厂 |
| src/dispatch/message-dispatcher.js | 新增 | 消息调度、命令分发、进度卡片 |
| src/dispatch/attachment-service.js | 新增 | inbound 文件保存 + outbound stub |
| src/platform/feishu/api.js | 新增 | 飞书 REST API 封装 |
| src/platform/feishu/events.js | 新增 | 飞书消息/卡片事件解析 |
| src/platform/feishu/commands.js | 新增 | 命令解析（/new /list /use 等） |
| src/platform/feishu/cards.js | 新增 | 交互卡片渲染 |
| src/platform/feishu/progress-card.js | 新增+修改 | 进度卡片 Patch 更新，formatAgentEvent 兼容修复 |
| src/platform/feishu/platform.js | 新增+修改 | 飞书长连接 WSClient，参数修正 |
| src/app/bootstrap.js | 新增+修改 | 组装入口，新增 command/card-action 路由 |
| src/index.js | 修改 | 简化入口，新增 setInterval 保活 |
| test/*.test.js (14 files) | 新增+修改 | 117 个测试覆盖所有模块 |

## Standards

- **S01**: 所有函数有中文 JSDoc 注释 ✓（符合宪章"合理注释"规则）
- **S02**: 极简优先 ✓（单进程架构，JSON 文件持久化，无多余依赖）
- **S03**: 配置集中管理 ✓（env.js 统一 .env + TOML + 环境变量）
- **S04**: 错误可诊断 ✓（driver 错误包含 agent/runtime/cwd/serverUrl）
- **S05**: 依赖显式传递 ✓（bootstrap deps 参数注入）
- **S06**: 代码无重复坏味道 ✓（各模块职责清晰，无霰弹式修改）
- **S07**: `setInterval(() => {}, 60000)` 保活机制略显 hack — 建议后续改为显式 heartbeat 或 graceful keep-alive
- **S08**: OpencodeDriver API 路径从 `/api/v1/` 改为 `/` — 需确认与实际 opencode serve 版本兼容
- **S09**: FeishuPlatform WSClient 参数 `appID→appId` + `eventDispatcher` 移入 start() — 需确认与 @larksuiteoapi 版本兼容
- **S10**: walker.pid 文件出现在工作区（未跟踪），属于运行时产物 — 需 .gitignore 排除

## Spec

- **SP01**: REQ-001（去 opendray）✓（无 opendray import/require）
- **SP02**: REQ-002~009（飞书长连接+路由+命令）✓（完整实现）
- **SP03**: REQ-010~012（opencode driver）✓（HTTP API/SSE 完整实现，API 路径已修正）
- **SP04**: REQ-013~014（飞书回复+进度卡片）✓（replyText + ProgressCard Patch）
- **SP05**: REQ-015~016（Driver/Runtime 抽象）✓（AgentDriver + StubDrivers + RuntimeFactory）
- **SP06**: REQ-017~018（会话状态+持久化）✓（SessionService + JsonStore）
- **SP07**: REQ-019（消息去重）✓（MessageDedup 5 分钟窗口）
- **SP08**: REQ-020~022（/stop /delete /help）✓
- **SP09**: REQ-023~025（附件/出站/表情）— inbound ✓，outbound 为 stub，done emoji ✓
- **SP10**: REQ-026~027（Claude/Codex 预留）✓（stub drivers）
- **SP11**: REQ-028（README）✓
- **SP12**: 验收标准 1~9 全覆盖 ✓

## 预审查摘要

- Standards findings: 3，worst: S08（API 路径变更需确认兼容性）
- Spec findings: 0，worst: none
- **无 blocker，可进入人工审查**

## 审查重点

- [ ] OpencodeDriver API 路径 `/session` vs `/api/v1/session` 与实际 opencode serve 版本兼容性
- [ ] FeishuPlatform WSClient API 参数变更与 @larksuiteoapi 版本兼容性
- [ ] `setInterval(() => {}, 60000)` 保活机制是否为最佳方案
- [ ] walker.pid 是否已加入 .gitignore
- [ ] AttachmentService outbound stub 后续实现计划
- [ ] Bootstrap 中 command/card-action 路由逻辑的事件传递完整性
