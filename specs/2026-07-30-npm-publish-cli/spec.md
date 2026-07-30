# npm 发布与后台运行态路径修复

## 背景

Walker 已经通过 `package.json` 的 `bin.walker` 暴露 `walker` 命令，且 `src/index.js` 支持默认前台启动。当前还需要补齐 npm 发布前校验脚本，并修复全局安装后后台模式将 `walker.pid` 与后台日志写入包安装目录的问题。

## 范围

- 为 npm 打包和发布增加自动校验脚本。
- 将 `walker start/status/logs/stop` 使用的 pid 文件和后台 stdout/stderr 日志迁移到用户数据目录。
- 保持 `walker` 前台启动行为不变。
- 保持现有 `WALKER_DATA_DIR` 配置语义：显式配置时优先使用，否则使用 `~/.walker`。

## 非目标

- 不发布 npm 包。
- 不更改包名、版本号或 npm registry 配置。
- 不改变飞书、opencode、admin console 的业务行为。

## 需求

### REQ-001 发布前校验脚本

npm 打包与发布前必须自动运行现有测试校验，降低发布坏包风险。

验收标准：`package.json` 包含 `prepack` 与 `prepublishOnly` 脚本，二者均执行现有 `npm test`。

### REQ-002 后台运行态文件位置

后台模式不得把 `walker.pid`、`walker.out.log`、`walker.err.log` 写入包安装目录。默认应写入 `~/.walker` 下；当设置 `WALKER_DATA_DIR` 时，应写入该目录下。

验收标准：daemon 导出的 pid/log 路径位于解析后的数据目录；`walker start` 创建日志目录并以该目录作为 pid/log 根位置。

### REQ-003 CLI 兼容性

现有 CLI 子命令语义保持不变，`walker` 仍前台启动，`walker start/stop/status/logs` 仍可用。

验收标准：现有 daemon 测试继续通过，并新增路径行为覆盖。
