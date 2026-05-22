## Problem

BOS and CHoCH currently draw as **full-width horizontal lines** spanning the entire chart, because `SMCChart.tsx` renders them with lightweight-charts' `priceLine` API (`addLine({ price: b.level, ... })`). Price lines always extend across the full visible range — they're meant for things like SL/TP, not structural breaks.

## Fix

Replace the BOS/CHoCH price lines with **short horizontal segments** anchored between the broken swing and the break candle, the way every SMC charting tool draws them.

Implementation in `src/components/SMCChart.tsx` only:

1. Remove the `addLine({...})` calls inside the BOS and CHoCH blocks (lines ~700–726). Keep the markers (arrows / circles at the break candle) untouched.
2. For each `bosLevels[i]` / `chochLevels[i]`:
   - **End point**: `chartData[b.index].time` at `b.level`.
   - **Start point**: walk `overlays.swingPoints` backwards for the nearest swing whose `price` ≈ `b.level` (tolerance: `0.05%` of price, or pip-aware) and `index < b.index`. If none found, fall back to `max(0, b.index - 20)`.
   - Create a tiny `addLineSeries({ color, lineWidth, lineStyle, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })` and `setData([{ time: startTime, value: b.level }, { time: endTime, value: b.level }])`.
3. Track these series in a ref (e.g. `structureLineSeriesRef.current: ISeriesApi<'Line'>[]`) and remove them at the top of the effect (same pattern as `priceLinesRef`) so they don't leak across re-renders.
4. Style:
   - BOS: dashed, `COLORS.bos`, width 1.
   - CHoCH: solid, `COLORS.choch`, width 2.
   - Add a small text label via a marker at the start point ("BOS" / "CHoCH ▲▼") — optional, since markers already exist at the break candle.

## Out of scope

- No changes to bot logic, scanner, or analysis. Pure visualization fix.
- No changes to BOS/CHoCH detection or to the data passed in.
- TradeReplayChart / Backtest use the same component and will benefit automatically.

## Validation

1. Open `/chart`, toggle BOS off then on. The horizontal lines should now be short segments from the broken swing to the break candle, not chart-wide rails.
2. Markers (arrows for BOS, circles for CHoCH) still appear at the break candle.
3. SL/TP/entry trade lines still draw full-width (they should — those are correctly using `priceLine`).
