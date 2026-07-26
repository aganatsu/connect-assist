# Task: Derive trend from BOS/CHoCH breaks instead of 2-swing comparison
## Branch: manus/trend-from-structure-breaks

## Behavior changes

1. **`analyzeMarketStructure().trend` now reflects the most recent confirmed structural break** rather than a standalone comparison of the last 2 swing highs/lows.
   - Priority: external (major) breaks override internal (minor) ones.
   - Fallback: if no external break exists, the most recent break of any significance decides.
   - If no BOS/CHoCH is detected at all, the legacy 2-swing comparison is used (backward compat).

2. **New field: `trendBasis: "external" | "internal" | "none"`** — reports which kind of break decided `trend`. Consumers (e.g., `gamePlan.ts`'s `determineBias()`) can use this to weight HTF trend inputs differently: full weight when external, reduced weight when internal-only.

3. **Ranging fixture snapshot updated.** The synthetic "ranging" candle series now correctly produces `direction: null, bias: neutral, score: 18.8` instead of the old `direction: long, bias: bullish, score: 23.1`.

4. **No change to any gate definitions, factor weights, or the SPECS table.**

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/smcAnalysis.ts` | Replaced 2-swing trend derivation with BOS/CHoCH-based derivation; added `trendBasis` field to return object |
| `supabase/functions/_shared/trendFromStructureBreaks.test.ts` | 5 regression tests including the adversarial conflicting-signal test + trendBasis assertions |
| `supabase/functions/_shared/structureInvalidationOneShot.test.ts` | 5 tests proving structure-invalidation one-shot guard prevents over-triggering in choppy markets |
| `supabase/functions/_shared/__snapshots__/confluenceScoring.ranging.snapshot.json` | Updated snapshot to reflect new behavior |

## Tests added

| Test | What it asserts |
|------|-----------------|
| `external bearish CHoCH overrides internal HH/HL pattern` | **THE ADVERSARIAL TEST**: constructs candles where old logic says "bullish" (HH+HL verified in-test with explicit assertion), new logic says "bearish" (external-first priority). Also verifies `trendBasis === "external"`. |
| `pure bullish BOS chain → trend = bullish` | Continuous uptrend → trend = "bullish" |
| `no BOS/CHoCH detected → trend = ranging` | Flat candles → trend = "ranging", trendBasis = "none" |
| `always returns valid trend type` | Output is always one of bullish/bearish/ranging |
| `bearish BOS chain → trend = bearish` | Continuous downtrend → trend = "bearish" |
| `one-shot guard prevents second trigger` | Position with `structureInvalidationFired=true` → no re-trigger |
| `fires exactly once when CHoCH against trade` | Fresh position with bearish CHoCH → fires at most once |
| `does NOT fire when rMultiple > 0` | Position in profit → no trigger |
| `does NOT fire when structure is neutral/bullish` | No CHoCH against trade → no trigger |
| `3 consecutive scan cycles — fires at most once total` | Simulates repeated manage cycles → one-shot holds |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/_shared/
ok | 1597 passed | 0 failed (18s)
```

## Regression check

1. **Structure-invalidation one-shot guard:** Claude's concern was that trend flipping more in ranging conditions might cause `computeManagementDecision`'s structure-invalidation branch to over-trigger. **Confirmed safe.** The branch has a `structureInvalidationFired` one-shot flag (line 783) — once it fires for a position, it NEVER fires again regardless of how many times trend flips. Five new tests prove this explicitly.

2. **Adversarial conflicting-signal test:** Claude asked to confirm this specific test exists. **Confirmed.** Test "external bearish CHoCH overrides internal HH/HL pattern" explicitly:
   - Asserts `oldWouldSayBullish === true` (verifies the old code would have gotten it wrong)
   - Asserts `result.trend === "bearish"` (verifies the new code gets it right)
   - Asserts `result.trendBasis === "external"` (verifies the priority rule)
   - Asserts external bearish break exists AND internal bullish break exists (the conflict)

3. **All 1597 tests pass** (5 more than before from the new one-shot tests).

## Open questions

1. **gamePlan.ts `determineBias()` weighting:** Claude suggested using `trendBasis` to reduce weight of internal-only trends in the game plan's HTF bias voting. The `trendBasis` field is now available for this. Should I implement the weighting change in `gamePlan.ts` as part of this branch, or as a separate follow-up? (It would modify game plan behavior.)

## Suggested PR title and description

**Title:** fix(smcAnalysis): derive trend from confirmed BOS/CHoCH breaks, add trendBasis field

**Description:**
The `trend` field in `analyzeMarketStructure()` was derived by comparing the last 2 swing highs and lows — a lagging heuristic that frequently contradicts the actual structural breaks the engine already detects.

**Changes:**
- Derive `trend` from the most recent confirmed BOS/CHoCH, with external breaks taking priority over internal ones
- Add `trendBasis: "external" | "internal" | "none"` field so consumers can weight trend differently based on break significance (e.g., game plan can discount internal-only trends for HTF bias)
- Falls back to legacy 2-swing comparison only when no breaks are detected at all

**Safety verification:**
- Structure-invalidation one-shot guard confirmed safe against trend-flipping in ranging (5 dedicated tests)
- Adversarial conflicting-signal test proves the exact bug is fixed (old logic → bullish, new logic → bearish)
- 1597 tests pass, 0 failures
