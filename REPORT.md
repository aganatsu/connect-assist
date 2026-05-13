# Task: Impulse Zone Credit System — Tier 1/2 Factor Credits + Score Recalculation

## Branch: manus/tier1-impulse-zone-credit

## Behavior changes

1. **More setups will pass Gate 19 (Tier 1 minimum).** When the impulse zone hard gate passes, the system now credits FVG, OB, and P/D factors as Tier 1, incrementing `tier1Count`. This directly increases the number of trades taken.
2. **Higher `effectiveScore` for credited setups.** Each credit now adds its factor weight to `tieredScore` and recalculates `analysis.score = (tieredScore / tieredMax) * 100`. This means `effectiveScore` (used for the minConfluence threshold) is higher, so more setups pass the score gate.
3. **Confluence Stack and HTF POI Alignment factors credited as Tier 2.** These boost `tier2Count` and overall score when the impulse zone validates stacking or HTF overlap.
4. **Maximum score boost from all 4 credits combined:** A rich impulse zone (FVG at 61.8% depth, S/R confirmed, overlapping 4H OB+FVG) can add up to ~4.5 pts to `tieredScore`, raising `analysis.score` by up to ~35 percentage points.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added 4 impulse zone credit blocks after the hard gate passes. Each block credits a factor, updates `tieredScore`, and recalculates `analysis.score`. |
| `supabase/functions/bot-scanner/tier1ImpulseZoneCredit.test.ts` | Updated pure function to include `tieredScore` + `analysis.score` recalculation. Added 3 new score recalculation tests. 18 total. |
| `supabase/functions/bot-scanner/impulseZoneExtendedCredits.test.ts` | New test file for P/D, Confluence Stack, and HTF POI credits. All 3 pure functions include score recalculation. Added 10 score recalculation tests. 37 total. |
| `REPORT.md` | This report. |

### Extra caution note for `supabase/functions/bot-scanner/index.ts`

Four credit blocks are inserted after the impulse zone hard gate passes and before the `else if (soft mode)` branch. Each follows this pattern:

1. **Tier 1 FVG/OB Credit:** Credits FVG and/or OB from the zone's primary POI type + HTF layers. Adds factor weight to `tieredScore`, recalculates `analysis.score`.
2. **P/D & Fib Credit:** When `izData.bestZone.fibDepth >= 0.5` and the P/D factor is not already present, credit it. Weight: 1.0 at 50%, 1.5 at 61.8%, 2.0 at 71%+. Tier 1 — increments `tier1Count`. Adds weight to `tieredScore`, recalculates `analysis.score`.
3. **Confluence Stack Credit:** When `srConfirmed + htfLayers.length >= 2`, credit the Confluence Stack factor. Weight: 1.0 for 2 layers, 1.5 for 3+. Tier 2 — increments `tier2Count`. Adds weight to `tieredScore`, recalculates `analysis.score`.
4. **HTF POI Alignment Credit:** When `priceAtZone` is true and the zone has HTF OB/FVG layers, credit HTF POI Alignment. Boost: 0.8 per FVG layer type + 0.7 per OB layer type, capped at 2.0. Tier 2 — increments `tier2Count`. Adds boost to `tieredScore`, recalculates `analysis.score`.

Score recalculation formula: `analysis.score = Math.round((newTieredScore / tieredMax) * 1000) / 10` — matches the one-decimal precision used in `confluenceScoring.ts`.

All credits have guards against double-counting (skip if factor already present) and null-safety (skip if no bestZone or no tieredScoring). They only fire in hard mode after the impulse zone gate has already passed.

## Tests added

### tier1ImpulseZoneCredit.test.ts (3 new score tests, 18 total)

| Test | Assertion |
|------|-----------|
| Tier1Credit: FVG credit adds 1.0 to tieredScore | tieredScore 6.5→7.5, score 57.7% |
| Tier1Credit: FVG+OB dual credit adds 2.0 to tieredScore | tieredScore 6.5→8.5, score 65.4% |
| Tier1Credit: no credit keeps tieredScore unchanged | No mutation when credit doesn't fire |

