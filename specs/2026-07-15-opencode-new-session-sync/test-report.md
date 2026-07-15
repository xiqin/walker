# OpenCode 新会话同步修复 - 执行测试报告

## 测试概览

- 覆盖 Requirement：REQ-001、REQ-002、REQ-003、REQ-004、REQ-005
- 目标测试：15 项通过，0 项失败
- 差异格式检查：通过
- 全量验证：由后续 verification 阶段执行

## 红绿反馈环

### 修复前（known red baseline）

- 命令：`node --test test/opencode-hook-installer.test.js`
- 结果：14 项通过，1 项失败
- 失败信号：生成插件未注册 `session.created` handler，实际值为 `undefined`
- 结论：失败准确复现 `/new` 后插件无法切换活动会话的根因

### 修复后

- 命令：`node --test test/opencode-hook-installer.test.js`
- 结果：15 项通过，0 项失败
- 状态：PASS
- evidence-command: `node --test test/opencode-hook-installer.test.js`
- evidence-exit-code: `0`
- evidence-file: `evidence/target-test.log`
- evidence-sha256: `EFBE7E6616AD118924837CECAF8FA1912BA6EEFCB63470A2704DA63DAFE66380`

## Requirement 验证

### REQ-001：根会话创建后切换注册与轮询目标

- 固定 `api.route.current` 为滞后的 `ses_old`
- 触发根级 `session.created(ses_new)`
- 验证插件向 `ses_new` 发起 register 和 poll
- 状态：PASS

### REQ-002：新活动会话的双向事件归属

- 验证 delivery 通过 `promptAsync({ sessionID: 'ses_new' })` 执行
- 验证 `session.idle` 以上报 `sessionId=ses_new` 和对应 deliveryId
- 验证 `session.error` 以上报 `sessionId=ses_new`
- 状态：PASS

### REQ-003：选择已有 TUI 会话后重新绑定

- 触发 `tui.session.select(ses_existing)`
- 验证插件向 `ses_existing` 发起 register 和 poll
- 状态：PASS

### REQ-004：内部子会话不抢占活动会话

- 触发带 `info.parentID` 的 `session.created(ses_child)`
- 验证插件不向 `ses_child` 注册
- 状态：PASS

### REQ-005：模板升级与安装幂等

- 模板标记已从版本 1 升至版本 2
- 既有旧版升级测试已更新并通过
- 当前模板内容匹配时不重复写入的既有测试通过
- 状态：PASS

## 代码质量检查

- 命令：`git diff --check`
- 结果：退出码 0，无格式错误

## 结论

verdict: PASS

执行阶段的目标回归测试已通过。完整测试套件、语法检查和规格完整性将在 verification 阶段独立验证。
