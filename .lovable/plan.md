

# Implement Full SL/TP Method System — Fully Functional

Yes, this will be **fully functional backend logic**, not just UI. The changes go into the `bot-scanner` edge function where trades are actually calculated and executed.

## What Changes

### 1. Backend: `supabase/functions/bot-scanner/index.ts`

**ATR calculation function** — standalone `calculateATR(candles, period)` extracted for reuse.

**Config loading** — `loadConfig()` updated to read all exit method fields:
- `slMethod` (fixed_pips | atr_based | structure | below_ob)
- `fixedSLPips`, `slATRMultiple`, `slATRPeriod`
- `tpMethod` (fixed_pips | rr_ratio | next_level | atr_multiple)  
- `fixedTPPips`, `tpRRRatio`, `tpATRMultiple`

**`calculateSLTP()` function** — replaces the current hardcoded structure-only block (lines 680-708) with a proper dispatch:

| SL Method | Calculation | Fallback |
|-----------|------------|----------|
| fixed_pips | entry ± fixedSLPips × pipSize | — |
| atr_based | entry ± ATR × slATRMultiple | fixed_pips |
| structure | nearest swing ± buffer (current logic) | fixed_pips |
| below_ob | nearest OB edge ± buffer | fixed_pips |

| TP Method | Calculation | Fallback |
|-----------|------------|----------|
| fixed_pips | entry ± fixedTPPips × pipSize | — |
| rr_ratio | entry ± slDistance × tpRRRatio | — |
| next_level | nearest PDH/PDL/PWH/PWL/liquidity pool | fixed_pips |
| atr_multiple | entry ± ATR × tpATRMultiple | rr_ratio |

All methods pass through the existing R:R validation gate before trade execution.

### 2. Frontend: `src/components/BotConfigModal.tsx`

Update the Entry/Exit tab with:
- **SL Method** dropdown (4 options) with conditional parameter fields
- **TP Method** dropdown (4 options) with conditional parameter fields
- Fields shown/hidden based on selected method (e.g., ATR Multiple only visible when ATR method selected)

### 3. Config Edge Function: `supabase/functions/bot-config/index.ts`

Ensure defaults include all new SL/TP fields so existing users get sensible fallbacks.

## Files Changed
- `supabase/functions/bot-scanner/index.ts` — ATR calc, config wiring, full `calculateSLTP()` dispatch
- `supabase/functions/bot-config/index.ts` — default config fields for SL/TP methods
- `src/components/BotConfigModal.tsx` — SL/TP method selectors and conditional fields

## What Won't Change
- Database schema (config is stored as JSON in `bot_configs.config_json` — no migration needed)
- Position sizing logic (already correct, uses SL distance)
- Safety gates and confluence scoring (untouched)

