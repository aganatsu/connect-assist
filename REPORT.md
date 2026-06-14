# Task: Style Tuning Port

## Branch: manus/style-tuning-port

## Behavior changes

1. **Scalper: Break-even disabled.** Previously, scalper trades would move SL to breakeven after 1R. Now trades run to TP or SL without BE intervention. Backtest validation: 44% WR × 2:1 R:R = profitable on EUR/USD (50 trades, +$806 over 3 months). BE was cutting winners short on 5m noise.

2. **Scalper: Trailing stop disabled.** Previously, trailing activated after 1R. Now trades run cleanly to TP/SL. Same validation as above.

3. **Scalper: tpRatio changed from 1.5 to 2.0.** The ATR floor already bumps SL to ~20 pips on EUR/USD 5m, so a 2:1 ratio gives ~40 pip TP. Validated profitable.

4. **Scalper: riskPerTrade set to 0.5%.** Lower risk per trade due to higher trade frequency (~17 trades/month).

5. **Scalper: impulseSlCapMultiplier set to 1.5.** Tighter SL cap for scalper to prevent oversized SLs on 5m.

6. **Swing: Break-even disabled.** Previously, BE triggered after 1R. Backtest showed XAU/USD was hitting BE on ALL 10 trades (100% BE rate) instead of reaching TP. With BE disabled: 8 trades, 75% WR, PF 8.88, +28.3% over 9 months.

7. **Swing: Trailing stop disabled.** Same reasoning — let swing trades develop to their 3R target.

8. **Swing: Partial TP disabled.** Taking 33% at 1R was reducing final P&L. Full position to 3R is optimal with cascade zone quality.

9. **Swing: minConfluence lowered from 65 to 40.** The cascade zone engine's selectivity (Daily→4H→1H waterfall) is the real quality filter. Lower confluence threshold allows more cascade-validated setups through.

10. **Swing: riskPerTrade set to 1.5%.** Higher conviction per trade (fewer trades, ~1/month).

11. **Swing: impulseSlCapMultiplier set to 6.** Wider SL cap for swing (Daily impulses are larger).

12. **Swing: Cascade zone engine now used as primary zone gate.** When `findCascadeZone` returns state="triggered" for swing_trader, it takes priority over the unified zone engine. The cascade SL override is applied after the unified SL override (final priority).

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added cascade zone engine import; updated STYLE_OVERRIDES for scalper (BE off, trailing off, tpRatio 2.0, risk 0.5%, SL cap 1.5) and swing_trader (BE off, trailing off, partial off, minConf 40, risk 1.5%, SL cap 6); added cascade zone engine call for swing_trader; added cascade gate pass logic; added cascade SL override |
| `supabase/functions/_shared/styleTuningPort.test.ts` | New test file with 21 tests covering all parameter changes, cascade integration, and day_trader regression |

## Extra caution explanation: bot-scanner/index.ts

The changes to bot-scanner/index.ts are in three categories:

1. **STYLE_OVERRIDES (lines 407-472):** These are default parameter values that get applied when a user selects a trading style. They are NOT gate definitions — they are tunable configuration. The user-protected-fields mechanism (line 1799) ensures that any user-explicit overrides still take precedence. The key behavioral changes (BE off, trailing off) were validated via 9-month backtests showing significant P&L improvement.

2. **Cascade zone engine call (lines 4307-4343):** This is an ADDITIVE block that runs ONLY for swing_trader. It calls `findCascadeZone` and stores the result in `detail.cascadeZone`. If it errors, it logs a warning and continues (non-fatal). It does NOT modify the existing unified zone engine call — both run, and cascade takes priority only when it reaches "triggered" state.

3. **Cascade gate pass and SL override (lines 4692-4698, 5364-5388):** The cascade gate pass is checked BEFORE the unified gate pass (priority order). If cascade triggers, `unifiedGatePassed` is set to true and `signalSource` is "cascade" (vs "unified"). The SL override runs AFTER the unified SL override and only applies when cascade is triggered. Both are bounded by the same `impulseSlCapMultiplier` safety cap.

None of these changes modify the 21 gate definitions. The day_trader style is completely unchanged.

## Tests added

