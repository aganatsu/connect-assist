# Task: Consolidate Correlation Gate + Fix Default-Value Divergence (Phase 3, Stage 3)

## Branch: manus/consolidate-correlation

## Behavior changes

### Commit 1: Replace bucket-based CORRELATION_GROUPS with numeric-coefficient matrix

1. **Backtest-engine Gate 20 now uses numeric correlation coefficients** instead of binary bucket membership. Pairs that were previously in the same bucket (e.g., EUR/USD + EUR/GBP in "EUR_CROSSES") but have low actual correlation (rawCorr=0.30) will now PASS the gate. Previously they would have been blocked.

2. **Hedge detection is new.** The old bucket model only checked same-direction positions. The new logic detects opposite-direction positions on highly-correlated pairs (e.g., long XAU/USD + short XAG/USD) as hedge conflicts and blocks them unconditionally. This matches bot-scanner Gate 22's existing behavior.

3. **SMT pair fallback** now applies in backtest-engine. If a pair isn't caught by the static matrix (rawCorr < threshold) but IS an SMT pair, the gate still fires. This matches bot-scanner.

4. **Currency decomposition fallback** now applies in backtest-engine. Synthetic hedges (e.g., long NZD/CAD + long CAD/NZD) are detected even when neither the matrix nor SMT covers the pair.

5. **Reason strings changed.** Old: `Correlation (METALS): 2/2 same-dir open`. New: `Correlated same-direction cap hit (threshold 0.8): 1/1 — XAG/USD long (raw ρ=0.85, eff=85%) — doubling`. This matches bot-scanner's format exactly.

6. **gatePerformanceEngine pattern matching fixed.** The old patterns ("Correlation conflict", "Correlated exposure") did NOT match bot-scanner's actual reason strings — confirmed by testing. The new patterns correctly categorize all four of bot-scanner's current Gate 22 reason strings.

### Commit 2: Align configMapper defaults to bot-scanner production values

7. **configMapper `correlationFilterEnabled` default changed from `true` to `false`.** This means backtest-engine now defaults to correlation filter DISABLED — matching what bot-scanner (live) has always done. Any account that never explicitly set this field was previously getting different behavior between live (filter off) and backtest (filter on). Now they match.

8. **configMapper `maxCorrelatedPositions` default changed from `2` to `1`.** Same rationale — accounts that explicitly enable the correlation filter but never set a cap will now get cap=1 in both engines (was 2 in backtest, 1 in live).

9. **configMapper source-section changed from `strategy` to `instruments`** for `correlationFilterEnabled` and `maxCorrelatedPositions`. Bot-scanner sources all three correlation fields from `instruments`; configMapper now does the same.

### Does this change live bot-scanner behavior?

**No.** Bot-scanner uses its own inline resolution (lines 900-902), not configMapper. The changes here only affect configMapper, which is consumed by backtest-engine. No live account's behavior changes.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/backtest-engine/index.ts` | Deleted `CORRELATION_GROUPS` constant and `getCorrelationGroup()` helper. Rewrote Gate 20 to use `getCorrelation`/`getDirectionalCorrelation` from shared `portfolioCorrelation.ts`, with SMT and currency-decomposition fallbacks. |
| `supabase/functions/_shared/configMapper.ts` | (1) Added `maxCorrelation: 0.8` to RUNTIME_DEFAULTS. (2) Changed `correlationFilterEnabled` default from `true` to `false`. (3) Changed `maxCorrelatedPositions` default from `2` to `1`. (4) Changed source-section from `strategy` to `instruments` for all three correlation fields. |
| `supabase/functions/_shared/gatePerformanceEngine.ts` | Updated correlation patterns to match bot-scanner's actual reason strings. Moved correlation entry before min_confluence to prevent "threshold" substring collision. |
| `supabase/functions/_shared/gatePerformanceEngine.test.ts` | Replaced 2 stale correlation tests with 3 tests covering bot-scanner's actual current reason strings. |
| `supabase/functions/_shared/gateCorrelation.test.ts` | **NEW** — 30 tests: 26 cross-engine agreement tests + 4 default-path agreement tests. |

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
| `gateCorrelation.test.ts` | **Default-path: RUNTIME_DEFAULTS match bot-scanner** | Asserts all 3 defaults are identical |
| `gateCorrelation.test.ts` | **Default-path: mapNestedToFlat with empty config** | Empty config resolves to bot-scanner defaults |
| `gateCorrelation.test.ts` | **Default-path: instruments-section source honored** | instruments wins over strategy |
| `gateCorrelation.test.ts` | **Default-path: same verdict with unset config** | Both engines pass (filter disabled) with unset config |
| `gatePerformanceEngine.test.ts` | Hedge conflict maps to correlation | New pattern works |
| `gatePerformanceEngine.test.ts` | Correlated same-direction cap maps | New pattern works |
| `gatePerformanceEngine.test.ts` | No correlated conflicts maps | New pattern works |

## Tests run

```
ok | 1781 passed | 0 failed (19s)
```

## Regression check

1. **Cross-engine agreement**: All 30 tests in `gateCorrelation.test.ts` verify that the backtest-engine Gate 20 produces identical `{ passed, reason }` output as bot-scanner Gate 22 for the same inputs, including the default/unset config path.

2. **Default-path specifically tested**: Four dedicated tests prove that when no correlation config is set, both engines resolve to `{ correlationFilterEnabled: false, maxCorrelatedPositions: 1, maxCorrelation: 0.8 }` and produce identical verdicts.

3. **Source-section priority verified**: Test proves `instruments.X` wins over `strategy.X` in configMapper, matching bot-scanner's chain.

4. **No live behavior change**: Bot-scanner uses its own inline resolution, not configMapper. Only backtest-engine behavior changes (it now matches live).

## Open questions

1. **`unifiedPositionSizing.ts` still has its own `CORRELATION_GROUPS`** (line 117). Used for position sizing, not gate decisions. Future cleanup candidate.

2. **Was there a deliberate reason for the old configMapper defaults (true/2)?** The task prompt asked this question. My analysis: this is drift, not deliberate design. configMapper was written later than bot-scanner's inline resolution, and the author likely chose "sensible" defaults without cross-referencing bot-scanner's actual values. The fact that the source-section was also different (strategy vs instruments) supports this being unintentional drift rather than a deliberate divergence.

## Suggested PR title and description

**Title:** [consolidate-correlation] Replace backtest correlation gate with numeric-coefficient matrix + fix default-value divergence

**Description:**
Two-commit fix for the correlation gate consolidation:

**Commit 1:** Replaces the binary bucket-based `CORRELATION_GROUPS` in backtest-engine with the same numeric-coefficient matrix (`portfolioCorrelation.ts`) that bot-scanner Gate 22 uses. Adds SMT pair and currency-decomposition fallbacks. Fixes stale gatePerformanceEngine patterns.

**Commit 2:** Aligns configMapper's correlation defaults to bot-scanner's production values:
- `correlationFilterEnabled`: `true` → `false`
- `maxCorrelatedPositions`: `2` → `1`
- Source-section: `strategy` → `instruments`

**Live behavior impact:** None. Bot-scanner uses its own inline resolution. Only backtest-engine behavior changes — it now matches what live has always done for accounts with unset correlation config.

**Backtest behavior impact:** Accounts that never set correlation config will now see the filter DISABLED by default in backtests (was incorrectly enabled). Accounts that explicitly enabled it will see cap=1 (was incorrectly 2). Both now match live.
