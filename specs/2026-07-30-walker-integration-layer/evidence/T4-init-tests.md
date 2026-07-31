# T4 init 测试证据

## 命令

- `node --test test/init-cli.test.js`
- `node --test test/init-cli.test.js test/providers-cli.test.js`
- `npm run check`

## 结果

- `node --test test/init-cli.test.js`: PASS，8 个测试通过，0 失败。
- `node --test test/init-cli.test.js test/providers-cli.test.js`: PASS，12 个测试通过，0 失败；覆盖真实 `walker init` 调度和帮助文案同步。
- `npm run check`: PASS，1321 个测试通过，0 失败。

## 覆盖点

- `REQ-005-B01`: 首次 init 在临时数据目录创建 `state.json`、`dedup.json`、`attachments/`、`logs/` 和 `config.json` 模板；入口级测试通过 `main(['init'], opts)` 覆盖真实 CLI 调度。
- `REQ-005-B02`: 重复 init 保留已有 `config.json`、`state.json` 和 `dedup.json` 内容。
- `REQ-005-B03`: 环境或生成的 admin token 输出均只显示脱敏值，不写入 `config.json`。
- `REQ-005-B04`: `safeWriteJson` 使用临时文件和 rename，模拟 rename 失败时清理临时文件且不留下损坏 JSON。
- `REQ-005-B05`: 缺失 `logs/` 可重建；损坏 `config.json` 返回明确错误并保留原文件。
- `REQ-005-B06`: init 不修改 shell profile、系统服务文件，也不写入 `FEISHU_APP_SECRET` 等第三方平台密钥。
- `REQ-007-B03`: 默认 admin host 模板保持 loopback，token 只引用 `WALKER_ADMIN_TOKEN` 环境变量入口，不降低安全边界。
- `REQ-007-B05`: 文件系统异常被捕获并转换为明确非零返回和错误输出，不抛出未处理异常。
- `REQ-007-B06`: `src/index.js` 的 `init` 分支已接线到 `initCommand.run(args.slice(1), opts)`，保留 `main(argv, options)` 的测试注入能力，未修改或删除既有 CLI、环境变量入口、Admin API。

## 备注

- `walker init` usage 文案已更新为初始化真实数据目录和配置，不再描述 preview。
- `test/providers-cli.test.js` 的 usage 断言已同步为真实初始化文案，消除了 T4 修复后由旧 preview 断言造成的全量检查阻断。
- 入口级测试使用临时 `WALKER_DATA_DIR` 和注入 `exit` 回调，验证真实创建资源、返回退出码 0，并确认输出不泄露完整 admin token。
