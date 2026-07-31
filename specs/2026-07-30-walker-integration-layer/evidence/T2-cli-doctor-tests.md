# T2 CLI Doctor/Providers Evidence

## Scope

- Task: T2
- Behaviors: REQ-002-B01, REQ-002-B02, REQ-002-B03, REQ-002-B04, REQ-002-B05, REQ-002-B06, REQ-005-B06, REQ-007-B03, REQ-007-B06
- Changed CLI files: `src/index.js`, `src/cli/cli-output.js`, `src/cli/doctor-command.js`, `src/cli/providers-command.js`
- Tests: `test/doctor-cli.test.js`, `test/providers-cli.test.js`

## Verification Commands

### `node --test test/doctor-cli.test.js test/providers-cli.test.js`

- Result: PASS
- Summary: 7 tests passed, 0 failed
- Coverage notes:
  - `walker doctor` output includes Core, Platforms, Providers, Suggestions.
  - Sensitive values including `WALKER_ADMIN_TOKEN` and `FEISHU_APP_SECRET` are not emitted in output.
  - Provider failure keeps other checks running and reports problem/suggestion.
  - Doctor command uses injected read-only dependencies and does not call mutating registry methods.
  - `providers list`, `providers doctor [id]`, and unknown provider non-zero error path are covered without relying on local provider binaries.
  - CLI usage retains existing foreground/start/stop/status/logs/help commands and adds doctor/providers/init entries.

### `npm run check`

- Result: PASS
- Summary: 1283 tests passed, 0 failed

### `npm run lint`

- Result: PASS
- Summary: ESLint completed without reported errors.

## Security/Forbidden Behavior Review

- `doctor` and T2 `init` preview are read-only: no config writes, no third-party secret writes, no shell profile changes, no system service changes.
- New CLI commands do not create listeners and do not alter Admin host/token checks.
- Output path sanitizes sensitive keys and common token/secret assignment patterns before writing to stdout/stderr.
