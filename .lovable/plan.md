## Problem

The floating HUD on `/chart` has 12 toggle chips, but several don't visibly do anything — most obviously **SES** (sessions) and **KZ** (kill zones).

Root cause: the HUD lives in `src/pages/Chart.tsx` and only controls which data is passed into `<SMCChart overlays={...} />` (by zero‑ing the relevant arrays). That works for data‑driven layers (OB, FVG, SP, LIQ, FIB, S/R, BOS, DISP, JDS, IZ).

But `SMCChart` has its own internal `visibleLayers` state, and the **sessions** and **killZones** layers are drawn purely from time (no input data to filter). They're added to the default set unconditionally:

```ts
// SMCChart.tsx
const [visibleLayers, setVisibleLayers] = useState<Set<OverlayLayer>>(
  new Set(defaultLayers ?? allLayers)
);
…
if (!visibleLayers.has("sessions") && !visibleLayers.has("killZones")) return;
```

Since Chart.tsx hides the SMCChart toolbar (`hideToolbar`), the user has no way to turn them off, and the HUD chip can't reach that internal state.

A secondary issue: clicking IZ/FIB/S/R toggles re‑filters the data, but other internal layers (e.g. anything SMCChart decides to keep on by default) are still influenced only by SMCChart's own state, not the HUD. Today every layer Chart.tsx cares about happens to be data‑gated, so that works — but it's fragile.

## Fix

Make HUD the single source of truth by letting Chart.tsx control SMCChart's visible layers directly.

### `src/components/SMCChart.tsx`
- Add an optional controlled prop: `visibleLayers?: Set<OverlayLayer>`.
- If provided, use it instead of the internal `useState` (skip `setVisibleLayers` updates — toolbar toggles become no‑ops in controlled mode, which is fine because we already hide the toolbar from Chart.tsx).
- Leave existing uncontrolled behavior intact for other call sites (e.g. `TradeReplayChart`, `Backtest`).

### `src/pages/Chart.tsx`
- Build a `Set<OverlayLayer>` from `overlayVisibility`, mapping HUD keys → SMCChart layer ids:
  - `iz → impulseZone`, `ob → orderBlocks`, `fvg → fvgs`, `sp → swingPoints`,
    `liq → liquidity`, `fib → fibs`, `sr → support` + `resistance`,
    `bos → bosChoch`, `disp → displacement`, `judas → judasSwing`,
    `sessions → sessions`, `killZones → killZones`.
  - Always include `htfPOIs` and `trades` (no HUD chip for them today; keep current behavior).
- Pass this as `<SMCChart visibleLayers={…} />`.
- Drop the now‑redundant `overlayVisibility.*` gates inside `chartOverlays` (or keep them — they're a harmless extra filter). Keep the `fib`/`sr` compute gates as a perf optimization.

### `src/components/ChartOverlayHUD.tsx`
- Flip `DEFAULT_VISIBILITY.sessions` and `DEFAULT_VISIBILITY.killZones` to `true` so the initial state matches what was actually rendering before.

## Out of scope

- No bot logic, no backend, no SMCChart drawing changes.
- Not adding HUD chips for `htfPOIs` / `trades` (they have no chip today).
- Not touching `TradeReplayChart` / `Backtest` usage of `SMCChart` — they stay uncontrolled.

## Validation

1. Open `/chart`. All 12 chips should visibly toggle their layer on/off:
   - SES → session boxes appear/disappear
   - KZ → kill zone shading appears/disappears
   - IZ/OB/FVG/SP/LIQ/FIB/S/R/BOS/DISP/JDS → existing behavior preserved
2. Confluence pill and tooltips unchanged.
3. `/replay` and `/backtest` charts still render with their own toolbar working (uncontrolled mode).
