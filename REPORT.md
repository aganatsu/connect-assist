# Task: Consolidate Correlation Gate (Phase 3, Stage 3)

## Branch: manus/consolidate-correlation

## Behavior changes

1. **Backtest-engine Gate 20 now uses numeric correlation coefficients** instead of binary bucket membership. Pairs that were previously in the same bucket (e.g., EUR/USD + EUR/GBP in "EUR_CROSSES") but have low actual correlation (rawCorr=0.30) will now PASS the gate. Previously they would have been blocked.

2. **Hedge detection is new.** The old bucket model only checked same-direction positions. The new logic detects opposite-direction positions on highly-correlated pairs (e.g., long XAU/USD + short XAG/USD) as hedge conflicts and blocks them unconditionally. This matches bot-scanner Gate 22's existing behavior.

3. **SMT pair fallback** now applies in backtest-engine. If a pair isn't caught by the static matrix (rawCorr < threshold) but IS an SMT pair, the gate still fires. This matches bot-scanner.

4. **Currency decomposition fallback** now applies in backtest-engine. Synthetic hedges (e.g., long NZD/CAD + long CAD/NZD) are detected even when neither the matrix nor SMT covers the pair.

5. **Reason strings changed.** Old: `Correlation (METALS): 2/2 same-dir open`. New: `Correlated same-direction cap hit (threshold 0.8): 1/1 — XAG/USD long (raw ρ=0.85, eff=85%) — doubling`. This matches bot-scanner's format exactly.

