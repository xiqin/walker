# 飞书模型切换修复实现计划

**目标：** 将模型选择收敛为经过验证、session 级、类型一致的行为，并保证新建和 clear 会话正确继承。

**架构：** 先让 SessionService 在创建时原子保存模型对象，再由 MessageDispatcher 负责模型目录解析、验证和命令边界规范化。TUI bridge 复用创建参数继承模型，减少创建后的二次状态修改。

**技术栈：** Node.js CommonJS、`node:test`、Walker SessionService、OpenCode driver/TUI bridge。

---

## Task 概览

| Task | 名称 | 层级 | 复杂度 | 依赖 | 文件 |
| ---- | ---- | ---- | ------ | ---- | ---- |
| T1 | Session 模型原子创建能力 | 数据层 | 简单 | 无 | `tasks/T1.md` |
| T2 | 模型验证、切换与继承集成 | 业务与集成层 | 高 | T1 | `tasks/T2.md` |

## 依赖关系

T1 → T2
