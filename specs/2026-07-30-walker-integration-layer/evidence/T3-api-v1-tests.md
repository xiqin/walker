# T3 API v1 Evidence

## Scope

- Task: T3
- Behaviors: REQ-003-B01, REQ-003-B02, REQ-003-B03, REQ-003-B04, REQ-003-B05, REQ-003-B06, REQ-007-B01, REQ-007-B03, REQ-007-B04, REQ-007-B05

## Commands

```text
node --test test/api-v1.test.js test/api-v1-auth.test.js test/admin-core-api.test.js
```

Result: PASS

Summary: 69 tests passed, 0 failed.

```text
npm run check
```

Result: PASS

Summary: 1290 tests passed, 0 failed.

```text
node --test test/api-v1.test.js test/api-v1-auth.test.js test/admin-core-api.test.js
```

Result: PASS after reviewer fix

Summary: 69 tests passed, 0 failed. This rerun includes regression assertions that `/api/v1/routes` list/detail/focus responses do not expose raw `session` state or nested `agentRef.secretToken`.

## Coverage Notes

- `test/api-v1.test.js` covers v1 provider status/doctor, session list/create/detail/stop/delete/cancel reachable surfaces, route list/detail/focus/unfocus, prompt success and invalid input, event/metric visibility, secret redaction, handler exception capture, and `/api/admin/*` compatibility path behavior.
- Reviewer fix: `src/api/v1/routes-routes.js` now maps Admin route DTOs to a stable v1 route DTO and strips raw `session` from list/detail/write-operation responses.
- `test/api-v1-auth.test.js` covers missing token, wrong token, and valid token access for `/api/v1/*` through the existing Admin auth guard.
- `test/admin-core-api.test.js` was run as regression evidence that existing Admin core API behavior did not regress.
- Tests use in-memory Admin server and mock appContext/registry/sessionService; no real network provider or external service is required.
