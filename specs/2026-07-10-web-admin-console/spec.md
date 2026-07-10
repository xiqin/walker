# Walker 网页管理端 — 需求规格

## 1. 概述

**需求来源**：用户要求“全部实现这些功能”，范围来自上一轮管理端功能清单。  
**需求类型**：新增功能。  
**选定方案**：方案 A — 在现有 Walker Node.js 单进程内增加本地 Admin HTTP 服务，提供管理 API 与静态网页控制台。

Walker 当前是飞书长连接到本机 Agent CLI 的轻量桥接器。管理端的定位不是通用 SaaS 后台，而是本机 Agent Hub 控制台，用于观察运行状态、管理 session/route、诊断飞书与 OpenCode/runtime 问题、执行受控维护操作。

## 2. 方案比较

### 方案 A：内置 Admin HTTP 服务（推荐）

- **架构思路**：在 `createApp(config)` 中可选启动 `AdminServer`，复用现有 `config`、`sessionService`、`registry`、`platform`、`dispatcher`、runtime、卡片渲染器和文件存储。前端静态文件由同一 HTTP 服务托管。
- **数据流**：浏览器访问 `127.0.0.1:<adminPort>`，通过 `/api/admin/*` 调用管理 API；API 读取 `.walker` 数据、日志文件和现有服务实例，写操作走已有 service/driver 方法。
- **优点**：部署最简单；不引入独立进程；能直接访问运行中服务状态；符合本地工具定位。
- **缺点**：Admin 服务异常可能影响主进程，需要隔离路由错误并提供关闭开关。
- **取舍**：以最小依赖和最小部署复杂度换取同进程耦合，适合当前项目规模。

### 方案 B：独立 Web 管理进程

- **架构思路**：新增独立管理端进程，通过本地 HTTP 或文件读取访问 Walker 状态。
- **优点**：管理端故障不影响主桥接器；未来可独立部署。
- **缺点**：需要额外进程生命周期、跨进程通信和权限同步；无法直接调用运行中 driver/watch 状态。
- **取舍**：复杂度高于当前收益，本次不采用。

### 方案 C：只做静态数据查看器

- **架构思路**：纯静态页面读取导出的 JSON/log 快照。
- **优点**：实现成本低，风险最低。
- **缺点**：不能执行 stop/delete/bind/prompt/health/service control 等用户要求的“全部功能”。
- **取舍**：不满足需求，本次不采用。

