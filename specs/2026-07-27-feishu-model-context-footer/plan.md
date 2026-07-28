# 飞书消息模型与上下文页脚实现计划

**目标：** 让所有发送到飞书的文本、Markdown 和卡片消息底部统一携带当前模型与上下文大小信息。

**架构：** 在 `FeishuApi` 层提供运行信息页脚构建与文本、Markdown、卡片 payload 注入能力，保证所有飞书 API 发送路径默认受益。`MessageDispatcher` 和 `ProgressRenderer` 在调用飞书 API 前把当前路由、会话模型和可取得的上下文元数据整理为运行信息；`bootstrap` 中的进度卡片 wrapper 继续把该运行信息透传给底层 `replyCard`/`patchCard`，避免 `FeishuApi` 额外访问 driver 或外部服务。测试层覆盖页脚格式、幂等、模型和上下文边界、分片、进度卡片 wrapper 兼容性与重试不变。

**技术栈：** Node.js CommonJS、`node:test`、现有 `FeishuApi` 与 `MessageDispatcher` 发送封装。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | Requirements | Behaviors | 文件 |
| ---- | ---- | ---- | ------ | ---- | ------------ | --------- | ---- |
| T1 | FeishuApi 页脚构建与 payload 注入 | 平台 API | medium | 无 | REQ-001, REQ-002, REQ-003, REQ-004 | REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B04, REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-003-B04, REQ-004-B01, REQ-004-B03 | `tasks/T1.md` |
| T2 | Dispatcher 与进度卡片运行信息透传 | 调度集成 | medium | T1 | REQ-002, REQ-003, REQ-004 | REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04, REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-004-B02, REQ-004-B03 | `tasks/T2.md` |
| T3 | 飞书页脚测试覆盖与回归验证 | 测试 | medium | T1, T2 | REQ-001, REQ-002, REQ-003, REQ-004 | REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B04, REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04, REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-003-B04, REQ-004-B01, REQ-004-B02, REQ-004-B03 | `tasks/T3.md` |

## 依赖关系

T1 -> T2 -> T3

## 文件结构与职责

| 文件 | 计划操作 | 职责 |
| ---- | -------- | ---- |
| `src/platform/feishu/api.js` | 修改 | 增加运行信息页脚格式化、幂等追加、文本分片前注入、Markdown 卡片内容注入、交互卡片 body 元素注入，并保持 `splitTextChunks` 和 token 获取逻辑不变。 |
| `src/dispatch/message-dispatcher.js` | 修改 | 在 `_callFeishu` 中基于调用上下文和会话服务生成运行信息参数，传给支持页脚的飞书 API 方法；保持 retryable 列表、重试次数和 fallback 语义不变。 |
| `src/dispatch/progress-renderer.js` | 修改 | 完整回复、legacy 回复和进度卡片创建/更新调用传递 `sessionId` context，避免旧模型-only footer 拼接，并让 FeishuApi 统一追加模型与上下文字段。 |
| `src/app/bootstrap.js` | 修改 | 让 `sendProgressCard` 与 `updateProgressCard` wrapper 接收 runtime 参数，并透传给底层 `replyCard`/`patchCard`，保证进度卡片真实发送链路也携带页脚。 |
| `test/feishu-api.test.js` | 修改 | 覆盖 `FeishuApi` 层页脚注入、幂等、模型和上下文字段、长文本分片、卡片 payload 结构。 |
| `test/message-dispatcher.test.js` | 修改 | 覆盖 dispatcher 调用飞书 API 时传入运行信息、不新增 driver 外部调用、重试次数不变。 |
| `test/progress-card.test.js` | 验证 | 回归进度卡片结构，确认 wrapper 透传 runtime 后不破坏现有卡片渲染。 |

## 实现策略

1. 在 `FeishuApi` 内实现纯内存运行信息页脚工具，输入为可选 metadata 对象，输出统一格式：正文底部分隔符后追加 `模型：实际模型名或 unknown` 与 `上下文：实际上下文大小或 unknown`。
2. 文本与 Markdown 字符串在分片前完成一次页脚追加，确保分片行为继续由 `splitTextChunks` 控制，且同一 payload 不重复追加。
3. 交互卡片通过向 `body.elements` 末尾追加一个 markdown 元素承载页脚；更新已有卡片时先检测已有页脚元素，避免重复。
4. `MessageDispatcher._callFeishu` 在实际调用 API 前补充最后一个可选 runtime 参数；参数只来自已传入 `context`、当前 session 和配置默认模型，不调用 driver 或其他外部 API。
5. `ProgressRenderer` 与 watch progress 调用向 `_callFeishu` 传入 `sessionId` context；`bootstrap` 的进度卡片 wrapper 把 runtime 继续透传给 `replyCard`/`patchCard`。
6. 对没有会话或上下文元数据的消息使用 `unknown`，并通过 try/catch 保证页脚解析异常不会阻塞飞书发送。

## Traceability 初始映射

planning 阶段已生成同目录 `traceability.json`，覆盖每个 `REQ-xxx` 及其全部 behaviors。`tests` 与 `evidence` 在 executing 阶段由真实测试和执行记录补齐。

## 串行与并行边界

- T1 与 T2 修改运行时发送链路，T2 依赖 T1 的 runtime 参数约定，必须串行。
- T3 读取 T1/T2 的最终接口和行为，必须在 T1/T2 后执行。
- 各 task 的 `owns` 无交集；若后续发现测试需要改动同一源文件，必须先更新 task 所有权或合并执行。

## 验证命令

- `node C:\Users\tianxiqin\.config\opencode\skills\loom-writing-plans\scripts\validate-plan.mjs --spec-dir specs/2026-07-27-feishu-model-context-footer`
- `node --test test/feishu-api.test.js test/message-dispatcher.test.js test/progress-card.test.js`
