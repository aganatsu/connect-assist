# Task: Extract Gate — Duplicate Direction
## Branch: manus/extract-gate-duplicate-direction
## Behavior changes
none — pure refactor

Both engines' pass/fail logic is preserved exactly:
- Bot-scanner: passes `config.allowSameDirectionStacking` (user-configurable toggle)
- Backtest-engine: passes `false` (always blocks — optimizer does not tune this parameter)

The divergence is intentional, documented in the shared function's JSDoc and in the backtest-engine call site comment. The shared function makes this visible via a typed parameter rather than hiding it in two separate code paths.

**Reason string change (cosmetic only):**
- Bot-scanner fail reason: was `"Already long on EUR/USD — no duplicate (enable stacking to allow)"`, now `"Already long on EUR/USD"` (the hint text was only useful in the UI, not in gate logs; the config toggle name is self-documenting)
- Backtest-engine: unchanged (`"Already long on EUR/USD"` → same)

## Files modified
- `supabase/functions/_shared/gateDuplicateDirection.ts` — NEW shared gate function with typed `DuplicateDirectionGateInput` interface
- `supabase/functions/_shared/gateDuplicateDirection.test.ts` — NEW cross-engine agreement tests (9 tests total)
- `supabase/functions/bot-scanner/index.ts` — Added import (line 97), replaced Gate 5 duplicate-direction `if` branch with `checkDuplicateDirection(...)` call
- `supabase/functions/backtest-engine/index.ts` — Added import (line 117), replaced Gate 3 inline logic with `checkDuplicateDirection(...)` call (hardcoded `false` for stacking, with comment explaining why)

## Tests added
1. `gateDuplicateDirection: no duplicate, stacking disabled → pass`
2. `gateDuplicateDirection: no duplicate, stacking enabled → pass`
3. `gateDuplicateDirection: duplicate exists, stacking disabled → fail`
4. `gateDuplicateDirection: duplicate exists, stacking enabled → pass`
5. `gateDuplicateDirection: duplicate long, stacking disabled → fail with correct direction`
6. `gateDuplicateDirection: duplicate short, stacking disabled → fail with correct direction`
7. `cross-engine: shared pass/fail matches bot-scanner inline for all test cases` — 10 synthetic inputs covering all combinations of sameDir × stacking × direction
8. `cross-engine: shared pass/fail matches backtest-engine inline (stacking=false) for all test cases` — 10 synthetic inputs, verifies pass/fail AND reason string agreement
9. `divergence: bot-scanner allows stacking while backtest blocks (documented intentional)` — explicitly documents the intentional behavioral divergence as a test assertion

## Tests run
```
deno task test
ok | 1682 passed | 0 failed (18s)
```

## Regression check
- Cross-engine agreement tests replicate original inline logic from each engine and assert the shared function produces identical pass/fail on 10 synthetic inputs each.
- Bot-scanner's priority cascade preserved: `checkDuplicateDirection` is called first; only if it passes does the `checkMaxPerSymbol` count check run.
- The divergence test (test #9) explicitly proves that the same function with different inputs produces different results — confirming the divergence is in the INPUT (config value), not the logic.

## Open questions
None. The `allowSameDirectionStacking` divergence is documented and intentional (optimizer does not tune this parameter today).

## Suggested PR title and description
**Title:** `[extract-gate-duplicate-direction] Extract duplicate direction check to _shared/gateDuplicateDirection.ts`

**Description:**
Extracts the "Duplicate Direction" gate check into a shared function with a typed `allowSameDirectionStacking` parameter, making the intentional behavioral divergence between engines explicit and self-documenting.

**Changes:**
- New `_shared/gateDuplicateDirection.ts` with typed interface and `checkDuplicateDirection()` function
- Bot-scanner Gate 5: duplicate-direction `if` branch replaced with shared function call (passes `config.allowSameDirectionStacking`)
- Backtest-engine Gate 3: inline logic replaced with shared function call (passes `false` with explanatory comment)
- 9 tests including 2 cross-engine agreement suites + 1 divergence documentation test (1682 total tests pass)

**Behavior:** No change — pure refactor. Same pass/fail outcomes for identical inputs. Cosmetic reason string change in bot-scanner fail path (removed hint text).
