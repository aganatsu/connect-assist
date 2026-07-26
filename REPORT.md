# Task: reconcile-oanda-trail

## Branch: manus/reconcile-oanda-trail

## Behavior changes

1. **reconcileBrokerState now runs every manage cycle** — Previously, if `manageOpenPositions()` returned zero active actions (i.e., all positions got "no_change"), the reconciliation would never fire. Now it runs unconditionally for all live, broker-mirrored positions. This means SL drift between DB and broker will be detected and corrected even on quiet cycles where no management action triggers.

2. **OANDA live accounts now get reconciliation coverage** — Previously only MetaAPI (MetaTrader) connections were reconciled. OANDA positions are now fetched via the OANDA REST API, SL compared, and corrected when mismatched. Matching is by instrument+direction (OANDA doesn't support comment tags like MetaAPI).

3. **Paper-trading trail ratchet uses shared formula** — The inline trail calculation in paper-trading's status handler now calls `computeTrailRatchet()` from exitEngine.ts. The **numerical output is identical** for the fixed-pip path (regression tests prove this). The only behavioral difference: the monotonic check now also validates against `prevTrailLevel` (from `exitFlags.trailingStopLevel`), which is a stricter guarantee that was already present in scannerManagement but missing from paper-trading.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Moved reconcileBrokerState() call outside `if (activeActions.length > 0)` block; changed broker_type filter from `.eq("metaapi")` to `.in("broker_type", ["metaapi", "oanda"])` |
| `supabase/functions/_shared/reconcileBrokerState.ts` | Added OANDA helpers (`oandaFetchPositions`, `oandaModifySL`, `resolveOandaSymbol`, `getOandaBaseUrl`); added OANDA reconciliation path in main loop; updated `BrokerConnection` interface to accept `"oanda"` type |
| `supabase/functions/_shared/exitEngine.ts` | Added `computeTrailRatchet()` function + `TrailRatchetInput` / `TrailRatchetResult` interfaces — single source of truth for trail ratchet formula |
| `supabase/functions/paper-trading/index.ts` | Added import for `computeTrailRatchet`; replaced inline trail formula (lines 948-967) with call to `computeTrailRatchet()` |
| `supabase/functions/_shared/reconcileOandaTrail.test.ts` | New test file (9 tests) |

## Tests added

| Test | Assertion |
|------|-----------|
| `computeTrailRatchet: LONG fixed-pip trail produces correct SL` | Verifies newSL = currentPrice - (trailPips × pipSize) for long |
| `computeTrailRatchet: SHORT fixed-pip trail produces correct SL` | Verifies newSL = currentPrice + (trailPips × pipSize) for short |
| `computeTrailRatchet: does NOT tighten when newSL is worse than prevTrailLevel` | Monotonic guarantee — price retrace doesn't widen SL |
| `computeTrailRatchet: no tighten when new SL is below current SL (long)` | Prevents widening when price hasn't moved enough |
| `computeTrailRatchet: regression - matches old inline formula for LONG` | Exact numerical match with pre-refactor inline formula |
| `computeTrailRatchet: regression - matches old inline formula for SHORT` | Exact numerical match with pre-refactor inline formula |
| `computeTrailRatchet: adaptive path produces different result than fixed` | Confirms adaptive delegation works when candles+ATR provided |
| `computeTrailRatchet: works correctly for XAU/USD (pipSize=0.1)` | Gold pip size handling |
| `computeTrailRatchet: works correctly for USD/JPY (pipSize=0.01)` | JPY pair pip size handling |

## Tests run

```
$ deno test --allow-all supabase/functions/_shared/reconcileBrokerState.test.ts \
    supabase/functions/_shared/reconcileOandaTrail.test.ts \
    supabase/functions/_shared/exitEngine.test.ts

ok | 40 passed | 0 failed (219ms)

$ deno test --allow-all supabase/functions/paper-trading/

ok | 29 passed | 0 failed (317ms)
```

Total: **69 tests passed, 0 failed**.

## Regression check

1. **Trail formula regression**: Tests 5 and 6 (`regression - matches old inline formula for LONG/SHORT`) prove that `computeTrailRatchet()` produces byte-identical SL values to the old inline formula given the same inputs. The only difference is the additional `prevTrailLevel` monotonic check, which is strictly safer (prevents edge cases where SL could widen).

2. **reconcileBrokerState existing tests**: All 9 existing tests in `reconcileBrokerState.test.ts` pass unchanged, confirming MetaAPI path is unaffected.

3. **exitEngine existing tests**: All 22 existing tests pass, confirming `computeAdaptiveTrail` is unaffected by the new `computeTrailRatchet` addition.

4. **paper-trading existing tests**: All 29 existing tests pass, confirming no regression in paper-trading behavior.

## Open questions

1. **OANDA position matching**: OANDA doesn't support comment tags on trades. The current matching is by `instrument + direction`. If a user has multiple positions on the same pair in the same direction (e.g., two EUR/USD longs from different signals), the reconciler will match the first one found. Is this acceptable, or should we add a `units` (size) check as a secondary discriminator?

2. **OANDA API credentials**: The implementation reads `oanda_token` and `account_id` from the `broker_connections` row's `credentials` JSON field. Please confirm this matches the schema used when OANDA connections are created.

3. **Paper-trading status handler polling caveat** (flagged per task description): The trail ratchet in paper-trading's `action === "status"` handler only runs when the frontend polls it. There is no server cron invoking it. If sub-minute reaction time on volatile symbols matters, this needs a real server-side trigger (e.g., a Supabase cron or a dedicated edge function on a timer). This is not addressed in this PR — it's a design decision for a separate task.

## Suggested PR title and description

**Title:** fix: reconcileBrokerState runs unconditionally + OANDA support + shared trail formula

**Description:**
Three safety-relevant fixes:

1. **Reconcile gating fix** — `reconcileBrokerState()` was inside `if (activeActions.length > 0)`, meaning it only ran when a management action fired. Moved it outside so it runs every manage cycle for all live, broker-mirrored positions. This is the entire design intent of reconciliation.

2. **OANDA reconciliation** — Added OANDA position fetch + SL modify via REST API. Changed broker_type filter from `.eq("metaapi")` to `.in(["metaapi", "oanda"])`. OANDA accounts now get full SL drift detection and correction.

3. **Trail formula extraction** — Extracted `computeTrailRatchet()` to `exitEngine.ts` as single source of truth. Paper-trading now calls it instead of duplicating the formula inline. Regression tests prove identical numerical output.

All 69 tests pass. Zero new type errors. Zero behavior change in default config for paper-trading (fixed-pip path produces identical results).
