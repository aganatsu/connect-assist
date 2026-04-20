# Commit 3 Notes

## ATR Multiplier (hardcoded 1.5)

Found in 3 places:
1. `smcAnalysis.ts` line 917: `config.slATRMultiple || 1.5` — SL calculation (already configurable via slATRMultiple!)
2. `smcAnalysis.ts` line 1061: `config.atrValue * 1.5` — volatility_adjusted lot sizing (HARDCODED)
3. `bot-scanner/index.ts` line 1628: `config.atrValue * 1.5` — local copy of volatility_adjusted (HARDCODED)

Fix: Add `atrVolatilityMultiplier` to config (default 1.5), pass it through to calculatePositionSize.
The SL calc already uses `slATRMultiple` from config, so only the lot sizing needs the fix.

## Spread Check Unification

OANDA path (lines 2824-2868):
- Resolves symbol format (EUR/USD → EUR_USD)
- Fetches pricing from OANDA REST API
- Extracts bid/ask from pricing response
- Calculates spread, checks against effectiveMaxSpread
- If fails: logs warning, continues without check (doesn't block)
- No SL/TP adjustment (OANDA uses broker-execute function which handles its own execution)

MetaApi path (lines 2973-3023):
- Fetches current-price from MetaApi
- Extracts bid/ask
- Calculates spread, checks against effectiveMaxSpread
- If fails: logs warning, continues without check
- Has SL/TP adjustment (half-spread widen)

Key difference: OANDA doesn't do SL/TP adjustment because it delegates to broker-execute.
MetaApi does direct trade execution so it adjusts SL/TP inline.

Unification approach: Extract a `fetchBrokerSpread()` helper that:
- Takes conn, pair, config
- Returns { bid, ask, spreadPips, passed, effectiveMax }
- Each broker type has its own fetch logic inside
- The caller handles the skip/continue and SL/TP adjustment
