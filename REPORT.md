# Task: Bidirectional Factor Scoring + Conflict Counter
## Branch: manus/bidirectional-scoring-v2

## Behavior changes

1. **Opposing displacement now penalizes at -50% of max weight** (was: 0). A bearish displacement on a long trade scores -0.5 instead of 0. This reduces the overall confluence score for trades with opposing displacement.

2. **Opposing reversal candle now penalizes at -50% of max weight** (was: 0). A bearish reversal candle on a long trade scores approximately -0.375 instead of 0.

3. **Opposing AMD phase now penalizes at -50% to -75% of max weight** (was: 0). Distribution phase opposing gets -0.75 (stronger penalty), other opposing phases get -0.5.

4. **Counter-directional confluence stacks now penalize** (was: reduced to 50% positive). A COUNTER-direction triple confluence now scores -0.375 instead of +0.375. Double confluence: -0.25. Single: -0.125.

5. **Daily Bias factor now uses bidirectional present check** (was: already had negative scoring but `present` was inconsistent). Factor is now `present: pts !== 0` so negative daily bias correctly shows as present with negative weight.

6. **FOTSI (Currency Strength) negative values now count toward opposing factor count** (was: negative FOTSI contributed to raw score but was not tracked as an opposing factor). When FOTSI produces a negative score, it now sets `_opposing: true` and uses a negative `weight`, contributing to `opposingFactorCount`.

7. **Structural conviction gate tightened** (Gate 3 in bot-scanner). Previously only blocked when supporting direction rate = 0%. Now also blocks when opposing rate > 2.5x supporting rate (e.g., Bear 50% vs Bull 20% = 2.5x -> blocked). This would have blocked the XAG/USD trade from the original analysis.

8. **Conflict counter introduced with configurable thresholds**. When N+ factors have opposing (negative) weights, the minimum confluence threshold is raised by 10 percentage points. When M+ factors oppose, the trade is blocked entirely regardless of score. Defaults: N=4 (raise threshold), M=6 (block). Both values are configurable via the Risk tab in Bot Config UI (`conflictThresholdRaise` and `conflictBlockAt`).

9. **Tiered scoring now includes `opposingFactorCount`** in its output, and the summary string includes an `[N opposing]` annotation when opposing factors are present.

## Files modified

- `supabase/functions/_shared/confluenceScoring.ts` — Factor 8 (Reversal Candle), Factor 10 (Displacement), Factor 17 (AMD Phase), Factor 18 (FOTSI/Currency Strength), Factor 19 (Confluence Stack), Factor 22 (Daily Bias): added bidirectional penalty logic. Tiered scoring loop: added opposing factor handling and conflict counter. Return object: added `opposingFactorCount` to `tieredScoring`.
- `supabase/functions/bot-scanner/index.ts` — Gate 3 (structural conviction): added 2.5x ratio block. Conflict counter: added configurable threshold adjustment and block logic at both initial entry and staged setup promotion checkpoints. loadConfig: added `conflictThresholdRaise` and `conflictBlockAt` reads from `risk` config section.
- `src/components/BotConfigModal.tsx` — Added `conflictThresholdRaise` (default 4) and `conflictBlockAt` (default 6) controls to Risk tab. Added corresponding BASE_CONFIG defaults and search index entries.
- `supabase/functions/_shared/reversalCandleAlignment.test.ts` — Updated test to expect negative weight for opposing reversal (was expecting 0/not-present).
- `supabase/functions/_shared/__snapshots__/confluenceScoring.snapshot.json` — Regenerated for new scoring output.
- `supabase/functions/_shared/__snapshots__/confluenceScoring.bearish.snapshot.json` — Regenerated.
- `supabase/functions/_shared/__snapshots__/confluenceScoring.ranging.snapshot.json` — Regenerated.
- `supabase/functions/_shared/bidirectionalScoring.test.ts` — New test file (15 tests).

## Changes to protected/cautioned files

### bot-scanner/index.ts (live execution)

Three changes were made:

1. **Gate 3 structural conviction (line ~1515)**: Added a new block condition. When the opposing direction's fractal break rate exceeds 2.5x the supporting direction's rate AND both rates are non-zero, the gate now fails. Example: Bull 20% / Bear 50% = 2.5x ratio -> gate fails. Previously this only failed when the supporting rate was exactly 0%.

2. **Conflict counter threshold adjustment (lines ~4063, ~4010)**: After the existing `adjustedMinConfluence` calculation, added conflict counter logic. Reads `opposingFactorCount` from the confluence result's `tieredScoring`. If >= `conflictBlockAt` (default 6) opposing factors, the trade is blocked entirely. If >= `conflictThresholdRaise` (default 4), the threshold is raised by 10 percentage points. This applies at both the initial entry check and the staged setup promotion check.

3. **loadConfig (line ~823)**: Added `conflictThresholdRaise` and `conflictBlockAt` reads from `risk` config section with defaults of 4 and 6 respectively.

### confluenceScoring.ts (scoring engine — not in the protected smcAnalysis.ts)

Six factor scoring sections modified:

1. **Factor 8 Reversal Candle**: When reversal type opposes trade direction, `pts` is now set to a negative value (50% of aligned weight) instead of 0. The `present` check uses `pts !== 0` pattern.

