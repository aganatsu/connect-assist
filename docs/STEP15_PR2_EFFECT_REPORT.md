# Step 15 PR 2 — scanner + fill-path attribution + lifecycle triggers: effect report

**Status:** built and tested; PR open, **not merged**. The account stays **paused and entries-locked**.

**Not included:** outcome resolver (PR 3), fill-floor policy, the float-equality supersede fix, the `pending_id` rename, config changes.

## Validation that changed the plan (evidence)

1. **"Zone Setups" = live Route 2 `pending_orders`** (the UI panel title); the **Watchlist = `staged_setups`**.
   - The watchlist is **dormant**: last row 2026-10-06 17:21, before step 8 switched staging off.
   - Staged setups have no plan geometry, so they get no `signal_id` of their own.
   - A promoted order records `route = watchlist_promotion` plus a contributor `watchlist / origin` (staged setup id, initial score, cycles).
2. **"Zone setup already active" happened 17 times in about 17 h.** The stale-order lookup only matches `status = 'pending'`, so an **armed** (`awaiting_confirmation`) order is never refreshed or superseded, and the re-detection's insert hits `idx_pending_orders_unique_active`. Those decisions now **link to the armed order's `signal_id`**: the tracked setup keeps one identity and no orphan attribution row is created.
3. **Supersede must share the new order's transaction.** Otherwise the old order is cancelled before the new attribution row exists, and the `superseded ⇔ linked` check would force `cancelled` and lose the link.
   - The cancel now runs inside `route2_place_order`, with the same fields as before.
   - This is behaviour-equivalent: the unique index allows one live order per symbol + direction, so after cancelling the stale `pending` order the new insert cannot collide.
4. **Deploy order (revised, see below).** There is no unattributed fallback. The migration is always applied before merge; if the function is ever missing, the order is not placed (`RPC_UNAVAILABLE`).
5. **A UI cancel runs as the signed-in user**, and client roles cannot write attribution. The triggers are therefore `SECURITY DEFINER`.
6. **Test harness gaps found and fixed:**
   - the Route 2 columns the trigger reads come from later migrations; without them the exception-safe trigger would silently no-op;
   - the production unique index was missing from the harness, which also exposed one step 8 test that relied on two live orders for one symbol.

## Code paths changed

| File | Change |
|---|---|
| `bot-scanner/index.ts` | `loadConfig` selects `config_version` (canonical md5, same read); `cap.id` minted per decision; stale lookup reads `signal_id`; same-level refresh links `cap.signal_id`; **`route2OrderRow` + `buildAttribution` + `placeRoute2Order`** replace the direct insert and the separate supersede cancel; duplicate → link to the tracked setup (decision status text unchanged); fills write `fill_sizing` (stop pips + inside-floor **recorded only**); real-fill position carries `signal_id` |
| `_shared/attribution.ts` (new) | pure builder of sections A–D; primary-engine rule; gate classifier; Game Plan alignment |
| `_shared/route2Placement.ts` (new) | the RPC call; outcome codes; **no direct write path** |
| `_shared/smcDecisionCapture.ts` | `id` / `signal_id` on the capture and row |
| `_shared/propFirmGate.ts` | `profileVersion` on the result (hash of the threshold columns), recording only |
| `zone-confirmation-scanner` (switched off) | position carries `signal_id`, for consistency |
| migration `20261008010000_step15_pr2_attribution_lifecycle.sql` | below |

## Triggers and functions added

- **`pending_orders_attribution()`**: AFTER INSERT OR UPDATE, `SECURITY DEFINER`, exception-safe. Only acts when `signal_id` is set.
  - **insert:** order_id / row id / placed_at, event `order_inserted`;
  - **geometry change while live:** event `refreshed_in_place` with old → new; the plan is untouched;
  - **touch:** `touched_at` (first) + event `touched`;
  - **awaiting → pending:** event `reset`;
  - **`confirmation_accepted_at`:** `confirmed_at` + confirmation + event `confirmed`;
  - **status cancelled / expired:** terminal `superseded` (only if linked) / `expired` / `blocked_caps` / `invalidated` (SL, impulse broken, zone exit, direction flip, FOTSI, refined-zone failure, thesis) / `cancelled`;
  - **status filled:** terminal `filled` or `hypothetical_fill` + section F from `fill_price`, `stop_loss`, `take_profit` and `fill_sizing`.
