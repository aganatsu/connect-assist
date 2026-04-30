# Task: SMT Opposite Veto Gate
## Branch: manus/smt-opposite-veto

## Behavior changes

1. **Trades where SMT divergence is detected opposite to the signal direction are now blocked.** Previously, the SMT factor scored 0 points when opposed but did not prevent the trade from being placed. Now, Gate 9b explicitly vetoes such trades with reason "SMT divergence opposite — vetoed". This is a hard block — the trade will not be placed regardless of overall confluence score.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added Gate 9b (SMT Opposite Veto) — 9 lines inserted between Gate 9 and Gate 10 |
| `supabase/functions/bot-scanner/smtVeto.test.ts` | New test file — 6 tests (5 behavioral + 1 structural verification) |
| `REPORT.md` | This report |

## Extra-caution file explanation: bot-scanner/index.ts

The change is a **9-line insertion** at line 1009, between Gate 9 (min confluence) and Gate 10 (min R:R). It adds a new gate entry to the `gates[]` array. The logic is:

1. Find the "SMT Divergence" factor in `analysis.factors`
2. If found AND its `detail` string contains the exact phrase `"opposite to signal direction"` → push a failing gate
3. Otherwise → push a passing gate

No existing lines were modified. No function signatures changed. No imports added. The gate uses the same `analysis.factors` array that is already computed and available at this point in the function.

## Exact code added

Inserted at line 1009 of `bot-scanner/index.ts` (between Gate 9 "Min confluence" and Gate 10 "Min R:R"):

```typescript
  // Gate 9b: SMT Opposite Veto — block trades where SMT divergence opposes signal direction
  {
    const smtFactor = analysis.factors?.find((f: any) => f.name === "SMT Divergence");
    if (smtFactor && smtFactor.detail && smtFactor.detail.includes("opposite to signal direction")) {
      gates.push({ passed: false, reason: `SMT divergence opposite — vetoed` });
    } else {
      gates.push({ passed: true, reason: `SMT veto: no opposition detected` });
    }
  }
```

## Gate sequence position

- Gate 9 (line 1002): Min confluence score check
- **Gate 9b (line 1009): SMT Opposite Veto** ← NEW
- Gate 10 (line 1019): Min R:R (spread + commission adjusted)

The gate appears in the `gates[]` array in the reasoning JSON stored in `signal_reason` on every trade (line ~3597), and in `detail.gates` on every scan detail (line 3263).

## Tests added

| # | Test name | Assertion |
|---|-----------|-----------|
| 1 | `SMT opposite to signal direction → veto (trade blocked)` | Factor detail "SMT detected (bearish) but opposite to signal direction" → gate fails |
| 2 | `SMT aligned with signal direction → pass (trade proceeds)` | Factor detail "SMT aligned: ..." → gate passes |
| 3 | `SMT not detected (no divergence found) → pass` | Factor detail "No SMT divergence detected on GBP/USD" → gate passes |
| 4 | `SMT factor missing from factors array → pass` | No SMT factor in array, also tests undefined/null factors → gate passes |
| 5 | `Detail with 'opposite' in different context → pass (no false positive)` | "opposite leg structure", scrambled words, "opposite to signal strength" → all pass (no veto) |
| 6 | `Source code presence verification` | Confirms Gate 9b comment, exact phrase, reason string, and position between Gate 9 and Gate 10 in source |

## Tests run

```
$ deno test --allow-all --no-check supabase/functions/
ok | 229 passed | 0 failed (5s)
```

Breakdown:
- 35 calcPnl tests ✓
- 92 confluenceScoring tests ✓
- 47 crossEngineEquivalence tests ✓
- 5 slFloorAndTier1Gate tests ✓
- 5 gate6Heat tests ✓
- 6 smtVeto tests ✓ (NEW)
- 14 reset tests ✓
- 25 liveBacktestParity tests ✓

## Regression check

1. **No existing gate logic was modified.** Gate 9b is purely additive — it inserts a new entry into the `gates[]` array without touching any other gate's logic or position.
2. **The gate always pushes exactly one entry** (either pass or fail), maintaining the invariant that every gate produces exactly one GateResult.
3. **The matching phrase "opposite to signal direction" is the exact string produced by `confluenceScoring.ts` line 1219** — confirmed by grep. No other factor uses this exact phrase in a way that could false-positive (the AMD factor uses "opposite to signal direction" in a different factor name, but Gate 9b specifically looks for `name === "SMT Divergence"` first).
4. **All 223 pre-existing tests pass unchanged** — the new gate does not alter scoring, detection, or any other gate's behavior.

## Hand-traced example

**Trade: EUR/USD short, 2026-04-30 15:00:22 UTC**

The `factorScores` array in `signal_reason` includes:
```json
{ "name": "SMT Divergence", "present": false, "weight": 0, "detail": "SMT detected (bearish) but opposite to signal direction" }
```

Gate 9b walk-through:
1. `analysis.factors?.find(f => f.name === "SMT Divergence")` → finds the factor above ✓
2. `smtFactor.detail` → `"SMT detected (bearish) but opposite to signal direction"` ✓
3. `smtFactor.detail.includes("opposite to signal direction")` → `true` ✓
4. Gate pushes: `{ passed: false, reason: "SMT divergence opposite — vetoed" }`
5. Later: `gates.every(g => g.passed)` → `false` (at least one gate failed)
6. **Trade would NOT have been placed.** The -$269 loss from this and similar trades would have been avoided.

## Open questions

None. The implementation is straightforward and self-contained.

## Suggested PR title and description

**Title:** `[smt-opposite-veto] Add Gate 9b: block trades with SMT divergence opposing signal direction`

**Description:**
```
Analysis of 25 paper trades over 48h shows trades where SMT divergence
opposes the signal direction perform significantly worse:
- WITH SMT-opposite: 33% WR, net -$269 (6 trades)
- WITHOUT: 68% WR, net +$172 (19 trades)

This PR adds a hard veto gate (Gate 9b) that blocks trade placement when
the SMT Divergence factor detail contains "opposite to signal direction".

The gate is:
- Positioned after the score gate (Gate 9) and before R:R (Gate 10)
- Hardcoded (not configurable) — testing the hypothesis first
- One-way: only blocks, never modifies scoring or other gates

6 new tests, 229 total passing, 0 failed.
```
