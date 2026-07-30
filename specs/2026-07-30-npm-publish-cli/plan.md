# npm 发布与后台运行态路径修复计划

## 摘要

本计划将 Walker 的 npm 发布前校验接入现有 `npm test`，并把后台 daemon 的 pid/stdout/stderr 运行态文件从包安装目录迁移到 Walker 数据目录。实现保持 `walker` 默认前台启动和现有 daemon 子命令语义不变。

## 任务概览

| Task | 名称 | 依赖 | 主要文件 | 覆盖需求 |
| --- | --- | --- | --- | --- |
| T1 | 增加 npm 发布前校验脚本 | 无 | `package.json` | REQ-001 |
| T2 | 迁移 daemon 后台运行态路径并补测试 | T1 | `src/cli/daemon.js`, `test/daemon.test.js` | REQ-002, REQ-003 |

## 实现顺序

1. 先更新 `package.json`，让 `npm pack` 与 `npm publish` 生命周期均复用 `npm test`。
2. 再更新 daemon 路径解析逻辑，复用 `WALKER_DATA_DIR` / `~/.walker` 语义，避免写入包安装目录。
3. 补充 daemon 路径测试，覆盖默认数据目录、显式 `WALKER_DATA_DIR`、`~` 展开和 start 创建日志目录。
4. 运行 `npm test` 与 `npm pack --dry-run` 验证。

## 并行性

T1 与 T2 修改不同生产文件，但 T2 的最终验证依赖发布脚本存在，因此按串行执行。无需 subagent 并行。

## 验证计划

- `npm test`
- `npm pack --dry-run`
