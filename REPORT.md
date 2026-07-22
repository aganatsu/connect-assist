# Task: Rebuild ICT Analysis Page to Use Full Bot-Scanner Data
## Branch: manus/ict-page-rebuild
## Behavior changes
1. ICT Analysis page no longer calls `smcApi.fullAnalysis()` or fetches raw candles for its own analysis. It now reads from `scan_logs` (same data source as BotView's scan panel).
2. Instrument sidebar now shows per-pair direction arrow and score from the latest scan.
3. Page displays 13 new/enhanced sections that were previously unavailable: Direction Verdict, Regime Detection, Zone Story, Tiered Scoring, Structure Intelligence, Entity Lifecycles, Confluence Stacking, Sweep & Reclaim, Pullback Health, Setup Classification, Fibonacci Levels, Gates, and enhanced Currency Strength (from scanner meta).
4. Removed: Correlation Matrix section (was a standalone computation unrelated to scanner data; can be re-added later if needed).
5. Removed: Premium/Discount visual zone (now covered by Zone Story panel which shows the full trade narrative).
6. Removed: PD/PW Levels section (data is available in scanner's chartOverlays for Session 3 chart overlays).

## Files modified
- `src/pages/IctAnalysis.tsx` — Complete rewrite (339 lines removed, 632 lines added). Now uses `scannerApi.logs()` as sole data source, reuses existing components (TierFactorBreakdown, TierScoreSummary, ZoneStoryPanel, generateDetailNarrative).

## Tests added
None (pure frontend display page with no business logic to unit-test; all data comes from scanner which has its own tests).

## Tests run
TypeScript check: `npx tsc --noEmit` → Exit code 0, zero errors.

## Regression check
- This is a display-only page with no effect on trading behavior. It reads scan_logs (read-only) and renders data.
- No backend files modified.
- No scoring, gates, or trade execution logic touched.

## Open questions
1. The Correlation Matrix was removed — should it be re-added as a separate section? It required fetching 60 days of daily candles for 7 pairs independently of the scanner.
2. The page currently shows "No scanner data for X. Run a scan from the Bot tab." if no scan_logs exist. Should we add a "Run Scan" button directly on this page?
3. Session 3 (Chart Overlays) will use `d.chartOverlays` data that's already available in the scanner detail — the ICT page is now perfectly positioned to receive chart overlay rendering.

## Suggested PR title and description
**Title:** feat: rebuild ICT Analysis page to use full bot-scanner data

**Description:**
Completely rewrites the ICT Analysis page to consume `scan_logs` (the same data source as BotView's scan panel) instead of running its own duplicate analysis from raw candles.

**What's new:**
- Direction Verdict with confidence/agreement/blocking
- Regime Detection (Daily + 4H with transitions)
- Zone Story (reuses ZoneStoryPanel)
- Full Tiered Scoring + Factor Breakdown
- Structure Intelligence (BOS/CHoCH, S2F, derived S/R)
- Entity Lifecycles dashboard (OBs, FVGs, Swing Points, Liquidity, Breakers, Unicorns)
- Confluence Stacking zones
- Sweep & Reclaim events
- Pullback Health / Decay
- Setup Classification + Style suggestion
- Fibonacci Levels
- Gates pass/fail
- Enhanced sidebar with direction arrows + scores

**Removed:** Correlation Matrix, standalone Premium/Discount visual, PD/PW levels (data available for chart overlays in Session 3).

**Technical:** Zero new API calls — all data comes from existing scanner output. Reuses TierFactorBreakdown, TierScoreSummary, ZoneStoryPanel, and generateDetailNarrative components.
