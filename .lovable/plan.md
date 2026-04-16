

# Fix: Strategy toggles ignored by bot scanner

## Problem
The Bot Configuration UI has 5 strategy toggles:
1. Order Blocks
2. Fair Value Gaps
3. Liquidity Sweeps
4. Structure Breaks (BOS/CHoCH)
5. Require HTF Bias Alignment

These are saved to `bot_configs.config_json.strategy` but the `bot-scanner` edge function never reads them. All 9 confluence factors are always scored, and HTF bias gate is always enforced, regardless of toggle state.

## Fix

**File: `supabase/functions/bot-scanner/index.ts`**

1. In `loadConfig`, read the strategy toggles from `config_json.strategy`:
   - `useOrderBlocks` (default true)
   - `useFVG` (default true)
   - `useLiquiditySweep` (default true)
   - `useStructureBreak` (default true)
   - `requireHTFBias` (default true)

2. In the confluence scoring function, skip (score = 0) for disabled factors:
   - If `useOrderBlocks` is false → skip Order Block factor (2.0 pts)
   - If `useFVG` is false → skip FVG factor (1.5 pts)
   - If `useLiquiditySweep` is false → skip Liquidity Sweep factor (0.5 pts)
   - If `useStructureBreak` is false → skip Market Structure factor (2.0 pts)

3. In the safety gates, make HTF Bias gate conditional:
   - If `requireHTFBias` is false → skip gate #1 (HTF bias alignment check)

4. Adjust the max possible score dynamically so the threshold still makes sense when factors are disabled.

5. Redeploy the `bot-scanner` edge function.

## Technical detail
- No database changes needed — config is already stored correctly
- No UI changes needed — toggles already save properly
- Only the scanner's scoring and gating logic needs to respect the flags

