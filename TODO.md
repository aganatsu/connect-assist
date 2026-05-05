# SMC Trading Bot — TODO

## Scoring System Fixes (Priority Order)

- [ ] Fix Unicorn penalty — stop zeroing FVG (Tier 1) when Unicorn fires; Unicorn setups should score higher, not lower
- [ ] Fix Daily Bias penalty — counter-HTF trades must be penalized in the tiered model, not silently dropped
- [ ] Fix Opening Range bonuses lost — push an "Opening Range" factor so tiered model can find it
- [ ] Fix negative FOTSI giving positive score — floor quality ratio at 0 when f.weight < 0
- [ ] Add Confluence Stack and Pullback Health to DEFAULT_FACTOR_WEIGHTS so users can adjust them
- [ ] Fix Tier 1 gate reason display — change "FVG" to "Fair Value Gap" and "Premium/Discount" to "Premium/Discount & Fib"
- [ ] Remove dead `score` variable accumulation (old system) — unify to single tiered system
- [ ] Fix OR marking factors present without setting weight — set meaningful weight when OR triggers factor enhancement

## Take-Profit Improvements

- [ ] Liquidity-targeted TP mode — rank untapped liquidity pools by proximity/size in trade direction, use as primary TP targets
  - Layer partial TPs at multiple liquidity levels (e.g., 50% at PDH, 50% at PWH)
  - Confluence-weight targets (liquidity + Fib extension + VAH/VAL alignment = stronger target)
  - Filter for untapped pools only (already swept = skip)
  - Audit how `calculateSLTP` currently uses/ignores liquidity data

## Future Considerations

- [ ] Evaluate quality scaling — should weak factors contribute less than strong ones? (currently binary present/absent)
- [ ] Re-calibrate 55% threshold after scoring fixes via backtest

## Unicorn Tier Promotion & Anti-Double-Count Audit (manus/fix-unicorn-tier-promotion)

- [x] Fix Unicorn to Tier 1 when it fires (currently Tier 3, causes -2.0 net penalty)
- [x] Fix anti-double-count Rule 1: when Unicorn fires, only zero Breaker Block, NOT FVG
- [x] Audit Rule 2 (Displacement + FVG overlap) for similar tier mismatch — OK, no mismatch
- [x] Audit Rule 3 (OB + FVG cap at 3.0) for similar tier mismatch — OK, no mismatch
- [x] Audit any other anti-double-count or factor interaction for scoring penalties — Rule 5 OK
- [x] Write regression tests proving Unicorn no longer penalizes score
- [x] Write regression tests for all other anti-double-count rules
- [x] Run full test suite — 238 passed, 0 failed (1 pre-existing unrelated)
- [x] Write REPORT.md

## UI Fixes

- [ ] Fix manual "Scan Now" button — add loading spinner while scan is running, refresh results on completion
