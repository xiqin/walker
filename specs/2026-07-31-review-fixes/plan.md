# 代码审查安全与稳定性修复 — 实现计划

## 摘要

本计划把已确认的 6 个安全与稳定性需求拆成 6 个可独立验证的任务。每个任务按模块边界独占写入文件，先补充失败测试，再做最小实现，最后通过完整测试和结构化追踪账本闭环。

## 实施原则

- 保持现有 CLI 命令名、API 路径和响应外壳兼容。
- 优先修复安全边界，不重构完整多平台回复通道。
- 所有敏感信息输出必须经过脱敏或避免返回。
- 每个任务必须补齐对应回归测试，并在 executing 阶段更新 `traceability.json` 的 tests/evidence。
- 任务之间不得同时写入同一文件；需要跨模块行为时通过依赖顺序串行集成。

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | Admin auth session 隔离 | Admin 鉴权 | medium | 无 | REQ-001 | REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B04 | `tasks/T1.md` |
| T2 | WebSocket 安全、限流与关闭释放 | Admin WebSocket | high | T1 | REQ-002 | REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04, REQ-002-B05, REQ-002-B06 | `tasks/T2.md` |
| T3 | Provider detector 最小环境 | Provider/CLI | medium | 无 | REQ-003 | REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-003-B04 | `tasks/T3.md` |
| T4 | API v1 错误与 prompt events 脱敏 | API v1 | medium | 无 | REQ-004 | REQ-004-B01, REQ-004-B02, REQ-004-B03, REQ-004-B04 | `tasks/T4.md` |
| T5 | 飞书 platform event 边界与可观测失败 | Platform adapter | high | 无 | REQ-005 | REQ-005-B01, REQ-005-B02, REQ-005-B03, REQ-005-B04, REQ-005-B05 | `tasks/T5.md` |
| T6 | safeWriteJson no-clobber 竞态修复 | CLI 写入 | medium | 无 | REQ-006 | REQ-006-B01, REQ-006-B02, REQ-006-B03, REQ-006-B04 | `tasks/T6.md` |

## 依赖关系

T1 → T2。T3、T4、T5、T6 与 T1/T2 文件边界独立，可并行执行。集成验证在全部任务完成后统一运行。

## 并行边界

T3、T4、T5、T6 可以与 T1 并行。T2 等待 T1。所有 task 的 `owns` 声明互不重叠；如果执行中发现需要修改其他 task owns 的文件，必须暂停并调整计划。

## 测试策略

- 任务级：每个 task 先运行对应测试文件，例如 `node --test test/api-v1-auth.test.js`。
- 集成级：涉及 WebSocket 和 bootstrap 的任务需要额外运行相关平台/API 测试。
- 完整级：全部执行后运行 `npm test -- --test-reporter=dot`。
- 结构化级：executing 阶段为每个 behavior 补齐 `traceability.json` 的 tests/evidence。

## 风险与缓解

- WebSocket Origin 规则过严可能影响非浏览器客户端：允许无 `Origin` 的客户端，浏览器 Origin 必须匹配 localhost 或显式允许来源。
- Provider detector 最小环境可能影响 Windows 命令解析：保留 `PATH`/`Path`/`PATHEXT`/`SystemRoot`/`COMSPEC` 等平台变量。
- Prompt events 脱敏可能改变测试断言：保持返回 `events` 字段，但内容经递归脱敏，降低兼容风险。
- 飞书空文本放行后业务层可能无回复：本计划只避免 adapter 静默丢弃，并保留业务层处理权限。

## 完成标准

- `tasks/T1.md` 到 `tasks/T6.md` 均存在且 frontmatter 完整。
- `traceability.json` 映射每个 `REQ-xxx` 和每个 `REQ-xxx-Bnn` 到至少一个 task。
- `loom_validate_plan` 通过。
- 用户确认计划后进入 executing。
