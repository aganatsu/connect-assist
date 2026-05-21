# Task: SMCChart Enhancements
## Branch: manus/smcchart-enhancements
## Behavior changes
1. Chart now loads 500 candles instead of 200 — users see more price history on initial load
2. BOS (Break of Structure) levels rendered as dashed sky-blue price lines at the broken swing level, with arrow markers at the break candle
3. CHoCH (Change of Character) levels rendered as solid orange price lines at the broken swing level, with circle markers at the break candle
4. Displacement candles highlighted with colored arrow markers (green for bullish, red for bearish) at the candle index
5. Judas Swing detection shown as an amber square marker on the most recent candle when detected (with checkmark suffix if confirmed)
6. Session background shading: Asian (indigo), London (green), New York (red) — uses NY-local time via Intl API for DST-aware accuracy
7. Kill Zone shading: London KZ 02:00-05:00 NY, New York KZ 08:30-12:00 NY — pink background bands
8. R:R ratio now displayed directly on TP/SL price line labels (e.g., "TP (2.5R)", "SL (0.00150)")
9. OHLC crosshair tooltip displayed at top-left of chart showing Open/High/Low/Close at cursor position
10. Five new toggleable overlay layers in the HUD: BOS, DISP, JDS, SES, KZ (sessions and kill zones default OFF to keep chart clean)

## Files modified
- `src/components/SMCChart.tsx` — Major enhancement: added BOS/CHoCH price lines + markers, displacement markers, Judas marker, session/KZ canvas overlay, OHLC tooltip, R:R on trade lines, marker deduplication
- `src/components/ChartOverlayHUD.tsx` — Added 5 new overlay layer toggles (bos, disp, judas, sessions, killZones) with colors and tooltips
- `src/pages/Chart.tsx` — Extended overlay mapping to pass bosLevels, chochLevels, displacementCandles, judasSwing from analysis; increased candle limit 200→500; extended layerDetails tooltips
- `src/lib/useChartAnalysis.ts` — Increased candle limit 200→500

## Tests added
- TypeScript compilation check (tsc --noEmit): passes with 0 errors
- Vite production build: passes (2556 modules transformed, built in 11.76s)

## Tests run
```
$ npx tsc --noEmit --skipLibCheck
(no output — 0 errors)

$ npx vite build
✓ 2556 modules transformed.
✓ built in 11.76s
```

## Regression check
- All existing overlay layers (IZ, OB, FVG, BRK, SP, LIQ, FIB, HTF, TRADE, S, R) remain unchanged in rendering logic
- The `SMCOverlays` interface is backward-compatible (all new fields are optional)
- The `OverlayLayer` union type is extended (not modified) — existing consumers unaffected
- `ChartOverlayHUD` `DEFAULT_VISIBILITY` keeps all original layers as `true`; new layers (sessions, killZones) default to `false` to avoid visual noise
- Marker pipeline now merges all marker sources (swing points + BOS + CHoCH + displacement + Judas) with deduplication, replacing the previous single-source `setMarkers` call — this is safe because the previous swing-point-only markers are still included

## Open questions
1. **Session/KZ timing accuracy**: The canvas overlay uses NY-local time via `Intl.DateTimeFormat` which is DST-aware. However, for intraday timeframes (5min, 15min, 1H), each candle maps to a single session. For daily candles, the session shading is less meaningful — should we auto-hide session/KZ layers when timeframe is Daily or Weekly?
2. **Judas Swing placement**: Currently placed on the last candle since it's a "live" detection about the current session. If the user wants it placed on the actual sweep candle, we'd need the sweep candle index from the backend (not currently returned by `detectJudasSwing`).
3. **Marker density**: With BOS + CHoCH + displacement + swing points all enabled, the chart can get visually dense on 500 candles. The current approach limits BOS to last 10 and CHoCH to last 6 — user may want to adjust these limits.

## Suggested PR title and description
**Title:** feat(chart): SMCChart enhancements — BOS/CHoCH, displacement, Judas, sessions, kill zones, R:R visual, 500 candles

**Description:**
Enhances the programmable SMCChart component with the full set of overlays the bot internally uses:

- **More data**: 500 candles loaded (was 200)
- **Structure breaks**: BOS (dashed sky lines + arrow markers) and CHoCH (solid orange lines + circle markers) plotted at the broken swing level
- **Displacement**: Strong momentum candles highlighted with colored arrows
- **Judas Swing**: False-break-and-reversal detection shown as amber square marker
- **Sessions**: Asian/London/NY background color bands (canvas overlay, DST-aware)
- **Kill Zones**: London 02-05 / NY 08:30-12 highlighted in pink
- **R:R visual**: TP/SL lines now show risk-to-reward ratio in their labels
- **OHLC tooltip**: Crosshair shows precise OHLC values
- **5 new toggles**: BOS, DISP, JDS, SES, KZ in the overlay HUD

All new layers are toggleable. Sessions and Kill Zones default OFF to keep the chart clean on first load.

No backend changes. No changes to protected files. Pure frontend enhancement.
