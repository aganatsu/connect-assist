## Why no scans show up

Cron is firing `bot-scanner` every 5 minutes and succeeds at the HTTP layer, but the actual scan crashes inside the function with:

```
ERROR [scan] background error for <user>: liqTolBase is not defined
    at runScanForUser (bot-scanner/index.ts:3970:72)  ← reported by Deno; root cause at line 3356/3368
```

So no scan rows get written, the UI shows "no scans", and trades never get placed.

## Root cause

In `supabase/functions/bot-scanner/index.ts` (HTF Phase 2 block, lines ~3320–3370):

- `liqTolBase` and `liqMinTouches` are declared with `const` **inside** `if (dailyCandles.length >= 10) { … }` (lines 3341–3343).
- They are then referenced **outside** that block, inside the separate `if (h4Candles.length >= 20)` block (line 3356) and `if (hourlyCandles.length >= 20)` block (line 3368).
- `const` is block-scoped, so those references throw `ReferenceError: liqTolBase is not defined`, killing the whole scan.

## Fix

Hoist the two consts to the outer scope (just above the daily `if`) so all three timeframe blocks can see them:

```ts
const liqSens = pairConfig.equalHighsLowsSensitivity ?? 3;
const liqTolBase = [0.10, 0.15, 0.20, 0.25, 0.30][Math.min(Math.max(liqSens, 1), 5) - 1];
const liqMinTouches = pairConfig.liquidityPoolMinTouches ?? 2;

if (dailyCandles.length >= 10) { … uses liqTolBase, liqMinTouches … }
if (h4Candles.length >= 20)    { … uses liqTolBase, liqMinTouches … }
if (hourlyCandles.length >= 20){ … uses liqTolBase, liqMinTouches … }
```

Remove the inner duplicate declarations from the daily block.

No business-logic change — same values, just correct scope.

## Validation

1. Redeploy `bot-scanner` (auto on save, plus an explicit redeploy to be sure).
2. Trigger a manual scan from the Bot page (or wait for the next 5-min cron).
3. Check edge function logs — the `liqTolBase` ReferenceError should be gone.
4. Confirm a new row appears in `scan_logs` with `pairs_scanned > 0`.
5. UI on `/bot` should show the new "Latest Scan" timestamp updating.

## Out of scope

- The `Broker equity fetch failed … invalid peer certificate` warning from MetaApi is separate (and non-fatal — code already falls back to paper). Not touching that here unless you want me to.
- No trading-bot logic changes; this is purely a scope/declaration bug fix.
