# Step 15 — per-trade attribution: build plan (nothing built, migrated or deployed)

**Inputs:**
- design `STEP15_ATTRIBUTION_DESIGN_V1.md`;
- live schema, 2026-10-07;
- dry-run orders d11627e7 → b25f637f → 77134ab8.

**Migration:** `docs/step15/PROPOSED_full_design_trade_attribution.sql`, validated on PGlite (Postgres 16) by `docs/step15/validate_migration.test.ts`. It runs twice cleanly, and the guards were exercised (§8).

The account stays **paused and entries-locked**. The fill-floor policy is untouched.

## 1. Migration (summary; full SQL in the file)

| Object | What |
|---|---|
| `bot_configs.config_version` | `text GENERATED ALWAYS AS (md5(config_json::text)) STORED`: the change-log trigger's expression |
| `trade_attribution` | ~95 columns in sections A–G. PK `signal_id`. Self-FK `superseded_by_signal_id`. FKs `history_id` → `paper_trade_history`, `ledger_id` → `paper_account_ledger`. 7 CHECK constraints (fill kind ↔ dry run, outcome kind ↔ fill kind, close needs fill, a fill means a filled terminal, superseded ↔ link, not self-superseded, a real close has history + ledger) |
| `trade_attribution_events` | append-only. FK `signal_id`. `dedupe_key` unique per signal |
| `signal_id` columns | `smc_scan_decision`, `pending_orders`, `paper_positions`, `paper_trade_history`, `paper_account_ledger`, all FK → `trade_attribution`. **Unique** on `pending_orders` and `paper_positions`, on `paper_trade_history` for final closes (partial TP rows excluded), indexed on the ledger and decisions |
| `pending_orders.fill_sizing` | the fill-time sizing record, for real and dry-run fills alike |
| Indexes | user + time, config_version, symbol + time, engine + route, (user, order_id) unique, unresolved-hypothetical partial index |
| Triggers | `trade_attribution_guard` (immutable / write-once / no delete / no truncate); events append-only; `signal_id` immutable on 4 lifecycle tables; `pending_orders_attribution` (insert, refresh, touch, reset, confirm, terminal, fill); `paper_positions_attribution` (open; delete without settlement) |
| RPC changes | `_paper_history_row` copies `signal_id`; `_paper_ledger_post` gains `p_signal_id`; `settle_paper_position` writes section G in its transaction; `settle_paper_partial` adds an event. New `ta_exit_reason(source, close_reason)` |
| New RPC | `attribution_resolve_hypothetical(signal_id, outcome)`: advisory-locked, write-once, service role only |
| Access | RLS on both tables; owner SELECT; INSERT / UPDATE / DELETE revoked from anon and authenticated |

## 2. Field ownership

