# Step 15 PR 3 — dry-run outcome resolver: effect report

**Status:** built and tested; PR open, **not merged**. The account stays **paused and entries-locked**.

**Not included:** real positions, trading-config changes, the fill-floor policy, the float-equality supersede fix, the `pending_id` rename.

## What it does

A new service-role Edge Function `attribution-outcome-resolver`, run by pg_cron every 15 minutes (:07/:22/:37/:52):

1. **Candidates:** reads `trade_attribution` rows with `fill_kind = 'hypothetical'` and `closed_at IS NULL`.
2. **Bars:** reads the stored 5m bars (`smc_scan_bars`) for each candidate's symbol, keeping the latest revision of each bar.
3. **Resolve:** replays each fill forward with the pure `resolveHypothetical` (method `bar_replay_5m.v1`).
4. **Write:** writes **only** through two new functions:
   - `attribution_resolve_hypothetical`: writes section G **once**, plus event `outcome_resolved`;
   - `attribution_defer_hypothetical`: event `outcome_deferred_data_gap`, deduplicated per gap.

It makes no order, position, account, ledger or trade-history write, and no market-data provider call (so it uses no TwelveData credits).

### Rules

| Case | Result |
|---|---|
| bar opens beyond the stop | `hypothetical_gap_through_stop` at the open (R < −1) |
| bar opens beyond the target | `hypothetical_target` at the open |
| range touches the stop (**also when it touches the target in the same bar**) | `hypothetical_stop` at the stop |
| range touches the target | `hypothetical_target` at the target |
| a 5m slot is missing while the FX market is open | **deferred**, nothing invented; retried each run |
| market closed (Fri 17:00 → Sun 17:00 New York) | not a gap |
| no touch for 14 days of final bars | `open_at_horizon`, marked at the last final close |

- **Replay start:** the first bar that **opens** at or after the fill. The fill bar's earlier range predates the entry.
- **Finality:** a bar counts only once a scan ran ≥5 min after its close.
  - Measured: 670 of 686 bar revisions are bars first recorded within 60 s of their close (p90 ~1 pip, max 4.8 pips); the next scan corrects them.
  - 26 revisions came >60 min later, each ≤1.45 pips.
  - **`margin_pips`** (how far the decisive bar went past the level) is recorded so flip-sensitive outcomes stay visible.
- **R and P/L:**
  - **R gross** = ±(exit − fill) / |fill − stop|.
  - **R net** = R gross − `cost_in_price` / |fill − stop|, using the spread + commission estimate the order's R:R gate recorded.
  - **P/L** = R × the fill's recorded `fill_risk_usd`.
- **Idempotent:** an advisory lock per signal; the UPDATE only matches `fill_kind = 'hypothetical' AND closed_at IS NULL AND closed_at ≥ filled_at`; the PR 1 write-once guard refuses any second value; the outcome event has dedupe key `outcome`.

## Measured effect on production data (read-only dry run, 2026-10-07 22:53 UTC)

**Full resolver, read path real, writes captured and not sent:**

```
{"candidates":3,"resolved":0,"deferred":0,"pending":3,"invalid":0,"errors":[]}
088f22f7 GBP/USD pending  no stop / target touch yet       (order 4d8eab45, fill 18:22 @1.32175)
4be9b5c9 GBP/USD pending  no stop / target touch yet       (order 896572f4, fill 18:52 @1.32206)
fff2ae4e GBP/USD pending  no final bar after the fill yet  (order 3758fd3a, fill 22:42 @1.3216)
captured RPCs: 0
```

**Checked against the raw bars:** the GBP/USD range since 18:25 is 1.32089–1.32281. That touches neither the stop (1.319745) nor the target (1.324995), so `pending` is correct.

**Cross-check against `position_book.py`** (independent code, same core rule) on **all 7** dry-run fills since bar retention began (09-24):

| order | pair | fill (UTC) | PR 3 resolver | position_book | margin |
|---|---|---|---|---|---|
| 2dee2910 | USD/JPY short | 10-06 23:20 | stop, −1R, closed 00:20 | stop, −1R | **1.34 pips** |
| 77134ab8 | CHF/JPY long | 10-07 01:33 | stop, −1R, closed 08:00 | stop, −1R | 13.69 |
| 02eb7948 | CHF/JPY long | 10-07 07:34 | stop, −1R, closed 08:00 | stop, −1R | 6.60 |
| bcf0216f | CHF/JPY short | 10-07 14:52 | target, +1.152R, closed 15:45 | target, +1.152R | **0.58 pips** |
| 4d8eab45 | GBP/USD long | 10-07 18:22 | pending | open | — |
| 896572f4 | GBP/USD long | 10-07 18:52 | pending | open | — |
| 3758fd3a | GBP/USD long | 10-07 22:42 | pending | open | — |

