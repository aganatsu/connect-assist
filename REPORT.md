# Task: Partial-TP Consolidation (Phase 1)
## Branch: manus/partial-tp-consolidation
## Behavior changes
1. When partial-TP triggers in `scannerManagement.ts`, it now performs FULL accounting: reduces `paper_positions.size`, inserts a `paper_trade_history` row (close_reason: "partial_tp"), and updates `paper_accounts.balance`. Previously it only set a flag.
2. The management action type changes from `"partial_enabled"` to `"partial_tp_executed"`. Bot-scanner accepts both for backward compatibility during rollout.
3. After partial-TP executes, the final `exitFlagsUpdated` DB write is skipped (via `partialTPWritten` guard) to prevent overwriting the size/flag update.
4. Paper-trading's existing `partial_tp_fired` check already prevents double-execution — no code change needed there.

## Files modified
- `supabase/functions/_shared/scannerManagement.ts` — Added PnL helpers (FALLBACK_RATES, getQuoteToUSDRate, calcPnl), expanded partial-TP block to do full accounting (size reduction, history insert, balance update), added `partialTPWritten` guard, added `"partial_tp_executed"` to ExitAttribution trigger union and ManagementAction type.
- `supabase/functions/bot-scanner/index.ts` — Updated partial close broker sync filter to accept both `"partial_tp_executed"` and `"partial_enabled"` action types (1 line change).
- `supabase/functions/_shared/scannerManagement.partialTP.test.ts` — New test file with 6 regression tests.

## Tests added
1. "Partial TP: executes full accounting (history + size + balance) when rMultiple >= level" — verifies DB insert, size reduction, and balance update for EUR/USD long
2. "Partial TP: skips when partialTPActivated already true" — verifies no double-fire
3. "Partial TP: skips when partial_tp_fired column is true" — verifies DB-level guard
4. "Partial TP: does not fire when rMultiple < partialTPLevel" — verifies threshold check
5. "Partial TP: correct PnL for short XAU/USD" — verifies PnL math for metals/short direction
6. "Partial TP: no duplicate signal_reason write after execution" — verifies partialTPWritten guard

## Tests run
```
ok | 1923 passed | 7 failed (21s)
```
All 7 failures are pre-existing on main (9 failures on main → 7 on this branch, net improvement of +2 passing tests).

## Regression check
- Ran full suite on main: 1921 passed, 9 failed
- Ran full suite on branch: 1923 passed, 7 failed
- No new failures introduced. 2 pre-existing failures now pass (likely beTrailingRace tests that benefit from cleaner management flow).
- PnL math verified by hand for both EUR/USD (lotUnits=100000) and XAU/USD (lotUnits=100).

## Open questions
1. **Paper-trading's independent partial-TP logic (lines 1079-1140)** still exists and can fire if the dashboard is open and the scanner hasn't run yet. It's guarded by `partial_tp_fired` column check, so it won't double-fire AFTER scannerManagement writes. But in the race window (scannerManagement hasn't written yet, paper-trading polls), paper-trading could fire first. Phase 2 should remove paper-trading's independent partial-TP activation entirely.
2. **Should we remove the old `"partial_enabled"` action type** after confirming the deploy is stable? Currently bot-scanner accepts both for safety.

## Suggested PR title and description
**Title:** fix(management): make scannerManagement single authority for partial-TP accounting

**Description:**
Previously, `scannerManagement.ts` only set a flag when partial-TP triggered, leaving accounting (size reduction, history insert, balance update) to paper-trading. This caused:
- Silent accounting bugs when bot-scanner fired the broker close without updating DB
- Race conditions between paper-trading (5s poll) and bot-scanner (1min cron)

This PR makes scannerManagement the single authority:
- Full PnL calculation using SPECS + fallback rates
- Inserts `paper_trade_history` row with close_reason "partial_tp"
- Reduces `paper_positions.size` and sets `partial_tp_fired = true`
- Updates `paper_accounts.balance`
- Skips redundant final exitFlags write via `partialTPWritten` guard

Bot-scanner updated to accept both old and new action types for safe rollout.
6 new regression tests covering all paths.
