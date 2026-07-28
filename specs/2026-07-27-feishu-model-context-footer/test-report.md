# Test Report: Feishu Model/Context Footer

## Summary

Status: PASS

The executing stage implemented and verified REQ-001, REQ-002, REQ-003, and REQ-004 for Feishu runtime footers. Text, Markdown, reply card, patch card, and progress card wrapper paths now receive a single runtime footer containing stable `模型` and `上下文` fields. Dispatcher sends runtime metadata instead of mutating business text, so FeishuApi remains the single formatting layer.

## Evidence Receipt

- evidence-command: `node --test "test/feishu-api.test.js" "test/message-dispatcher.test.js" "test/progress-card.test.js"`
- evidence-exit-code: 0
- evidence-file: `evidence/test-run-feishu-footer.log`
- evidence-sha256: 6cd879943163bdf505b3ba9a325b89ac550211fd1559f9e9b6d2e87cc52b60b4

Evidence file: `specs/2026-07-27-feishu-model-context-footer/evidence/test-run-feishu-footer.log`

Command:

```powershell
node --test "test/feishu-api.test.js" "test/message-dispatcher.test.js" "test/progress-card.test.js"
```

Result:

```text
tests 207
suites 19
pass 207
fail 0
cancelled 0
skipped 0
duration_ms 1710.1452
```

## Requirement Coverage

REQ-001: Covered. `test/feishu-api.test.js` verifies text, Markdown, reply card, and patch card payloads receive one footer with fixed `模型` and `上下文` field names while preserving original body content. `test/progress-card.test.js` remains green after progress card wrapper runtime passthrough.

REQ-002: Covered. `test/feishu-api.test.js` verifies object/string/default/unknown model rendering and exception fallback. `test/message-dispatcher.test.js` verifies Dispatcher passes latest session model metadata and falls back to `defaultModel` when session model is absent.

REQ-003: Covered. `test/feishu-api.test.js` verifies numeric, string, object, missing, and exceptional context metadata render as readable values or `unknown` without blocking send.

REQ-004: Covered. Long text split tests still pass after footer injection, retry/fallback behavior remains three attempts for retryable methods, Dispatcher runtime metadata tests assert no driver model-list call is introduced for footer generation, and progress card wrapper regression tests remain green.

## Notes

The prior ProgressRenderer/Dispatcher model-only footer behavior was intentionally moved out of Dispatcher. Dispatcher now preserves reply text exactly and passes runtime metadata to FeishuApi, which appends the unified footer with both model and context fields.