| Field(s) | Writer | Stage |
|---|---|---|
| `signal_id` | bot-scanner (`crypto.randomUUID()`, once per order decision) | decision |
| A: symbol, direction, dry_run, scan_cycle_id, decision_id, decision_at, strategy_bar_time, **config_version** (read with the config), strategy / sizing / stop / management / caps versions, risk_profile_version (the step 13 profile hash), route | bot-scanner `insertAttribution()` | decision → **before** the order insert |
| B: primary_engine (rule `primary-engine.v1`), contributors | bot-scanner `_shared/attribution.ts` | decision |
| C: game_plan, impulse, ob_fvg_zone, unified, score (raw + adjusted + components), gates (id / mode / passed / would_block), risk_gate (the step 13 cycle decision), legacy_would_admit, logged_only_would_block | bot-scanner | decision |
| D: zone_id, entry_source, entry_depth, limit / stop / target, stop_source / distance / floor / cap, market_anchored_stop, raw / effective R:R, cost, intended risk % / $, planned lots, expires_at, **supersedes_signal_ids** | bot-scanner | order creation (same insert as A–C) |
| `smc_scan_decision.signal_id` | bot-scanner decision capture | decision (row written after the order; FK already satisfied) |
| `pending_orders.signal_id` | bot-scanner order insert | order creation |
| order_id, pending_order_row_id, order_placed_at | trigger `pending_orders_attribution` (INSERT) | order creation |
| event `refreshed_in_place` (old → new entry / stop / target / size) | trigger (UPDATE, geometry changed while live) | refresh. The plan (D) never changes |
| superseded_by_signal_id on the **old** row | bot-scanner, after inserting the new row, before cancelling the old order | supersede |
| terminal_status `superseded` / `cancelled` / `invalidated` / `expired` / `blocked_caps`, terminal_reason, terminal_at | trigger (status → cancelled / expired) | cancel / expire / supersede |
| touched_at; event `touched` / `reset` | trigger (`zone_touch_time` set; awaiting → pending) | hunt |
| confirmed_at, confirmation | trigger (`confirmation_accepted_at` set) | hunt |
| terminal `filled` / `hypothetical_fill`, fill_kind, filled_at, fill_price, fill stop / target, fill lots / risk / cap, fill_stop_distance_pips, fill_inside_floor | trigger (status → filled), from `fill_price`, `stop_loss`, `take_profit`, `fill_sizing`. PR 2 adds `stopDistancePips` and `insideFloor` to the fill-sizing record; today it carries the distance in price only | fill (real: inside `route2_claim_and_fill`; dry run: the hypothetical-fill update) |
| events `blocked` (prop-firm lock, entries locked, sizing unavailable) | bot-scanner hunt (dedupe per order + reason) | hunt |
| `paper_positions.signal_id` | bot-scanner `positionRow` → `route2_claim_and_fill` (writable: any existing column) | position creation |
| position_row_id, position_id; event `position_opened` | trigger `paper_positions_attribution` (INSERT) | position creation |
| `paper_trade_history.signal_id` | `_paper_history_row` (from the position) | settlement |
| `paper_account_ledger.signal_id` | `_paper_ledger_post(p_signal_id)` | settlement |
| G (real): outcome_kind real, closed_at, exit_price, exit_reason, close_source, realized P/L, R gross / net, history_id, ledger_id; event `closed` | `settle_paper_position` | close + settlement, **one transaction** |
| event `partial_close` | `settle_paper_partial` | partial (off in the freeze) |
| event `position_deleted_unsettled` | trigger (position DELETE with no close) | the legacy `reset_account` path |
| G (hypothetical); event `outcome_resolved` / `outcome_deferred_data_gap` | `attribution-outcome-resolver` → `attribution_resolve_hypothetical` | hypothetical dry-run outcome |

## 3. Signal ID propagation

```
bot-scanner decision ── signal_id minted
  │  INSERT trade_attribution (A–D)                         [code]
  │  INSERT pending_orders.signal_id                         [code] → trigger fills order_id …
  │  INSERT smc_scan_decision.signal_id                      [code]
  ▼
hunt: touch / confirm / fill  ── UPDATE pending_orders       [code] → trigger writes E / F
  ▼
route2_claim_and_fill: INSERT paper_positions.signal_id      [code, same txn as the order fill]
  ▼
any close path ── settle_paper_position(position_row_id, …)
  │  history row  ← _paper_history_row copies position.signal_id
  │  ledger row   ← _paper_ledger_post(p_signal_id)
  │  trade_attribution G ← same transaction
  ▼
position row deleted (trigger sees G present → no "unsettled" event)
```

Every close path goes through `settle_paper_position`, so the id is preserved without touching any caller:

| Close path | Caller | Ledger source | exit_reason |
|---|---|---|---|
| stop / target (paper-trading engine) | `paper-trading` | `paper_trading_auto` | stop / target (from close_reason) |
| stop / target (scanner check) | bot-scanner | `scanner_breach_check` | stop / target |
| manual close | `paper-trading` manual | `paper_trading_manual` | manual |
| prop-firm emergency | `propFirmEmergencyClose` | `prop_firm_emergency` | prop_firm_emergency |
| kill switch | `paper-trading` kill | `kill_switch` | kill_switch |
| reset (system-reset) | `system-reset` `settleFlatten` | `account_reset_flatten` | reset_flatten |
| reverse signal | bot-scanner | `scanner_reverse_signal` | reverse_signal |
| legacy `reset_account` (deletes positions unsettled) | `paper-trading` | none | event `position_deleted_unsettled`; G stays empty and visible as unsettled |

## 4. Immutability