## 3. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | Admin 服务开关与绑定地址 | P0 | 给定默认配置，当启动 Walker 时，管理端默认只监听 `127.0.0.1`；当 `WALKER_ADMIN_ENABLED=false` 时，不启动管理端。 |
| REQ-002 | Token 访问控制 | P0 | 给定设置了 `WALKER_ADMIN_TOKEN`，当请求管理页面或 API 未携带有效 token 时，则返回 401 或显示登录界面；敏感写操作必须要求 token。 |
| REQ-003 | 总览 Dashboard | P0 | 给定 Walker 正常启动，当访问首页时，则展示进程状态、启动时间、版本、数据目录、飞书连接摘要、Agent 服务摘要、session 统计、route 统计、最近错误。 |
| REQ-004 | Session 列表与详情 | P0 | 给定已有 `sessions.json`，当打开 Sessions 页时，则展示未删除 session；当点击详情时，则展示 `id/title/agent/status/runtime/cwd/agentRef/routeKeys/errorMessage/createdAt/updatedAt`。 |
| REQ-005 | Session 创建 | P0 | 给定输入 agent、title、runtime、cwd，当提交创建时，则创建 Walker session；若 agent 为 `opencode` 且选择创建底层会话，则调用 driver 创建底层 session 并写入 `agentRef`。 |
| REQ-006 | Session 停止与删除 | P0 | 给定 session 存在，当点击停止时，则优先调用对应 driver stop，再将 Walker session 标记为 stopped；当点击删除并确认时，则调用 driver delete 并清除相关 route。 |
| REQ-007 | 路由绑定管理 | P0 | 给定 `routes.json`，当打开路由页时，则展示 `routeKey/sessionId/platform/chatId/openId/rootId/health`；支持绑定到已有 session 和解除绑定。 |
| REQ-008 | 悬空绑定诊断 | P0 | 给定 route 指向不存在或已删除 session，当查看路由页或健康检查时，则标记为 dangling 并提供解除操作。 |
| REQ-009 | Agent Driver 管理 | P0 | 给定已注册 driver，当打开 Agent 页时，则展示 `opencode/claude/codex` 可用状态；`opencode` 展示 server URL、autostart、健康检查、watcher 数、配置摘要。 |
| REQ-010 | OpenCode 健康检查与自启 | P0 | 给定 OpenCode 服务不可用，当点击检测时，则返回明确错误；当点击尝试启动且 autostart=true 时，则调用 `ensureReady()` 并展示结果。 |
| REQ-011 | Runtime 管理 | P0 | 给定 runtime 配置，当打开 Runtime 页时，则展示 Windows/WSL 当前配置、工作目录存在性、WSL distro、WSL IP 探测结果和命令可用性检查。 |
| REQ-012 | 配置查看与安全编辑 | P0 | 给定访问配置页，当查看配置时，则敏感项脱敏；当编辑允许列表配置并保存时，则更新 `.env`，返回需要重启生效提示。 |
| REQ-013 | 日志查看 | P0 | 给定 `logs/walker.out.log` 和 `logs/walker.err.log` 存在，当打开日志页时，则支持查看最近 500 行、按文件/关键词/级别过滤并刷新。 |
| REQ-014 | 事件查看 | P0 | 给定运行中发生飞书消息、卡片回调、Agent 事件或 API 错误，当打开事件页时，则展示最近 200 条内存事件；重启后事件可为空但页面必须正常显示。 |
| REQ-015 | 附件管理 | P0 | 给定 `.walker/attachments` 存在，当打开附件页时，则按 session 或全局展示文件名、大小、修改时间、路径，并支持下载和删除孤立附件。 |
| REQ-016 | 会话时间线 | P1 | 给定 session 存在，当打开时间线时，则合并展示 session 状态变更、route 绑定、手动 prompt、driver 事件、错误和附件记录。 |
| REQ-017 | 手动发送 Prompt | P1 | 给定 session 有有效 `agentRef`，当网页端提交 prompt 时，则调用对应 driver prompt，并将来源标记为 `web-admin`，输出事件进入时间线。 |
| REQ-018 | 健康检查页 | P0 | 给定访问诊断页，当点击一键检查时，则检查飞书凭据存在性、数据目录读写、sessions/routes JSON、OpenCode 可用性、runtime、日志目录、孤立 route，并返回 pass/warn/fail。 |
| REQ-019 | 数据维护工具 | P1 | 给定访问维护页，当执行导出时，则下载 sessions/routes/config 摘要；当执行备份时，则在数据目录生成带时间戳备份；当执行清理时，则只清理已确认的 stopped/deleted session route 或孤立附件。 |
| REQ-020 | 飞书命令模拟器 | P1 | 给定输入 `/new`、`/list`、`/use` 等命令，当运行模拟时，则展示 `parseCommand` 结果、模拟 routeKey、将要调用的 dispatcher 动作和预期卡片摘要；默认不真实发送飞书消息。 |
| REQ-021 | 卡片预览 | P1 | 给定选择卡片类型，当打开预览时，则展示未绑定引导、session 列表、可纳入 session、错误卡片、进度卡片的 JSON 和简化视觉预览。 |
| REQ-022 | 多 Agent 扩展配置 | P1 | 给定 `claude/codex` 为 stub driver，当打开扩展页时，则展示预留状态、不可用原因和未来配置入口；不得误报为可执行。 |
| REQ-023 | 指标趋势 | P2 | 给定服务运行中，当打开指标页时，则展示本进程启动后的消息数、命令数、错误数、prompt 数、平均 prompt 耗时和最近 60 分钟趋势。 |
| REQ-024 | 服务控制 | P2 | 给定管理端有权限，当点击停止 Walker 时，则先二次确认并返回“服务将停止”；实现应调用 `app.stop()` 后延迟退出进程。 |
| REQ-025 | 响应式网页 UI | P0 | 给定桌面或 390px 宽移动视口，当访问管理端时，则导航、表格、表单和详情面板不重叠，核心操作可完成。 |
| REQ-026 | 自动化测试 | P0 | 给定执行 `npm run check`，则现有测试通过，并新增覆盖 Admin API、鉴权、配置脱敏、route/session 操作、健康检查和静态资源服务的测试。 |

## 4. 接口/API 设计

所有 API 路径使用 `/api/admin/*`，响应统一为 JSON：

```json
{
  "ok": true,
  "data": {}
}
```

错误响应：

```json
{
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "可读错误信息"
  }
}
```

### 4.1 认证

- `POST /api/admin/auth/login`：输入 `{ "token": "..." }`，成功后返回临时 cookie 或 bearer token。
- `GET /api/admin/auth/status`：返回是否已认证、是否需要 token。
- API 同时支持 `Authorization: Bearer <token>`，便于测试。

### 4.2 总览与指标

- `GET /api/admin/overview`：返回进程、配置摘要、session/route 统计、driver/runtime/feishu 摘要、最近错误。
- `GET /api/admin/metrics`：返回本进程内存指标和最近 60 分钟桶统计。
- `GET /api/admin/events?limit=200&type=...`：返回内存事件。

