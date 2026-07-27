# Task: Extract Gate — Max Open Positions
## Branch: manus/extract-gate-max-positions
## Behavior changes
none — pure refactor

Both engines previously used `openPositionCount >= maxOpenPositions` as the fail condition. The shared function preserves this exact semantics. Reason strings are unified to the bot-scanner format (`"Max positions (N) reached"` / `"X/N positions"`), which is a cosmetic-only change for backtest-engine (previously `"Open positions: X/N"`). Pass/fail logic is identical.

## Files modified
- `supabase/functions/_shared/gateMaxPositions.ts` — NEW shared gate function with typed interface + GateResult
- `supabase/functions/_shared/gateMaxPositions.test.ts` — NEW cross-engine agreement tests (8 unit tests + 2 cross-engine regression suites)
- `supabase/functions/bot-scanner/index.ts` — Added import (line 95), replaced Gate 4 inline logic (line 1135) with `checkMaxPositions(...)` call
- `supabase/functions/backtest-engine/index.ts` — Added import (line 115), replaced Gate 1 inline logic (line 467) with `checkMaxPositions(...)` call

## Tests added
1. `gateMaxPositions: 0 positions, limit 3 → pass` — verifies zero positions passes
2. `gateMaxPositions: 2 positions, limit 3 → pass` — verifies below-limit passes
3. `gateMaxPositions: 3 positions, limit 3 → fail (at limit)` — verifies at-limit fails
4. `gateMaxPositions: 5 positions, limit 3 → fail (over limit)` — verifies over-limit fails
5. `gateMaxPositions: 1 position, limit 1 → fail (exactly at limit)` — edge case: limit=1
6. `gateMaxPositions: 0 positions, limit 1 → pass (room for one)` — edge case: limit=1 with room
7. `cross-engine: shared matches bot-scanner inline for all test cases` — 10 synthetic inputs, verifies shared function produces identical pass/fail AND reason strings vs the old bot-scanner inline code
8. `cross-engine: shared pass/fail matches backtest-engine inline for all test cases` — 10 synthetic inputs, verifies shared function produces identical pass/fail vs the old backtest-engine inline code (reason strings intentionally differ cosmetically)

## Tests run
```
deno task test
ok | 1651 passed | 0 failed (20s)
```

## Regression check
- Both cross-engine agreement tests replicate the original inline logic from each engine and assert the shared function produces the same pass/fail on 10 synthetic inputs covering: zero positions, below limit, at limit, over limit, and limit=1 edge cases.
- The `>=` comparison is preserved exactly — no behavioral change in which trades are blocked.
- Reason string for bot-scanner path is identical; backtest-engine path has a cosmetic reason string change only (pass/fail unchanged).

## Open questions
- The `manus/extract-gate-min-rr` branch (Gate 1 — Min R:R) exists on the remote but was never merged to main. This branch does not depend on it. Should Gate 1 be merged first, or can these be merged independently?

## Suggested PR title and description
**Title:** `[extract-gate-max-positions] Extract Max Open Positions check to _shared/gateMaxPositions.ts`

**Description:**
Extracts the "Max Open Positions" gate check into a shared function so both bot-scanner (Gate 4) and backtest-engine (Gate 1) use a single source of truth.

**Changes:**
- New `_shared/gateMaxPositions.ts` with typed `MaxPositionsGateInput` interface and `checkMaxPositions()` function
- bot-scanner Gate 4: replaced inline `if/else` with shared function call
- backtest-engine Gate 1: replaced inline logic with shared function call
- 8 unit tests + 2 cross-engine agreement regression suites (1651 total tests pass)

**Behavior:** No change — pure refactor. Same `>=` comparison, same pass/fail outcomes.