- **A–D immutable:** the guard compares every column not in the write-once list (including any column added later) and raises `check_violation` on any change. DELETE and TRUNCATE are refused.
- **E–G write-once:** a column may go NULL → value once. A second write of a different value is refused. Writers use `WHERE … IS NULL` so a repeat is a no-op, not an error.
- **Refresh:** the order row's live geometry may change. The trigger always emits `refreshed_in_place` with old → new values, and the plan (D) cannot change. That makes "silent" structurally impossible, whichever code path does the update.
- **Supersede (both directions):** the new row carries `supersedes_signal_ids` (immutable, set at insert). The old row gets `superseded_by_signal_id` (write-once), and its terminal status becomes `superseded` (CHECK: superseded ⇔ link). Order of operations in bot-scanner: insert the new attribution → link the old → cancel the old order → insert the new order.
- **Also found:** `d11627e7` → `b25f637f` was a "supersede" at the **same** price (190.099305 vs 190.09930500000002). The same-level test uses exact float equality. Attribution records it truthfully as a supersede; fixing the comparison is a separate, explicitly approved change.

## 5. Config hash: one canonical implementation

**Canonical:** `md5(config_json::text)` over the stored jsonb. It is written by `audit_bot_config_change()` into `bot_config_change_log.next_hash`, and now exposed as `bot_configs.config_version` (a generated column, so it cannot drift).

- `loadConfig` selects `config_version` with `config_json` in one read. The attribution row stores **that** value, which is the hash of the exact bytes the scan used.
- The 16-hex `configHash(mapped config)` is retired as an identifier:
  - new `pending_orders.config_hash` values get the canonical 32-hex (length distinguishes them from legacy rows);
  - `bot_config_history` writes stop (no deletion; legacy rows stay);
  - the full config for any version is `bot_config_change_log.next_config WHERE next_hash = config_version`.
- Test: the PGlite check that the generated column equals the trigger's `next_hash` for the same update.

## 6. Dry-run outcome job (`attribution-outcome-resolver`)

