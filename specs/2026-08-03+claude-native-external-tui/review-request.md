# 代码审查请求

**功能：** Claude 外部原生 TUI 与飞书共享同一长期 PTY 会话
**当前分支：** `main`
**审查 fixed point：** 当前工作树相对 `HEAD`
**Spec：** `specs/2026-08-03+claude-native-external-tui/spec.md`
**验证报告：** `specs/2026-08-03+claude-native-external-tui/verify-report.md`

## Standards

- 无未解决 findings。
- 预审查期间发现并已修复一个安全 blocker：`ClaudeDriver._ensureTerminal()` 曾把含 attach token 的 URL 保存到 `terminal.attachUrl`，而 dispatcher 会持久化完整 `agentRef`。现已改为只把 URL/token 传给 `openClaudeAttachTerminal()` 启动窗口，不再写入可持久化 terminal 状态；回归测试断言 `ref.terminal.attachUrl === undefined` 且 `JSON.stringify(ref)` 不含 token。
- 修复证据：`src/drivers/claude-driver.js:251-262`、`test/claude-driver.test.js:149-152`。

## Spec

- 无未解决 findings。
- 实现仍符合用户硬要求：Walker 持有唯一长期 Claude PTY runtime，外部 Windows 终端运行 `walker claude attach <runtime-id>` 作为 attach 客户端，飞书消息与本地键盘经统一输入仲裁写入同一个 Claude/kscc TUI 进程。
- 未采用已拒绝方案：没有把 Claude 主通道改成 headless `stream-json` worker，也没有让外部终端直接拥有 `kscc` 进程。
- OpenCode 保护边界仍成立：OpenCode 专属源码和测试不在本 feature 修改范围内，`WindowsRuntime.openTerminal(command,args,options)` 保持旧签名和旧语义。

## 预审查摘要

- Standards findings: 0 unresolved，worst: none。
- Spec findings: 0 unresolved，worst: none。
- 已修复 finding: 1 个安全 blocker，涉及 attach token 持久化风险；修复后定向测试、lint、artifact validator、全量测试均通过。

## 变更统计

`git diff --stat` 当前显示已跟踪文件变更：28 files changed, 1172 insertions(+), 35 deletions(-)。

注意：本功能新增文件多为未跟踪文件，未包含在 `git diff --stat` 中。`git status --short` 还显示新增：

- `src/cli/claude-attach-command.js`
- `src/drivers/claude-attach-server.js`
- `src/drivers/claude-driver.js`
- `src/drivers/claude-pty-broker.js`
- `src/drivers/claude-pty-runtime.js`
- `src/drivers/claude-transcript.js`
- `test/claude-attach.test.js`
- `test/claude-driver.test.js`
- `test/claude-pty-broker.test.js`
- `test/claude-transcript.test.js`
- `test/cli-claude-attach.test.js`
- `specs/2026-08-03+claude-native-external-tui/`

工作树还包含执行前已有的大量非本 feature 改动和未跟踪目录，未在本任务中回退。

## 主要变更

1. 新增 Claude PTY runtime/broker：每个 Claude session 由 Walker 持有长期 PTY 和唯一 `kscc` TUI 进程，新建使用 `--session-id <uuid>`，恢复使用精确 `--resume <uuid>`，禁止裸 `--continue`。
2. 新增本机 attach 通道：`ClaudeAttachServer` 仅监听 loopback，使用高熵 token；`walker claude attach <runtime-id>` 作为外部终端客户端，转发键盘、输出和 resize。
3. 改造 `ClaudeDriver`：`/new claude` 立即创建长期 PTY runtime 和外部 attach 窗口；飞书 prompt 不再启动 `kscc --print`，而是通过输入仲裁写入同一 PTY。
4. 新增输入仲裁：本地 attach 半行输入、Enter、Ctrl+C、detach、busy/permission 状态和飞书 prompt FIFO 均有测试覆盖，避免飞书文本与本地键盘交错。
5. 新增精确 transcript 模块：基于 canonical cwd 与绑定 Claude UUID 定位 JSONL，禁止目录 mtime 猜测；支持边界后 assistant 读取、watcher、部分行恢复和 fail-closed 路径安全。
6. 更新 dispatcher：持久化 `transport: pty-attach` agentRef；旧 Claude ref 仅在有合法 UUID 时精确恢复；缺失或非法 UUID fail closed；stop/delete/watch 路径支持新 ref。
7. 增加 OpenCode 零变更回归：OpenCode 定向测试通过，OpenCode 专属路径未出现在本 feature diff 清单中，`WindowsRuntime.openTerminal()` 旧语义由测试保护。

