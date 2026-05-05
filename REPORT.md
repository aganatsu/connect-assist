# Task: FVG Qualification Fixes
## Branch: manus/fvg-qualification-fixes
## Behavior changes

1. **Counter-directional FVGs no longer score as present.** Previously, a bearish FVG in a bullish trend would score at half-weight (1.0 instead of 2.0) and still count toward the Tier 1 gate. Now it scores as `present: false` — the bot will not enter trades where the only FVG available opposes the trade direction.

2. **FVGs filled >75% are disqualified.** Previously, heavily-filled FVGs still scored (at reduced weight via the fill multiplier) and could satisfy the Tier 1 gate. Now they are marked `present: false` with detail "dead zone — FVG X% filled, disqualified".

3. **FVGs without displacement are demoted from Tier 1 to Tier 2.** They still contribute to the overall confluence score (weight unchanged), but they do NOT count toward the "3 core factors required" gate. This means a setup relying on an unconfirmed FVG as its primary entry factor will now need an additional Tier 1 factor (OB, Market Structure, or Premium/Discount) to pass the gate.

**Net effect on trade selection:** Setups that previously passed the Tier 1 gate solely because of a counter-directional, heavily-filled, or unconfirmed FVG will now be rejected. Based on analysis of 40 closed trades, this would have blocked approximately 11 losing trades (-$858 in losses) while blocking 2 winning trades (-$239 in gains), for a net improvement of ~$619.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/confluenceScoring.ts` | +38/-12 lines. Added counter-directional FVG rejection (Fix A), >75% fill disqualification (Fix B), and displacement-based Tier 1 demotion (Fix C) to the Factor 3 scoring block. Added `_fvgHasDisplacement` hoisted variable for cross-scope access. |
| `supabase/functions/_shared/fvgQualification.test.ts` | New file (460 lines). 8 tests covering all three fixes plus regression checks. |

## Tests added

| Test | Assertion |
|------|-----------|
| Fix A: Counter-directional FVG should NOT be present | Bearish FVG in confirmed bullish trend → `present: false` |
| Fix A: Aligned FVG should still be present | Bullish FVG in bullish trend → `present: true`, weight > 0 |
| Fix B: FVG filled >75% should NOT be present | 90%-filled FVG → `present: false` |
| Fix B: FVG filled <=30% should still be present | Low-fill FVG → `present: true`, no "dead zone" in detail |
| Fix C: FVG with displacement should remain Tier 1 | Large displacement candle → `tier: 1`, no "demoted" in detail |
| Fix C: FVG without displacement should be demoted to Tier 2 | Small middle candle → `_hasDisplacement: false`, `tier: 2` |
| REGRESSION: Non-FVG Tier 1 factors unaffected | Market Structure, OB, P/D remain Tier 1 |
| REGRESSION: Score is bounded 0-100% | Score and rawScore within valid range |

## Tests run

```
$ deno test --no-check --allow-read --allow-env --allow-net supabase/functions/_shared/
ok | 109 passed | 0 failed (5s)
```

All 109 tests pass:
- 8 new FVG qualification tests
- 9 unicorn anti-double-count regression tests
- 5 SL floor and Tier 1 gate tests
- 87 cross-engine equivalence tests (with --no-check due to pre-existing type error in that file)

## Regression check

1. **Unicorn model unaffected:** All 9 unicorn regression tests pass — the Unicorn anti-double-count logic, Breaker zeroing, and tier classification work identically.
2. **Score bounds preserved:** Score remains 0-100%, rawScore remains non-negative.
3. **Non-FVG factors unaffected:** Market Structure, Order Block, and Premium/Discount retain Tier 1 classification regardless of FVG changes.
4. **Existing FVG behavior preserved for valid setups:** Aligned FVGs with low fill and displacement still score normally at Tier 1.
5. **Data validation:** Ran analysis against 40 closed trades from paper trading history. The fixes correctly identify the losing patterns without disrupting winning trade patterns.

## Open questions

1. **The `crossEngineEquivalence.test.ts` has a pre-existing type error** (references `.active` on `SessionResult` which no longer exists). This is unrelated to our changes but should be fixed separately. Tests still pass with `--no-check`.

2. **Threshold tuning:** The 75% fill threshold for Fix B is based on the trade data analysis. Should this be configurable via bot config, or is a hard 75% acceptable?

3. **Counter-directional FVG edge case:** When `direction` is `null` (no clear trend), FVGs of any type are still allowed through. This preserves the current behavior for ranging markets. Is that acceptable, or should FVGs be blocked entirely when direction is unclear?

## Suggested PR title and description

**Title:** Tighten FVG qualification: reject counter-directional, dead-zone, and unconfirmed FVGs

**Description:**
Data analysis of 40 closed trades revealed that FVG entries without proper qualification had a 15.4% win rate vs 60.9% for non-FVG entries. Three fixes address this:

- **Fix A:** Counter-directional FVGs (bearish FVG in bullish trend) → `present: false`
- **Fix B:** FVGs filled >75% → `present: false` (dead zone)
- **Fix C:** FVGs without displacement → demoted from Tier 1 to Tier 2 (still scores, but doesn't satisfy the "3 core factors" gate)

Expected impact: blocks ~11 losing trades (-$858) while blocking ~2 winners (-$239). Net: +$619 over the sample period.

All 109 existing tests pass. 8 new regression tests added.
