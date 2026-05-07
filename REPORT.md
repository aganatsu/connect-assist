# Task: Ranging Direction Fixes
## Branch: manus/ranging-direction-fixes
## Behavior changes

1. **Direction override in ranging markets (Fix 1):** When entry-TF structure is "ranging" but the regime (computed from daily candles) has ≥60% confidence in a direction, the direction is now set to align with the regime bias instead of falling through to mean-reversion logic. Previously, a ranging market with a strong bullish regime could still produce a "short" direction if the P/D zone happened to be in premium.

2. **100%+ retracement hard rejection (Fix 2):** When the ZigZag-detected retracement exceeds 100% of the swing range, the Premium/Discount & Fib factor is now zeroed (pts=0, present=false). Previously, a 200%+ retrace could still score points via the counter-swing or with-trend branches. This affects the existing bullish test fixture which has a 208% retrace — P/D is now correctly invalidated there.

3. **Ranging market quality cap (Fix 3):** In ranging markets, Market Structure weight is capped at 1.0 (qualityRatio ≤ 0.4) instead of receiving the +0.25 "partial trend credit" bonus. The displayWeight is also set to the actual capped pts value so the tiered scoring quality ratio correctly reflects the cap. Previously, a ranging market with a single CHoCH could get full 2.5 displayWeight, giving it 100% qualityRatio in tiered scoring.

4. **Gate 1 regime veto (Fix 4):** When daily structure is "ranging" (soft mode), Gate 1 now consults the regime directional bias. If the regime has ≥60% confidence in a direction opposite to the entry, the trade is blocked with a "HTF regime veto" reason. Previously, any entry was allowed when daily was ranging.

