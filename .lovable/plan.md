
User asks whether unifying the two scores (SMC + Extended ICT) into one panel on the Chart tab would be a good idea.

Short answer: **yes** — two separate scores side-by-side is confusing because:
- Users see two numbers and don't know which to trust
- The factors overlap conceptually (both are ICT/SMC)
- Decision-making is faster with one combined signal

Recommended unification:

## Plan — Unify Confluence on Chart tab

### 1. Single "Total Confluence" score
- Combine SMC (max 10) + Extended (max 10) → weighted sum normalized to **/10**
- Default weights: SMC 50% / Extended 50% (already the natural split)
- Color-coded badge: red <4, amber 4–6.5, green >6.5
- Show direction (BUY/SELL/NEUTRAL) inferred from majority factor bias

### 2. Single unified "Confluence Factors" accordion
Replace the two current accordions ("Confluence Score" + "ICT Extended Factors") with ONE grouped list:

```text
Total Confluence: 7.5 / 10  [BUY]

▸ Structure & Bias
   ✓ Trend (H4 bullish)
   ✓ Power of 3 (NY distribution up)
   ✗ Judas Swing

▸ Zones
   ✓ Order Block (bullish, 1.0823)
   ✓ FVG overlap
   ✓ Breaker Block flipped bullish
   ✓ Unicorn setup

▸ Timing
   ✓ Kill Zone (NY AM)
   ✓ Silver Bullet window
   ✗ Macro Time

▸ Price Action
   ✓ Displacement (3 candles up)
   ✓ Above VWAP
   ✗ Liquidity sweep
```

Each row keeps the ✓/✗ + detail it has today — just regrouped.

### 3. Keep "Bot Scan (live)" as a separate accordion
It's a different data source (scheduled scanner output) — leave it alone.

### 4. Files to change
- `src/pages/Chart.tsx` — collapse two accordions into one, compute unified score + grouping
- Small helper `src/lib/confluenceUnify.ts` — pure function: `(smc, extended) => { total, direction, groups[] }`
- No edge function changes, no DB changes

### Out of scope
- Configurable weights in Settings (can be follow-up)
- Bot Scan panel stays separate

### Risk
Low — pure presentation refactor, both data sources already exist on the page.
