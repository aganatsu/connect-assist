# Task: Fix Unicorn Tier Promotion & Audit Anti-Double-Count Rules

## Branch: manus/fix-unicorn-tier-promotion

## Behavior changes

1. **Unicorn setups now score HIGHER than or equal to FVG-only setups (previously scored LOWER).** When a Unicorn fires and FVG is also present, FVG retains its full Tier 1 (2.0 pts) credit and Unicorn adds a Tier 3 bonus (0.5 pts). Previously, FVG was zeroed (-2.0 pts) and Unicorn only contributed Tier 3 (0.5 pts), resulting in a net -1.5 pt penalty on the highest-conviction setups.

2. **Unicorn is promoted to Tier 1 when FVG is absent.** If a Unicorn fires but no independent FVG is detected (price is inside the Unicorn overlap zone but not separately inside an FVG), the Unicorn is promoted from Tier 3 to Tier 1 (2.0 pts) to fill the FVG's core slot. A Unicorn IS an FVG + Breaker overlap, so it qualifies as a core setup factor.

3. **Breaker Block is still zeroed when Unicorn fires.** This is correct behavior — the Breaker Block is subsumed by the Unicorn and zeroing it prevents double-counting.

4. **Tier 1 gate reason message now uses full factor names** ("Fair Value Gap" instead of "FVG", "Premium/Discount & Fib" instead of "Premium/Discount") and includes "Unicorn Model" when it was promoted.

5. **OB + FVG cap (Rule 3) now applies regardless of Unicorn presence.** Previously it was skipped when Unicorn fired (because FVG was zeroed). Since FVG is no longer zeroed, the cap applies in all cases. This is a minor defensive change — the cap only triggers when OB + FVG combined weight exceeds 3.0, which is rare.

6. **Snapshot files regenerated.** The three snapshot files under `_shared/__snapshots__/` have been regenerated to reflect the new scoring behavior.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/confluenceScoring.ts` | Anti-double-count Rule 1: stopped zeroing FVG when Unicorn fires; added Unicorn Tier 1 promotion when FVG is absent; updated Rule 3 guard condition; updated Tier 1 gate reason message to use full names and include Unicorn; updated comments throughout |
| `supabase/functions/_shared/unicornAntiDoubleCount.test.ts` | **NEW** — 9 regression tests covering all anti-double-count rules |
| `supabase/functions/_shared/__snapshots__/confluenceScoring.snapshot.json` | Regenerated (bullish fixture) |
| `supabase/functions/_shared/__snapshots__/confluenceScoring.bearish.snapshot.json` | Regenerated (bearish fixture) |
| `supabase/functions/_shared/__snapshots__/confluenceScoring.ranging.snapshot.json` | Regenerated (ranging fixture) |
| `TODO.md` | Added tracking items for this task |

## Extra-caution file explanation: confluenceScoring.ts

This file is the core scoring engine. The changes are confined to three specific sections:

**Section 1 — Anti-double-count Rule 1 (lines 1607-1635):** Replaced the FVG-zeroing logic with FVG-preserving logic. When Unicorn fires, only the Breaker Block is zeroed. FVG gets a "[confirmed: part of Unicorn confluence]" tag instead of being zeroed. If FVG is absent, a `_promotedToTier1` flag is set on the Unicorn factor.

**Section 2 — Tier classification (lines 1734-1743):** Added a post-classification block that checks for `_promotedToTier1` and overrides the Unicorn's tier from 3 to 1 when the flag is set.

**Section 3 — Tier 1 gate reason (lines 2031-2040):** Updated the display string to use full factor names and include Unicorn when promoted. This is a display-only change.

No scoring formulas, tier point values, quality scaling logic, or any other factor's scoring was modified.

## Tests added

| Test | What it asserts |
|------|----------------|
| `REGRESSION: Unicorn does NOT zero FVG weight` | When Unicorn fires, FVG weight > 0 and detail does not contain "[zeroed:]" |
| `REGRESSION: Breaker Block IS zeroed when Unicorn fires` | Breaker weight = 0 and detail mentions "absorbed by Unicorn" |
| `REGRESSION: Unicorn setup scores HIGHER than FVG-only` | Score with Unicorn enabled >= score with Unicorn disabled (when Unicorn fires) |
| `REGRESSION: Unicorn tier classification is correct` | Unicorn is Tier 3 when FVG present; Tier 1 (promoted) when FVG absent |
| `REGRESSION: Rule 2 — Displacement reduced when FVG present` | Displacement weight <= 0.5 and detail mentions "adjusted" |
| `REGRESSION: Rule 3 — OB + FVG cap at 3.0 still works` | OB + FVG combined weight <= 3.0 |
| `REGRESSION: Rule 5 — AMD + Sweep absorbs Judas` | Judas weight = 0 and detail mentions "absorbed" |
| `Tiered scoring: tier counts are valid after Unicorn fix` | tier1Max is 4-5, all counts within bounds, score 0-100% |
| `Tiered scoring: rawScore <= enabledMax` | rawScore never exceeds enabledMax |

## Tests run

```
$ deno test --allow-all --no-check

