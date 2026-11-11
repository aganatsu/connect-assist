# LATEST_CHOCH_PREREG_V1 — let the most recent structure-TF CHoCH decide, pre-registered

**Written 2026-11-11, before the variant was run.** Owner request (2026-11-11), from
the analyst's reading of `directionEngine.ts`.

## The logic question

Style-aware direction (scalper: bias 1H, structure 15m, confirm 5m) hard-blocks when
any structure-TF CHoCH **against** the bias formed in the last 10 structure candles
(`is4HRetracing`, `h4ChochLookback` = 10 → 2.5 h on 15m). It ignores a **newer**
CHoCH back **with** the bias. In the textbook sequence — pullback (opposing 15m
CHoCH) → price reaches the zone → 15m CHoCH back with the 1H — the last step is the
entry signal, yet the block stands for up to 2.5 h after the first.

Graded direction blocks (synthetic market entry at the block, 1.5×ATR stop, 2R; last
60 days, 349 resolved) win 25.5% (−0.235R before costs). That shows entering blindly
at a block is bad; it does not test the textbook sequence.

## Change under test (one rule)

`structureLatestChochDecides = true`: among the structure-TF CHoCHs in the lookback
window, take the **most recent**. If it is **with** the bias, the CHoCH block does not
fire (the remaining checks — structure-trend block, confirm TF — run unchanged). If it
is against, block exactly as today. Everything else is untouched; `priceAwareStructureBlocks`
stays off (the live value).

## Test

`local-runner/break-strength-replay.ts` (the SMC_IMPULSE_ZONE causal replay: production
decideDirection → buildHtfContext → decideZone → findUnifiedZone, frozen costs, 1m
execution), decisions 2026-03-29 → 2026-09-25, 7 FX pairs, the same corpus
(`local-runner/.cache/smc/`).

- **BASELINE** = the cached run with the flag off (`smc_bs_setups_*.json`, n=889,
  −0.091R) — the current code.
- **VARIANT** = the same replay with `structureLatestChochDecides: true`
  (`local-runner/latest-choch-replay.ts` → `smc_lc_setups_*.json`).

Trades = outcome TRADE_TAKEN and not ambiguous. **NEW** = variant trades whose
(zoneId, t) is not a baseline trade — the setups the change lets through.

## Gate — all must hold to add a Bot Config switch

1. NEW: ≥ 30 trades and net expectancy > 0R;
2. VARIANT overall net expectancy > BASELINE;
3. 1 and 2 hold in each half (split 2026-06-27).

Pass → Bot Config switch "Latest 15m CHoCH decides direction", **default off**; the
owner turns it on and starts a fresh demo record. Fail → no change.

## Reported, not decisive

Before-cost expectancy; trades removed by the change (in baseline, not variant — slot
effects); by pair.