**7 / 7 agree** on exit type and R. Only the 3 GBP/USD fills have attribution rows (the other 4 predate PR 2), so after deploy the resolver writes outcomes for those 3 only. No historical row is backfilled.

Two of the four resolved outcomes have margins (0.58 and 1.34 pips) within the measured late-revision range of ≤1.45 pips. They are recorded as resolved, with the margin visible.

## Finding: summed hypothetical P/L overcounts (needs a decision; not changed here)

A dry-run fill opens no position. The live caps (3 global / 1 per symbol) therefore never see it, and once the order leaves the active states the scanner can arm the **same zone** again:

- **CHF/JPY:** 02eb7948 filled at 07:34 while 77134ab8 was still open. Both stopped on the same 08:00 bar: one loss counted twice.
- **GBP/USD:** 4d8eab45, 896572f4 and 3758fd3a are three fills of one zone with identical stop and target, all open at once.

Under the live 1-per-symbol cap, **3 of these 7 fills would never have existed** (the PR 1 `hypothetical_position_book` measurement models exactly this).

Each per-fill outcome is correct, and PR 3 records them faithfully. But **adding up `realized_pnl_usd` across hypothetical rows overstates the sample** (here ~43% of fills). Options, for a later step:

- **(a) Recommended:** the Step 16 reporting layer applies the cap book when it aggregates. The resolver stays per-fill.
- **(b)** The resolver annotates each outcome with `would_be_capped_by` (the earlier open hypothetical fill on the same symbol). This is an extra field only.

## Tests

- `tests/_shared/step15Pr3OutcomeResolver.test.ts`: **12 tests**.
  - fill-bar skip;
  - stop / target / same-bar tie / gap at the open, long and short;
  - R gross / net and P/L from risk dollars;
  - finality cutoff; deferral on a missing open-market bar; a weekend is not a gap;
  - horizon; invalid inputs; `margin_pips`;
  - `loadBars` keeps the latest revision;
  - the run writes only through the two RPCs (no `insert` / `update` / `delete` / `upsert`); the source has no provider call.
- `tests/_shared/paperSettlementLedger.test.ts`: **+3 real-Postgres (PGlite) tests**, with migration `20261008020000` applied on top of PR 1 and PR 2.
  - The close is written exactly once; a second call returns `not_resolved` and leaves the row byte-identical; there is one `outcome_resolved` event and no position.
  - It refuses a non-hypothetical (real) fill, a close before the fill, a non-hypothetical exit reason, and a missing `r_gross`.
  - A deferral is recorded once per distinct gap, never writes an outcome, and returns `not_applicable` after resolution. `anon` and `authenticated` cannot execute either function.

| Suite | Result |
|---|---|
| Deno, `supabase/tests/` + `supabase/functions/` (CI command) | **3385 passed, 0 failed** |
| `deno check` (resolver function, run module, pure module, bot-scanner) | clean |
| Frontend `npx vitest run` | **366 passed, 0 failed** (26 files) |

## Deploy order (by hand, before and after merge)

1. **Before merge:** apply `supabase/migrations/20261008020000_step15_pr3_outcome_resolver.sql` in the SQL editor. It only adds two functions and grants.
   - **Verify:** both functions exist; `has_function_privilege('anon', …, 'execute')` is false for both.
2. **Merge:** `deploy-functions.yml` deploys `attribution-outcome-resolver`. bot-scanner is unchanged.
3. **After deploy:** run `supabase/cron/attribution_outcome_resolver_cron.sql` once. It uses the same vault/auth pattern as the live settlement monitor.
   - **Verify:** one `cron.job` row is active; the first run returns a summary with `errors: []`; any resolved row has `close_source = 'attribution_outcome_resolver'` and `outcome_kind = 'hypothetical'`.

**Rollback:** `select cron.unschedule('attribution-outcome-resolver-15m');`. The functions are inert without the cron. Resolved rows are write-once by design and are not rolled back.

## Open live verification (carried from PR 2, not blocking)

The next new Route 2 order after the #645 deploy (19:21 UTC) must have `pending_orders.config_hash` equal to its `trade_attribution.config_version` (32 hex).

As of 22:53 UTC no such order exists: the newest order, 3758fd3a, was placed at 19:00, before #645, and carries the old 16-hex hash. This will be checked opportunistically.
