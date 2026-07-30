# Code Review Request

**Feature:** npm publish scripts and daemon runtime data directory
**Spec:** `specs/2026-07-30-npm-publish-cli`
**Review base:** current `HEAD`

## Findings

### Standards

- No blocker findings. Pre-review found one daemon initialization risk before this request was finalized: `src/index.js` requires `src/cli/daemon.js` before `runForeground()` calls `loadEnvConfig()`, so `.env` values for `WALKER_DATA_DIR` would not affect daemon path constants. This was fixed in `src/cli/daemon.js` by calling `loadDotEnv()` before `DATA_DIR` initialization and covered by a new daemon unit test.

### Spec

- No blocker findings. Implementation matches `REQ-001`, `REQ-002`, and `REQ-003`: npm lifecycle scripts run `npm test`, daemon pid/stdout/stderr paths now resolve under the Walker data directory, and existing CLI foreground/background subcommand behavior is preserved.

### Pre-Review Summary

- Standards findings: 0 blocker, worst: none after the `.env` load-order fix.
- Spec findings: 0 blocker, worst: none.

## Change Statistics

```text
.loom/compliance/history.json | 28 ++++++++++++
README.md                     |  2 +-
package.json                  |  2 +
src/cli/daemon.js             | 20 +++++++--
src/index.js                  |  2 +-
test/daemon.test.js           | 99 +++++++++++++++++++++++++++++++++++++++++++
6 files changed, 148 insertions(+), 5 deletions(-)
```

Note: `.loom/compliance/history.json` is an automatic loom compliance record, not part of the product implementation.

## Main Changes

1. Added npm lifecycle safety scripts in `package.json`: `prepack` and `prepublishOnly` both run `npm test`.
2. Moved daemon runtime files from the package/project directory to the Walker data directory in `src/cli/daemon.js`.
3. Preserved `WALKER_DATA_DIR` semantics, including `~` expansion and values loaded from `.env` before daemon path constants are initialized.
4. Updated `walker help` and `README.md` so users see the real background log location.
5. Expanded `test/daemon.test.js` coverage for default `~/.walker`, explicit `WALKER_DATA_DIR`, `.env` loading, no package-directory fallback, and logs directory creation before opening daemon stdout/stderr files.

## File Details

| File | Type | Notes |
| --- | --- | --- |
| `package.json` | Modified | Adds `prepack` and `prepublishOnly`, both delegating to `npm test`. |
| `src/cli/daemon.js` | Modified | Resolves `DATA_DIR`, `PID_FILE`, `OUT_LOG`, and `ERR_LOG` from Walker data dir instead of `PROJECT_ROOT`; loads `.env` before path constants. |
| `src/index.js` | Modified | `walker help` prints exported daemon log paths instead of hard-coded `logs/...`. |
| `README.md` | Modified | Documents background logs under Walker data dir, defaulting to `~/.walker/logs/`. |
| `test/daemon.test.js` | Modified | Adds path migration and `.env` loading tests; existing daemon log rotation/start tests still pass. |
| `specs/2026-07-30-npm-publish-cli/*` | Added | Requirements, plan, traceability, test report, verification report, evidence, task states, and handoffs for this change. |

## Self-Test Evidence

- `node --test test/daemon.test.js`: PASS, 9 daemon tests passed.
- `npm test`: PASS, `tests 1261`, `suites 65`, `pass 1261`, `zero unsuccessful`, `duration_ms 16224.423`.
- `npm pack --dry-run`: PASS, triggered `prepack` and `npm test`; package `walker-bridge-0.1.0.tgz`, `total files 101`, shasum `2da127689211c4fe402b2cf18679ab2155ca6e79`.
- `git diff --check`: PASS, no output.
- `loom tasks --spec-dir "H:\walker\specs\2026-07-30-npm-publish-cli" --validate`: PASS, no task ownership conflicts.

## Review Focus

- Verify that loading `.env` in `src/cli/daemon.js` is acceptable for all daemon subcommands and does not introduce unwanted side effects beyond honoring `WALKER_DATA_DIR` earlier.
- Verify the daemon path constants being computed at module load remain acceptable for `start/status/stop/logs` in CLI processes.
- Verify npm lifecycle scripts are intentionally strict: `prepack` and `prepublishOnly` both run the full existing `npm test`.

## Residual Risks

- No real global `npm install -g` execution was performed; package behavior was validated through `npm pack --dry-run` and daemon unit tests.
- `verify-artifacts.mjs` could not run because the local opencode skill installation is missing `src/core/artifact-checker.js`; direct project verification commands passed and this is recorded as a known tooling warning in `verify-report.md`.
