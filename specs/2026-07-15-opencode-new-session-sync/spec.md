# OpenCode 新会话同步修复 - 需求规格

## 1. 概述

**需求来源**：用户反馈执行 `/new` 后，飞书与 OpenCode TUI 双向消息同步中断  
**需求类型**：缺陷修复  
**选定方案**：事件驱动维护 TUI 活动会话，并自动重新注册到 Walker

OpenCode 1.17.20 在执行 `/new` 后会发出包含新 `sessionID` 的
`session.created` 事件，但现有 Walker TUI 插件只从
`api.route.current` 读取会话。该 route 可能仍是旧快照，导致插件继续注册、
轮询和上报旧会话。

插件应维护独立的活动会话状态，并以 OpenCode 会话切换事件更新该状态。
新活动会话注册后，Walker 继续使用现有 bridge enrollment 流程，根据工作目录
加入原飞书路由、设置焦点并建立 watcher。

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | `/new` 后自动绑定新会话 | P0 | 给定插件当前绑定 `ses_old` 且 `api.route.current` 仍返回 `ses_old`，当收到根级 `session.created` 且 `sessionID` 为 `ses_new` 时，则插件向 Walker 注册 `ses_new`，后续使用 `ses_new` 轮询消息 |
| REQ-002 | 新会话继续双向同步 | P0 | 给定 Walker 为 `ses_new` 返回飞书 delivery，当插件轮询 `ses_new` 时，则使用 `ses_new` 调用 OpenCode prompt；该会话进入 idle 或 error 后，事件也以 `ses_new` 上报 Walker |
| REQ-003 | 选择已有会话后自动重新绑定 | P1 | 给定插件收到 `tui.session.select` 且 `sessionID` 为另一根会话，则插件注册并改为轮询该会话 |
| REQ-004 | 内部子会话不得抢占路由焦点 | P0 | 给定 `session.created` 的 `info.parentID` 非空，则插件不得将该子会话设为活动会话或向 Walker 注册为当前 TUI 会话 |
| REQ-005 | 已生成插件自动升级 | P0 | 给定磁盘中存在版本 1 的 Walker TUI 插件，当 installer 启动时，则以版本 2 模板覆盖旧插件；版本 2 内容完全匹配时不重复写入 |

## 3. 接口设计

现有 loopback API 保持不变：

| 接口 | 用途 | 本次变化 |
| ---- | ---- | -------- |
| `POST /opencode/tui-bridge/register` | 注册 runtime 当前会话 | 请求结构不变；会在会话切换事件后携带新 `sessionId` 调用 |
| `POST /opencode/tui-bridge/poll` | 轮询飞书投递 | 请求结构不变；使用插件维护的活动会话 ID |
| `POST /opencode/tui-bridge/events` | 上报 TUI 输出和错误 | 请求结构不变；使用事件所属会话 ID |
| `POST /opencode/tui-bridge/dispose` | 注销 runtime | 不变 |

## 4. 状态设计

插件在单个 TUI runtime 内维护：

- `activeSessionId`：当前应注册、轮询和接收飞书投递的 OpenCode 根会话。
- `lastRegisteredSessionId`：最近成功注册的会话，用于避免重复注册。
- `activeDeliveries`：按会话记录正在执行的飞书投递，现有结构保持不变。

初始化时，`activeSessionId` 取自 `api.route.current`。运行期间：

1. 根级 `session.created` 将活动会话更新为事件中的 `sessionID`。
2. `tui.session.select` 将活动会话更新为事件中的 `sessionID`。
3. route 只用于初始化和在事件不可用时补足空状态，不得用滞后的旧 route 覆盖已经由事件确认的新活动会话。

## 5. 业务规则

- 会话切换后必须先注册新会话，再轮询新会话的飞书投递。
- 注册沿用服务端现有行为：按工作目录加入已有飞书路由、设置为路由焦点并触发 watcher enrollment。
- `session.created` 仅接受没有 `parentID` 的根会话；内部 agent、工具或任务创建的子会话不改变当前路由。
- 重复收到同一会话的创建或选择事件不得产生无意义的重复注册。
- 会话切换不得删除旧 Walker session；旧 session 保留，新 session 成为当前路由焦点。
- 插件模板版本从 1 升级为 2，确保现有安装自动获得修复。

## 6. 异常与边界场景

| 场景 | 预期行为 |
| ---- | -------- |
| 会话事件缺少 `sessionID` | 忽略该事件，保持当前活动会话 |
| 创建的是带 `parentID` 的子会话 | 忽略该事件，不注册、不切换焦点 |
| Walker 正在重启或注册失败 | 保留活动会话；后续 tick 重试注册，不回退到旧 route |
| 切换事件与 tick 并发 | 当前 tick 可以结束；下一次 tick 必须注册并轮询最新活动会话，不向旧会话执行新 delivery |
| idle/error 属于非活动会话 | 不得把该事件误归属到当前活动会话；只按事件自带的 session ID 处理对应 delivery |

## 7. 非目标

- 不修改飞书消息事件注册和 reaction warning 处理。
- 不修改 Walker 服务端 route、session 或 TUI bridge API 数据模型。
- 不删除或合并会话切换前的 Walker session。
- 不引入新的配置项、持久化状态或轮询接口。
- 不改变非 TUI transport 的 OpenCode driver 行为。