5. **HTF promotion disabled when ranging + low confidence (Fix 5):** The HTF Tier 1 Gate Enhancement (which promotes HTF FVG/OB/Fib to Tier 1 slots) is now skipped entirely when entry-TF structure is "ranging" AND regime confidence is below 70%. Previously, HTF zones could inflate the score in a low-conviction ranging environment.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/confluenceScoring.ts` | Fixes 1, 2, 3, 5: regime override for direction, >100% retrace rejection, ranging quality cap, HTF promotion guard |
| `supabase/functions/bot-scanner/index.ts` | Fix 4: Gate 1 regime-aware veto when daily is ranging |
| `supabase/functions/_shared/confluenceScoring.test.ts` | Updated existing test to reflect Fix 2 behavior (P/D invalidation) |
| `supabase/functions/_shared/rangingDirectionFixes.test.ts` | New regression test file for all 5 fixes |
| `supabase/functions/_shared/__snapshots__/*.json` | Regenerated snapshots to reflect new scoring behavior |
| `TODO.md` | Added task items |

## Tests added

| Test | Assertion |
|------|-----------|
| Fix 1: Ranging + bullish regime → direction is 'long', never 'short' | When regime is bullish with ≥60% confidence, direction must not be "short" |
| Fix 1: Ranging + bearish regime → direction is 'short', never 'long' | When regime is bearish with ≥60% confidence, direction must not be "long" |
| Fix 1: Ranging + neutral regime → mean-reversion still works | Neutral regime allows any direction (mean-reversion preserved) |
| Fix 1: Ranging + no daily candles → mean-reversion still works | Without daily candles, no regime computed, mean-reversion preserved |
| Fix 2: P/D factor detail mentions 'thesis invalidated' when retrace > 100% | Factor weight is 0 and detail mentions "thesis invalidated" |
| Fix 3: Ranging market structure weight is capped at 1.0 | Weight ≤ 1.0, qualityRatio ≤ 0.4 |
| Fix 3: Ranging market structure detail mentions 'capped' | Detail string contains "capped" |
| Fix 4: bot-scanner Gate 1 contains regime veto logic | Source verification of Fix 4 comment, reason string, threshold, direction checks |
| Fix 4: Gate 1 regime veto is inside the soft-mode ranging branch | Structural verification that veto is in the correct code branch |
| Fix 5: Ranging + low-confidence regime → no HTF Tier 1 promotions | No _htfTier1FVG/_htfTier1OB flags, no HTF promotions in tier1 present names |
| Fix 5: source contains _skipHTFPromotion guard | Source verification of the guard variable and conditions |
| Regression: Bullish trending market still produces 'long' direction | Trending markets unaffected by Fix 1 |
| Regression: Market Structure factor in trending market is NOT capped at 1.0 | Trending markets unaffected by Fix 3 |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/_shared/
ok | 147 passed | 0 failed (6s)

$ deno test --no-check --allow-all supabase/functions/bot-scanner/
ok | 12 passed | 0 failed (158ms)
```

All 159 tests pass.

## Regression check

- **Trending markets:** Verified via regression tests that bullish trending markets still produce "long" direction and Market Structure weight > 1.0 (the +1.0 alignment bonus is preserved).
- **Existing test suite:** All 147 `_shared/` tests and 12 `bot-scanner/` tests pass without modification (except the one test updated to reflect the intentional Fix 2 behavior change).
- **Snapshot drift:** Snapshots regenerated. The bullish fixture now scores lower (5 vs 7 rawScore) due to P/D invalidation. The ranging fixture scores lower due to the quality cap. The bearish fixture is minimally affected.
- **Gate 1 soft mode:** The existing "ranging allowed" path is preserved — only counter-regime trades with ≥60% confidence are blocked.

## bot-scanner/index.ts change explanation

**What changed:** Added a new `else if` branch inside Gate 1's soft-mode section. When `htfTrend === "ranging"` AND `analysis.regimeInfo` is available, the gate now checks if the entry direction opposes the regime bias with ≥60% confidence. If so, it pushes a `passed: false` gate with a "HTF regime veto" reason.

**Why:** Previously, Gate 1 in soft mode unconditionally passed when the daily structure was "ranging." This allowed the bot to take short trades even when the regime was strongly bullish (or vice versa), directly contradicting its own higher-timeframe analysis. The 60% threshold ensures only high-confidence regime signals trigger the veto — low-confidence or neutral regimes still allow the trade through.

## Open questions

1. **Confidence threshold (60% for Fix 1 & Fix 4, 70% for Fix 5):** The 60% threshold for direction override and gate veto is conservative — it requires the regime to be "more likely than not" directional. The 70% threshold for HTF promotion is stricter because promotion inflates the score more aggressively. These thresholds could be made configurable if needed. "Confidence" here refers to the regime classifier's self-reported certainty (0-100 scale, stored as 0.0-1.0) — it's computed by `classifyInstrumentRegime()` based on how many directional indicators agree (EMA alignment, ADX, higher-highs/lower-lows count, etc.).

2. **displayWeight semantics:** Fix 3 changes the Market Structure `displayWeight` from always-2.5 to the actual capped pts value when ranging. This means the "weight" shown in the UI for Market Structure in ranging markets will be lower (e.g., 1.0 instead of 2.5). This is intentional — it correctly reflects the factor's contribution — but may surprise users who expect to see the max possible weight.

3. **Bullish fixture regression:** The existing `generateBullishFixture()` produces a 208% retracement (detected by ZigZag). This was always the case but previously scored points anyway. Fix 2 now correctly invalidates it. If the fixture is meant to represent a "good bullish setup," it may need to be redesigned with a more realistic price action pattern in a future task.

## Suggested PR title and description

**Title:** fix: Prevent bot from trading against its own regime analysis in ranging markets

**Description:**
Fixes 5 related issues where the bot could take trades contradicting its own regime detection:

- **Fix 1:** Override direction with regime bias when entry-TF is ranging but regime has ≥60% confidence
- **Fix 2:** Hard-reject P/D factor when retracement exceeds 100% (swing thesis broken)
- **Fix 3:** Cap Market Structure quality ratio at 40% in ranging markets (no trend alignment bonus)
- **Fix 4:** Gate 1 now vetoes counter-regime trades when daily is ranging with ≥60% regime confidence
- **Fix 5:** Skip HTF Tier 1 promotions when ranging + regime confidence < 70%

All 159 existing tests pass. 13 new regression tests added covering each fix and verifying trending markets are unaffected.