### 4.3 Sessions

- `GET /api/admin/sessions`：列出未删除 session，包含 routeKeys。
- `POST /api/admin/sessions`：创建 session。输入字段：`agent`、`title`、`runtime`、`cwd`、`createAgentSession`。
- `GET /api/admin/sessions/:id`：session 详情、routeKeys、timeline 摘要。
- `POST /api/admin/sessions/:id/stop`：停止 session。
- `DELETE /api/admin/sessions/:id`：删除 session。
- `POST /api/admin/sessions/:id/prompt`：发送网页 prompt。输入字段：`text`。
- `GET /api/admin/sessions/:id/timeline`：返回时间线。

### 4.4 Routes

- `GET /api/admin/routes`：列出所有 route 绑定和健康状态。
- `POST /api/admin/routes`：绑定 route。输入字段：`routeKey`、`sessionId`。
- `DELETE /api/admin/routes/:encodedRouteKey`：解除绑定。
- `POST /api/admin/routes/cleanup-dangling`：清理悬空 route，必须带确认字段 `{ "confirm": true }`。

### 4.5 Agent 与 Runtime

- `GET /api/admin/agents`：列出 driver、状态、配置摘要。
- `POST /api/admin/agents/:id/check`：执行健康检查。
- `POST /api/admin/agents/opencode/ensure-ready`：尝试确保 OpenCode server 可用。
- `GET /api/admin/runtime`：返回 runtime 配置和检测摘要。
- `POST /api/admin/runtime/check`：执行 runtime 检测。

### 4.6 配置

- `GET /api/admin/config`：返回脱敏配置、来源、可编辑字段列表。
- `PATCH /api/admin/config`：只允许更新 allowlist 字段，写入 `.env`，返回 restartRequired=true。

允许编辑字段：

- `WALKER_ADMIN_ENABLED`
- `WALKER_ADMIN_HOST`
- `WALKER_ADMIN_PORT`
- `WALKER_DEFAULT_AGENT`
- `WALKER_DEFAULT_RUNTIME`
- `WALKER_DEFAULT_CWD`
- `WALKER_WSL_DISTRO`
- `FEISHU_ROUTE_MODE`
- `FEISHU_PROGRESS_STYLE`
- `FEISHU_REACTION_EMOJI`
- `FEISHU_DONE_EMOJI`
- `OPENCODE_SERVER_URL`
- `OPENCODE_SERVER_AUTOSTART`
- `OPENCODE_CMD`
- `OPENCODE_MODEL`
- `OPENCODE_AGENT`

### 4.7 日志、附件、维护

- `GET /api/admin/logs?file=out|err&lines=500&q=...`：读取日志尾部。
- `GET /api/admin/attachments`：列出附件。
- `GET /api/admin/attachments/download?path=...`：下载附件，必须限制在附件目录内。
- `DELETE /api/admin/attachments?path=...`：删除附件，必须限制在附件目录内。
- `GET /api/admin/maintenance/export`：导出 JSON 快照。
- `POST /api/admin/maintenance/backup`：备份数据目录关键文件。
- `POST /api/admin/maintenance/cleanup`：执行确认后的清理动作。

### 4.8 调试工具

- `POST /api/admin/tools/command-simulate`：输入 command、route 输入，返回解析结果与动作摘要。
- `GET /api/admin/tools/cards`：列出可预览卡片类型。
- `POST /api/admin/tools/cards/render`：输入卡片类型和示例数据，返回卡片 JSON 与简化 HTML 预览数据。
- `POST /api/admin/service/stop`：停止 Walker，必须二次确认。

## 5. 数据设计

### 5.1 新增配置项

- `WALKER_ADMIN_ENABLED`：默认 `true`。
- `WALKER_ADMIN_HOST`：默认 `127.0.0.1`。
- `WALKER_ADMIN_PORT`：默认 `8787`。
- `WALKER_ADMIN_TOKEN`：默认空；为空时本机访问不要求登录，但 API 仍不暴露敏感 secret。

### 5.2 内存事件与指标

新增轻量内存 store，不要求跨重启持久化：

```json
{
  "events": [
    {
      "id": "evt_...",
      "type": "feishu.message|feishu.card|agent.event|admin.action|error|session.state|route.bind|attachment",
      "level": "info|warn|error",
      "sessionId": "wks_...",
      "routeKey": "feishu:...",
      "message": "摘要",
      "data": {},
      "createdAt": 1783650000000
    }
  ],
  "metrics": {
    "messages": 0,
    "commands": 0,
    "prompts": 0,
    "errors": 0,
    "promptDurationsMs": []
  }
}
```

内存事件最多保留 1000 条，时间线 API 按 sessionId 过滤。

### 5.3 现有文件兼容