6. **gatePerformanceEngine pattern matching fixed.** The old patterns ("Correlation conflict", "Correlated exposure") did NOT match bot-scanner's actual reason strings — confirmed by testing. The new patterns correctly categorize all four of bot-scanner's current Gate 22 reason strings. Pattern ordering was also fixed (correlation now before min_confluence to prevent "threshold" false-matching).

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/backtest-engine/index.ts` | Deleted `CORRELATION_GROUPS` constant and `getCorrelationGroup()` helper. Rewrote Gate 20 to use `getCorrelation`/`getDirectionalCorrelation` from shared `portfolioCorrelation.ts`, with SMT and currency-decomposition fallbacks. Added import for `getCorrelation`/`getDirectionalCorrelation`. |
| `supabase/functions/_shared/configMapper.ts` | Added `maxCorrelation: 0.8` to `RUNTIME_DEFAULTS` and added resolution chain line: `instruments.maxCorrelation ?? raw.maxCorrelation ?? RUNTIME_DEFAULTS.maxCorrelation` |
| `supabase/functions/_shared/gatePerformanceEngine.ts` | Updated correlation patterns from stale `["Correlation conflict", "Correlated exposure"]` to `["Hedge conflict on correlated", "Correlated same-direction", "No correlated conflicts"]`. Moved correlation entry before min_confluence to prevent "threshold" substring collision. |
| `supabase/functions/_shared/gatePerformanceEngine.test.ts` | Replaced 2 stale correlation tests with 3 tests covering bot-scanner's actual current reason strings. |
| `supabase/functions/_shared/gateCorrelation.test.ts` | **NEW** — 26 cross-engine agreement tests covering all detection paths, threshold sensitivity, and documented divergences. |

## Tests added

| Test file | Test name | What it asserts |
|-----------|-----------|-----------------|
| `gateCorrelation.test.ts` | no open positions → pass | Both engines pass with empty portfolio |
| `gateCorrelation.test.ts` | same symbol skipped | Same-symbol positions don't trigger correlation gate |
| `gateCorrelation.test.ts` | XAU/XAG same direction → doubling blocked | Metals same-dir blocked via coefficient |
| `gateCorrelation.test.ts` | XAU/XAG opposite direction → hedge blocked | Metals opposite-dir detected as hedge |
| `gateCorrelation.test.ts` | BTC/ETH same direction → doubling blocked | Crypto same-dir blocked |
| `gateCorrelation.test.ts` | EUR/USD + GBP/USD same direction → doubling | Forex high-correlation doubling |
| `gateCorrelation.test.ts` | EUR/USD + USD/CHF same direction → hedge | Inverse-correlated same-dir = hedge |
| `gateCorrelation.test.ts` | below threshold → pass | rawCorr < threshold passes |
| `gateCorrelation.test.ts` | maxCorrelatedPositions=2 allows one doubling | Cap logic works |
| `gateCorrelation.test.ts` | maxCorrelatedPositions=2 blocks at 2 doublings | Cap exceeded blocks |
| `gateCorrelation.test.ts` | hedge always blocks regardless of cap | Hedge unconditional |
| `gateCorrelation.test.ts` | filter disabled → pass | Config toggle works |
| `gateCorrelation.test.ts` | coefficient: XAU/XAG raw=0.85 | Static matrix value correct |
| `gateCorrelation.test.ts` | coefficient: XAU/XAG eff=-0.85 opposite-dir | Directional flip correct |
| `gateCorrelation.test.ts` | coefficient: EUR/USD ↔ USD/CHF raw=-0.90 | Inverse pair value correct |
| `gateCorrelation.test.ts` | coefficient: BTC/ETH raw=0.90 | Crypto pair value correct |
| `gateCorrelation.test.ts` | SMT pair fallback: same direction → doubling | SMT fallback fires when matrix misses |
| `gateCorrelation.test.ts` | currency decomposition: perfect hedge | Synthetic hedge detected |
| `gateCorrelation.test.ts` | currency decomposition: identical exposure | Synthetic doubling detected |
| `gateCorrelation.test.ts` | reason string has colon for split(':')[0] | Aggregation-compatible format |
| `gateCorrelation.test.ts` | passing reason for 'no conflicts' | Pass-through format acceptable |
| `gateCorrelation.test.ts` | threshold=0.9: EUR/GBP still caught by SMT | SMT overrides higher threshold |
| `gateCorrelation.test.ts` | threshold=0.85 catches EUR/GBP doubling | Exact-threshold boundary |
| `gateCorrelation.test.ts` | DIVERGENCE: AUD/USD + NZD/USD coefficient | Documents new mechanism |
| `gateCorrelation.test.ts` | DIVERGENCE: EUR/USD + EUR/GBP now passes | Documents correct improvement |
| `gateCorrelation.test.ts` | DIVERGENCE: opposite direction now hedge | Documents new capability |
| `gatePerformanceEngine.test.ts` | Hedge conflict maps to correlation | New pattern works |
| `gatePerformanceEngine.test.ts` | Correlated same-direction cap maps | New pattern works |
| `gatePerformanceEngine.test.ts` | No correlated conflicts maps | New pattern works |

## Tests run

```
ok | 1777 passed | 0 failed (19s)
```

## Regression check

1. **Cross-engine agreement**: All 26 tests in `gateCorrelation.test.ts` verify that the backtest-engine Gate 20 produces identical `{ passed, reason }` output as bot-scanner Gate 22 for the same inputs.

2. **Intentional divergences documented**: Three tests explicitly document where the new behavior DIFFERS from the old bucket model, with explanations of why each is an improvement (not a regression).

3. **gatePerformanceEngine patterns**: Verified that the old patterns ("Correlation conflict", "Correlated exposure") matched NONE of bot-scanner's actual current reason strings — they were already broken. The fix restores correct categorization.

4. **Config field sourced correctly**: `maxCorrelation` is sourced from `instruments` section (matching bot-scanner's inline resolution chain), not from `strategy` (where the other two correlation fields live in configMapper). This ensures users who have already set `maxCorrelation` in their DB config under `instruments` get it honored by both engines.

## Open questions

1. **`unifiedPositionSizing.ts` still has its own `CORRELATION_GROUPS`** (line 117). This is used by bot-scanner for position sizing (correlation-adjusted risk), not for the gate decision. It's a separate concern and out of scope for this task, but flagged for awareness — it could be migrated to use `portfolioCorrelation.ts` coefficients in a future task.

2. **configMapper sources `correlationFilterEnabled` and `maxCorrelatedPositions` from `strategy` section**, but bot-scanner sources them from `instruments` section. I matched bot-scanner's actual source for `maxCorrelation` (instruments), but the two sibling fields have a pre-existing inconsistency. This doesn't cause bugs (both fall through to `raw.*` and then defaults) but is worth noting for a future cleanup.

## Suggested PR title and description

**Title:** Replace backtest correlation gate with numeric-coefficient matrix (Phase 3, Stage 3)

**Description:**
Replaces the binary bucket-based `CORRELATION_GROUPS` in backtest-engine with the same numeric-coefficient matrix (`portfolioCorrelation.ts`) that bot-scanner Gate 22 uses. This eliminates the last major source of divergence between the two engines' correlation logic.

**Key changes:**
- Gate 20 now uses `getCorrelation()`/`getDirectionalCorrelation()` from shared library
- Adds SMT pair and currency-decomposition fallbacks (matching bot-scanner exactly)
- Adds `maxCorrelation` to shared `configMapper.ts` (was only in bot-scanner's inline config)
- Fixes stale `gatePerformanceEngine.ts` patterns that didn't match bot-scanner's actual reason strings
- 26 new cross-engine agreement tests + 3 updated pattern tests

**Behavior impact:** This changes which trades the backtest-engine blocks. Low-correlation pairs that happened to share a bucket (e.g., EUR/USD + EUR/GBP, rawCorr=0.30) will now pass. Opposite-direction positions on highly-correlated pairs will now be detected as hedges and blocked. See REPORT.md for full divergence documentation.