| Test | Assertion |
|------|-----------|
| `scalper tpRatio is 2.0` | Validates scalper R:R ratio is 2:1 |
| `scalper breakEvenEnabled is false` | Validates BE is disabled for scalper |
| `scalper trailingStopEnabled is false` | Validates trailing is disabled for scalper |
| `scalper riskPerTrade is 0.5` | Validates lower risk for high-frequency style |
| `scalper impulseSlCapMultiplier is 1.5` | Validates tight SL cap for scalper |
| `swing_trader tpRatio is 3.0` | Validates swing R:R ratio is 3:1 |
| `swing_trader breakEvenEnabled is false` | Validates BE is disabled for swing |
| `swing_trader trailingStopEnabled is false` | Validates trailing is disabled for swing |
| `swing_trader partialTPEnabled is false` | Validates partial TP is disabled for swing |
| `swing_trader minConfluence is 40` | Validates lower confluence threshold for swing |
| `swing_trader riskPerTrade is 1.5` | Validates higher risk for high-conviction style |
| `swing_trader impulseSlCapMultiplier is 6` | Validates wider SL cap for swing |
| `bot-scanner imports findCascadeZone` | Validates cascade engine import exists |
| `bot-scanner calls findCascadeZone for swing_trader` | Validates conditional call |
| `cascade gate pass logic exists` | Validates CASCADE GATE PASSED log message |
| `cascade SL override exists` | Validates cascade SL override logic |
| `day_trader tpRatio still 2.0` | Regression: day_trader unchanged |
| `day_trader breakEvenEnabled still true` | Regression: day_trader unchanged |
| `day_trader minConfluence still 55` | Regression: day_trader unchanged |
| `cascadeZoneEngine exports findCascadeZone` | Module export validation |
| `cascadeZoneEngine returns correct state for empty candles` | Functional test |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/
ok | 1452 passed | 0 failed (19s)
```

## Regression check

1. **Day trader parameters are unchanged** — verified by 3 regression tests that check tpRatio, breakEvenEnabled, and minConfluence remain at their original values.

2. **All 1,431 pre-existing tests pass** — the 21 new tests bring the total to 1,452 with 0 failures.

3. **Cascade zone engine is additive** — it only activates for `swing_trader` style. For `scalper` and `day_trader`, the code path is identical to before (the `if (resolvedStyle === "swing_trader")` guard ensures this).

4. **Style override application is backward-compatible** — the `userProtectedFields` mechanism (line 1799) ensures that any user-explicit config values always win over style defaults. The new fields (`riskPerTrade`, `impulseSlCapMultiplier`) are added to the style overrides but NOT to `userProtectedFields`, meaning they always apply from the style (consistent with how `entryTimeframe`, `htfTimeframe` work).

## Backtest validation summary

| Style | Pairs | Period | Trades | WR | P&L | PF | Sharpe | Max DD |
|-------|-------|--------|--------|-----|------|-----|--------|--------|
| Scalper (tuned) | EUR/USD | Jan-Mar 2026 | 50 | 44% | +$806 (8.1%) | ~1.55 | — | — |
| Swing (tuned) | EUR/USD, GBP/JPY, XAU/USD | Jul 2025-Mar 2026 | 8 | 75% | +$2,825 (28.3%) | 8.88 | 12.78 | 3.0% |

**Scalper finding:** Only profitable on EUR/USD. GBP/JPY and XAU/USD have too much 5m noise (25-26% WR despite correct 2:1 R:R). Recommendation: scalper should only trade low-volatility majors.

**Swing finding:** Disabling BE was the single biggest improvement. XAU/USD went from 0 wins (10/10 trades hit BE) to 3 trades with 67% WR and $1,063 P&L.

## Open questions

1. **Scalper instrument restriction:** The scalper is only validated profitable on EUR/USD. Should we add an instrument whitelist to the scalper style override (e.g., only EUR/USD, AUD/USD, USD/CAD), or leave it to the user to configure their instrument list?

2. **Day trader BE/trailing:** The day_trader style still has BE and trailing enabled. Should we run similar backtests to validate whether disabling them improves day_trader performance too?

3. **Cascade vs Unified for day_trader:** The cascade engine currently only activates for swing_trader. Should we test it for day_trader as well (with Daily→4H→1H→15m cascade)?

## Suggested PR title and description

**Title:** `[style-tuning-port] Backtest-validated style parameters + cascade zone engine for swing`

**Description:**
Ports backtest-validated parameter tuning to the live bot-scanner:

**Scalper (EUR/USD validated: 50 trades, 44% WR, +8.1%):**
- Disable BE and trailing — 5m noise cuts winners short
- Set tpRatio to 2.0 (ATR floor gives ~20p SL → 40p TP)
- Lower riskPerTrade to 0.5% (high frequency)
- Tight impulseSlCapMultiplier (1.5)

**Swing (3 pairs validated: 8 trades, 75% WR, +28.3%, PF 8.88):**
- Disable BE, trailing, and partial TP — let trades reach 3R
- Lower minConfluence to 40 (cascade selectivity is the real filter)
- Higher riskPerTrade (1.5%) for high-conviction setups
- Wider impulseSlCapMultiplier (6) for Daily-scale impulses
- Integrate cascade zone engine (Daily→4H→1H) as primary zone gate

**Day trader:** Unchanged (regression tests verify).

21 new tests, all 1,452 tests passing.
