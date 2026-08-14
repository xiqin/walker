# 飞书引用回复会话路由 — 测试报告

## 测试概览

- 总需求数：5
- 总 behavior 数：24
- 通过：24
- 失败：0
- 警告：1

## 集成测试

### 集成测试 1: 引用回复路由决策

- **涉及模块**: `FeishuPlatform` → `MessageDispatcher` → `SessionService`
- **状态**: PASS
- **覆盖需求**: `REQ-001`, `REQ-002`, `REQ-004`
- **测试结果**:
  - 引用命中按映射 session 投递：PASS
  - 引用命中不切换 route 焦点：PASS
  - effective route key 用于 prompt event 与 route lock：PASS
  - 无效或空 `parentId` 降级到直接回复路径：PASS
  - thread root fallback 保留且优先级低于有效 `parentId` 映射：PASS

### 集成测试 2: 飞书出站消息绑定记录

- **涉及模块**: `MessageDispatcher` → `Feishu API facade` → `SessionService`
- **状态**: PASS
- **覆盖需求**: `REQ-003`, `REQ-005`
- **测试结果**:
  - `replyText` 数组返回中的每个 message id 被记录：PASS
  - 字符串与对象返回形态 message id 被提取：PASS
  - 记录异常不影响飞书发送成功返回值：PASS
  - 发送失败 fallback 不写入虚假映射：PASS
  - 映射容量剪枝、旧 state 初始化、删除 session 清理：PASS

## 回归测试

- **测试命令**: `npm test`
- **工作目录**: `H:\walker\.worktree\2026-08-12-feishu-quoted-session-routing`
- **总测试数**: 1518
- **通过**: 1518
- **失败**: 0
- **跳过**: 0
- **Evidence**: `evidence/executing-npm-test.log`

### 新增代码引起的失败

无。

### 预先存在的失败

无。基线阶段曾发现 4 个既有失败，已在用户确认后先行修复；本执行阶段开始前 `npm test` 已恢复通过。

## 定向测试

- `node --test test/session-service.test.js`：PASS，55 个测试通过，证据 `evidence/T1-session-service.log`。
- `node --test test/feishu-platform.test.js test/feishu-events.test.js`：PASS，32 个测试通过，证据 `evidence/T2-feishu-platform.log`。
- `node --test test/message-dispatcher.test.js test/message-dispatcher-platform-event.test.js test/permission-handler.test.js`：PASS，214 个测试通过，证据 `evidence/T3-message-dispatcher.log`。

## Spec 验证详情

### REQ-001: 引用回复按被引用消息所属会话投递

- **状态**: PASS
- **验证行为**: `REQ-001-B01`, `REQ-001-B02`, `REQ-001-B03`, `REQ-001-B04`, `REQ-001-B05`, `REQ-001-B06`
- **测试文件**: `test/message-dispatcher.test.js`
- **证据**: `evidence/T3-message-dispatcher.log`, `evidence/executing-npm-test.log`

### REQ-002: 直接回复按当前焦点会话投递

- **状态**: PASS
- **验证行为**: `REQ-002-B01`, `REQ-002-B02`, `REQ-002-B03`, `REQ-002-B04`
- **测试文件**: `test/message-dispatcher.test.js`
- **证据**: `evidence/T3-message-dispatcher.log`, `evidence/executing-npm-test.log`

### REQ-003: 持久记录飞书出站消息到会话映射

- **状态**: PASS
- **验证行为**: `REQ-003-B01`, `REQ-003-B02`, `REQ-003-B03`, `REQ-003-B04`, `REQ-003-B05`, `REQ-003-B06`
- **测试文件**: `test/message-dispatcher.test.js`, `test/session-service.test.js`
- **证据**: `evidence/T3-message-dispatcher.log`, `evidence/T1-session-service.log`, `evidence/executing-npm-test.log`

### REQ-004: 飞书事件透传引用上下文

- **状态**: PASS
- **验证行为**: `REQ-004-B01`, `REQ-004-B02`, `REQ-004-B03`
- **测试文件**: `test/feishu-platform.test.js`, `test/feishu-events.test.js`
- **证据**: `evidence/T2-feishu-platform.log`, `evidence/executing-npm-test.log`

### REQ-005: 映射状态有边界并容忍旧数据

- **状态**: PASS
- **验证行为**: `REQ-005-B01`, `REQ-005-B02`, `REQ-005-B03`, `REQ-005-B04`, `REQ-005-B05`
- **测试文件**: `test/session-service.test.js`
- **证据**: `evidence/T1-session-service.log`, `evidence/executing-npm-test.log`

## 编译和静态分析

- `npm run lint`: PASS，通过 `npm test` 执行。
- `npm run check`: PASS，通过 `npm test` 执行，包含 syntax check 与完整 Node test suite。

## 警告

- `npm install` 阶段报告当前 Node `v22.11.0` 低于部分 ESLint 依赖声明的 `^22.13.0` 下界，并报告 3 个 high severity audit findings；这些不是本次功能引入，未在本阶段处理。

## Evidence Receipt

- evidence-command: `npm test`
- evidence-exit-code: `0`
- evidence-file: `evidence/executing-npm-test.log`
- evidence-sha256: `7F099D5164FACDF97288B9BB4E58FA790EDEE27441F0D781F3772740C64083DA`

verdict: PASS
