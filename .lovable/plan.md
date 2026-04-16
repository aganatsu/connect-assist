

# Opening Range Module — Full Implementation (UI + Scanner Logic)

## Overview
Add a complete "Opening Range" system: configurable via the Bot Config modal, stored in the database, and actively used by the bot-scanner during confluence analysis and safety gates.

## 1. Default Config — `supabase/functions/bot-config/index.ts`
Add `openingRange` to `getDefaultConfig()`:
```
openingRange: {
  enabled: false,
  candleCount: 24,
  useBias: true,
  useJudasSwing: true,
  useKeyLevels: true,
  usePremiumDiscount: false,
  waitForCompletion: true,
}
```

## 2. Scanner Logic — `supabase/functions/bot-scanner/index.ts`

### New function: `computeOpeningRange(dailyCandles, hourlyCandles, config)`
- Takes the first `config.openingRange.candleCount` hourly candles of the current trading day
- Returns `{ high, low, midpoint, completed: boolean }`

### Integration into `runFullConfluenceAnalysis` and `runScanForUser`:

**a) Daily Bias from OR** (`useBias`)
- After computing OR, if price is above OR high → bullish bias boost (+0.5 to Market Structure factor)
- If price is below OR low → bearish bias boost
- This modifies Factor 1 (Market Structure) scoring

**b) Judas Swing from OR** (`useJudasSwing`)
- Enhance Factor 6: if price swept OR high then reversed below, or swept OR low then reversed above → confirmed Judas Swing
- This gives a stronger detection than the generic 20-candle version

**c) OR Key Levels** (`useKeyLevels`)
- Add OR high, low, midpoint to the PD/PW Levels check (Factor 7)
- If price is near OR high/low/mid → +0.5 points (same logic as PDH/PDL)

**d) Premium/Discount from OR** (`usePremiumDiscount`)
- Override Factor 4's equilibrium calculation to use OR high/low instead of swing-based range
- Tighter zones for intraday decisions

**e) Wait for Completion** (`waitForCompletion`)
- New Safety Gate (Gate 11): if the current trading day has fewer than `candleCount` hourly candles elapsed, reject the trade
- Added to `runSafetyGates` function

### Data fetching
- The scanner already fetches 15m and daily candles. Will add a third fetch for 1h candles (`fetchCandles(pair, "1h", "2d")`) when `openingRange.enabled` is true
- Passed into `runFullConfluenceAnalysis` as an optional parameter

## 3. Bot Config Modal UI — `src/components/BotConfigModal.tsx`
- Add "Opening Range" tab (with `BarChart3` icon) after "Sessions"
- Master toggle: "Enable Opening Range"
- Numeric input: "Candle Count" (default 24)
- Five sub-toggles with descriptions:
  - Daily Bias from OR
  - Judas Swing Detection
  - OR Key Levels
  - Premium/Discount from OR
  - Wait for OR Completion
- Sub-toggles disabled when master toggle is off

## 4. Scanner Config Loading — `loadConfig` in bot-scanner
- Merge `openingRange` defaults when the field is missing from saved config (same pattern as `instruments`)

## Files Changed
1. `supabase/functions/bot-config/index.ts` — add defaults
2. `supabase/functions/bot-scanner/index.ts` — add `computeOpeningRange`, modify confluence scoring + safety gates, add 1h candle fetch
3. `src/components/BotConfigModal.tsx` — add Opening Range tab with toggles

## Deployment
All three files updated and edge functions redeployed.