- **`paper_positions_attribution()`**: AFTER INSERT OR DELETE, `SECURITY DEFINER`, exception-safe.
  - **insert:** `position_row_id` / `position_id` + event `position_opened`;
  - **delete with no ledger close:** event `position_deleted_unsettled`.
- **`route2_place_order(attribution, order, supersede)`**: `SECURITY INVOKER`, service role only. One transaction:
  1. read the superseded orders' signal ids;
  2. insert the attribution row with `supersedes_signal_ids`. **Fail closed:** no `signal_id` → `attribution_missing`; a row the database refuses → `attribution_write_failed`. Either way nothing is written (no order, no supersede cancel);
  3. link `superseded_by` and cancel the old orders, as before;
  4. insert the new order with the same `signal_id`;
  5. on `unique_violation`, roll back all of it and return `duplicate` + the live order's `signal_id`.

  Unknown or generated columns are refused.

## Proofs (real Postgres, PGlite 16)

| Requirement | Test | Result |
|---|---|---|
| One `signal_id` decision → order → fill → position (→ close) | "one signal_id survives …": decision row, order, touch → reset → touch → confirm, **real fill via `route2_claim_and_fill`** (order + position in one transaction), position, settle. The same id is on the decision, order, position, history and ledger. F: real / fill price / lots / position link / inside_floor false. G: stop −1R. Events in order: `order_inserted, touched, reset, touched, confirmed, filled, position_opened, closed` | pass |
| Zone Setup keeps its lifecycle identity | "a re-detection of a live (armed) setup …": a duplicate returns the armed order's id and signal; no orphan attribution; no second order; the tracked attribution is byte-identical; the decision links to it. Plus the same-level refresh link (wiring test) | pass |
| Refreshes don't mutate the plan | "same-price refresh is an event": every A–D column is identical after stop / target / size / score change; one `refreshed_in_place` with exact old / new; polls add no events | pass |
| Supersede both ways | "supersede links both directions": old → `superseded`, `superseded_by` = new; new `supersedes` = [old]; the old order's status / reason / cancel text / resolved_at are as before. A legacy old order is superseded as before; the new row links to nothing | pass |
| Cancellations / expiry terminal | direction flip → invalidated; impulse broken → invalidated; expired → expired; position cap → blocked_caps; manual → cancelled; terminal is write-once (a later status change can't rewrite it) | pass |
| Dry-run never becomes a position | hypothetical fill → `hypothetical_fill` / `hypothetical`, no position link; a position insert is refused while locked **and** unlocked ("dry-run order can never become a position"); `outcome_kind real` is refused on a dry-run row | pass |
| Real fill carries the id into the position | first test: `position.signal_id` = the order's; F + position link written in the claim transaction | pass |
| Legacy rows work | order placed with no attribution → no signal; full lifecycle + a legacy position settle → 0 attribution rows, 0 events. **All 32 pre-step-15 settlement tests + 11 PR 1 tests still pass** | pass |
| **Invalid attribution → no new order** | invalid row (bad config hash) → `attribution_write_failed`: no order, no attribution row, **the order it would have superseded stays live**; no attribution at all → `attribution_missing`, no order | pass |
| **Attribution insert failure → no new order** | the database rejects the attribution INSERT → `attribution_write_failed`, 0 orders; other errors (entries lock) still surface as errors | pass |
| **Lifecycle-write failure never blocks cancel / fill / settlement** | every attribution UPDATE and event INSERT failing: the order cancel, the position insert, **a real fill via `route2_claim_and_fill`** and its settlement all succeed, and the ledger still carries the `signal_id` | pass |
| Migration idempotent | re-run: triggers / RPC unchanged | pass |

**TypeScript tests (`step15Pr2Attribution.test.ts`, 12):**
- the primary-engine rule table: Unified is **never** primary with modifiers off, and the score is never primary;
- **all 18 gate reasons production wrote at 13:00 UTC** classify to the right id;
- Game Plan alignment;
- the row: Impulse primary, Unified `detected_only` not applied, score as evidence, Game Plan below-threshold captured, step 13 risk result captured, old-rule would-block captured, versions, plan values, no lifecycle fields at placement;
- the watchlist origin;
- the decision row id + signal;
- placement mapping and **legacy fallback**;
- wiring.

**Existing tests updated** (same property, new location):
- `pendingSupersedeChurn` ×2 (refresh before placement; `resolved_at` now in the RPC + fallback);
- `perPairStopFloor`;
- `route2Forward` (terminal-reason sources include the RPC);
- `step9FillTimeSizing` (the extended record);
- `route2AtomicFill` (harness gains the PR 1 columns, asserted to exist in the PR 1 migration);
- the PR 1 event-sequence assertions (now include `position_opened`);
- the step 8 harness test (second order on another symbol, because of the production unique index).

## Full results

- **Deno:** 3,369 passed / 0 failed (supabase/tests 1,800 + supabase/functions 1,569).
- **Frontend:** 366 passed.
- **`deno check`:** clean on every changed file.

## Behaviour today

- **Trading:** none changes. Orders, fills and closes write the same values.
- **Additions:**
  - an attribution row per new Route 2 order (≈ 21 / day, dry run);
  - its events;
  - `signal_id` on decisions / orders / positions;
  - `fill_sizing` on filled orders;
  - two extra keys in the dry-run fill-sizing record.
- **Edge case (race only):** a concurrent scan making the new insert collide now **keeps** the stale order instead of cancelling it with nothing to replace it.

## Deploy (after your approval)

1. Apply the migration in the SQL editor (one transaction), with a verification row.
2. Run a rolled-back verification (one `DO` block on a throwaway account) of place → refresh → supersede → duplicate → touch → confirm → real fill → close.
3. Merge (CI green). This deploys `bot-scanner` + `zone-confirmation-scanner`.
4. Verify on the next placed dry-run order: its attribution row, `signal_id` on the order and decision, and events.


## Revision 2: new entries fail closed on attribution (requested 2026-10-07)

**Rule:** a new Route 2 order is placed only together with its valid `trade_attribution` row. Otherwise no order is placed and the decision log records the reason:

| Outcome | When | Decision log |
|---|---|---|
| `ATTRIBUTION_INVALID` | before any write: the canonical config hash is missing / not 32-hex, or the builder throws | `status = attribution_invalid`, `skipReason = "Order not placed: attribution invalid (…)"` |
| `ATTRIBUTION_WRITE_FAILED` | the database refuses the attribution row (constraint, store error) or it is missing | `status = attribution_write_failed`, `skipReason = "Order not placed: attribution write failed (…)"` |
| `RPC_UNAVAILABLE` | `route2_place_order` missing | `status = zone_setup_insert_failed`, `placementCode = RPC_UNAVAILABLE`; no order |

- Placement is atomic, so a refused attribution also leaves the order it would have superseded **live**, rather than cancelling it with nothing to replace it.
- **Fail open, unchanged:** settlement / money movement, cancellation, expiry, fills and position writes, position close, lifecycle events. Triggers and settlement swallow attribution errors.
- **Deploy-order fallback removed.** It is not needed: the migration is always applied before merge, while the account is paused and locked.

**Measured effect.** Every dry-run order placed since step 8 (**16**, 10-06 22:05 → 10-07 13:10) was replayed on PGlite through the production builder + `route2_place_order`, with inputs rebuilt from each order's stored record, its decision row and the config hash active at placement:

- **16 / 16 placed, 0 would have been blocked** (no invalid, no write failure);
- all 16 attribute to `primary_engine = impulse_zone`;
- Game Plan: 1 aligned, 12 below threshold, 3 neutral.

The replay also found **one gate per order classified `unclassified`: the Game Plan filter** ("GP filter (soft): … REJECTED …" / "Game plan: … aligns …"). It is now classified `game_plan_filter`; 0 unclassified across the 16.

**Remaining risk:** a systematic bug in attribution would stop **all** new entries. This is now loud, not silent: the decision-log statuses above, and the funnel report counts them.
