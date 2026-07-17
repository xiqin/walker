# 贡献指南

感谢你对 Walker 项目的兴趣！Walker 是飞书多 Agent CLI 桥接器，通过飞书长连接操控本机 opencode agent 会话（架构保留 Claude Code、Codex 等扩展点）。本文档说明如何参与本项目开发。

## 环境准备

- **Node.js**：v22.11.0 或更高（推荐使用 LTS）
- **npm**：v10.9.0 或更高
- **操作系统**：当前仅支持 Windows（PowerShell 脚本）；WSL 模式用于在 Windows 上运行 Linux Agent CLI
- **飞书应用**：需要一个已开启机器人能力、订阅 `im.message.receive_v1` 事件的飞书自建应用

### 安装依赖

```powershell
npm install
```

### 配置环境变量

复制 `.env.example` 为 `.env` 并填入飞书应用凭据：

```powershell
Copy-Item .env.example .env
```

## 开发流程

### 1. 验证基线

开始任何改动前，先确认现有测试通过：

```powershell
npm test
```

该命令执行两步校验：

- `node --check` 对所有源文件做语法检查
- `node --test` 运行 `test/` 目录下的测试套件（33 个文件，907 个测试）

### 2. 创建分支

使用 conventional commits 风格的分支命名：

```powershell
git checkout -b feature/<简要描述>
git checkout -b fix/<简要描述>
git checkout -b refactor/<简要描述>
```

### 3. 编码

Walker 采用 CommonJS 模块系统（`"type": "commonjs"`），无打包步骤。源码组织：

| 目录                       | 职责                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `src/core/`                | 核心工具：session-service、json-store、logger、http-helper 等 |
| `src/drivers/`             | Agent 驱动层：agent-driver 基类、opencode-driver 主驱动       |
| `src/platform/feishu/`     | 飞书平台层：platform、api、events、commands、cards            |
| `src/admin/`               | Web 管理端：HTTP server、router、auth、各类 admin 路由        |
| `src/opencode-tui-bridge/` | TUI 桥接：bridge、routes                                      |
| `src/opencode-hook/`       | Hook 机制：plugin installer、receiver、health-poller          |
| `src/runtime/`             | 运行时：windows-runtime、wsl-runtime、runtime-factory         |
| `src/dispatch/`            | 消息分发：message-dispatcher（核心调度）、attachment-service  |
| `test/`                    | 测试套件                                                      |

编码约定：

- 使用中文 JSDoc 注释描述函数职责和参数（已有惯例）
- 敏感字段（token/secret/password/apikey）日志输出必须脱敏，使用 `src/core/logger.js` 的 redact 机制
- 新增配置项需同步更新 `.env.example` 和 `README.md` 环境变量表
- 新增源文件自动纳入语法检查（`scripts/check.js` 递归扫描 `src/**/*.js`，无需手动维护列表）
- 代码风格由 ESLint 强制（`eslint.config.js`）：2 空格缩进、单引号、分号、`===`、无 tab、多行尾逗号；运行 `npm run lint` 检查，`npm run lint:fix` 自动修复

### 4. 测试

Walker 使用 Node.js 内置 `node:test` 测试框架，不依赖第三方断言库。

运行测试：

```powershell
npm test
```

编写测试时：

- 单元测试放在 `test/` 下，命名 `<模块名>.test.js`
- 集成测试命名 `<场景>.test.js`，如 `feishu-tui-sync.test.js`、`hook-routing.test.js`
- 测试应覆盖正常路径和边界条件
- 涉及外部服务（飞书 API、opencode server）的测试用 mock/stub

### 5. 提交

遵循 Conventional Commits 规范：

```
<type>: <描述>

[可选 body]
```

常用 type：

- `feat`：新功能
- `fix`：bug 修复
- `refactor`：重构（不改变行为）
- `chore`：杂项（依赖升级、配置调整、文档更新）
- `docs`：文档
- `test`：测试

提交示例：

```
feat: 支持飞书卡片按钮切换焦点 session
fix: SSE 断流后游标错位导致丢失事件
refactor: 全局错误处理统一 + parseBody 异步化
```

### 6. 自检清单

提交前确认：

- [ ] `npm test` 通过
- [ ] 新增源文件已加入 `check` 脚本
- [ ] 新增环境变量已更新 `.env.example` 和 `README.md`
- [ ] 敏感信息不会出现在日志或提交中
- [ ] commit message 符合 conventional commits
- [ ] 无 `console.log` 调试残留（应使用 `src/core/logger.js`）

### 日志规范

- 使用 `src/core/logger.js` 的结构化 JSON 日志
- 日志级别通过 `WALKER_LOG_LEVEL` 环境变量控制（默认 `info`）
- 禁止直接 `console.log`，避免污染日志格式
- 敏感字段自动脱敏，新增敏感字段需扩展 logger 的 redact 列表

### 路由与 Session 机制

- routeKey 三种模式：`thread`（消息线程）、`user`（用户）、`channel`（群）
- 1:N session 路由：同一 routeKey 可绑定多个 session，焦点 session 接收普通消息
- 修改路由逻辑需注意 `_schemaVersion` 迁移兼容（当前版本 3）

## 报告问题

- Bug 报告请包含：复现步骤、预期行为、实际行为、日志片段（脱敏后）、环境信息
- 安全问题请勿公开 issue，直接联系维护者

## 版本发布

版本号遵循 semver，记录在 `package.json` 的 `version` 字段和 `CHANGELOG.md`。