## 自测情况

- [x] `node --test test/claude-driver.test.js test/message-dispatcher.test.js test/claude-attach.test.js test/runtime.test.js`：232 pass / 0 fail。
- [x] `npx eslint src/drivers/claude-driver.js test/claude-driver.test.js`：通过，无输出。
- [x] `loom_verify_artifacts`：通过，无 errors/warnings。
- [x] `npm test`：1418 pass / 0 fail。
- [x] `git diff --check`：通过，无输出。
- [x] 执行阶段证据：`test-report.md` 记录 OpenCode 定向 186/186、Claude 定向 260/260、全量 1418/1418。
- [x] 验证阶段证据：`verify-report.md` verdict 为 PASS，traceability 覆盖 7 个 REQ、36 个 behavior。

## 变更详情

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/drivers/claude-pty-runtime.js` | 新增 | 封装 `node-pty`/ConPTY runtime，支持 fake pty 注入、data/exit 事件、write/resize/kill。 |
| `src/drivers/claude-pty-broker.js` | 新增 | 管理长期 Claude PTY runtime、generation、输出回放、pending 写入、stop/delete 和脱敏 agentRef。 |
| `src/drivers/claude-attach-server.js` | 新增 | 本机 WebSocket attach server，loopback/token 校验，二进制 PTY 转发，resize 和错误帧处理。 |
| `src/cli/claude-attach-command.js` | 新增 | `walker claude attach <runtime-id>` 客户端，raw stdin/stdout 与 attach server 互通。 |
| `src/drivers/claude-driver.js` | 新增/改造 | Claude provider 主逻辑改为长期 `pty-attach`，实现 prompt 输入仲裁、attach broker facade、stop/delete/watch。 |
| `src/drivers/claude-transcript.js` | 新增 | 精确 UUID JSONL path/cursor/watcher/assistant 读取和诊断错误。 |
| `src/runtime/windows-runtime.js` | 修改 | 新增 `openClaudeAttachTerminal()`；保持 `openTerminal()` 旧签名和旧语义。 |
| `src/index.js` | 修改 | 增加 `walker claude attach <runtime-id>` 子命令。 |
| `src/dispatch/message-dispatcher.js` | 修改 | 支持 Claude `pty-attach` agentRef 持久化、旧 ref 迁移、fail-closed、watch/stop/delete。 |
| `test/claude-*.test.js`、`test/cli-claude-attach.test.js` | 新增 | 覆盖 PTY broker、attach server/CLI、ClaudeDriver、transcript。 |
| `test/message-dispatcher*.test.js`、`test/runtime.test.js` | 修改 | 覆盖 dispatcher 迁移、合法 UUID fixture、WindowsRuntime 兼容和 attach terminal。 |
| `package.json`、`package-lock.json` | 修改 | 新增 `node-pty` 依赖。 |

## 审查重点

- [ ] 安全性：确认 attach token 只通过子进程环境/连接 URL 传递，不进入持久化 `agentRef`、terminal 状态或日志。
- [ ] 生命周期：确认 PTY runtime generation guard 能隔离旧进程迟到 data/exit，stop/delete 幂等且不会误杀后续 generation。
- [ ] 输入仲裁：确认 attach 输入、飞书 prompt、busy/permission、detach/Enter/Ctrl+C 的 lease 语义不会导致字符交错或队列卡死。
- [ ] 恢复策略：确认只允许精确 UUID `--resume`，不使用 `--continue` 或 latest/recent conversation 猜测。
- [ ] Transcript：确认 canonical cwd、Claude config root、UUID 精确绑定和 fail-closed 路径安全足够稳健。
- [ ] OpenCode 边界：确认 OpenCode 专属路径未被修改，`WindowsRuntime.openTerminal()` 兼容旧调用。
- [ ] 测试质量：确认新增测试覆盖行为而非只耦合实现细节，尤其 attach server 到 driver facade 的真实路径。

## 残余风险

- `node-pty` 安装期间 npm 报 eslint engine warning：当前 Node 为 22.11.0，部分 eslint 包声明 `^22.13.0`；当前 lint 和测试均通过。
- npm audit 高危项来自既有 `@larksuiteoapi/node-sdk -> axios` 链路，不是本次 `node-pty` 引入，未在本功能内处理。
- 工作树有非本 feature 的既有修改和未跟踪目录；审查时请优先聚焦本 spec 相关路径。
