# Task: Impulse Zone → Scoring Credit System (Tier 1 + Extended Credits)

## Branch: manus/tier1-impulse-zone-credit

## Behavior changes

1. **More setups will pass Gate 19 (Tier 1 minimum).** The original Tier 1 FVG/OB credit (commit 1) credits the zone's POI type. The new P/D & Fib credit (this commit) adds another Tier 1 factor when the impulse zone validates a POI at fibDepth >= 0.5, even if the entry-TF zigzag shows < 50% retracement. Combined, a single impulse zone can now credit up to 3 of the 4 Tier 1 factors (FVG, OB, P/D).

2. **Higher overall confluence scores.** The Confluence Stack credit (Tier 2) fires when the impulse zone has srConfirmed + HTF layers >= 2 total layers. This increases the tieredScore and may push borderline setups above score thresholds.

3. **Higher Tier 2 factor counts.** The HTF POI Alignment credit (Tier 2) fires when priceAtZone is true and the zone overlaps HTF OB/FVG layers. This increases tier2Count and overall score.

Combined effect: setups that pass the impulse zone hard gate will now have significantly better scoring representation, reflecting the confluence that the impulse zone engine already validated but that confluenceScoring missed due to different measurement approaches. This directly increases trade frequency.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added 3 new credit blocks (lines 3812-3909) after the existing Tier 1 FVG/OB credit: P/D & Fib (Tier 1), Confluence Stack (Tier 2), HTF POI Alignment (Tier 2). |
| `supabase/functions/bot-scanner/impulseZoneExtendedCredits.test.ts` | New test file with 27 Deno tests covering all 3 extended credits. |
| `supabase/functions/bot-scanner/tier1ImpulseZoneCredit.test.ts` | Existing test file (15 tests) from previous commit — unchanged, still passing. |
| `REPORT.md` | This report. |

### Extra caution note for `supabase/functions/bot-scanner/index.ts`

Three new credit blocks were added between the existing Tier 1 FVG/OB credit (line 3811) and the `else if (soft mode)` branch (now line 3910). Each follows the same pattern as the original credit:

1. **P/D & Fib Credit (lines 3812-3848):** When `izData.bestZone.fibDepth >= 0.5` and the P/D factor is not already present, credit it. Weight scales: 1.0 at 50%, 1.5 at 61.8%, 2.0 at 71%+. This is Tier 1 so it increments `tier1Count` and may flip `tier1GatePassed`. Rationale: the P/D factor uses the entry-TF zigzag to measure retracement, but the impulse zone uses the 1H impulse leg's Fib overlay — a different (often better) swing anchor. When the zone validates a POI at OTE depth, the entry IS at a premium/discount Fib level.

2. **Confluence Stack Credit (lines 3849-3878):** When `srConfirmed + htfLayers.length >= 2`, credit the Confluence Stack factor. Weight: 1.0 for 2 layers, 1.5 for 3+. This is Tier 2 so it increments `tier2Count`. Rationale: the zone engine validates S/R + HTF overlap independently of confluenceScoring's entry-TF-based stacking detection.

3. **HTF POI Alignment Credit (lines 3879-3909):** When `priceAtZone` is true and the zone has HTF OB/FVG layers, credit HTF POI Alignment. Boost: 0.8 per FVG layer type + 0.7 per OB layer type, capped at 2.0. This is Tier 2 so it increments `tier2Count`. Rationale: if price is at zone AND zone overlaps HTF POI, then price is effectively at HTF POI (transitive property).

All three credits have guards against double-counting (skip if factor already present) and null-safety (skip if no bestZone or no tieredScoring). They only fire in hard mode after the impulse zone gate has already passed.

## Tests added

### Extended credits (impulseZoneExtendedCredits.test.ts — 27 tests)

