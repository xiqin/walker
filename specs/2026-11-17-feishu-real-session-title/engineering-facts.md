# 规划工程事实

## 核实范围

2026-11-17 在主仓库只读核实；没有修改业务代码、没有读取真实会话标题、没有启动额外 OpenCode 服务。以下是工程事实，不是修复已通过的证据。

| 项目 | 已核实事实 | 依据 |
| --- | --- | --- |
| 驱动与依赖 | CommonJS、Node.js >=22.11.0；驱动已有 HTTP 客户端、`execFile`、`sqliteCmd` 和 `opencodeDbPath` | `package.json`；`src/drivers/opencode-driver.js:39-76` |
| HTTP 认证 | `_configureEndpoint` 解析既有地址和认证；`_applyAuthHeaders` 将现有 Basic 认证设置给 HTTP/SSE 客户端 | `src/drivers/opencode-driver.js:79-105`；`src/drivers/opencode-service.js:48-79` |
| HTTP 超时 | `DefaultHttpClient.request` 支持第四参数 `timeoutMs`；`httpRequest` 用总时钟定时器执行 `req.destroy(err)`，并非仅 socket 空闲超时。未显式指定时不可假设是2秒 | `src/drivers/opencode-http-client.js:17-25`；`src/core/http-helper.js:23-98` |
| HTTP 目标 | `_buildUrl` 优先使用关联 `sessionRef.serverUrl`，其次驱动地址 | `src/drivers/opencode-driver.js:1000-1003` |
| 官方响应 | `GET /api/session/{sessionID}` 返回 JSON `{data: Session.Info}`；`Session.Info.title` 是可选字符串。现有 HTTP 包装再包一层，因此应从 `resp.data.data.title` 读取；可兼容已有测试边界中直接 `resp.data.title`，不得使用会生成默认名的 `normalizeSessionSummary` 作为真实标题源 | `https://opencode.ai/docs/api` 和 `https://opencode.ai/docs/openapi.json`，本轮只读获取相应操作和 schema |
| TUI 数据库 | 默认文件为用户目录 `.local/share/opencode/opencode.db`，`session` 表存在 `id TEXT PRIMARY KEY` 和 `title TEXT NOT NULL` | Python sqlite 3.50.4 使用 `mode=ro` URI 执行 `PRAGMA table_info(session)`；随后以现有 sqlite 命令重复只读核实 |
| SQLite 命令兼容 | 本机默认命令是 `I:/phpStudy/Apache/bin/sqlite3.exe`，版本3.13.0；不支持 `-readonly`，支持 `file:///...?...mode=ro` 连接。不可依赖新版 JSON 输出选项 | `sqlite3 -version`、`sqlite3 -help`；只读 URI 下的 `PRAGMA table_info(session)` 成功 |
| 既有 SQL 入口 | `_queryLocalMessageTable` 用单引号双写转义 ID，通过 `execFile` 而非 shell 执行；当前消息读取没有设置子进程超时。新标题读取不顺带改写消息读取 | `src/drivers/opencode-driver.js:291-299` |
| 会话归属缺陷 | 显式 `sessionId` 失效会继续使用 `routeKey` 的焦点会话 | `src/dispatch/message-dispatcher.js:2150-2161` |
| 页脚聚合 | `_feishuRuntimeContext` 当前直接使用本地标题；问题处理器也复用此入口。模型补读的既有状态写入必须保持原样，标题获取不能新增状态写入 | `src/dispatch/message-dispatcher.js:138-143,2119-2148` |
| 清理 | 调度器 `destroy()` 清理各集合并设置 `_destroyed`；新增缓存归调度器管理，并在此清空、阻止迟到写入 | `src/dispatch/message-dispatcher.js:2352-2371` |
| 验证命令 | `npm test` 依次执行 ESLint、源码语法检查和 `test/*.test.js`；测试串行运行 | `package.json:30-37`；`scripts/check.js:40-69` |

## 安全与局限

- 两次早期命令失败：旧 SQLite 不识别 `-readonly`；PowerShell 转义造成一次 Python 语法错误。它们不是业务失败证据，也没有产生数据库写入；之后只读 schema 检查成功。
- 标题查询计划使用只读 URI、`SELECT hex(title) FROM session WHERE id=... LIMIT 1`。十六进制输出兼容旧 SQLite，避免多行标题被行分隔截断；Node.js 解码回 UTF-8。ID 必须双写单引号；文件路径必须通过 `pathToFileURL` 生成，不能拼接不可信 SQL。
- 官方 schema 是接口契约证据，不代表已对本机活服务执行标题接口。实施后以真实客户端和隔离测试服务验证响应及超时；不启动真实 OpenCode 服务。
- 宪章中的技术栈占位项没有作为事实使用，也不在本需求中修改宪章。
