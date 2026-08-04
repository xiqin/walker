# T2 Provider Bootstrap Tests

## 命令

- `node --test test/bootstrap.test.js test/provider-catalog.test.js test/driver-registry.test.js test/providers-cli.test.js test/doctor-cli.test.js`
- `npx eslint src/app/bootstrap.js src/providers/provider-catalog.js src/providers/provider-health.js test/bootstrap.test.js test/provider-catalog.test.js test/driver-registry.test.js test/providers-cli.test.js test/doctor-cli.test.js`

## 结果

- Node test: 53 tests passed, 0 failed.
- ESLint: passed with no output after removing the stale `stubClaudeDriver` import.

## 覆盖点

- `createApp()` registers a real `ClaudeDriver` instance under `claude` and keeps `opencode` plus `codex` registered.
- Claude provider catalog exposes CLI-based capabilities with `http:false`, `tui:false`, `models:true`, `permissions:true` and the planned `CLAUDE_*` config keys.
- DriverRegistry provider metadata and doctor status report Claude as registered, installed, healthy and versioned when the command detector succeeds.
- Provider list and doctor CLI tests continue to use injected registry/status objects and do not call a real Claude prompt.

## 真实 Claude 调用约束

T2 tests use injected drivers and detector dependencies. They do not execute `claude --print` or send a real prompt.
