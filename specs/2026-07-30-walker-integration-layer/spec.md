# Walker 可扩展集成层 — 需求规格

## 1. 概述

**需求来源**：用户要求将推进方案写入文档并开始推进。
**需求类型**：新增 + 架构改造。
**选定方案**：渐进式集成层改造。先建立 Provider Catalog 与 Doctor，再稳定 `/api/v1`，随后补齐 CLI 初始化、WebSocket 事件流，并以轻 adapter 方式引入 PlatformDriver 抽象，避免一次性重写现有飞书链路。

当前 Walker 已具备飞书入口、OpenCode driver、session/route 管理、Admin 后台和事件指标。此改造的目标不是引入重型后端，而是把现有能力产品化、接口化、可扩展化，让 Walker 从“飞书绑定 OpenCode”的单入口桥接器演进为“多平台入口 + 多 Provider Agent + 稳定本地 API”的本地优先集成层。

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | Provider Catalog 与 DriverRegistry 增强 | P0 | 给定本机环境，当执行 provider 检测或 Admin/API 查询时，Walker 能返回 opencode、claude、codex、shell 的安装、版本、配置、健康状态与 capabilities。 |
| REQ-002 | Doctor 检测与 CLI 可观测输出 | P0 | 给定缺失配置或不可用 provider，当执行 `walker doctor` 或 provider doctor 时，命令输出明确状态、问题和修复建议，且不自动写入敏感凭据。 |
| REQ-003 | 稳定 `/api/v1` 核心 API | P0 | 给定合法 token，当调用 `/api/v1` 的 providers、sessions、routes、prompt、events 接口时，返回统一 JSON 成功/错误格式，并复用现有核心服务能力。 |
| REQ-004 | PlatformDriver 抽象 | P1 | 给定飞书消息入口，当通过平台中立事件进入 dispatcher 时，现有飞书功能保持可用，并为 Telegram、钉钉、企业微信、Slack 预留清晰驱动接口。 |
| REQ-005 | `walker init` 初始化体验 | P1 | 给定首次使用环境，当执行 `walker init` 时，命令能创建必要本地目录/配置模板/安全 token，并检查或提示 OpenCode TUI plugin 状态。 |
| REQ-006 | WebSocket 事件流 | P1 | 给定通过认证的客户端，当连接 `/api/v1/events/stream` 时，可以实时收到新事件，并支持基本过滤、心跳和脱敏。 |
| REQ-007 | 兼容现有飞书与 Admin 行为 | P0 | 给定现有飞书消息、Admin 页面或已有 session 状态，当改造完成后，原有路由、prompt、session 管理和事件查询仍保持兼容。 |

## 2.1 结构化需求清单 requirements.json

同目录生成 `requirements.json`。每个 `REQ-xxx` 均声明 `types`、`required_categories` 和可独立验证的 `behaviors`，后续 `plan.md`、`tasks/`、`traceability.json`、测试报告必须逐行为闭环。

## 3. 接口/API 设计

### 3.1 Provider API

- **调用方式**：`GET /api/v1/providers`
- **描述**：返回所有已知 provider 的元信息、检测状态、版本、健康状态和 capabilities。
- **输出**：遵循统一格式。

```json
{
  "ok": true,
  "data": {
    "list": [
      {
        "id": "opencode",
        "label": "OpenCode",
        "installed": true,
        "version": "0.x.x",
        "healthy": true,
        "capabilities": {
          "sessions": true,
          "prompt": true,
          "cancel": true,
          "models": true,
          "streaming": true,
          "permissions": true
        },
        "problems": [],
        "suggestions": []
      }
    ],
    "total": 1
  }
}
```

### 3.2 Provider Doctor API

- **调用方式**：`GET /api/v1/providers/:id/doctor`
- **描述**：对单个 provider 执行命令存在性、版本、配置和健康检测。
- **错误**：未知 provider 返回 `NOT_FOUND`；检测异常返回 `PROVIDER_CHECK_FAILED`。

### 3.3 Sessions API

- **调用方式**：`GET /api/v1/sessions`、`POST /api/v1/sessions`、`GET /api/v1/sessions/:id`、`DELETE /api/v1/sessions/:id`、`POST /api/v1/sessions/:id/stop`、`POST /api/v1/sessions/:id/cancel`
- **描述**：暴露可复用 session 生命周期能力，不绑定 Admin 页面或飞书入口。

### 3.4 Routes API

- **调用方式**：`GET /api/v1/routes`、`GET /api/v1/routes/:routeKey`、`PUT /api/v1/routes/:routeKey/focus`、`DELETE /api/v1/routes/:routeKey/focus`
- **描述**：暴露 route 绑定、焦点 session 切换与清理能力。

### 3.5 Prompt API

- **调用方式**：`POST /api/v1/prompt`
- **描述**：通过稳定 API 向指定 route 或 session 发送 prompt。
- **输入**：

