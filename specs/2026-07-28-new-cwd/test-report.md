# Test Report: New Command CWD

## Summary

Status: PASS

Executing stage implemented and verified `/new [agent] [title] [--cwd <path>]`. `MessageDispatcher` now consumes only the explicit `--cwd` option, passes the selected cwd to both driver and Walker session creation, preserves the default cwd when omitted, rejects missing cwd values without creating or binding a new session, and leaves non-option positional arguments on the existing agent/title path. Command help, README, and debug console documentation were updated.

## Evidence Receipt: Message Dispatcher

- evidence-command: `node --test "test/message-dispatcher.test.js"`
- evidence-exit-code: 0
- evidence-file: `evidence/test-run-message-dispatcher.log`
- evidence-sha256: 3251e66066e0619f4e74e6a9cfd2bb6c35920a07dee5c1abf05a4f0613c40fab

Evidence file: `specs/2026-07-28-new-cwd/evidence/test-run-message-dispatcher.log`

Result:

```text
tests 169
suites 19
pass 169
cancelled 0
skipped 0
duration_ms 1747.0536
```

Outcome: PASS, all 169 tests completed successfully.

Covered behaviors: `REQ-001-B01`, `REQ-001-B02`, `REQ-001-B03`, `REQ-001-B04`, `REQ-002-B01`, `REQ-002-B02`, `REQ-002-B03`, `REQ-002-B04`.

## Evidence Receipt: Feishu Commands

- evidence-command: `node --test "test/feishu-commands.test.js"`
- evidence-exit-code: 0
- evidence-file: `evidence/test-run-feishu-commands.log`
- evidence-sha256: 0874af36a3fd5492cc882d889bb3a1110939728e79fd56c41a65775012d4a69d

Evidence file: `specs/2026-07-28-new-cwd/evidence/test-run-feishu-commands.log`

Result:

```text
tests 32
suites 0
pass 32
cancelled 0
skipped 0
duration_ms 237.423
```

Outcome: PASS, all 32 tests completed successfully.

Covered behaviors: `REQ-003-B01`, `REQ-003-B02`.

## Requirement Coverage

REQ-001: Covered. `test/message-dispatcher.test.js` verifies explicit `--cwd` is passed to `driver.createSession` and `sessionService.createSession`, `agent` and `title` parsing is preserved, omitted `--cwd` uses `defaultCwd`, and a third bare positional argument is not treated as cwd.

REQ-002: Covered. `test/message-dispatcher.test.js` verifies `/new --cwd` without a path returns a visible error, does not call driver/session creation, and leaves the current route binding unchanged.

REQ-003: Covered. `test/feishu-commands.test.js` verifies `/new` usage and formatted help include `[--cwd <path>]`, and `parseCommand` still tokenizes `--cwd` arguments without adding shell-style parsing.
