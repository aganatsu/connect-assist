# Task: Extract Gate — Cooldown
## Branch: manus/extract-gate-cooldown
## Behavior changes
none — pure refactor

Both engines' pass/fail logic is preserved exactly. The shared function accepts pre-computed `elapsedMinutes` (each engine computes from its own time source: wall-clock for bot-scanner, candle time for backtest).

**Reason string format change:**
- Bot-scanner old pass: `"Cooldown passed (45min since last)"` → new: `"Cooldown: passed (45min since last)"`
- Bot-scanner old fail: `"Cooldown: 15min remaining for EURUSD"` → new: `"Cooldown: 15min remaining for EURUSD"` (unchanged)
- Bot-scanner old no-trade: `"No recent trades — cooldown OK"` → new: `"Cooldown: no recent trades — OK"`
- Backtest old pass: `"Cooldown clear"` → new: `"Cooldown: passed (Nmin since last)"`
- Backtest old fail: `"Cooldown active (30min)"` → new: `"Cooldown: 30min remaining for SYMBOL"`

**Reason string safety verification (broader sweep):**
1. `gatePerformanceEngine.ts` — matches on `reason.includes("Cooldown")`. All new reason strings start with `"Cooldown"` ✅
2. `backtest-engine` line 2818 `split(":")[0]` — all new reason strings yield `"Cooldown"` as the aggregation key ✅
3. Old bot-scanner pass format `"Cooldown passed (...)"` did NOT have a colon — the new format adds one, which is an improvement for consistency with the colon-split pattern (previously would have yielded the full string as the key). No practical impact since bot-scanner reasons only go through `gatePerformanceEngine.ts` which uses `includes()`, not `split()`.
4. Telegram/narrative/dashboard — no code parses this specific reason string ✅

## Files modified
- `supabase/functions/_shared/gateCooldown.ts` — NEW shared gate function
- `supabase/functions/_shared/gateCooldown.test.ts` — NEW cross-engine agreement tests (10 tests)
- `supabase/functions/bot-scanner/index.ts` — Added import (line 101), replaced Gate 13 inline if/else with `checkCooldown(...)` call (DB query preserved inline)
- `supabase/functions/backtest-engine/index.ts` — Added import (line 121), replaced Gate 8 inline logic with `checkCooldown(...)` call (trade filtering preserved inline)

## Tests added
1. `gateCooldown: no previous trade → pass`
2. `gateCooldown: elapsed exceeds cooldown → pass`
3. `gateCooldown: elapsed equals cooldown → pass`
4. `gateCooldown: elapsed below cooldown → fail`
5. `gateCooldown: zero elapsed → fail`
6. `gateCooldown: symbol included in fail reason`
7. `gateCooldown: all reason strings contain 'Cooldown' for pattern matching`
8. `gateCooldown: all reason strings contain colon for split aggregation`
9. `cross-engine: shared pass/fail matches bot-scanner inline for all test cases` — 10 synthetic inputs
10. `cross-engine: shared pass/fail matches backtest-engine inline for all test cases` — 10 synthetic inputs

## Tests run
```
deno task test
ok | 1724 passed | 0 failed (18s)
```

## Regression check
- Cross-engine agreement tests replicate original inline logic from each engine and assert the shared function produces identical pass/fail on 10 synthetic inputs each.
- Reason string format tests explicitly verify both consumer constraints (substring match + colon presence + stable aggregation key).

## Open questions
None. This gate has no divergence between engines — both use the same comparison logic (`elapsed >= cooldownMinutes`), just different time sources for computing elapsed.

## Suggested PR title and description
**Title:** `[extract-gate-cooldown] Extract cooldown gate to _shared/gateCooldown.ts`

**Description:**
Extracts the "Cooldown" gate into a shared function. Both engines pre-compute `elapsedMinutes` from their own time source (wall-clock for bot-scanner, candle time for backtest) and pass it to the shared comparison function.

**Changes:**
- New `_shared/gateCooldown.ts` with typed interface
- Bot-scanner Gate 13: inline if/else replaced with shared function call (DB query preserved inline)
- Backtest-engine Gate 8: inline logic replaced with shared function call (trade filtering preserved inline)
- 10 tests including 2 cross-engine agreement suites + 2 reason-string safety tests (1724 total tests pass)

**Behavior:** No change — pure refactor. Same pass/fail outcomes for identical inputs.

**Note:** This is the last of 6 overlapping conditions with the backtest-engine pre-gates fast-path. Next PR: consolidate the pre-gates fast-path to use shared functions.