| 参数 | 类型 | 必填 | 说明 |
| ---- | ---- | ---- | ---- |
| routeKey | string | 否 | 平台路由键，未提供时必须提供 sessionId。 |
| sessionId | string | 否 | 目标 session，未提供时通过 routeKey 选择焦点 session。 |
| agent | string | 否 | 目标 agent/provider，默认使用当前 session 或默认配置。 |
| text | string | 是 | prompt 文本。 |
| cwd | string | 否 | 工作目录。 |
| source | string | 否 | 调用来源，如 `feishu`、`admin`、`api`。 |
| metadata | object | 否 | 调用方附加元数据。 |

### 3.6 Events API 与 WebSocket

- **调用方式**：`GET /api/v1/events`、`GET /api/v1/metrics`、`WS /api/v1/events/stream`
- **描述**：HTTP 提供历史事件查询，WebSocket 提供实时事件订阅。
- **事件类型**：至少覆盖 `session.*`、`prompt.*`、`route.*`、`provider.*`、`platform.*`、`system.*`。

### 3.7 统一响应格式

成功：

```json
{
  "ok": true,
  "data": {}
}
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "PROVIDER_NOT_AVAILABLE",
    "message": "opencode is not installed or not healthy",
    "details": {}
  }
}
```

## 4. 数据设计

### 4.1 Provider 定义

```js
{
  id: 'opencode',
  label: 'OpenCode',
  type: 'agent',
  driver: 'opencode',
  executableCandidates: ['opencode'],
  versionCommand: ['opencode', '--version'],
  healthCheck: 'opencode-http',
  capabilities: {
    sessions: true,
    prompt: true,
    cancel: true,
    models: true,
    streaming: true,
    permissions: true
  },
  configKeys: [
    'OPENCODE_SERVER_URL',
    'OPENCODE_SERVER_AUTOSTART',
    'OPENCODE_CMD',
    'OPENCODE_MODEL',
    'OPENCODE_AGENT'
  ]
}
```

### 4.2 Provider 检测结果

```js
{
  id: 'opencode',
  installed: true,
  executable: 'opencode',
  version: '0.x.x',
  configured: true,
  healthy: true,
  capabilities: {},
  health: {
    status: 'ok',
    checks: [
      { name: 'command', ok: true },
      { name: 'version', ok: true },
      { name: 'server', ok: true }
    ]
  },
  problems: [],
  suggestions: []
}
```

### 4.3 Platform 事件

```js
{
  platform: 'feishu',
  type: 'message',
  messageId: 'om_xxx',
  routeKey: 'feishu:chat:oc_xxx',
  userId: 'ou_xxx',
  text: '帮我看下错误',
  attachments: [],
  raw: {}
}
```

## 5. 业务规则

- `DriverRegistry` 继续负责 driver 实例管理，但 provider 元信息、检测和健康状态必须来自 Provider Catalog。
- `shell` provider 是内建能力，不要求外部可执行文件，但仍要出现在 provider 列表中。
- `/api/v1` 不直接暴露内部 state 文件结构，必须通过 service 或 adapter 返回稳定字段。
- `/api/admin/*` 首版保持兼容，可以复用 `/api/v1` 的服务层，但不能破坏现有 Admin 页面。
- PlatformDriver 首版只要求飞书 adapter 化，不要求实现 Telegram、钉钉、企业微信、Slack。
- `walker init` 可以创建目录、模板、token 和安装/刷新 TUI plugin，但不能自动写入第三方平台密钥。
- WebSocket 事件流必须复用现有脱敏规则，不向客户端广播 token、secret 或完整敏感环境变量。
- 所有新增 HTTP API 默认只服务 loopback，并复用 `WALKER_ADMIN_TOKEN` 鉴权。

## 6. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| provider 命令不存在 | `installed=false`，doctor 输出明确问题和安装建议，不抛未处理异常。 |
| provider 版本命令超时 | 返回该 check 失败，整体 doctor 可继续执行其他检查。 |
| OpenCode server 不可达 | `installed` 可为 true，但 `healthy=false`，建议启动或启用 autostart。 |
| 未配置 admin token | doctor 给出安全警告；受保护 API 返回 `UNAUTHORIZED`。 |
| `/api/v1/prompt` 缺少 text | 返回 `BAD_REQUEST`，不创建 session，不调用 driver。 |
| routeKey 与 sessionId 均缺失 | 返回 `BAD_REQUEST`。 |
| WebSocket 未认证 | 拒绝连接或立即关闭，不发送历史事件。 |
| WebSocket 客户端断开 | 服务端释放订阅，不影响 event-store 记录。 |
| 飞书消息经过新 adapter | 原有命令、普通 prompt、卡片回复、权限/问题处理保持兼容。 |

## 7. 非目标

- 本次不实现 Telegram、钉钉、企业微信、Slack 的真实平台接入。
- 本次不引入 PostgreSQL、pgvector、多租户 API key 或远程 SaaS 控制面。
- 本次不重写 OpenCodeDriver，只为 provider 检测和 `/api/v1` 复用补齐必要接口。
- 本次不改动用户已存在的敏感配置文件，不自动写入飞书密钥。
- 本次不承诺 `/api/v1` 外部公网访问能力，默认仍是本地 loopback 使用。
