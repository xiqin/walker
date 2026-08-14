# Test Report

## Summary

- Spec: `specs/2026-08-12-claude-opencode-tool-parity`
- Stage: `executing`
- Verdict: PASS
- Requirements covered: `REQ-001` through `REQ-008`
- Behavior obligations covered: 45 / 45
- Task states: T1 done, T2 done, T3 done, T4 done

## Evidence Receipt

- evidence-command: `npm test *> specs\2026-08-12-claude-opencode-tool-parity\evidence\executing-npm-test.log`
- evidence-exit-code: 0
- evidence-file: `evidence/executing-npm-test.log`
- evidence-sha256: `A9A71A7E1811F0E8DE8F120F62FB27E632154E919D211A97D2146AEB1D9E1D56`

## Commands

| Scope | Command | Result | Evidence |
| --- | --- | --- | --- |
| T1 driver and PTY | `node --test test/claude-driver.test.js test/claude-pty-broker.test.js` | PASS, 52 tests | `evidence/T1-node-test-claude-driver-pty-broker.log` |
| T1 reconnect regression | `node --test test/claude-tui-reconnect.integration.test.js` | PASS, 5 tests | `evidence/T1-node-test-claude-tui-reconnect.log` |
| T2 transcript and OpenCode regression | `node --test test/claude-transcript.test.js test/opencode-driver.test.js` | PASS, 111 tests | `evidence/T2-node-test-claude-transcript-opencode-driver.log` |
| T3 config/admin/provider regression | `node --test test/config-env.test.js test/bootstrap.test.js test/admin-observability-config.test.js test/provider-catalog.test.js` | PASS, 91 tests | `evidence/T3-node-test.log` |
| T3 whitespace check | `git diff --check` | PASS | `evidence/T3-git-diff-check.log` |
| T4 tool parity integration regression | `node --test test/claude-tool-parity.integration.test.js test/claude-driver.test.js test/claude-pty-broker.test.js test/claude-transcript.test.js test/opencode-driver.test.js test/provider-catalog.test.js` | PASS | `evidence/T4-node-test-claude-tool-parity-regression.log` |
| T4 whitespace check | `git diff --check` | PASS | `evidence/T4-git-diff-check.log` |
| Full project regression | `npm test` | PASS | `evidence/executing-npm-test.log` |

## Requirement Coverage

| Requirement | Covered By | Evidence |
| --- | --- | --- |
| REQ-001 | T1, T4 | `T1-node-test-claude-driver-pty-broker.log`, `T1-node-test-claude-tui-reconnect.log`, `T4-node-test-claude-tool-parity-regression.log` |
| REQ-002 | T1, T4 | `T1-node-test-claude-driver-pty-broker.log`, `T4-node-test-claude-tool-parity-regression.log` |
| REQ-003 | T1, T3, T4 | `T1-node-test-claude-driver-pty-broker.log`, `T3-node-test.log`, `T3-receipt.json`, `T4-node-test-claude-tool-parity-regression.log` |
| REQ-004 | T2, T4 | `T2-node-test-claude-transcript-opencode-driver.log`, `T4-node-test-claude-tool-parity-regression.log` |
| REQ-005 | T1, T2, T3, T4 | `T1-node-test-claude-driver-pty-broker.log`, `T1-node-test-claude-tui-reconnect.log`, `T2-node-test-claude-transcript-opencode-driver.log`, `T3-node-test.log`, `T4-node-test-claude-tool-parity-regression.log` |
| REQ-006 | T3, T4 | `T3-node-test.log`, `T3-git-diff-check.log`, `T3-receipt.json`, `T4-node-test-claude-tool-parity-regression.log` |
| REQ-007 | T1, T2, T4 | `T1-node-test-claude-driver-pty-broker.log`, `T1-node-test-claude-tui-reconnect.log`, `T2-node-test-claude-transcript-opencode-driver.log`, `T4-node-test-claude-tool-parity-regression.log` |
| REQ-008 | T1, T2, T4 | `T1-node-test-claude-driver-pty-broker.log`, `T1-node-test-claude-tui-reconnect.log`, `T2-node-test-claude-transcript-opencode-driver.log`, `T4-node-test-claude-tool-parity-regression.log` |

## Supporting Evidence Receipts

- `specs/2026-08-12-claude-opencode-tool-parity/evidence/T1-node-test-claude-driver-pty-broker.log`
- `specs/2026-08-12-claude-opencode-tool-parity/evidence/T1-node-test-claude-tui-reconnect.log`
- `specs/2026-08-12-claude-opencode-tool-parity/evidence/T2-node-test-claude-transcript-opencode-driver.log`
- `specs/2026-08-12-claude-opencode-tool-parity/evidence/T3-node-test.log`
- `specs/2026-08-12-claude-opencode-tool-parity/evidence/T3-git-diff-check.log`
- `specs/2026-08-12-claude-opencode-tool-parity/evidence/T3-receipt.json`
- `specs/2026-08-12-claude-opencode-tool-parity/evidence/T4-node-test-claude-tool-parity-regression.log`
- `specs/2026-08-12-claude-opencode-tool-parity/evidence/T4-git-diff-check.log`
- `specs/2026-08-12-claude-opencode-tool-parity/evidence/executing-npm-test.log`

## Notes

- The full `npm test` run was retried with a 10 minute timeout after the first 120 second host timeout. The retry completed successfully.
- `traceability.json` has behavior-level `tests` and `evidence` for all 45 behavior obligations.
- T4 integration uses controlled fake PTY, bridge, transcript, and HTTP clients. It verifies contracts without launching a real Claude TUI.
- The working tree intentionally remains dirty because the user approved implementing on `main` with existing related uncommitted changes preserved.
