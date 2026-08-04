# T5 REQ-010 测试证据

## 结论

verdict: PASS

T5 已覆盖 Claude/kscc 与 OpenCode 等价 TUI/window 会话链路的增量行为：`/new claude` 创建 session 后记录并展示 terminal/window 状态，飞书 prompt 复用同一 `claudeSessionId`，Claude watch/refresh 按通用 agentRef 分发且幂等，Admin 与 provider catalog 展示 Claude 真实 window/TUI 能力，并保留 OpenCode 专属 TUI bridge 与 `opencodeSessionId` 语义。

## Evidence Receipt

- evidence-command: `node --test test/claude-driver.test.js test/message-dispatcher.test.js test/provider-catalog.test.js test/admin-core-api.test.js *> specs/2026-07-31-claude-provider/evidence/T5-req010-tests.log`
- evidence-exit-code: 0
- evidence-file: `evidence/T5-req010-tests.log`
- evidence-sha256: `8A8924C372EFBC7AA12CED70EBED6AF3EE35606F77B94346DF16EE4CABC8232C`
- result: 277 tests, 23 suites, 277 pass, 0 fail

## 覆盖摘要

- `test/claude-driver.test.js`: 覆盖 Claude terminal launcher、`cli-terminal` sessionRef、同一 session 连续 prompt 复用 `claudeSessionId`、terminal 启动失败脱敏降级、watchSession 幂等复用窗口状态、无 pending prompt 时 stop 更新 terminal 状态。
- `test/message-dispatcher.test.js`: 覆盖 `/new claude` 不依赖 `opencodeSessionId`、成功回复 `terminal active`、窗口失败回复 `terminal failed:<reason>`、Claude session 通过 `claudeSessionId` 建立 watch 且重复调用幂等。
- `test/provider-catalog.test.js`: 覆盖 Claude catalog 声明 Walker 层真实 `tui:true` 与 `window:true`，同时保持 `http:false`。
- `test/admin-core-api.test.js`: 覆盖 Admin session list 展示 Claude `transport:'cli-terminal'` 与 terminal/window 诊断。

## 行为映射

- `REQ-010-B01`: `createSession()` 拉起 terminal/window，`/new claude` 回复 terminal active，catalog 标记 TUI/window 能力。
- `REQ-010-B02`: 连续 `prompt()` 使用同一 `--session-id <claudeSessionId>`。
- `REQ-010-B03`: terminal launcher 失败保留 failed 状态并脱敏；`/new claude` 返回降级状态。
- `REQ-010-B04`: `watchSession()` 与 `ensureWatchForSession()` 对 Claude session 幂等，不重复拉起窗口/watch。
- `REQ-010-B05`: terminal 启动失败、stop 状态、窗口降级通过 sessionRef/飞书回复/Admin 诊断可观察。
- `REQ-010-B06`: `/new`、watch、Admin list 与 catalog 输出 Claude agent、transport、window/watch 状态。
- `REQ-010-B07`: terminal 启动使用 command + argv/options，`shell:false`，title/cwd/prompt 不 shell 拼接，敏感错误脱敏。
- `REQ-010-B08`: `resumeSession()` 与 `watchSession()` 保留/恢复 terminal 状态，窗口未附着时明确 unavailable。
- `REQ-010-B09`: Claude agentRef 使用 `claudeSessionId` 与 terminal metadata，不伪造 `opencodeSessionId`；OpenCode message-dispatcher/admin 回归随定向与全量测试通过。
- `REQ-010-B10`: provider catalog/admin/list/watch 测试均使用状态与 fake launcher，不触发真实长 prompt；全量测试证明列表类路径未阻塞。
- `REQ-010-B11`: terminal 失败时 `/new claude` 回复降级状态，不把后台 `--print` 或 failed terminal 冒充完整 TUI 成功。
