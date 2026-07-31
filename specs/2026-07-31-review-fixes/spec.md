# 代码审查安全与稳定性修复 — 需求规格

## 1. 概述

**需求来源**：再次代码审查发现的问题，用户要求“修”。
**需求类型**：修改 / 安全加固 / 稳定性修复。
**选定方案**：方案 A — 最小安全闭环修复。

本次修复聚焦已确认的代码审查发现，不扩展新的产品能力。目标是在不重写 Admin/API/平台抽象的前提下，修复鉴权隔离、WebSocket 安全边界、API 脱敏、provider 诊断环境、飞书平台事件边界和安全写入竞态。

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | Admin 登录 session 必须按 server/token 隔离 | P0 | 给定两个不同 token 的 admin server，当使用 A 登录得到的 sid 访问 B，则 B 返回 401 |
| REQ-002 | WebSocket 事件流必须具备浏览器来源防护、资源限制和停机释放 | P0 | 恶意 Origin 被拒绝；超大订阅消息被拒绝；server stop 会关闭已连接客户端 |
| REQ-003 | Provider 诊断命令不得继承敏感环境变量 | P0 | doctor/providers 执行外部命令时只传最小环境，测试证明 token/secret/api key 不进入子进程 env |
| REQ-004 | API v1 不得向客户端暴露内部异常或原始 driver 事件秘密 | P0 | INTERNAL_ERROR 响应不含原始异常；prompt 返回事件中的 token/secret/Bearer 被脱敏或不返回原始事件 |
| REQ-005 | 飞书 platform event 适配必须兼容合法边界并可观测失败 | P1 | 只有 user_id/union_id 的事件可生成 userId；空文本不在适配层异常；适配失败产生可观测 admin event |
| REQ-006 | safeWriteJson 不覆盖语义必须抵抗并发创建竞态 | P1 | overwrite=false 时，检查后目标被并发创建也不能被覆盖，并返回/抛出明确结果 |

## 2.1 结构化需求清单 requirements.json

同目录生成 `requirements.json`。每个 `REQ-xxx` 声明 `types`、`required_categories` 和可独立验证的 `behaviors`，后续通过 `traceability.json` 映射到任务、测试和证据。

## 3. 接口/API 设计

### 3.1 Admin HTTP 鉴权

- **现有接口**：`POST /api/admin/auth/login`、`GET /api/admin/auth/status`、所有 admin/API 受保护路由。
- **变更**：登录 session 作用域与当前 auth 配置绑定；不同 server/token 之间不共享 sid。
- **输出**：保持现有响应格式，不改变成功字段。

### 3.2 WebSocket 事件流

- **现有接口**：`GET /api/v1/events/stream` WebSocket upgrade。
- **变更**：增加 Origin 校验、payload 限制、订阅 filter 限制、服务端关闭主动释放客户端。
- **输出**：合法客户端协议保持兼容；非法 Origin/超限输入被拒绝或关闭。

### 3.3 API v1 Prompt 与错误响应

- **现有接口**：`POST /api/v1/prompt`、API v1 route wrapper。
- **变更**：内部异常响应只返回通用错误；prompt 返回 events 必须脱敏或改为安全 DTO。
- **输出**：保持 `{ ok, data }` / `{ ok:false, error }` 统一格式。

## 4. 数据设计

- Auth session entry 需要包含能与当前 server/config 绑定的信息，或 session store 改为实例级。
- WebSocket client 状态可增加无效消息计数、filter 限制后的字段。
- Provider detector 环境由最小 allowlist 生成，不保存秘密。
- Prompt event DTO 必须经过递归脱敏或白名单转换。

## 5. 业务规则

- Admin token 未配置时维持现有免鉴权行为，但 WebSocket Origin 防护仍应对浏览器连接生效，避免误暴露。
- Cookie 鉴权的 WebSocket 必须校验 Origin；无 Origin 的非浏览器客户端允许继续使用。
- Provider 诊断仍可执行本机 provider 版本命令，但不得把 Walker/Feishu/API 密钥传给子进程。
- 飞书事件适配层只拒绝结构上不可恢复的事件；空文本或 sender ID 变体由业务层处理。
- `safeWriteJson(file, value, { overwrite:false })` 不得覆盖调用开始后由其他进程创建的目标文件。

## 6. 异常/边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| 使用 server A sid 访问 server B | 返回 401 |
| WebSocket 带恶意 Origin 和合法 cookie | 拒绝 upgrade |
| WebSocket 发送超大消息 | 拒绝消息或关闭连接，不造成未限制内存增长 |
| server stop 时仍有 WS 客户端连接 | 客户端收到 close 或连接被 terminate |
| provider version 命令执行 | 子进程 env 不包含 token/secret/password/api key |
| API handler 抛出 `doctor exploded` | 响应不包含 `doctor exploded`，event/log 保留可观测信息 |
| prompt driver 返回含 Bearer/token 的 event | API 响应不包含明文秘密 |
| 飞书 sender 只有 `user_id` | 标准事件 `userId` 使用 fallback |
| 飞书文本为空 | 不因 platform event 校验失败而静默丢弃 |
| safeWriteJson 检查后目标被创建 | 不覆盖目标文件 |

## 7. 非目标

- 不重构完整多平台回复通道。
- 不移除 legacy cookie，除非修复过程中发现无法安全兼容。
- 不改造 provider discovery 为纯 Node PATH 解析，除非最小环境方案无法满足测试。
- 不新增数据库或持久化 session 存储。
- 不改变现有 CLI 命令名称和 API 路径。
