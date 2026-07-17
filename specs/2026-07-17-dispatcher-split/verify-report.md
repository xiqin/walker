## 完成前验证报告

**功能：** message-dispatcher.js 按职责拆分重构（1575 行单文件 → 5 文件，行为不变）
**验证时间：** 2026-07-17 02:12
**流水线：** quickfix 短路（executing → verification），spec_dir = `specs/2026-07-17-dispatcher-split`

### 检查结果

| 检查项 | 状态 | 说明 |
| ------ | ---- | ---- |
| 前置产出核验 | ✅ | `test-report.md` 已读取，最终 907 tests 全通过，拆分结果表与 plan.md 一致 |
| BUILD_CMD（check.js） | ✅ | `node scripts/check.js`：fail 0，全部文件通过 `node --check` |
| VET_CMD（eslint） | ✅ | `npx eslint src/dispatch/*.js`（5 文件）：exit 0，无输出 |
| TEST_CMD（全套测试） | ✅ | `node --test "test/**/*.test.js"`：907 tests, 907 pass, 0 fail, 0 skipped |
| 占位符扫描 | ✅ | grep `TBD\|TODO\|implement later\|fill in details` 仅命中 `AgentEvent.TYPE_TODO`（常量引用，非占位符标记），无真实占位符 |
| 类型一致性 | ✅ | 4 个 helper 类构造签名与 plan.md 设计一致；主类薄委托方法签名保持不变；共享 Map 仍挂在 dispatcher 实例上 |
| 最终一致性核验 | ✅ | plan.md 5 项拆分目标全部达成（见下表）；兼容性约束 3 个 Map 字段全部保持 |
| Drift Check | ✅ | 实现匹配 plan 目标，未引入 spec 外范围，未改公开方法签名，未改 bootstrap.js，未重构 _cmdXxx |

### Requirement Coverage（对照 plan.md 拆分边界）

| Requirement ID | 代码位置 | 测试证据 | 状态 |
| -------------- | -------- | -------- | ---- |
| REQ-1 turn-state.js | `src/dispatch/turn-state.js:1` TurnStateManager（141 行，8 方法） | message-dispatcher.test.js + 3 集成测试全通过 | PASS |
| REQ-2 heartbeat.js | `src/dispatch/heartbeat.js:1` PromptHeartbeat（89 行，3 方法） | 同上 | PASS |
| REQ-3 progress-renderer.js | `src/dispatch/progress-renderer.js:1` ProgressRenderer（319 行，16 方法） | 同上 + progress-card.test.js | PASS |
| REQ-4 permission-handler.js | `src/dispatch/permission-handler.js:1` PermissionHandler（60 行，2 方法） | 同上 | PASS |
| REQ-5 主调度骨架保留 | `src/dispatch/message-dispatcher.js:1`（1167 行，-408） | 全套 907 tests | PASS |
| REQ-6 行为不变 | 全套 33 测试文件 | 907 pass, 0 fail | PASS |
| REQ-7 兼容性（turnStates Map） | dispatcher 实例字段保留 | 9 处测试访问全通过 | PASS |
| REQ-8 兼容性（sessionWatchStops Map） | dispatcher 实例字段保留 | 4 处测试访问全通过 | PASS |
| REQ-9 兼容性（sessionWatchProgressCards Map） | dispatcher 实例字段保留 | 1 处测试访问通过 | PASS |
| REQ-10 bootstrap.js 导入路径不变 | `src/app/bootstrap.js:10,47,103` | 未修改，测试通过 | PASS |

### Evidence Receipt

- evidence-command: `node scripts/check.js && npx eslint src/dispatch/*.js && node --test "test/**/*.test.js"`
- evidence-exit-code: `0`（三命令均 0）
- evidence-file: `evidence/verification.log`
- evidence-sha256: `cd872767e070a419ad74863f6c22b90b5250aa6b0c415f9c0919cf23188fddee`

### 关键产物指纹（SHA-256）

| 文件 | 行数 | SHA-256 |
|------|------|---------|
| src/dispatch/message-dispatcher.js | 1167 | ffd145f86a4de6fe1ad727b278f3fbb8c291519f378fcb3b19e65945e07f9e3a |
| src/dispatch/turn-state.js | 141 | b16cc9b2fa97cacecf376372571b3b2a71ba974d05af278145e56d05e8b70265 |
| src/dispatch/heartbeat.js | 89 | cf3d7a38d3776087d01813d3217b36a9bcba1adeafb181be202fd26560b02fdb |
| src/dispatch/progress-renderer.js | 319 | f79de15ca6caabfa69b5b16940f4eea2591584ec31c8bbe7f90ed91deae9c322 |
| src/dispatch/permission-handler.js | 60 | 90ee300113413cb704c88c8f99a366ef0e53b999e8e59fe0985793d12ad12607 |

### 剩余风险

- 主文件仍 1167 行（_cmdXxx 命令处理系列按 plan 保留，与主调度耦合紧）——非本次拆分目标，未来可单独评估。
- 未提交 git（用户未要求）——验证仅覆盖工作区当前状态。

verdict: PASS
