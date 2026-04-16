

# Deep Dive: Everything the Scanner & Paper Engine Are NOT Reading Right

After auditing the full bot-scanner (1321 lines), paper-trading (535 lines), and BotConfigModal, here are all the issues found — grouped by severity.

---

## CRITICAL — Config is saved but completely ignored

### 1. Session filter uses wrong IDs
The UI saves sessions as lowercase IDs: `"asian"`, `"london"`, `"newyork"`, `"sydney"`. The scanner maps detected sessions correctly (`Asian → asian`, `London → london`, `New York → newyork`). **But Sydney is never detected.** `detectSession()` only returns `"Asian"`, `"London"`, `"New York"`, or `"Off-Hours"` — there is no Sydney session window. If a user enables only Sydney, the scanner skips every scan silently.

### 2. `enabledDays` is hardcoded, not configurable
The config always uses `enabledDays: [1,2,3,4,5]` (Mon-Fri). There is no UI to change it, but crypto trades 24/7 including weekends. If you enable only crypto instruments, the scanner still rejects Saturday/Sunday scans.

### 3. SL calculation uses hardcoded `0.0001` pip size
Lines 677 and 687 in the confluence analysis function:
```
stopLoss = nearestLow - config.slBufferPips * 0.0001;
```
This is hardcoded for standard forex. For JPY pairs (pip = 0.01), indices (pip = 1.0), gold (pip = 0.01), the SL is set **way too tight** — essentially zero buffer. The per-symbol recalculation at lines 1196-1206 fixes it *after* gates, but Gate 10 (R:R check) uses the wrong SL/TP from the analysis, so valid trades get rejected with bad R:R.

### 4. `paper-trading` is missing 13 new instrument symbols
The paper-trading function's `YAHOO_SYMBOLS` map only has 14 symbols. It's missing all 11 new forex crosses (EUR/AUD, GBP/CAD, etc.), all 3 indices (US30, NAS100, SPX500), and US Oil. So `fetchLivePrice()` returns `null` for these — positions never get price updates, current_price stays stale at entry price forever.

### 5. `paper-trading` SPECS missing new instruments
Same issue: the paper-trading SPECS table only has 14 instruments. For all new pairs, it falls back to EUR/USD specs — wrong pip size, wrong lot units. PnL calculations for indices/oil will be completely wrong.

---

## HIGH — Logic bugs that produce wrong results

### 6. Auto-style mode mutates config for ALL remaining instruments
Line 1148: `Object.assign(config, STYLE_OVERRIDES[pairStyle]);` — in auto mode, each instrument's style overrides **permanently mutate** the shared config object. So instrument #3's style leaks into instrument #4, #5, etc. The last instrument's style wins for all subsequent ones.

### 7. Session gate checks first instrument's asset profile, not each
Line 1087: `getAssetProfile(config.instruments[0])` — the session skip check before the scan loop uses only the FIRST instrument in the list. If instrument[0] is forex, crypto instruments later in the list still get session-gated. Should be checked per-instrument inside the loop.

### 8. `closeOnReverse` PnL is always "0"
Lines 1227-1228: When closing opposite positions on reverse signal, `pnl` and `pnl_pips` are hardcoded to `"0"`. The actual PnL is never calculated — balance never updates for these closes, and the trade history shows $0 profit/loss.

### 9. Trailing Stop / Break Even / Partial TP — stored but never executed
The scanner stores exit flags (`trailingStop`, `breakEven`, `partialTP`, `maxHoldHours`) inside `signal_reason` JSON on the position. But the paper-trading engine never reads these flags. There is no periodic position management loop — no code checks if price moved enough to trail the stop, move to breakeven, take partial profit, or auto-close after max hold hours.

### 10. `protection.circuitBreakerPct` is never read
The UI has an "Equity Circuit Breaker %" slider (lines 326-330). `loadConfig` never maps it. Gate 8 uses `risk.maxDrawdown` instead. The circuit breaker field is completely dead.

---

## MEDIUM — Incorrect or missing behavior

### 11. Position size capping at 1 lot max
Line 741: `Math.min(1, ...)` caps every position at 1.0 lots. For indices and commodities where lot sizes are different, this is wrong. For a $50k account trading gold, 1 lot is the right scale, but for forex that's too restrictive.

### 12. Opening Range `waitForCompletion` gate assumes 1h candles
Gate 11 compares `hoursSinceMidnight < candleCount`. With default `candleCount=24`, this means the bot can never trade before midnight the next day — effectively blocking all trades for the entire day. The logic assumes candle count = hours, which only works for 1h candles.

### 13. No SL/TP hit detection on open positions
The paper-trading engine never checks if current price has crossed stop_loss or take_profit on open positions. Positions with SL/TP set just sit there until manually closed or kill-switched. There should be a check in the `status` action (or a separate cron) that auto-closes positions when SL/TP is hit.

---

## Plan: Fix All Issues

### Files to modify

**`supabase/functions/bot-scanner/index.ts`**
- Fix #3: Use `SPECS[symbol].pipSize` instead of hardcoded `0.0001` in confluence analysis SL/TP calc
- Fix #6: Clone config per instrument in auto-mode instead of mutating shared object
- Fix #7: Move session gate check inside the per-instrument loop
- Fix #8: Calculate actual PnL for closeOnReverse positions and update balance
- Fix #10: Map `protection.circuitBreakerPct` and use it (or merge with maxDrawdown)
- Fix #1: Add Sydney session detection (21:00-06:00 UTC)
- Fix #2: Skip day-of-week check for crypto instruments
- Fix #11: Scale max lot size by asset type
- Fix #12: Fix OR wait gate to use actual candle timestamps not hour count

**`supabase/functions/paper-trading/index.ts`**
- Fix #4: Add all 17 missing symbols to YAHOO_SYMBOLS
- Fix #5: Add all missing instruments to SPECS
- Fix #9: Add SL/TP hit detection + trailing stop / break even / max hold hours logic in the `status` action
- Fix #13: Auto-close positions when current price crosses SL or TP

### What does NOT change
- The BotConfigModal UI (all fields are correct)
- The bot-config edge function
- Database schema
- The 9-factor scoring formulas (only fixing the SL buffer used within them)

