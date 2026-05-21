# Task: Fix Partial TP Same-Cycle Double-Count Bug
## Branch: manus/fix-partial-tp-same-cycle
## Behavior changes
1. When partial TP fires and a final SL/TP close happens in the same scan cycle, the final close PnL is now calculated on the **reduced** position size (after partial), not the original full size. Previously, the full size was used, double-counting the partial portion.
2. The trade history record for the final close now records the correct reduced size instead of the stale original size from the database read.

## Files modified
- `supabase/functions/paper-trading/index.ts` — Changed `size` from `const` to `let` (line 836), added `size = remainSize` after partial TP fires (line 1039), changed history insert to use `size.toString()` instead of `pos.size` (line 1066).
- `supabase/functions/paper-trading/partialTP.test.ts` — New test file with 4 tests proving the fix.

## Tests added
- `partial TP: same-cycle close uses reduced size (not original)` — Proves that when both partial TP and final TP trigger in the same cycle, the final PnL uses 50% size, not 100%.
- `partial TP: normal case (different cycles) — size already correct from DB` — Verifies the normal multi-cycle path still works.
- `partial TP: does NOT fire if profit below trigger level` — Ensures partial TP respects the R-multiple threshold.
- `partial TP: size consistency — partial + final = original` — Arithmetic invariant: partial size + remaining size = original size.

## Tests run
```
running 4 tests from ./supabase/functions/paper-trading/partialTP.test.ts
partial TP: same-cycle close uses reduced size (not original) ... ok (0ms)
partial TP: normal case (different cycles) — size already correct from DB ... ok (0ms)
partial TP: does NOT fire if profit below trigger level ... ok (0ms)
partial TP: size consistency — partial + final = original ... ok (0ms)
ok | 4 passed | 0 failed (11ms)
```

Full suite: 36 failures, all pre-existing on main (confirmed by running same tests on main branch — same failures exist without our changes). Our new tests all pass.

## Regression check
- Verified on `main` branch that the same test failures exist (livePriceStatus.test.ts, reset.test.ts — pre-existing, unrelated to our change).
- The fix only affects the code path where partial TP fires in the same cycle as a final close. Normal multi-cycle operation is unchanged because the DB already stores the reduced size.
- `scannerManagement.ts` was NOT modified — it only marks flags, doesn't do size reduction. The actual size reduction happens in `paper-trading/index.ts` which we fixed.

## Open questions
- The pre-existing test failures (36 total across the suite) appear to be from other features/PRs. They are not caused by this change.

## Suggested PR title and description
**Title:** fix(paper-trading): prevent PnL double-count when partial TP and close happen in same scan cycle

**Description:**
When a volatile price move triggers both partial TP (e.g., at 1R) and final TP (e.g., at 2R) in the same 5-minute scan cycle, the final close was calculating PnL on the full original position size instead of the reduced size after partial close.

Fix: Change `size` from `const` to `let` and sync it to `remainSize` after partial TP fires. Also update the history insert to use the current size variable.

Impact: Prevents inflated PnL on same-cycle partial+close events. Normal multi-cycle operation is unaffected.