2. **Factor 10 Displacement**: When displacement direction opposes trade direction, `pts = -0.5` instead of 0.

3. **Factor 17 AMD Phase**: When AMD bias opposes trade direction, `pts` is -0.75 for distribution phase (stronger penalty) or -0.5 for other phases.

4. **Factor 18 FOTSI/Currency Strength**: When FOTSI produces negative pts, the factor now sets `_opposing: true` and uses a negative `weight` value. Previously, negative FOTSI contributed to raw score but was not tracked as opposing.

5. **Factor 19 Confluence Stack**: Counter-directional stacks now produce negative weights (-0.375 for triple, -0.25 for double, -0.125 for single) instead of reduced positive weights.

6. **Factor 22 Daily Bias**: Present check changed to `pts !== 0` (was already capable of negative scoring).

7. **Tiered scoring loop**: Added `opposingFactorCount` tracking. Factors with `_opposing: true` and `weight < 0` are counted and subtract 50% of tier points from the tiered score.

8. **All 6 factor push lines**: `weight` field now uses `pts < 0 ? -Math.abs(s.displayWeight) : s.displayWeight` so the tiered scoring loop can see negative weights.

### src/components/BotConfigModal.tsx (UI)

Added two new controls to the Risk tab:
- **Conflict Threshold Raise** (conflictThresholdRaise, default 4): Number of opposing factors that triggers a +10pp threshold increase.
- **Conflict Block At** (conflictBlockAt, default 6): Number of opposing factors that blocks the trade entirely.

## Tests added

| Test | What it asserts |
|------|-----------------|
| Opposing displacement produces negative weight (not 0) | Bearish displacement on long trade has weight < 0 |
| tieredScoring includes opposingFactorCount field | Field exists in output |
| Clean bullish fixture has <= 2 opposing factors | Regression: clean trend shouldn't trigger many penalties |
| Reversal candle uses present: pts !== 0 pattern | Bidirectional present check works |
| AMD Phase factor has correct present/weight shape | Structural check on factor output |
| Confluence Stack factor has correct present/weight shape | Structural check |
| Daily Bias factor has correct present/weight shape | Structural check |
| Bearish daily candles on long produce negative Daily Bias weight | Opposing daily bias penalizes |
| Final score is clamped at 0 (never negative) | Score floor works |
| Summary includes opposing count annotation | `[N opposing]` in summary string |
| Aligned factors still produce positive weight | Regression: no factor becomes negative without `_opposing` flag |
| DEFAULT_FACTOR_WEIGHTS has expected factor count | Regression: factor count unchanged |
| FOTSI uses _opposing flag when negative | Negative FOTSI has `_opposing: true` and negative weight |
| Negative FOTSI contributes to opposingFactorCount | Opposing count increases when FOTSI is negative |
| Config defaults for conflictThresholdRaise and conflictBlockAt | UI defaults (4, 6) and bot-scanner reads from risk section |

## Tests run

```
$ deno test --allow-all --no-check
688 passed | 1 failed (10s)
```

The 1 failure is pre-existing and unrelated:
- `src/test/example.test.ts` — template test (uncaught vitest error, not a Deno test)

## Regression check

1. **Snapshot tests**: Deleted old snapshots, regenerated with new scoring, verified stability on second run. The new snapshots capture the bidirectional scoring output as the new baseline.
2. **Reversal candle alignment test**: Updated from "scores 0" to "produces negative penalty" — this is the intentional behavior change.
3. **Clean bullish fixture**: Verified that a clean bullish trend with bullish daily candles produces <= 2 opposing factors and no factors are negative without the `_opposing` flag.
4. **Score floor**: Verified that even with maximum opposing signals, the score is clamped at 0 (never goes negative).
5. **All 688 non-pre-existing tests pass**: No regressions introduced.

## Open questions

1. **XAG/USD trade confirmed blocked**: User confirmed this is the desired outcome.
2. **Conflict counter thresholds now configurable**: User requested this — defaults are 4 (raise) and 6 (block), adjustable in Risk tab.
3. **FOTSI negative values now count toward opposing**: User confirmed this should be included.

## Suggested PR title and description

**Title:** feat: bidirectional factor scoring with configurable conflict counter

**Description:**
Implements bidirectional scoring for 6 confluence factors (Displacement, Reversal Candle, AMD Phase, FOTSI, Confluence Stack, Daily Bias) so that opposing signals penalize at 50% of max weight instead of scoring 0. Adds a configurable conflict counter that raises the minimum confluence threshold by 10pp when N+ factors oppose (default 4), and blocks entirely when M+ oppose (default 6). Tightens the structural conviction gate to block when opposing rate > 2.5x supporting rate. Both conflict counter thresholds are configurable via the Risk tab in Bot Config.

This addresses the "no-penalty for opposing signals" gap identified in the XAG/USD trade analysis, where bearish displacement, bearish reversal candle, and counter-directional confluence all scored 0 instead of reducing the overall score.

BEHAVIOR CHANGES: Yes — trades with opposing signals will score lower. Trades with structural conviction ratio > 2.5x opposing will be blocked. Trades with 6+ opposing factors will be blocked. FOTSI negative values now contribute to opposing factor count.
