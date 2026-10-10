# Candidate C live shadow — "always enter at the Impulse Zone midpoint" (V1)

Code: `supabase/functions/_shared/shadowZoneMid.ts` · guarded edits in `bot-scanner/index.ts` · `dataCache.peek()`.
Tests: `supabase/tests/_shared/shadowZoneMid.test.ts` (module, hook, writes, pins),
`shadowZoneMidHarness.test.ts` (runs the real `runScanForUser`, flag off / on / drain, injected faults),
`paperSettlementLedger.test.ts` → "shadow C" (real Postgres: placement, isolation, no positions, resolver, reports).

**The flag is OFF by default. Nothing below runs until `SMC_SHADOW_ZONEMID` is set.**

## What C is
Baseline A enters at `bestZone.refinedEntry`, else the zone midpoint. C changes that one variable: it always enters
at `(bestZone.high + bestZone.low) / 2`. Everything else is A's:
- **Signal and gates:** C exists only where A reaches its Route 2 branch (`effectiveLimitEnabled && limitEntry`), for
  Impulse Zone entries (`refinedEntry` / `zoneMid`). It inherits every gate verdict before that point, including
  A's placement-time caps.
- **Geometry:** distance guard (1.5 H1 ATR), the limit-anchored stop chain, 1.1R target, the order R:R gate and
  fill-time sizing. All of it is applied by `shadowRoute2Geometry` to C's own limit. Fed A's limit, that function
  reproduces all 57 recorded A orders that carry a full context (stop, target, R:R and lots bit-for-bit).
- **Lifecycle:** the same 8h fixed TTL, same-level refresh or supersede, and `route2_place_order`.
  The order row copies A's, including the refined-zone bounds. So the hunt's zone-exit check and its
  Tier-1-without-refined-zone rule are A's for the same setup.
- **Hunt:** C runs the real minute-level hunt loop, after every A order.

## Isolation
| Concern | How |
|---|---|
| Identity | bot `smc_shadow_zonemid`, `dry_run = true`, order id `zm` + 10 hex (A's are 8 hex), `strategy_version shadow-zonemid.v1`, `entry_source zoneMid`. |
| A's orders and caps | C has its own bot id under the unique active-order index. Supersede is scoped to the bot. Fill-time caps use C's own book (C fills not yet closed). |
| Positions | None, ever: `dry_run` is immutable; the database refuses a position from a dry-run order; D3 refuses real exposure for a bot with no paper account. |
| Credits | Cache-only reads (`scanCache.peek`). A minute where any series A's code would read is not cached is logged as `shadow_no_data` and the order is left untouched. |
| 17-A re-anchor | Not applied to C. Fills keep the planned stop and target, as A's live fills do. |
| Telegram, counters, scan-log arrays | C has its own sinks. A's counters and `thesisObservations` / `touchChecks` / `confirmationHunt` never see C. |
| Poll log | Separate insert, after A's, `poller_name = bot-scanner:shadow-zonemid`. |
| Placement timing | The intent is built without I/O inside the pair loop. It is written after A's decision capture, in its own try/catch. |
| UI, reset, second poller, reports | All read bot `smc`. The Baseline A report excludes C (dry-run after unlock). The Step 16-B attribution report now filters bot `smc`. |
| Config hash | Unchanged: the flag is a function secret, not bot config. No migration. |

## Flag
`SMC_SHADOW_ZONEMID`: anything other than `on` / `drain` (case-insensitive) is **off**.
- `off`: no shadow query and no write.
- `drain`: no new placements; existing C orders finish their hunt (≤ 8h).
- `on`: the full shadow.

Disable with `drain`, then `off`. If C orders must end at once, a service-role update can cancel them
(`terminal_reason = CANCELLED_SHADOW_DISABLED`). That is a manual step, not code.

## Validity of a C vs A result
A result is valid only when shadow coverage is **≥ 90% overall and ≥ 80% for every pair**:
`shadowCoverage(polls)`, where a `shadow_no_data` poll is an unobserved C order-minute.
A pair below 80% is reported separately and excluded from any promotion decision. Then the evaluation gate from the
design applies:
- ≥ 100 paired setups over ≥ 20 trading days, ≥ 10 per pair;
- ≥ 60 resolved fills per arm, both arms judged by the same resolver;
- promote / drop / continue rules as approved.

## Known limits — read before the canary
- **Coverage will probably fall short of the gate.** C sees data only where an A order on the same symbol fetched
  it that minute. Estimate from the 49 Baseline A orders since 2026-10-07 12:56Z: C orders that end when A's end for
  shared reasons (direction flip, supersede, expiry), but live to their TTL after A fills, would be covered about
  **71% overall** (58–79% by pair).
  - This is a rough bound: it ignores C orders where A was rejected, and A orders on the same pair in the other
    direction.
  - Measure it in the canary before relying on the experiment.
- **The second poller (`zone-confirmation-scanner`) has not run since 2026-10-06 18:51Z.** A is hunted by bot-scanner
  only, the same hunt C gets. If it is re-enabled, A gains a poller C does not have.
- **C's cap book lags.** Hypothetical closes arrive with the 15-minute resolver, so C can count a trade as open up to
  one resolver cycle late. C is capped slightly more often, never less.
- **Not tested pre-merge:** executing a real Route 2 signal through `runScanForUser`. Synthetic candles stop at the
  Impulse Zone gate. The hook is covered instead by:
  - running its exact source block against a deep-frozen scope;
  - feeding its rows to the real `route2_place_order`;
  - the source pins.

  The post-deploy check is the F11 replay with the flag on (A must reproduce 100%).
