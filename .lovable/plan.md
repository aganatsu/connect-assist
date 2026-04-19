
This is a thorough audit. The user already approved fixes for the P0 items in a prior turn (regime scoring + useVolumeProfile/useTrendDirection/useDailyBias toggles), so those should already be live. I'll focus the plan on the remaining **P1 (real quality wins)** and offer P2 as opt-in.

## Plan: Wire P1 OB/FVG/Structure/Liquidity Tuning Into Scanner

These five config fields exist in the UI (Strategy tab) and DB but the scanner hardcodes the values. After this fix, changing them in the UI actually changes scoring behavior.

### Changes to `supabase/functions/bot-scanner/index.ts`

**1. `loadConfig()` — map missing strategy fields to flat config**
Add these mappings from `strategy.*`:
- `obLookbackCandles` (default 50)
- `fvgMinSizePips` (default 0 = off)
- `fvgOnlyUnfilled` (default true)
- `structureLookback` (default 50)
- `liquidityPoolMinTouches` (default 2)

**2. Order Block recency (~line 864)**
Replace hardcoded `OB_RECENCY = 50` with `config.obLookbackCandles ?? 50`.

**3. FVG minimum size filter (~line 1452, FVG scoring)**
Before scoring an FVG, compute its size in pips and skip if `< config.fvgMinSizePips`.

**4. FVG unfilled filter (~line 1452)**
If `config.fvgOnlyUnfilled !== false`, skip FVGs flagged as mitigated.

**5. Structure lookback (~`analyzeMarketStructure` call site)**
Slice candles to last `config.structureLookback ?? 50` before passing in.

**6. Liquidity pool min touches (~`detectLiquidityPools`)**
Replace hardcoded `count >= 2` with `count >= (config.liquidityPoolMinTouches ?? 2)`.

### Verification
Deploy `bot-scanner`, run a manual scan, then change `fvgMinSizePips` from 0 → 20 and re-scan. FVG factor scores should drop noticeably for pairs with small gaps.

### Out of scope for this plan
- P2 items (fixed lot sizing, ATR filter, correlation filter, EoS close, profit-target halt) — large surface area, propose separately if wanted.
- "Medium" tuning items I judged low-value (obMinBodyWickRatio, chochAsReversal, zoneMethod alternatives) — current scanner behavior is already the sensible default, wiring them adds knobs without clear user value. Leave as-is unless you want them.
