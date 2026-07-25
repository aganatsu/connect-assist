# Task: Add crypto/metals/energy correlation groups + min-lot floor budget guard
## Branch: manus/sizing-correlation-minlot
## Behavior changes
1. **New correlation groups recognized:** XAU/USD + XAG/USD (METALS), BTC/USD + ETH/USD (CRYPTO_MAJORS), US30 + NAS100 + SPX500 (RISK_ON_EQUITY), XAU/USD + US Oil (USD_HAVENS). Previously, trades in these pairs had zero correlation coverage — the system would happily open max-size positions in both XAU/USD and XAG/USD simultaneously. Now they are treated as correlated and subject to the `maxCorrelatedExposure` cap.
2. **Min-lot floor no longer silently exceeds hard budget caps.** Previously, if portfolio heat, correlation, or prop-firm daily loss caps reduced the position to below 0.01 lots, the system would floor it to 0.01 lots regardless — potentially risking more USD than the cap allowed. Now, if 0.01 lots would breach the tightest applicable cap, the trade is **rejected** with a clear reason instead of being taken at over-budget size.

## Files modified
- `supabase/functions/_shared/unifiedPositionSizing.ts` — Added 4 new correlation groups (METALS, CRYPTO_MAJORS, RISK_ON_EQUITY, USD_HAVENS). Added `hardCapUSD` tracking through portfolio heat, correlation, and prop-firm cap steps. Modified Step 6 (min-lot floor) to check whether 0.01 lots would exceed the tightest hard cap, and reject if so.
- `supabase/functions/_shared/unifiedPositionSizing.test.ts` — Added 7 new tests covering new correlation groups and min-lot floor budget guard.

## Tests added
1. `areCorrelated: XAU/USD and XAG/USD are in METALS group` — verifies correlation adjustment triggers for metals pairs
2. `areCorrelated: BTC/USD and ETH/USD are in CRYPTO_MAJORS group` — verifies rejection when crypto correlated exposure exceeds cap
3. `areCorrelated: US30 and NAS100 are in RISK_ON_EQUITY group` — verifies rejection for equity index correlation
4. `areCorrelated: XAU/USD not correlated with BTC/USD (different groups)` — verifies no false positives across unrelated groups
5. `min-lot floor rejects when 0.01 lots would exceed portfolio heat budget` — XAU/USD with $10 remaining heat, 0.01 lots would risk $100 → rejected
6. `min-lot floor rejects when 0.01 lots would exceed prop-firm daily loss budget` — XAU/USD with $5 daily loss remaining, 0.01 lots would risk $50 → rejected
7. `min-lot floor allows when 0.01 lots is within budget (EUR/USD + heat)` — confirms normal heat reduction still works without false rejection

## Tests run
```
ok | 28 passed | 0 failed (14ms)  [unifiedPositionSizing.test.ts only]
ok | 1918 passed | 6 failed (19s) [full suite — 6 failures are pre-existing on main (BE trailing tests)]
```

## Regression check
- All 21 existing position sizing tests pass unchanged — the new code only adds behavior for previously-uncovered asset classes and for the edge case where min-lot would breach a cap.
- Existing forex pairs (EUR/USD, GBP/USD, etc.) continue to be correlated exactly as before — the new groups only add coverage for crypto/metals/energy/indices.
- The `hardCapUSD` variable starts at `Infinity` and is only set when a cap actually reduces the position. If no cap fires, behavior is identical to before (min-lot floor applies unconditionally).

## Open questions
- The `USD_HAVENS` group links XAU/USD and US Oil. This is a loose correlation (both react to USD strength/risk sentiment). If you want tighter grouping, we could remove this or make it a separate "soft correlation" tier with a different cap.
- `SPX500` is in the RISK_ON_EQUITY group but doesn't appear in the SPECS table in smcAnalysis.ts. If the bot ever trades SPX500, it will fall back to EUR/USD specs for sizing. Consider adding it to SPECS if it's a tradeable instrument.

## Suggested PR title and description
**Title:** feat(sizing): add crypto/metals/equity correlation groups + min-lot budget guard

**Description:**
Two position sizing improvements:

1. **Correlation coverage for non-forex assets** — adds METALS (XAU/XAG), CRYPTO_MAJORS (BTC/ETH), RISK_ON_EQUITY (US30/NAS100/SPX500), and USD_HAVENS (XAU/Oil) groups. Previously these asset classes had zero correlation tracking.

2. **Min-lot floor respects hard caps** — when portfolio heat, correlation, or prop-firm daily loss caps reduce a position below 0.01 lots, the system now checks whether 0.01 lots would exceed the tightest cap. If so, the trade is rejected rather than silently taken at over-budget size.

Both changes are additive — existing forex correlation behavior is unchanged.