- **Schedule and scope:** Edge Function on a 15-minute cron. It reads only the DB (no TwelveData calls) and writes only through `attribution_resolve_hypothetical`.
- **Candidates:** `fill_kind = 'hypothetical' AND closed_at IS NULL` (partial index).
- **Candles:** `smc_scan_bars`, **5m**, the bars the scanner already records (provider as recorded), keeping the latest `first_seen_at` per `bar_time`. The replay starts at the **first bar opening after the fill** (the fill bar's earlier range predates the entry).
- **Stop / target:** the stop and target at fill (section F). Per bar, in order:
  1. if the bar **opens** beyond the stop → exit at the open (`hypothetical_gap_through_stop`, R below −1);
  2. else if the bar opens beyond the target → exit at the open;
  3. else if the bar touches the stop → stop;
  4. else if it touches the target → target.
- **Tie-break:** stop and target both touched in one bar → **stop** (conservative; intrabar order is unknown).
- **Missing data:** expected bars are every 5 minutes during FX hours. Weekend closure (Fri 17:00 – Sun 17:00 New York) is not a gap.
  - A hole before resolution stops the replay at the hole, appends `outcome_deferred_data_gap` (dedupe by gap start), and retries next run.
  - Nothing is invented.
  - After **14 days** with no stop or target hit → `open_at_horizon`, marked at the last close and flagged.
- **No double processing:** advisory lock per signal, `WHERE closed_at IS NULL`, the write-once guard, and event dedupe `outcome`. A second call returns `already_resolved_or_not_hypothetical`.
- **R and P/L:**
  - `r_gross = ±(exit − fill) / |fill − fill_stop|`;
  - `r_net = r_gross − cost_in_price / |fill − fill_stop|` (the spread + commission model of the order R:R gate);
  - `pnl_usd = r_gross × fill_risk_usd`. The quote→USD rate is the one at fill, a stated approximation;
  - `outcome_method = 'bar_replay_5m.v1'`.
- **Same logic as `position_book.py`:** the rules match it exactly (stop-first, bars after the fill), so the funnel book and attribution agree.

## 7. Historical records

No historical attribution rows are created, and no inferred field is written to an existing row. Links that are **certain** today (exact ids written by the code at the time), usable through a read-only view `legacy_trade_lineage`:

| Link | Key | Why certain |
|---|---|---|
| pending order → position | `paper_positions.source_pending_order_id` = order id | written by the Route 2 fill code (13 of the 39 $100k-period trades) |
| position → history | `paper_trade_history.source_position_row_id` / `position_id` | written by the settlement RPC / close code (5 + business id) |
| history → ledger | `paper_account_ledger.history_id` | written in the settlement transaction (since 10-05) |
| poll → order | `route2_poll_log.pending_id` = **order_id** (business id, despite the name) | written per poll |

**Not certain, not linked:**
- decision → order (time + stop-price heuristic only);
- historical `config_version` (the mapped 16-hex hash matches the change log only by timestamp);
- supersede chains (no link was ever written);
- Game Plan / verdict per order (null columns).

## 8. Tests

**PGlite (real Postgres)**
1. One signal end-to-end: decision → order → touch → confirm → real fill (position) → stop close via `settle_paper_position`. The same `signal_id` is on the decision, order, position, history and ledger; G is filled; the position is deleted; no unsettled event.
2. Supersede chain: A → B → C, both directions, terminal `superseded`; the CHECK refuses superseded-without-link.
3. Same-price refresh: order geometry changes → exactly one `refreshed_in_place` event with old / new; `stop_price` / `target_price` / `planned_lots` unchanged.
4. Cancelled order (direction flip) → `invalidated` with the reason; no F / G.
5. Expired order → `expired`.
6. Dry-run fill + replay: hypothetical fill → F; resolver on fixture bars (stop, target, same-bar tie → stop, gap-through, data gap → deferred, horizon); the second call is a no-op.
7. Real fill: `route2_claim_and_fill` with `signal_id` and `fill_sizing` → F + position link in one transaction; a lost race writes nothing.
8. Manual close → `manual`.
9. Stop close → `stop`, R = −1 at the fill stop.
10. Target close → `target`, R = ±(target − fill) / |fill − stop|.
11. Prop-firm emergency close → `prop_firm_emergency`.
12. Kill switch → `kill_switch`.
13. Reset flatten → `reset_flatten`. Legacy `reset_account` delete → `position_deleted_unsettled` event, G empty.
14. Config hash: `bot_configs.config_version` = the change log's `next_hash` for the same update (several JSON shapes).
15. Immutable rejection: UPDATE of any A–D column raises. DELETE / TRUNCATE raise.
16. Write-once rejection: a second different value raises; the same value or a NULL-guarded repeat is a no-op.

**TypeScript**
- The primary-engine rule table (impulse hard + IZ entry → `impulse_zone`; Unified present with modifiers off → contributor only).
- Contributor roles.
- Resolver pure function.
- Source checks: every `pending_orders` insert carries `signal_id`; the decision capture carries it; no code writes `trade_attribution` A–D after insert; `loadConfig` selects `config_version`.

Already exercised by the validation run: migration idempotent; hash equality; order link; refresh event without plan change; immutable / write-once / delete rejection; touch → confirm → hypothetical fill through the trigger; resolver once-only; supersede link; `signal_id` immutability.

## 9. Example: 77134ab8, full row + events

**Proposed row** (values from today's records; `signal_id` is illustrative, since none was minted then):

| Section | Field | Value |
|---|---|---|
| A | signal_id | `s-77134ab8` |
| | decision_id / scan_cycle_id | `185f6945-2200-4de3-97c6-de7e0c95358d` / that scan's cycle |
| | symbol / direction / dry_run | CHF/JPY / long / true |
| | decision_at | 2026-10-07T00:10:06Z |
| | config_version | `e3eb2e67b221fa1aeaae73a39270bb43` (stored config at 00:10) |
| | strategy_version | `smc-zone-impulse-control-v1` (at placement; no longer overwritten at fill) |
| | sizing / stop / management / caps | `fill_time_v1 (0.5%, ≤20 lots)` / `route2_limit_anchor_v1 (floor 25p, cap max(floor×1.5, leg×1.2))` / `none_v1` / `unified_3_1` |
| | risk_profile_version | NULL (profile activated 01:53:48) |
| | route | route2_pending_confirmation |
| B | primary_engine | `impulse_zone` (rule: IZ hard gate required + entry_source refinedEntry) |
| | contributors | smc_score scoring {raw 61.6, adjusted 63.35, threshold 20, log}; direction_verdict gate {long, 75%, agreement 0.5}; game_plan context {bearish, 36%, below_threshold, focus}; unified detected_only {null}; stop stop_source {floor}; confirmation_5m confirmation (from E) |
| C | impulse | detected; 1H; leg 189.9432–190.49909; zone OB 189.99417–190.14972, fib 0.786, refined 190.142885, score 3.5 |
| | gates | reaction log **would-block**; score log pass; rr_legacy log pass (2.13 on the legacy geometry); rr_order gate pass (1.00); ict_fvg off; news log pass; correlation pass (0.8); cooldown pass; consecutive-loss pass; caps 0/3 · 0/1 unified; P/D pass; direction pass |
| | risk_gate | `{active: false}` |
| | legacy_would_admit / logged_only_would_block | false / `{reaction}` |
| D | zone_id / entry_source / entry_depth | `CHF/JPY|1H|long|189.9942|190.1497` / refinedEntry / 0.55 |
| | limit / stop / target | 190.142885 / 189.892885 (floor, 25.0p, floor 25, cap 66.71) / 190.417885 |
| | market_anchored_stop | {189.93208, 21.08p, below_floor true} |
| | raw / effective R:R | 1.10 / 1.00 (cost 0.025) |
| | intended risk / planned lots | 0.5% · $500 / 3.16 |
| | supersedes_signal_ids | `{s-b25f637f}` |
| | expires_at | 08:10:06Z |
| E | order_id / order_placed_at | 77134ab8 / 00:10:06Z |
| | touched_at / confirmed_at | 01:25:01Z / 01:33:02Z (tier 3, bullish_reversal_pattern, 5m) |
| | terminal | hypothetical_fill · FILLED · 01:33:02Z |
| F | fill | hypothetical, 01:33:02Z @ 190.1643; stop 189.892885 (27.14p, inside_floor false); target 190.417885; 2.9177 → 2.91 lots; $498.67 (0.4987%); not capped |
| G | outcome | hypothetical, `bar_replay_5m.v1`; closed 08:00:00Z @ 189.892885; `hypothetical_stop`; R gross −1.00, net ≈ −1.09 (cost 0.025 / 0.27141); P/L −$498.67 |

**Events (in order):**
1. `order_inserted` 00:10:06
2. `touched` 01:25:01
3. 3 × min-window resets (01:26, 01:27, 01:29) are poll-log only: the order never left `awaiting_confirmation`, so no event
4. `filled` 01:33:02
5. `outcome_resolved` (resolver run after 08:00)

**Supersede chain:**
- `s-d11627e7` (23:50:09): superseded at 00:00:12 by `s-b25f637f`. Same price; float-equality artefact.
- `s-b25f637f` (00:00:12): superseded at 00:10:06 by `s-77134ab8`. Entry moved 190.099305 → 190.142885.

## 10. Measured impact

| | Today (measured 10-06 22:09 → 10-07 13:20) | Added by step 15 |
|---|---|---|
| Full scans | 6.1 / h ≈ 145 / day, 6 decisions each ≈ 870 decision rows / day, ~18.8 KB each ≈ **16 MB / day** | +16 bytes per decision (signal_id, set only on order-producing decisions) |
| Orders | ≈ 21 / day (dry run, uncapped by positions), ~27 KB per row ≈ 0.55 MB / day | **1 attribution row per order**, ~6–8 KB ≈ **0.15 MB / day** |
| Events | — | ~3–5 per order ≈ 60–100 rows / day, < 1 KB each |
| Poll log | ≈ 1,420 rows / day | unchanged (events are state changes only) |
| Schema | — | 2 tables, 6 columns, 1 generated column, 11 indexes, 6 triggers, 3 functions changed, 2 added |

**Latency:**
- one extra INSERT per placed order (~21 / day, ~10–30 ms) in a scan cycle that already takes seconds of provider I/O;
- decisions need no extra round trip (the id is generated in the function);
- fill and close add one indexed UPDATE inside the existing RPC transaction (sub-millisecond);
- the pending-order trigger costs a few comparisons per order update and writes only on state changes;
- the resolver is a separate 15-minute job reading only the DB.

**No meaningful latency is added to the live scanner.**

## Rollout (after approval)

1. **PR 1:** migration + RPC changes + PGlite tests. The user applies it in the SQL editor **before** merging any dependent code; inert until the code sends `signal_id`.
2. **PR 2:** bot-scanner + `attribution.ts` + `loadConfig config_version` + `route2_claim_and_fill` callers + source tests.
3. **PR 3:** the resolver function + cron.

Each PR reports its effect before merge. The account stays paused and locked throughout.
