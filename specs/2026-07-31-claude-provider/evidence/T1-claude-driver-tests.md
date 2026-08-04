# T1 ClaudeDriver 验证证据

## 命令

```powershell
node --test test/claude-driver.test.js
npx eslint src/drivers/claude-driver.js test/claude-driver.test.js
```

## 结果

- `node --test test/claude-driver.test.js` 通过：9 个测试全部通过。
- `npx eslint src/drivers/claude-driver.js test/claude-driver.test.js` 通过：无 ESLint 报错。

## 覆盖点

- Claude CLI `--version` 探测成功与失败脱敏诊断。
- Claude sessionRef 创建和恢复，不混用 OpenCode session 字段。
- `claude --print --output-format stream-json` 的 argv 构造，`shell:false`，模型、agent、tools、permission mode 映射。
- stream-json 文本、reasoning、tool use、tool result、error、done、unknown event 映射。
- 默认不传危险权限参数。
- 非零退出 stderr 脱敏。
- `stop`、`cancel`、`delete` pending 子进程清理幂等。
- 自动测试使用 fake `execFile`/`spawn`，未调用真实 Claude prompt。
