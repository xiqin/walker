# 测试报告：message-dispatcher.js 拆分重构

## 执行日期
2026-07-17

## 测试基线
重构前 `node --test test/message-dispatcher.test.js`：123 tests，0 fail。

## 子任务回归（每步独立验证）

| 子任务 | 测试范围 | tests | pass | fail |
|--------|----------|-------|------|------|
| T1 turn-state.js | message-dispatcher + 3 集成 + progress-card | 201 | 201 | 0 |
| T2 heartbeat.js | 同上 | 165 | 165 | 0 |
| T3 progress-renderer.js | 同上 + progress-card | 201 | 201 | 0 |
| T4 permission-handler.js | 同上 + progress-card | 201 | 201 | 0 |

## 最终全套验证

- `node scripts/check.js`（src/ 全量语法检查）：fail 0，所有文件通过 `node --check`
- `npx eslint src/dispatch/*.js`（5 个文件）：无输出，通过
- `node --test "test/**/*.test.js"`（全套 33 个测试文件）：**907 tests，907 pass，0 fail，0 skipped**

## 拆分结果

| 文件 | 行数 | 职责 |
|------|------|------|
| message-dispatcher.js | 1167 (-408) | 主调度骨架 + 命令处理 + watch 管理 + 公共 API |
| turn-state.js | 141 | turn 状态机（启动/取消/超时/查询） |
| heartbeat.js | 89 | prompt 心跳机制 |
| progress-renderer.js | 319 | 进度卡片渲染 + 模型辅助 |
| permission-handler.js | 60 | 权限确认卡片处理 |

## 兼容性验证

测试直接访问的 3 个 dispatcher 实例字段均保持向后兼容：
- `dispatcher.turnStates` (Map) — 9 处 set/get/delete 全部通过
- `dispatcher.sessionWatchStops` (Map) — 4 处 set/has/size 全部通过
- `dispatcher.sessionWatchProgressCards` (Map) — 1 处 has 通过

`bootstrap.js` 导入路径 `require('../dispatch/message-dispatcher')` 未变，`deps.MessageDispatcher` 注入入口保持。

## 结论

重构行为完全不变，所有现有测试通过，无回归。拆分目标达成（5 文件按职责分离）。
