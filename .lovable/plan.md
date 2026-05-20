# Remove duplicate chart overlay legend

## Problem
On `/chart` two overlay legends render:
1. The new floating `ChartOverlayHUD` (IZ/OB/FVG/SP/LIQ/FIB/S/R + confluence pill) — intended.
2. `SMCChart`'s built-in toolbar (IZ/OB/FVG/BRK/SP/LIQ/FIB/HTF/TRADE/S/R from `LAYER_DEFS`) — leftover, visible behind the new HUD.

## Fix
`SMCChart` already supports a `hideToolbar` prop. Pass it from `Chart.tsx`.

### Edit: `src/pages/Chart.tsx` (line ~230)
```tsx
<SMCChart
  candles={(candles as any[]) ?? []}
  symbol={selectedSymbol}
  overlays={chartOverlays}
  loading={!candles}
  hideToolbar          // ← add this
/>
```

That's the only change. The new HUD remains the single source of truth for layer toggles, and the chips it drives already gate `chartOverlays` (via `overlayVisibility`), so the chart still respects toggles correctly.

## Out of scope
- No changes to `SMCChart` internals, overlay drawing, or analysis logic.
- Other pages that mount `SMCChart` without `hideToolbar` (e.g. `TradeReplay`) keep their existing toolbar.

## Verify
- `/chart` shows only the floating HUD; no second row of chips behind it.
- Toggling IZ/OB/FVG/SP/LIQ/FIB/S/R from the HUD still hides/shows the corresponding overlays on the chart.
- No console errors.
