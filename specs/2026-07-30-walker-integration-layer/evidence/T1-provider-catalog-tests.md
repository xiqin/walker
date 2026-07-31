# T1 Provider Catalog Evidence

## Scope

- Task: T1
- Behaviors: REQ-001-B01, REQ-001-B02, REQ-001-B03, REQ-001-B04, REQ-001-B05, REQ-001-B06, REQ-001-B07, REQ-007-B05

## Commands

- `node --test test/provider-catalog.test.js test/driver-registry.test.js`
- Result: PASS, 12 tests passed, 0 failed.
- `npm run lint`
- Result: PASS.
- `npm run check`
- Result: PASS, 1276 tests passed, 0 failed.

## Reviewer Fix Verification

- `src/providers/provider-detectors.js` default resolver now uses `which <command>` on non-Windows and `where <command>` on Windows via `execFile` path execution, with tests covering both platform branches through the default resolver.
- `src/admin/agent-runtime-admin.js` now accepts `providerStatuses` as either an array or object map and reuses full provider status fields before falling back to metadata.
- `test/driver-registry.test.js` covers the real `DriverRegistry.listProviderStatuses()` plus `listAgents()` integration path, including `installed`, `version`, `healthy`, `problems`, `suggestions`, `health`, and registration fields.

## Covered Files

- `test/provider-catalog.test.js`
- `test/driver-registry.test.js`
- `src/providers/provider-catalog.js`
- `src/providers/provider-detectors.js`
- `src/providers/provider-health.js`
- `src/drivers/driver-registry.js`
- `src/admin/agent-runtime-admin.js`
