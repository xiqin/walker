# 飞书模型切换修复需求规格

## 1. 概述

修复飞书 `/model` 与 `/new` 的会话模型行为，确保模型选择只影响当前 Walker session、始终使用完整且一致的模型引用，并在写入前验证模型是否可用。

## 2. 功能清单

| Requirement ID | 功能点 | 优先级 | 可验证验收标准 |
| -------------- | ------ | ------ | -------------- |
| REQ-001 | 模型切换仅作用于当前 session | P0 | 执行 `/model` 不调用 OpenCode `PATCH /config`，只更新当前 Walker session 的 `model` 字段 |
| REQ-002 | 验证并规范化模型引用 | P0 | `/model provider/model_id` 仅接受目录中匹配的 provider 与 model；保存为 `{ providerID, modelID }` |
| REQ-003 | 处理未限定 provider 的模型 ID | P0 | 唯一匹配时补全 provider；无匹配时拒绝；多个 provider 重名时提示使用完整 ID，且不修改 session |
| REQ-004 | 新 session 继承当前模型 | P0 | `/new` 创建的 OpenCode session 和 Walker session 均继承命令执行前当前 route 焦点 session 的规范化模型引用 |
| REQ-005 | 默认模型保持一致类型 | P1 | 配置的 `defaultModel` 在 prompt 前转换为 `{ providerID, modelID }` 或 `{ modelID }`，不向 driver 传递裸字符串 |
| REQ-006 | TUI clear 保持模型类型 | P1 | clear 后新 Walker session 继承旧 session 的模型对象，且新建时可直接通过 `createSession` 保存，不依赖二次类型不明确的更新 |
| REQ-007 | 回归测试 | P0 | dispatcher、session service 与 TUI bridge 的相关自动化测试覆盖成功、无匹配、歧义和继承场景并通过 |

## 3. 数据约束

持久化 session 的 `model` 统一使用以下形态：

```javascript
{
  providerID: 'provider-name',
  modelID: 'model-name'
}
```

仅在无法从配置获知 provider 的 `defaultModel` 兼容场景中允许 `{ modelID }`。不得写入裸字符串。模型对象在创建 session 时复制，避免不同 session 共享可变引用。

## 4. 业务规则

- `/model` 使用当前 agent driver 的 `listModels()` 获取可用目录，并忽略 deprecated 或 disabled 模型。
- 完整 ID 按第一个 `/` 分隔 provider 与 model ID；model ID 本身允许继续包含 `/`。
- 未限定 provider 时按模型 ID 精确匹配。
- 模型目录读取失败时命令失败，不写入未经验证的值。
- `/new` 只继承当前 route 在命令开始时的焦点 session 模型；无当前 session 时使用规范化的 `defaultModel`。
- 不删除 `OpencodeDriver.updateConfig()` 公共能力，但模型命令不再调用它。

## 5. 非目标

- 不改变 OpenCode 自身模型目录接口。
- 不新增全局默认模型管理命令。
- 不迁移历史持久化数据中的裸字符串；读取时仅在 prompt 与继承边界做规范化兼容。
- 不改变飞书以外入口的 session 创建语义。

## 6. 验证命令

```bash
node --test test/session-service.test.js test/message-dispatcher.test.js test/opencode-tui-bridge.test.js
npm test
```
