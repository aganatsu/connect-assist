# Task: Disable CHoCH-Against SL Tightening
## Branch: manus/disable-choch-tightening
## Behavior changes
1. The CHoCH-against structure invalidation SL tightening feature is now **disabled by default**. Previously, when a position was underwater (0R to -0.8R) and a CHoCH was detected against the trade direction on the entry timeframe, the SL was tightened by 50%. This fired on 57.5% of trades (23/40) and was stopping out winners during normal retracements.
2. The feature can be re-enabled by setting `structureInvalidationEnabled: true` in the bot config. All existing behavior is preserved when enabled.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added `structureInvalidationEnabled: false` to DEFAULTS (1 line in Exit toggles section). No gate definitions modified. |
| `supabase/functions/_shared/scannerManagement.ts` | Added config read (`config.structureInvalidationEnabled ?? false`) and wrapped the existing structure invalidation block with the toggle check (2 lines added). No logic inside the block was changed. |
| `supabase/functions/_shared/slFloorAndTier1Gate.test.ts` | Updated 3 existing test configs to explicitly pass `structureInvalidationEnabled: true` since they test the feature when enabled. |
| `supabase/functions/_shared/structureInvalidationToggle.test.ts` | New test file (3 tests). |

## Tests added

| Test | Assertion |
|------|-----------|
| `structureInvalidationEnabled=false → no fire` | With toggle off, no SL tightening occurs even when position is underwater |
| `structureInvalidationEnabled=true → fires` | Code path is reachable when enabled |
| `config key missing → defaults to false` | Old configs without the key default to disabled (backward compat) |

## Tests run

```
$ deno test --no-check supabase/functions/_shared/
107 passed | 5 failed (pre-existing on main: 2 candleSource API key tests + 3 snapshot tests)
```

All failures are pre-existing on main and unrelated to this change.

## Regression check
- The feature is disabled by default, so no existing behavior changes unless the user explicitly sets `structureInvalidationEnabled: true`.
- When enabled, the behavior is identical to before (same code path, same logic, same one-shot guard).
- Existing tests that test the feature's internal logic (SL floor, one-shot) now explicitly enable it and still pass.

## Open questions
1. Should the dashboard UI expose this toggle? Currently it's config-only (editable via the bot config JSON).
2. When ready to re-enable with the HTF check improvement, should that be a separate branch?

## Suggested PR title and description
**Title:** feat: add structureInvalidationEnabled toggle (default: off)

**Description:**
Adds a config toggle to disable the CHoCH-against SL tightening feature. Analysis of 40 trades showed it fired on 57.5% of positions (mostly during normal retracements on the entry TF), stopping out 8 winners early. Disabled by default; can be re-enabled via `structureInvalidationEnabled: true` in bot config. No logic changes to the feature itself — just wrapped in a conditional.
