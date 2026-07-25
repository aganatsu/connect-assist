# Task: Trade Management Consolidation — Phase 2 (Dedup)
## Branch: manus/trade-mgmt-dedup
## Behavior changes
1. Paper-trading NO LONGER independently activates break-even (BE). Only scannerManagement (via bot-scanner manage cycle) can activate BE.
2. Paper-trading NO LONGER independently activates trailing stop. Only scannerManagement can set trailingStopActivated=true. Paper-trading still ratchets the trail forward every 5s once activated.
3. Paper-trading NO LONGER independently fires partial take-profit. Only scannerManagement (Phase 1) handles partial-TP accounting and activation.
4. Net effect: eliminates the race condition where both paper-trading (every 5s) and bot-scanner/scannerManagement (every 1 min) could independently trigger the same action on the same position.

## Files modified
- `supabase/functions/paper-trading/index.ts` — Removed BE activation block (~35 lines), removed trailing legacy activation path (~40 lines), removed partial-TP block (~55 lines). Kept trail ratchet (fast 5s tightening when already activated).
- `supabase/functions/paper-trading/dedup.test.ts` — NEW: 5 tests verifying dedup guarantees.

## Tests added
1. "Dedup: paper-trading does NOT activate BE even when conditions are met" — verifies SL unchanged when BE conditions satisfied
2. "Dedup: paper-trading does NOT activate trailing even when R threshold is met" — verifies no trail activation without scannerManagement
3. "Dedup: paper-trading DOES ratchet trail when already activated by scannerManagement" — verifies fast ratchet still works
4. "Dedup: paper-trading does NOT fire partial-TP even when conditions are met" — verifies no independent partial-TP
5. "Dedup: trail ratchet does NOT widen SL (only tightens)" — verifies directional safety

## Tests run
```
ok | 1924 passed | 6 failed (21s)
```
All 6 failures are pre-existing (beTrailingRace + brokerFillPriceBE tests that fail on main too). Zero new failures.

## Regression check
- Ran full suite on main before changes: 1921 passed, 9 failed
- Ran full suite on branch after changes: 1924 passed, 6 failed
- Net: +3 passing tests, -3 failing tests (improvement, not regression)
- Type check: `deno check paper-trading/index.ts` — clean, zero errors

## Open questions
1. **Legacy positions**: Positions opened BEFORE this deploy that have `trailingStopActivated: false` will no longer get trailing activated by paper-trading. They'll need to wait for the next bot-scanner manage cycle (1 min) for scannerManagement to activate them. Is this acceptable? (Should be fine — 1 min delay max.)
2. **partialCloseBroker function**: Now dead code in paper-trading (defined but never called). Should it be removed in Phase 4, or kept as a utility?

## Suggested PR title and description
**Title:** `[trade-mgmt-dedup] Remove independent BE/trailing/partial-TP activation from paper-trading`

**Description:**
Paper-trading was independently activating BE, trailing stop, and partial-TP every 5 seconds (on dashboard poll), racing with scannerManagement which does the same every 1 minute. This caused:
- Double partial-TP closes (75% instead of 50%)
- Inconsistent BE activation timing
- Duplicate trailing activation

This PR removes all independent activation logic from paper-trading. scannerManagement is now the sole decision authority. Paper-trading retains only:
- Trail ratcheting (tightens SL every 5s when trail is already active)
- SL/TP hit detection and full close

Depends on: Phase 1 (`manus/partial-tp-consolidation`) already merged to main.