- `sessions.json` 继续由 `SessionService` 读写。
- `routes.json` 继续由 `SessionService` 读写。
- 附件继续位于 `WALKER_DATA_DIR/attachments`。
- 日志继续读取项目根目录 `logs/walker.out.log` 和 `logs/walker.err.log`。
- `.env` 更新必须保留未知键和注释；只更新 allowlist 键。

## 6. 前端设计

前端作为无构建静态 SPA 实现，避免引入 Vite/React 等额外工具链。文件放在 `src/admin/public/`，使用原生 HTML/CSS/JS 调用 Admin API。

页面结构：

- 总览
- Sessions
- 路由绑定
- Agent
- Runtime
- 日志
- 附件
- 配置
- 诊断
- 维护
- 工具
- 指标

UI 约束：

- 桌面端使用左侧导航和主内容区。
- 移动端导航折叠为顶部选择器或横向标签。
- 表格在 390px 宽度下切换为紧凑行卡片，文本不重叠。
- 危险操作使用确认弹窗，确认文案必须包含目标 sessionId、routeKey 或动作名。
- Secret 永远不在 DOM 中明文渲染。

## 7. 业务规则

- 管理端默认只绑定 `127.0.0.1`，除非用户显式配置其他 host。
- 所有写操作必须走 Admin API，不允许前端直接写文件。
- 所有路径参数必须做目录穿越防护，附件下载/删除只能访问附件根目录内文件。
- `.env` 写入只允许 allowlist 键，`FEISHU_APP_SECRET` 和 `WALKER_ADMIN_TOKEN` 不通过网页编辑。
- 删除 session 前必须先尝试调用 driver delete；driver 不支持或失败时仍可标记 Walker session 删除，但响应中要展示 warning。
- 停止 session 前必须先尝试调用 driver stop；driver 不支持或失败时仍可标记 stopped，但响应中要展示 warning。
- 手动 prompt 只能发送到存在 `agentRef` 且 driver 支持 `prompt` 的 session。
- 命令模拟器默认 dry-run，不真实调用飞书 API；若未来增加真实执行，必须另设确认开关。
- 服务停止接口只能停止当前 Walker 进程，不负责重新启动。

## 8. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| 未配置飞书凭据 | 主进程当前仍按既有逻辑拒绝启动；若未来允许只启动管理端，应在 Dashboard 标红。 |
| `sessions.json` 损坏 | 健康检查返回 fail；管理页不崩溃；维护页提示先备份再修复。 |
| `routes.json` 存在悬空绑定 | 路由页标记 dangling；一键清理需要确认。 |
| OpenCode server 不可用 | Agent 页和健康检查返回 fail，展示 server URL 和 autostart 建议。 |
| WSL distro 不存在 | Runtime 检测返回 fail，展示 distro 名称和命令错误。 |
| 日志文件不存在 | 日志页显示空内容和“文件不存在”提示，不返回 500。 |
| 附件目录不存在 | 附件页显示空列表，不返回 500。 |
| 管理端 token 错误 | API 返回 401，前端停留登录界面。 |
| 浏览器刷新 SPA 子页面 | 服务返回 `index.html`，页面根据 hash 或 query 恢复视图。 |
| 静态文件找不到 | 返回 404，不落到 API 错误格式。 |

## 9. 非目标

- 不实现多用户账号、角色权限、审计合规系统。
- 不引入数据库；继续使用现有 JSON 文件与内存状态。
- 不把管理端暴露为公网服务。
- 不实现 Claude/Codex driver 的真实 CLI 协议，只展示扩展配置和 stub 状态。
- 不保证事件和指标跨进程重启保留。
- 不实现复杂图表库；趋势图可用轻量 SVG/Canvas 或 CSS 条形图。
- 不重构现有飞书消息处理主流程，除必要事件采集钩子外保持行为兼容。

## 10. 验证计划

- 运行 `npm run check`，包含 `node --check` 和全部 `node --test test/*.test.js`。
- 新增 Admin API 单元测试，覆盖鉴权、overview、sessions、routes、config、logs、attachments、health、tools。
- 新增静态资源测试，覆盖 `/`、SPA fallback、CSS/JS 文件返回。
- 新增安全测试，覆盖 token 缺失、路径穿越、敏感配置脱敏、非 allowlist 配置拒绝。
- 手动启动 Walker 后访问 `http://127.0.0.1:8787`，检查桌面和移动宽度下主要页面可用。

## 11. 自审结论

- 本规格覆盖用户要求的全部功能，并按 P0/P1/P2 区分实现风险与优先级。
- 选定方案与当前 CommonJS Node.js 单进程架构一致，不引入额外数据库或大型前端构建链。
- 所有危险能力均包含 token、二次确认、路径限制或 allowlist 约束。
- 本规格内容已完整落地为明确需求、约束与验证计划。
