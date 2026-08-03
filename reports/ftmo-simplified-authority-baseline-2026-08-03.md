# FTMO Simplified-Authority Baseline

Date: 2026-08-03

## Sources

- Supabase export of closed SMC trades through 2026-07-31
- `smc-preset-ftmo-x1-2026-07-23.json`, exported 2026-07-23 13:55 UTC
- FTMO `trading-journal.csv`, covering 2026-07-01 through 2026-07-16

Raw account exports are intentionally not committed because they contain user
and broker identifiers.

## Findings

- Main bot account: 308 trades, 61.2% win rate, approximately $10,583 net P&L.
- 123 trades below legacy score 40 produced approximately $12,295 with a 65.9%
  win rate.
- 197 trades below score 50 produced approximately $12,046 with a 65.5% win
  rate.
- The saved preset disabled Tier 1 authorization, structural conviction,
  regime scoring, rolling premium/discount enforcement, spread/volatility
  filters and opening range. Minimum zone score was zero and confluence was 20.
- The preset retained OB, FVG, BOS, CHoCH and liquidity-sweep concepts.
- The FTMO journal contains 54 broker trades and $3,002.31 gross trade P&L.
  After applying the broker's three-hour timestamp offset, 53 of 54 entries
  matched the bot history by symbol, direction and a 30-minute time window.

## Conclusion

The evidence supports a paper/demo authority model in which Zone Story and the
named canonical authorities own market quality. Legacy scores, tiers, credits
and duplicate market gates remain available for diagnostics but do not own
authorization. Operational risk and execution safety remain hard requirements.

This evidence does not validate every feature added after the FTMO period.
Newer cross-timeframe lineage, canonical range, confirmation and thesis systems
remain enforced because they provide explicit authority and frozen provenance.