| Test | Assertion |
|------|-----------|
| PDCredit: fibDepth=0.618 → weight 1.5 (OTE zone) | P/D credited, tier1Count 2→3, gate passes |
| PDCredit: fibDepth=0.71 → weight 2.0 (deep OTE) | Weight scales to 2.0 at 71%+ |
| PDCredit: fibDepth=0.5 → weight 1.0 | Minimum threshold credits at exactly 50% |
| PDCredit: fibDepth=0.786 → weight 2.0 | Deep premium zone gets max weight |
| PDCredit: fibDepth=0.45 → NO credit | Below threshold, no mutation |
| PDCredit: P/D already present → NO duplicate | Idempotency guard |
| PDCredit: no bestZone → NO credit | Null safety |
| PDCredit: null tieredScoring → no crash | Null safety |
| StackCredit: srConfirmed + 1 HTF layer → weight 1.0 | 2-layer minimum met |
| StackCredit: srConfirmed + 2 HTF layers → weight 1.5 | 3-layer gets higher weight |
| StackCredit: only srConfirmed (1 layer) → NO credit | Below 2-layer minimum |
| StackCredit: no srConfirmed + 1 HTF layer → NO credit | Below 2-layer minimum |
| StackCredit: no srConfirmed + 2 HTF layers → credits | HTF layers alone can satisfy |
| StackCredit: already present → NO duplicate | Idempotency guard |
| StackCredit: null tieredScoring → no crash | Null safety |
| HTFPOICredit: FVG layer → boost 0.8 | FVG-specific scoring |
| HTFPOICredit: OB layer → boost 0.7 | OB-specific scoring |
| HTFPOICredit: both FVG+OB → boost 1.5 | Additive scoring |
| HTFPOICredit: many layers → capped at 2.0 | Cap enforcement |
| HTFPOICredit: priceAtZone=false → NO credit | Guard condition |
| HTFPOICredit: only breaker/fib layers → NO credit | OB/FVG required |
| HTFPOICredit: already present → NO duplicate | Idempotency guard |
| HTFPOICredit: null bestZone → no crash | Null safety |
| HTFPOICredit: null tieredScoring → no crash | Null safety |
| Combined: all 3 credits fire together | Integration test |
| Combined: P/D fires but Stack doesn't | Selective activation |
| Regression: deterministic outputs | Same inputs → same outputs |

### Original Tier 1 credit (tier1ImpulseZoneCredit.test.ts — 15 tests, unchanged)

All 15 original tests still pass.

## Tests run

```
$ deno test --no-check
FAILED | 530 passed | 34 failed (4s)
```
- 530 passed = 503 pre-existing + 15 (original credit) + 12 (net from extended: 27 new)
- Wait, math: 503 + 15 + 27 = 545? No — the pre-existing 503 already included the 15 from commit 1.
- Correct: 503 (baseline with commit 1) + 27 (new extended tests) = 530 passed
- 34 failed = all pre-existing failures (vitest import errors, missing API keys, etc.)
- 0 new failures introduced by this change

## Regression check

1. All 15 original Tier 1 FVG/OB credit tests still pass unchanged.
2. The 34 pre-existing failures are identical to the baseline.
3. All 3 new credits only activate when: (a) impulse zone hard gate has already passed, (b) the specific factor is NOT already present, (c) the zone data meets minimum thresholds. Existing setups with these factors already scored correctly are unaffected.
4. Determinism test proves identical inputs produce identical outputs across runs.

## Open questions

1. **Soft mode:** Currently all credits only fire in hard mode. Should they also apply in soft mode when `priceAtZone` is true?
2. **Score recalculation:** The credits mutate `factor.weight` and `factor.present` but don't recalculate `analysis.score` (the percentage). The `effectiveScore` calculation happens after these credits, but it only adds `fotsiPenalty + impulseZonePenaltyVal`. Should the overall score be recalculated to reflect the new factor weights?
3. **HTF POI Alignment → Tier 1 promotion:** The existing `_htfTier1FVG`/`_htfTier1OB` promotion logic in confluenceScoring can promote HTF POI Alignment to Tier 1. Our HTF POI credit doesn't trigger this promotion. Should it?

## Suggested PR title and description

**Title:** `[tier1-impulse-zone-credit] Extend impulse zone credits to P/D & Fib, Confluence Stack, and HTF POI Alignment`

**Description:**

### Problem
The impulse zone engine validates multiple confluence factors (Fib depth, S/R overlap, HTF POI overlap) that confluenceScoring misses because it uses different measurement approaches:
- P/D factor uses entry-TF zigzag; impulse zone uses 1H impulse leg Fib
- Confluence Stack checks entry-TF FVG/OB overlap; impulse zone checks zone-level S/R + HTF layers
- HTF POI Alignment checks if price is inside HTF zones; impulse zone checks if the zone overlaps HTF zones

### Fix
After the impulse zone hard gate passes, patch `analysis.tieredScoring` and `analysis.factors` to credit:
1. P/D & Fib (Tier 1) when zone fibDepth >= 0.5
2. Confluence Stack (Tier 2) when zone has srConfirmed + HTF layers >= 2
3. HTF POI Alignment (Tier 2) when priceAtZone + zone has HTF OB/FVG layers

### Safeguards
- Only activates when hard gate already passed
- No credit when factor is already present (no double-counting)
- No credit when zone data doesn't meet minimum thresholds
- 27 new unit tests + 15 existing tests all passing
- Does not modify confluenceScoring.ts or smcAnalysis.ts (protected files)

### Impact
More setups will pass Gate 19 and have higher scores. This increases trade frequency for setups that already pass the impulse zone hard gate.
