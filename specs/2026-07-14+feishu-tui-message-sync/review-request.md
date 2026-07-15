# 代码审查请求

**功能：** 飞书与 OpenCode TUI 消息同步修复
**分支：** 工作区未提交改动（基于 HEAD a00e4ac）

## 变更统计

```
 src/dispatch/message-dispatcher.js      | 19 +++++++-
 src/drivers/opencode-session-watcher.js |  6 ++-
 test/message-dispatcher.test.js         | 124 +++++++++++++++++++++++++++++++
 test/opencode-driver.test.js            | 195 +++++++++++++++++++++++++++++++++++++++++++++++++
 test/integration-feishu-tui-sync.test.js| 新增，335 行
```

## 主要变更

1. **Thread route fallback**（`message-dispatcher.js:85-98`）：thread 模式下，线程 route 未绑定时回退到同群根 route，使飞书线程消息能立即投递到已 attach 的群聊 session
2. **Watcher resume 修复**（`opencode-session-watcher.js:119`）：`_resumePolling` 从错误的 `{ onEvent: watcher._handlers }` 改为直接传递 `watcher._handlers`，修复 TUI 回复必须等下一条飞书消息才推送的问题
3. **pollIntervalMs 可配置**：从硬编码 3000ms 提升为构造参数，测试可控
4. **timer.unref()**：轮询定时器调用 `unref()` 允许进程正常退出

## 重点关注

1. **安全性**：thread fallback 中 `{ ...event, rootId: '' }` 保留 chatId，天然同群，无跨群泄露
2. **正确性**：fallback 的 4 个守卫条件（`!current`、`thread` 模式、`event.rootId`、`event.chatId`）联合防止误触发
3. **时序**：watcher resume 后轮询立即执行首次 poll，不等第一个 interval

## 自测情况

- [x] 编译通过（`node --check` 4 个核心文件）
- [x] 静态分析（项目无独立 VET_CMD，编译检查通过）
- [x] 测试通过（`npm test` 620/620）
- [x] 代码符合编码红线（最小改动、精准手术、中文注释）
- [x] 图后端已注明索引查询跳过（CodeGraph 可用但不影响审查）

## 变更详情

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/dispatch/message-dispatcher.js` | 修改 | thread route fallback 逻辑（+15 行） |
| `src/drivers/opencode-session-watcher.js` | 修改 | _resumePolling handlers 修复 + pollIntervalMs 可配置 + timer.unref（+3 行，-1 行） |
| `test/message-dispatcher.test.js` | 修改 | +4 测试（线程回退、线程优先、双重未绑定、agentRef 正确性） |
| `test/opencode-driver.test.js` | 修改 | +4 测试（resume 回调、pending 游标、stopWatch 清理、去重） |
| `test/integration-feishu-tui-sync.test.js` | 新增 | 5 集成测试（入站+出站+去重+chat 隔离+session 隔离） |

## 审查重点

- [ ] 架构合规性：fallback 逻辑是否放在正确的层级
- [ ] 代码质量：守卫条件是否完整、边界是否覆盖
- [ ] 安全性检查：thread fallback 是否存在跨群投递风险
- [ ] 性能影响：额外一次 getCurrent 调用是否可接受

## Standards

- `timer.unref` 写法与 `health-poller.js` 略有不一致（`if (timer.unref)` vs `if (typeof timer.unref === 'function')`），功能等价，建议后续统一
- 无其他 Standards 发现

## Spec

- REQ-001/002/003 全部覆盖，验收标准 1-5 全部满足
- 无 spec 外范围引入
- 无 Spec 发现

## 预审查摘要

- Standards findings: 1，worst: 代码风格不一致（非阻塞）
- Spec findings: 0，worst: none
