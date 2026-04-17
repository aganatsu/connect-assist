
## Plan

### Phase 1 — Port single-pair factors into `smc-analysis`
Add to the existing `runFullAnalysis` function (NO change to bot-scanner):
- **Displacement detection** (large-body candle vs avg, returns count + last direction)
- **Breaker blocks** (mitigated OBs that flipped polarity)
- **Unicorn setups** (breaker + overlapping FVG)
- **Silver Bullet windows** (10-11 NY am, 2-3 NY pm — time-based)
- **Macro times** (xx:50–xx:10 windows, 09:50, 10:50, 11:50 NY)
- **VWAP** (session anchored — daily reset, computed from candles)
- **Power of 3 / AMD** (Asian range → London manipulation → NY distribution — daily structure check)

Skip: **SMT divergence** (needs cross-pair data the chart doesn't fetch).

Update return: add `extendedFactors: { displacement, breakers, unicorns, silverBullet, macroTime, vwap, powerOf3 }` and recompute a 2nd score `extendedConfluenceScore` using the same weighting as the bot-scanner audit doc, capped at 10.

### Phase 2 — Update Chart panel
Replace the thin "Confluence Score" accordion with a richer breakdown:
- Show both scores side-by-side: **SMC Score** (existing) + **Extended Score** (new factors)
- New accordion section "ICT Extended Factors" listing each new factor with ✓/✗ + detail
- Kill zone, session badge already exist — no dup

### Phase 3 — Add "Bot Scan (live)" accordion
- Query `scan_logs` (latest row), find `details_json` entry where `pair === selectedSymbol`
- Reuse the existing `ScanDetailInline` component pattern (or inline a slim version)
- Show "No recent bot scan for this symbol" empty state
- Auto-refresh every 30s

### Phase 4 — Deploy `smc-analysis`, verify in browser

### Out of scope
- bot-scanner unchanged
- SMT divergence skipped (multi-pair)
- No DB schema changes
