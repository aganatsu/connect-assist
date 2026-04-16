

# Connect All Bot Config Options to the Scanner

## Problem

The BotConfigModal saves config as nested objects (`strategy.confluenceThreshold`, `risk.maxDailyDrawdown`, etc.) but the bot-scanner reads flat keys (`minConfluence`, `maxDailyLoss`, etc.). The shallow merge in `loadConfig` never maps nested UI fields to the flat scanner keys. **Result: toggling options in the UI has zero effect on the bot.**

## Solution

Update `loadConfig` in the bot-scanner to properly extract nested UI config fields and map them to the scanner's internal field names. Also wire up the strategy toggles (useOrderBlocks, useFVG, etc.) so they actually skip those confluence factors when disabled.

## Changes

### 1. `supabase/functions/bot-scanner/index.ts` — Fix `loadConfig` mapping

Update `loadConfig` to read from the nested config structure the UI saves:

```
strategy.confluenceThreshold → minConfluence
strategy.requireHTFBias → htfBiasRequired
strategy.useOrderBlocks → (new field) enableOB
strategy.useFVG → (new field) enableFVG
strategy.useLiquiditySweep → (new field) enableLiquiditySweep
strategy.useStructureBreak → (new field) enableStructureBreak
risk.riskPerTrade → riskPerTrade
risk.maxDailyDrawdown → maxDailyLoss
risk.maxConcurrentTrades → maxOpenPositions
risk.minRR → minRiskReward
risk.maxDrawdown → maxDrawdown
entry.cooldownMinutes → cooldownMinutes
entry.closeOnReverse → closeOnReverse
exit.trailingStop → trailingStopEnabled (new)
exit.breakEven → breakEvenEnabled
exit.partialTP → partialTPEnabled (new)
exit.timeExitHours → maxHoldHours (new)
instruments.enabled → instruments (array)
sessions.filter → enabledSessions
sessions.killZoneOnly → killZoneOnly (new)
protection.maxDailyLoss → (dollar-based limit, new gate)
protection.maxConsecutiveLosses → (new gate)
protection.circuitBreakerPct → ties into maxDrawdown
tradingStyle → tradingStyle (already works)
openingRange → openingRange (already works)
```

### 2. `supabase/functions/bot-scanner/index.ts` — Wire strategy toggles into confluence scoring

In the confluence analysis function, check the `enableOB`, `enableFVG`, `enableLiquiditySweep`, `enableStructureBreak` flags. When a factor is disabled, skip scoring it (set weight to 0 / mark not present).

### 3. `supabase/functions/bot-scanner/index.ts` — Wire entry/exit options

- **Cooldown**: Before placing a trade, check last trade time vs `cooldownMinutes`
- **Close on Reverse**: When placing a new signal in opposite direction, close existing same-symbol positions
- **Kill Zone Only**: Add as safety gate — reject if session is active but not in kill zone
- **Trailing Stop / Break Even / Partial TP**: Store flags on the position so the paper-trading engine can reference them
- **Time-based Exit**: Store `maxHoldHours` on position for paper-trading to enforce

### 4. `supabase/functions/bot-scanner/index.ts` — Add protection gates

- **Max Consecutive Losses**: Query recent trade history, count consecutive losses, reject if exceeded
- **Max Daily Loss ($)**: Dollar-based limit in addition to percentage-based

### 5. Settings page cleanup (agreed earlier)

Replace the duplicate `BotConfigSettings` component in `src/pages/Settings.tsx` with a button that opens the `BotConfigModal`, eliminating the second disconnected config UI.

### Files Modified
- `supabase/functions/bot-scanner/index.ts` — Config mapping, strategy toggles, new gates, entry/exit wiring
- `src/pages/Settings.tsx` — Replace bot config tab with modal launcher

### What Does NOT Change
- The BotConfigModal UI itself (field names stay the same)
- The `bot-config` edge function (save/load stays the same)
- Database schema (no new tables)
- The 9-factor scoring formulas (just adding enable/disable per factor)

