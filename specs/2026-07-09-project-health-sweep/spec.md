# Project Health Sweep Spec

## 背景

Walker 是一个 Node.js CommonJS 单进程本地 Agent Hub，通过飞书长连接接收消息，并将消息路由到本地 opencode agent session。现有基线 `npm run check` 已通过，覆盖语法检查和 `node --test test/*.test.js` 的 155 个断言。

本次工作目标是基于源码审计、现有测试、CodeGraph 调用关系和最新公开资料，对项目中高置信、可验证的问题进行修复，并用测试防止回归。

## 范围

### 本轮必须修复

1. 飞书 API 错误处理不完整。
   - `_request()` 只解析 JSON，不校验 HTTP 状态与飞书业务 `code`。
   - `replyCard()` 在缺少 `data.message_id` 时返回 `om_card_stub`，会把发送失败伪装成成功。
   - `addReaction()` 未 `await` 内部异步请求，无法吞掉失败。

2. 进度卡片更新不可靠。
   - 飞书卡片更新路径需要初始卡片和后续卡片都声明 `config.update_multi: true`。
   - 当前 `ProgressCard.render()` 只设置 `wide_screen_mode`。

3. 飞书 WebSocket 事件处理可能超过 3 秒 ACK 要求。
   - `FeishuPlatform` 事件 handler 直接 `await onMessage()`。
   - 普通消息会继续等待长时间 agent prompt，可能触发飞书重推。

4. 异步飞书回复缺少可靠捕获。
   - 非文本消息回复、reaction、错误卡片、引导卡片等路径存在未等待 Promise 的调用。
   - 失败时可能产生 `unhandledRejection` 或用户不可见错误。

5. `JsonStore` 默认值会被 `update()` 原地污染。
   - 文件不存在或损坏时返回 `defaultValue` 引用。
   - `update()` 变异该引用后，后续 fallback 不再是初始默认值。

6. 删除会话可被重新绑定或被脏 route 命中。
   - `bindRoute()` 未拒绝 `deleted` session。
   - `getCurrent()` 未过滤 `deleted` session。

7. prompt 结束状态可能覆盖已停止或已删除状态。
   - `handleIncomingMessage()` 成功后无条件 `markIdle()`，失败后无条件 `markError()`。
   - 并发 `/stop` 或 `/delete` 后，长 prompt 完成会回写错误状态。

8. HTTP/SSE 边界处理不严。
   - `httpRequest()` 缺少超时控制。
   - `sseConnect()` 不校验响应状态和 `Content-Type`。
   - SSE 解析按单行 `data:` 直接 JSON.parse，不支持标准空行分帧与多行 data。

9. OpenCode driver 对创建 session 的响应校验不足。
   - `createSession()` 未检查 HTTP 状态。
   - 未校验返回 session id，可能产生 `opencodeSessionId: undefined`。

10. 目录级 SSE 事件可能串流或提前终止。
    - `_eventBelongsToSession()` 默认接受无 session id 的事件。
    - `_isTerminalSSEEvent()` 会把无 session id 的 `idle` 当成目标 session 完成。

11. Windows/WSL 终端打开命令拼接存在命令注入和参数破坏风险。
    - `openTerminal()` 通过 `cmd.exe /k` 拼接字符串。
    - 参数中含 `& | < > ^ % ! "` 等字符时可能被 shell 解释。

12. 群聊 @ 机器人命令识别不稳。
    - `parseMessageEvent()` 未利用 mentions 清理 bot mention 前缀。
    - `parseCommand()` 要求文本以 `/` 开头，`@bot /list` 可能被当普通文本。

13. `FeishuPlatform.start()` 未等待 WSClient 启动结果。
    - SDK 资料显示 `WSClient.start()` 是异步方法。
    - 当前启动成功日志可能早于实际连接成功，连接失败不易传播。

### 本轮不强制修复

1. `.loom/rules/constitution.md` 仍含模板占位内容。
2. `ws` 依赖存在新小版本 `8.21.0`，当前 `package.json` 为 `^8.19.0`，但 `npm outdated` 未报告必须升级。
3. README 和 DESIGN 的长期产品承诺，例如 Claude/Codex 真驱动实现，不作为本轮运行时修复目标。

## 约束

1. 保留 CommonJS 和现有目录结构。
2. 不回滚当前工作区已有修改。
3. 优先做最小正确改动，避免大规模重构。
4. 每个高风险修复必须有针对性测试或明确验证命令。
5. 修复后必须运行 `npm run check`。

## 验收标准

1. `npm run check` 通过。
2. 新增或更新测试覆盖本轮修复的关键失败模式。
3. 飞书 API 错误不再被伪装成成功。
4. 进度卡片渲染包含 `config.update_multi: true`。
5. 飞书事件 handler 对长任务快速返回，并在后台捕获错误。
6. JSON store fallback 不被变异污染。
7. 删除 session 不可被重新绑定，脏 route 不会返回 deleted session。
8. prompt 完成不会覆盖 stopped/deleted 终态。
9. SSE 非成功响应、多行 data 和跨 session 事件有明确处理。
10. 终端命令参数经过 Windows shell 安全转义。
