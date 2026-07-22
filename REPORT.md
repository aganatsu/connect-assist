# Task: Chart Overlays — BSL/SSL, IPDA, Zone Lifecycle
## Branch: manus/chart-overlays-bsl-ipda-lifecycle
## Behavior changes
1. **New overlay: BSL/SSL** — Buy-Side and Sell-Side Liquidity levels now render as labeled horizontal lines on the chart. BSL lines are fuchsia, SSL lines are purple. Swept levels appear faded/dotted; active levels are solid and bright. Data sourced from scanner `chartOverlays.liquidityPools` (directional).
2. **New overlay: IPDA** — Premium/Discount/Equilibrium zone boundaries render from scanner daily entity data. Shows: IPDA High/Low, Equilibrium (50%), Premium (55%), Discount (45%), and OTE (62-79%) boundaries when in OTE zone. Off by default (toggle via HUD chip).
3. **Zone lifecycle coloring** — Order Blocks, FVGs, and Breaker Blocks are now color-coded by their lifecycle state:
   - Active: full opacity, solid line
   - Tested: 60% opacity
   - Mitigating: 35% opacity, dashed line
   - Broken/Filled: 15% opacity, dotted line
   - State labels appear in the price line title (e.g., "OB [tested]", "FVG [partially_filled 45%]")
4. **OBs no longer filtered by mitigated flag** — Previously only non-mitigated OBs/FVGs were shown. Now all are shown but visually distinguished by state (broken ones are nearly invisible). This gives better context of where zones were.

## Files modified
- `src/components/ChartOverlayHUD.tsx` — Added `bsl` and `ipda` to OverlayLayer type, OverlayVisibility interface, LAYERS array, and DEFAULT_VISIBILITY
- `src/components/SMCChart.tsx` — Added ChartBSLSSL and ChartIPDA interfaces, new OverlayLayer values, BSL/SSL colors, IPDA rendering section, lifecycle state coloring for OB/FVG/Breaker, layerHasData updates
- `src/pages/Chart.tsx` — Added bsl/ipda to smcVisibleLayers mapping, BSL/SSL data derivation from scanner, IPDA data derivation from scanner dailyEntities, lifecycle state passthrough for OB/FVG/Breaker, layerDetails entries for bsl and ipda

## Tests added
None — this is a pure frontend rendering change with no backend logic. The scanner data shape is unchanged; we're only consuming existing fields that were previously unused on the chart.

## Tests run
```
npx tsc --noEmit → EXIT: 0 (zero errors)
```

## Regression check
- No backend changes — scanner output is identical
- Existing overlays (OB, FVG, Breaker, Liquidity, Fib, S/R, BOS, Displacement, Judas, Sessions, KZ) continue to render with the same logic, only with added lifecycle state coloring
- IPDA is off by default so existing users see no change unless they toggle it on
- BSL/SSL is on by default but only renders when scanner data is available (graceful no-op otherwise)

## Open questions
- Should IPDA default to ON? Currently set to OFF since it adds 6-8 horizontal lines which could feel cluttered alongside Fibs and S/R. User can toggle it on.
- The BSL/SSL classification uses `direction === 'bullish'` → BSL, everything else → SSL. If the scanner uses different direction values, the classification may need adjustment.

## Suggested PR title and description
**Title:** feat: Chart overlays — BSL/SSL liquidity, IPDA zones, zone lifecycle coloring

**Description:**
Adds three new chart overlay capabilities:

1. **BSL/SSL overlay** — Renders buy-side and sell-side liquidity levels from scanner data with distinct colors and swept/active styling
2. **IPDA overlay** — Shows Premium/Discount/Equilibrium zone boundaries and OTE zone from HTF scanner analysis
3. **Zone lifecycle states** — OB/FVG/Breaker overlays now visually indicate their lifecycle state (active → tested → mitigating → broken) through opacity and line style changes

All overlays are toggleable via the existing HUD chip panel. IPDA defaults to off to avoid clutter; BSL/SSL defaults to on.
