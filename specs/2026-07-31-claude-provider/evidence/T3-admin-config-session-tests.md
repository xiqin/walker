# T3 Admin Config 与通用 Session 接入验证

## 验证命令

- `node --test test/admin-observability-config.test.js test/admin-config-event.test.js test/admin-core-api.test.js test/config-env.test.js test/session-service.test.js`
- `npx eslint src/admin/config.js src/admin/config-editor.js src/admin/session-admin.js src/config/env.js test/admin-observability-config.test.js test/admin-config-event.test.js test/admin-core-api.test.js test/config-env.test.js test/session-service.test.js`

## 结果

- Node test: 163 tests passed, 0 failed.
- ESLint: passed, no output.

## 覆盖点

- Claude 配置项加入 admin 配置摘要、可编辑 allowlist 和 `claude` 配置组。
- `CLAUDE_PERMISSION_MODE` 仅允许 `default`、`acceptEdits`、`auto`、`dontAsk`、`plan`，拒绝 `bypassPermissions`。
- `CLAUDE_PROMPT_TIMEOUT_MS` 使用正整数校验，非法值不写入 `.env`。
- `.env` 更新保留未知键并保持失败原子性。
- `loadEnvConfig()` 解析所有 `CLAUDE_*` 运行时字段，并保留默认 `claude` 命令和 `120000` ms 超时。
- `session-admin.createSession()` 在 `createAgentSession=true` 时按 `session.agent` 获取 driver，可为 `agent=claude` 创建底层 Claude sessionRef。
- 缺少目标 agent driver 时返回可诊断错误并记录 eventStore 错误事件。
- 默认 OpenCode session 创建路径继续通过现有测试覆盖。

## 外部调用约束

本轮测试仅使用 fake registry 和本地单元测试，不执行真实 `claude --print` 或真实 Claude prompt。
