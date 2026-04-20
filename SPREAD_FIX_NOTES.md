# Spread Fix Notes (Commit 2)

## Current State

### Spread Filter
- Single `maxSpreadPips` (default 3) for ALL instruments
- OANDA: spread check at line 2819-2861
- MetaApi: spread check at line 2988-2993
- Two separate code paths doing the same thing

### SL/TP Adjustment (MetaApi only, line 2995-3009)
- SL widened by halfSpread ✓
- TP NOT adjusted at all ✗ (comment says "tighten TP" but code doesn't do it)

### R:R Gating (line 1963-1974)
- Uses raw SL/TP distances without spread cost
- `rr = reward / risk` — doesn't subtract spread from reward

## Fixes Needed

### Fix 1: Per-instrument spread limits
- Add `maxSpread` to SPECS per instrument with sensible defaults:
  - EUR/USD, USD/JPY: 2 pips (tight majors)
  - GBP/USD, AUD/USD, NZD/USD, USD/CAD, USD/CHF: 3 pips
  - Crosses (EUR/GBP, EUR/JPY, etc.): 4 pips
  - GBP/JPY, GBP/NZD, GBP/AUD: 5 pips (volatile crosses)
  - XAU/USD: 5 pips (gold)
  - XAG/USD: 4 pips
  - US Oil: 5 pips
  - US30: 3 points
  - NAS100, SPX500: 2 points
  - BTC/USD: 50 pips
  - ETH/USD: 3 pips
- Config `maxSpreadPips` becomes the global override (0 = use per-instrument defaults)
- Per-instrument override in instrumentOverrides

### Fix 2: TP spread adjustment
- For long: TP should be widened by halfSpread (exit at bid, TP needs to be higher)
  Actually no — for long, TP is hit when ask reaches TP, but you exit at bid.
  So effective TP is TP - spread. To compensate: widen TP by halfSpread.
  brokerTP = tp + halfSpread (long)
  brokerTP = tp - halfSpread (short)

### Fix 3: Spread cost in R:R
- At Gate 10: subtract spread from reward before computing R:R
- Need to estimate spread at gate time (before broker execution)
- Use a default spread estimate from SPECS (new field: `typicalSpread`)
- effectiveReward = reward - (typicalSpread * pipSize)
- effectiveRR = effectiveReward / risk