unicornAntiDoubleCount.test.ts:     9 passed | 0 failed
confluenceScoring.test.ts:         14 passed | 0 failed
crossEngineEquivalence.test.ts:    25 passed | 0 failed
slFloorAndTier1Gate.test.ts:        5 passed | 0 failed
liveBacktestParity.test.ts:        30 passed | 0 failed
+ 155 other tests from gate/scanner test files

TOTAL: 238 passed | 1 failed (pre-existing Vitest config issue in src/test/example.test.ts — unrelated)
```

## Regression check

The Unicorn fix was verified through three complementary approaches:

1. **Direct comparison test**: `REGRESSION: Unicorn setup scores HIGHER than FVG-only` runs the same fixture with Unicorn enabled vs disabled and asserts the Unicorn-enabled score is >= the Unicorn-disabled score. This test would have FAILED before the fix (Unicorn-enabled score was lower due to the -1.5 pt penalty).

2. **Factor weight inspection**: `REGRESSION: Unicorn does NOT zero FVG weight` directly checks that FVG's weight is preserved when Unicorn fires. Before the fix, FVG weight was set to 0.

3. **Cross-engine stability**: All 25 cross-engine equivalence tests pass, confirming idempotency, config equivalence, and output bounds are maintained.

4. **Snapshot regeneration**: Snapshots were deleted and regenerated. Second run confirmed stability (no drift).

## Audit of other anti-double-count rules

| Rule | Description | Verdict |
|------|-------------|---------|
| Rule 1 (Unicorn → FVG + Breaker) | **FIXED** — FVG no longer zeroed, Unicorn promoted when FVG absent |
| Rule 2 (Displacement + FVG) | **OK** — Displacement (Tier 2) reduced to 0.5 weight when FVG present. No tier mismatch. |
| Rule 3 (OB + FVG cap at 3.0) | **OK** — Both are Tier 1. Cap only triggers when combined > 3.0. Minor fix: now applies regardless of Unicorn. |
| Rule 5 (AMD + Sweep → Judas) | **OK** — Judas (Tier 3, 0.5 pts) zeroed when AMD + Sweep present. Defensible: Judas is a subset of AMD manipulation. |

No other anti-double-count rules exhibit the same tier mismatch pattern as Rule 1.

## Open questions

1. **Legacy smc-analysis endpoint**: `supabase/functions/smc-analysis/index.ts` has a separate legacy scoring path that scores Unicorn independently as "Unicorn Setup" for 1.5 pts with no anti-double-count. This endpoint is semantically inconsistent with the shared engine. Should it be updated to use the shared engine, or is it intentionally separate?

2. **Threshold recalibration**: With Unicorn setups now scoring higher, some trades that previously fell below the 55% threshold may now pass. This is the correct behavior (Unicorn setups SHOULD score higher), but you may want to backtest with the new scoring to verify the threshold is still optimal.

## Suggested PR title and description

**Title:** `[fix-unicorn-tier-promotion] Stop penalizing Unicorn setups in tiered scoring`

**Description:**

Fixes a critical scoring bug where Unicorn setups (the highest-conviction ICT entry pattern) scored LOWER than standalone FVG entries due to the anti-double-count logic zeroing FVG (Tier 1, 2pts) while Unicorn was only classified as Tier 3 (0.5pts).

Changes:
- Anti-double-count Rule 1: FVG is no longer zeroed when Unicorn fires (only Breaker Block is zeroed)
- Unicorn is promoted to Tier 1 when FVG is absent (it IS an FVG + Breaker overlap)
- Tier 1 gate reason message updated to use full factor names and include Unicorn
- 9 new regression tests covering all anti-double-count rules
- Audited Rules 2, 3, 5 — no similar tier mismatches found

Impact: Unicorn setups will now score higher (correctly). Some trades that previously fell below the confluence threshold may now pass. Recommend backtesting with new scoring before deploying to live.