### impulseZoneExtendedCredits.test.ts (10 new score tests, 37 total)

| Test | Assertion |
|------|-----------|
| ScoreRecalc: P/D credit at 0.618 adds 1.5 | tieredScore 6.5→8.0, score 61.5% |
| ScoreRecalc: P/D credit at 0.71 adds 2.0 | tieredScore 6.5→8.5, score 65.4% |
| ScoreRecalc: P/D credit at 0.5 adds 1.0 | tieredScore 6.5→7.5, score 57.7% |
| ScoreRecalc: Stack credit (2 layers) adds 1.0 | tieredScore 6.5→7.5, score 57.7% |
| ScoreRecalc: Stack credit (3 layers) adds 1.5 | tieredScore 6.5→8.0, score 61.5% |
| ScoreRecalc: HTF POI (FVG only) adds 0.8 | tieredScore 6.5→7.3, score 56.2% |
| ScoreRecalc: HTF POI (OB only) adds 0.7 | tieredScore 6.5→7.2, score 55.4% |
| ScoreRecalc: HTF POI (FVG+OB) adds 1.5 | tieredScore 6.5→8.0, score 61.5% |
| ScoreRecalc: Combined all 3 accumulate | 6.5→8.0→9.5→11.0, score 84.6% |
| ScoreRecalc: no credit → score unchanged | No mutation when no credit fires |

## Tests run

```
$ deno test --no-check
ok | 543 passed | 34 failed (5s)
```

- 543 passed = baseline + 55 credit tests (18 + 37)
- 34 failed = all pre-existing failures (vitest imports, missing API keys, snapshot mismatches)
- 0 new failures introduced by this change

Credit-specific: `55 passed | 0 failed`

## Regression check

1. All 15 original Tier 1 FVG/OB credit tests still pass unchanged.
2. The 34 pre-existing failures are identical to the baseline (verified by stashing changes and running tests on unmodified code).
3. All credits only activate when: (a) impulse zone hard gate already passed, (b) factor NOT already present, (c) zone data meets minimum thresholds. Existing setups with factors already scored correctly are unaffected.
4. Score recalculation math verified with exact numeric equality in 13 tests: `(newTieredScore / tieredMax) * 100` with `Math.round(... * 1000) / 10`.
5. Determinism test proves identical inputs produce identical outputs across runs.
6. No-op tests verify that when credit conditions are not met, neither `tieredScore` nor `analysis.score` are mutated.

## Open questions

1. **HTF Tier 1 promotion:** Should the HTF POI credit trigger the `_htfTier1` promotion logic that can promote Tier 2 factors to Tier 1? Currently it does not.
2. **Score recalculation rounding:** The formula uses `Math.round(... * 1000) / 10` for one-decimal precision. Confirm this matches the expected format.
3. **Monitoring:** After merge, watch for `"IMPULSE-ZONE CREDIT"` in factor details and `"impulse-zone credit"` in `tier1GateReason` to confirm credits are firing in production.

## Suggested PR title and description

**Title:** `[tier1-impulse-zone-credit] Impulse zone credit system with score recalculation`

**Description:**

### Problem
The impulse zone engine validates multiple confluence factors that `confluenceScoring` misses due to different measurement approaches (different swing anchors, tolerance windows, temporal scope). This caused Gate 19 to reject 53% of gate-evaluated setups, and `effectiveScore` to undercount the true confluence.

### Fix
After the impulse zone hard gate passes, patch `analysis.tieredScoring` and `analysis.factors` to credit:
1. FVG/OB (Tier 1) from zone POI type + HTF layers
2. P/D & Fib (Tier 1) when zone fibDepth >= 0.5
3. Confluence Stack (Tier 2) when zone has srConfirmed + HTF layers >= 2
4. HTF POI Alignment (Tier 2) when priceAtZone + zone has HTF OB/FVG layers

Each credit also updates `tieredScore` and recalculates `analysis.score`, ensuring `effectiveScore` reflects the credited factors for the minConfluence threshold.

### Impact
More setups pass Gate 19 and the score threshold. A rich impulse zone can boost score by up to ~35 percentage points. 55 tests, all passing.
