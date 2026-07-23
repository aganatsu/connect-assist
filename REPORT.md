# Task: Session 5 — Trade Replay Zone Overlay
## Branch: manus/trade-replay-zone-overlay
## Behavior changes
1. **Zone overlays now render with labels** — Each zone shows its type and lifecycle state (e.g., "OB bullish [active]", "FVG bearish [tested]") directly on the chart via price line titles.
2. **State-based visual styling** — Zones are styled according to their lifecycle state: active=solid full opacity, tested=dashed 70% opacity, mitigating=dotted 50% opacity, broken/filled/swept=sparse dotted 25% opacity.
3. **Range zones have midpoint fill** — OBs, FVGs, and Breakers render a faint midpoint line between high/low boundaries to give a visual "fill" effect.
4. **New overlay: BSL/SSL** — Buy-Side and Sell-Side Liquidity levels from swing points, with swept/active state distinction. Toggle via toolbar chip.
5. **New overlay: Fibonacci** — Fibonacci retracement levels from signal_reason.fibLevels rendered as labeled amber lines with axis labels. Toggle via toolbar chip.
6. **Entry-time data priority** — Zone data now sourced from `signal_reason.entityLifecycles` first (frozen at trade entry time), falling back to scan_logs `analysis_snapshot` (latest data) only when entry-time data is unavailable.
7. **S/R levels no longer rendered as fake ranges** — Previously S/R had artificial ±0.02% bands. Now rendered as single price lines with touch count labels.

## Files modified
- `src/components/TradeReplayChart.tsx` — Full rewrite: added state-based styling (getStateStyle), opacity helpers, extended ZoneOverlay type with bsl/ssl/fib and strength, range vs single-level rendering logic, midpoint fill lines, labeled zones
- `src/pages/TradeReplay.tsx` — Enhanced zone building: entry-time data sourcing from signal_reason, BSL/SSL extraction from swing points, Fibonacci levels, new overlay toggles (Fib, BSL/SSL), updated legend, overlayToggles mapping for bsl/ssl

## Tests added
None — these are frontend-only rendering changes. No backend logic was modified. The zone data sources (signal_reason, scan_logs) are unchanged.

## Tests run
```
npx tsc --noEmit → 0 errors
```

## Regression check
- No backend code was modified
- Existing zone types (OB, FVG, S/R, Liquidity, Breaker) continue to render with the same data sources, only with improved visual styling
- New overlays (Fib, BSL/SSL) are additive — they default ON but gracefully render nothing if data is unavailable
- The overlayToggles prop is backward-compatible: old toggle keys still work, new bsl/ssl keys are mapped from the parent's bslssl toggle

## Open questions
- The `signal_reason.entityLifecycles` field may not contain full zone geometry (high/low) for all trades — it depends on what the scanner stored at trade entry time. For trades where this data is sparse, the fallback to scan_logs provides latest-state zones which may differ from entry-time state.
- Should we persist `analysis_snapshot` to `paper_trade_history` at close time? This would give us a guaranteed entry-time zone snapshot for every closed trade. Currently this requires a backend change to the paper-trading function.

## Suggested PR title and description
**Title:** feat: Trade Replay zone overlays — state-based styling, BSL/SSL, Fibonacci, entry-time sourcing

**Description:**
Enhances the Trade Replay chart with rich zone overlays:

- **State-based styling**: Zones visually indicate their lifecycle (active → tested → mitigating → broken) through line style and opacity changes
- **BSL/SSL overlay**: Buy-Side and Sell-Side Liquidity levels from swing points with swept/active distinction
- **Fibonacci overlay**: Retracement levels from trade entry reasoning data
- **Entry-time priority**: Zones sourced from signal_reason (frozen at entry) first, falling back to latest scan data
- **Labels**: All zones now show descriptive titles on the chart
- **Range fill**: OB/FVG/Breaker zones render midpoint lines for visual fill effect

No backend changes — all data sources already exist.
