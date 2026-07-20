# Test Report — 飞书交互式问题通知与确认

## 概览

| 项目 | 值 |
|------|-----|
| 测试总数 | 1004 |
| 通过 | 1004 |
| 失败 | 0 |
| lint | 通过 |
| 覆盖 REQ | REQ-001 ~ REQ-013（全部） |

## 变更文件

### 源文件（9 个修改）

| 文件 | 变更类型 | 对应 Task |
|------|----------|-----------|
| `src/drivers/agent-driver.js` | 修改 | T1 |
| `src/opencode-tui-bridge/bridge.js` | 修改 | T2 |
| `src/drivers/opencode-driver.js` | 修改 | T3 |
| `src/platform/feishu/cards.js` | 修改 | T4 |
| `src/platform/feishu/platform.js` | 修改 | T5 |
| `src/app/bootstrap.js` | 修改 | T5 |
| `src/platform/feishu/commands.js` | 修改 | T6 |
| `src/dispatch/message-dispatcher.js` | 修改 | T7 |
| `src/dispatch/permission-handler.js` | 修改 | T7 |

### 测试文件（3 个新增）

| 文件 | 测试数 | 对应 Task |
|------|--------|-----------|
| `test/agent-driver-schema.test.js` | 7 | T1 |
| `test/permission-handler.test.js` | 8 | T7 |
| `test/integration-feishu-question.test.js` | 33 | T8 |

## REQ 覆盖矩阵

| REQ | 描述 | 测试覆盖 |
|-----|------|----------|
| REQ-001 | TUI bridge 接收交互式问题事件 | integration #1 (confirm 全链路) |
| REQ-002 | single_select 多选卡片渲染 | integration #2, cards test |
| REQ-003 | multi_select 多选卡片渲染 | integration #3, cards test |
| REQ-004 | text 自由文本输入卡片渲染 | integration #4, cards test |
| REQ-005 | /answer 命令处理 | integration #1-4, dispatcher test |
| REQ-006 | confirm 确认卡片渲染 | integration #1, cards test |
| REQ-007 | 回调路由准确性 | cards routeKey test, integration |
| REQ-008 | 卡片状态更新（replied） | integration #8-11, handler test |
| REQ-009 | 幂等与重复点击保护 | integration #5-7 |
| REQ-010 | 向后兼容 | integration #8-11 |
| REQ-011 | TUI bridge replyQuestion delivery | integration #20, bridge test (8) |
| REQ-012 | formValue 全链路传递 | integration, platform/bootstrap test |
| REQ-013 | 未知 inputMode 降级 | integration #12, cards/handler test |

## 集成测试详情

### 全链路成功路径（4 个）
1. confirm inputMode 全链路（事件→卡片→/answer→driver→patch）
2. single_select 全链路
3. multi_select 全链路
4. text 全链路

### 幂等与状态（3 个）
5. replied 状态幂等保护
6. submitting 状态防重复
7. 失败回滚到 pending 后可重试

### 向后兼容（4 个）
8. 传统 permission 不受影响
9. /permit 命令不受影响
10. permission_replied 走 handleReplied
11. question permission_replied 走 handleQuestionReplied

### 异常场景（6 个）
12. 未知 inputMode 降级为 confirm
13. select 缺少 options 渲染错误状态
14. text required 空答案拒绝
15. multi_select required 空数组拒绝
16. 无 session 时 reject
17. driver 不支持 replyPermission 时报错

### patch 卡片策略（2 个）
18. HTTP transport 直接 patch 卡片
19. TUI bridge transport 不 patch（等 permission_replied 事件驱动）

### TUI bridge delivery（1 个）
20. replyQuestion delivery 完整流程

### 补充覆盖（13 个）
- buildQuestionCard 4 种 inputMode 渲染
- inputMode 降级
- 缺 options 错误态
- questionRepliedCard 格式
- permissionRepliedCard 格式
- question 与 permission 路由隔离
- required=false 允许空值

## 验证命令

```bash
npm run test    # lint + check (node-tap test runner)
npm run lint    # eslint
```

## Verdict

Verdict: PASS

- evidence-command: `npm run test`
- exit-code: 0

## 遗留风险

- 飞书卡片 `multi_select_static` 和 `input` 组件类型未在代码库中出现过，实现基于飞书协议文档，需卡片预览工具验证实际渲染效果
- `buildQuestionCard` 中 options value 非空校验由 dispatcher `_cmdAnswer` 的 required 校验兜底，卡片层未单独校验
