# Task: Extract Gate — Max Per Symbol
## Branch: manus/extract-gate-max-per-symbol
## Behavior changes
none — pure refactor

Both engines previously used `symbolPositionCount >= maxPerSymbol` as the fail condition. The shared function preserves this exact semantics.

**Bot-scanner:** The original Gate 5 combined two checks (same-direction duplicate + count) into one gate result with priority logic. This extraction replaces only the count-check branches (`else if` and `else`) with `checkMaxPerSymbol()`, preserving the duplicate-direction short-circuit and the "(stacking allowed)" suffix on pass reasons. The same-direction duplicate check remains inline — it has divergent behavior between engines (bot-scanner has `allowSameDirectionStacking` toggle; backtest always blocks) and will be extracted separately.

**Backtest-engine:** Gate 2's inline `symbolCount < config.maxPerSymbol` replaced directly with `checkMaxPerSymbol()`. Reason string changes cosmetically from `"EUR/USD positions: 1/2"` to `"1/2 for EUR/USD"` — pass/fail logic identical.

## Files modified
- `supabase/functions/_shared/gateMaxPerSymbol.ts` — NEW shared gate function with typed interface + GateResult
- `supabase/functions/_shared/gateMaxPerSymbol.test.ts` — NEW cross-engine agreement tests (10 tests total)
- `supabase/functions/bot-scanner/index.ts` — Added import (line 95), replaced Gate 5 count-check branches (lines 1145-1153) with `checkMaxPerSymbol(...)` call wrapped in stacking-note logic
- `supabase/functions/backtest-engine/index.ts` — Added import (line 115), replaced Gate 2 inline logic (line 475) with `checkMaxPerSymbol(...)` call

## Tests added
1. `gateMaxPerSymbol: 0 positions on EUR/USD, limit 2 → pass` — zero positions passes
2. `gateMaxPerSymbol: 1 position on GBP/USD, limit 2 → pass` — below limit passes
3. `gateMaxPerSymbol: 2 positions on XAU/USD, limit 2 → fail (at limit)` — at-limit fails
4. `gateMaxPerSymbol: 3 positions on BTC/USD, limit 2 → fail (over limit)` — over-limit fails
5. `gateMaxPerSymbol: 1 position, limit 1 → fail (exactly at limit)` — edge case
6. `gateMaxPerSymbol: 0 positions, limit 1 → pass (room for one)` — edge case
7. `cross-engine: shared matches bot-scanner count path (no stacking note) for all test cases` — 10 synthetic inputs, verifies shared function produces identical pass/fail AND reason strings vs old bot-scanner inline code (when no stacking note)
8. `cross-engine: shared pass/fail matches backtest-engine inline for all test cases` — 10 synthetic inputs, verifies pass/fail agreement (reason strings intentionally differ cosmetically)
9. `bot-scanner integration: stacking note appended when sameDirectionExists and pass` — verifies the wrapper logic that appends "(stacking allowed)" to the shared function's reason
10. `bot-scanner integration: no stacking note when count fails (stacking irrelevant)` — verifies stacking note is NOT appended on fail

## Tests run
```
deno task test
ok | 1653 passed | 0 failed (17s)
```

## Regression check
- Cross-engine agreement tests replicate original inline logic from each engine and assert the shared function produces the same pass/fail on 10 synthetic inputs covering: zero positions, below limit, at limit, over limit, and limit=1 edge cases.
- The `>=` comparison is preserved exactly — no behavioral change in which trades are blocked.
- Bot-scanner's priority cascade (duplicate check short-circuits before count check) is preserved — the shared function is only called in the `else` branch.
- The "(stacking allowed)" suffix is preserved via wrapper logic in bot-scanner.

## Open questions
1. **Same-direction duplicate check divergence:** Bot-scanner has `allowSameDirectionStacking` config toggle; backtest-engine always blocks same-direction duplicates (no toggle). This is a genuine behavioral divergence — extracting it requires deciding whether to add the toggle to backtest-engine or document it as intentional. Recommend a separate PR with explicit discussion.

## Suggested PR title and description
**Title:** `[extract-gate-max-per-symbol] Extract Max Per Symbol count check to _shared/gateMaxPerSymbol.ts`

**Description:**
Extracts the "Max Positions Per Symbol" count check into a shared function so both bot-scanner (Gate 5 count path) and backtest-engine (Gate 2) use a single source of truth.

**Changes:**
- New `_shared/gateMaxPerSymbol.ts` with typed `MaxPerSymbolGateInput` interface and `checkMaxPerSymbol()` function
- bot-scanner Gate 5: count-check branches replaced with shared function call (duplicate-direction short-circuit preserved inline)
- backtest-engine Gate 2: replaced inline logic with shared function call
- 10 tests including 2 cross-engine agreement suites + 2 bot-scanner integration tests (1653 total tests pass)

**Behavior:** No change — pure refactor. Same `>=` comparison, same pass/fail outcomes. Same-direction duplicate check intentionally left inline (divergent behavior between engines, separate PR).
