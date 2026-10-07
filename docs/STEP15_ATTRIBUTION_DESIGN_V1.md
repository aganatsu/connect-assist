# Step 15 — per-trade attribution: research and design (nothing built)

**Date:** 2026-10-07. Account paused and entries-locked; config `3d5b8fb0`.

**Supersedes:** `SMC_ATTRIBUTION_AND_CONFIG_VERSIONING_V1` (10-05). Its "primary engine = smc_core for every order" stopped being true at step 8: the score is now log-only, and the **Impulse hard gate is the required admission**.

**Method:**
- PostgREST schema of 12 tables;
- every column of current dry-run orders;
- the decision rows;
- the pre-reset snapshot (39 trades, 110 orders);
- the code paths that write each record.

## 1. Current attribution map

| Store | Key(s) | What it records today | Coverage / caveat |
|---|---|---|---|
| `smc_scan_decision` (one row per pair per full scan) | `id`, `scan_cycle_id`, `symbol` | direction inputs, the full **effective pairConfig** (incl. Game Plan context, HTF POIs), gate inputs, **gate outputs (raw pass/fail + text)**, portfolio/caps input, ICT judas/kill-zone, final status, score, SL/TP, `contract_version` | written **after** the order (00:10:15 vs order 00:10:06). Contains **no order id**. Gate results have **no gate id**, only text. `risk_input` / `session_news_input` are now null |
| `pending_orders` (130 columns, 58 filled on a dry-run order) | `id`, `order_id`, `zone_id`, `config_hash` | geometry, zone (type / bounds / refined / `entry_source`), `signal_reason` (14 KB: factorScores, tieredScoring, directionVerdict, impulseZone, sizing), `zone_story_at_*`, `frozen_strategy_*`, `exit_flags`, `dry_run_context` (switches, scoreGate, ictFVGGate, route2Stop, plannedSizing, orderRR, loggedOnlyWouldBlock, unified, **fillSizing / fillPrice** at fill), lifecycle timestamps, `terminal_reason` | **`candidate_id` 0 / 110**; `decision_context`, `game_plan_id`, `direction_verdict` all null. No scan / decision id |
| `paper_positions` | `id`, `position_id`, `order_id`, `source_pending_order_id` | copy of geometry + telemetry at fill; `entry_*` snapshots; `initial_risk_*` | `stop_loss` / `take_profit` / `size` / `signal_reason` are **mutated** by management afterwards |
| `paper_trade_history` | `position_id`, `source_pending_order_id`, `source_position_row_id` | outcome (`exit_price`, `pnl`, `pnl_pips`, `close_reason`, `realized_r_gross` / `net`) + the carried snapshot | **$100k period: 13 / 39 rows link to an order**, 14 / 39 have a strategy version, 8 / 39 a config snapshot. `stop_loss` = the stop **at close** (31 / 40 equal the exit) |
| `paper_account_ledger` | `settlement_key`, `position_row_id`, `history_id` | the money: amount, balance before / after, `source` (who closed) | complete since 10-05 (5 / 5 closes have `history_id`) |
| `route2_poll_log` | `pending_id` | every hunt poll: touch, zone exit, confirmation, branch | complete; per poll, not per lifecycle |
| `bot_config_change_log` | `next_hash` = md5(`config_json`) | every stored config version | complete |
| `bot_config_history` | `config_hash` (16-hex hash of the **mapped** config) | the mapped config per hash | a **different hash** from the change log; the two don't join (1:1 by time only) |
| `prop_firm_daily_state` / `_events` | `config_id`, `trading_day` | day-level risk state | not linked to any order |
| `close_audit_log`, `trade_reasonings` | `position_id` | close source / narrative | partial, legacy |

## 2. Gaps

**Missing**
- **No `signal_id`.** Nothing links the decision row to the order (`candidate_id` 0 / 110).
- **Superseded orders link to nothing:** 24 / 24 have no `superseded_candidate_id`, and the replacement order isn't recorded.
- **Config version is not the stored-config hash.** `pending_orders.config_hash` is a different function, computed (until step 14) before style overrides, so it described a config that never ran.
- No sizing / stop / management / risk-profile version, apart from the switches inside `dry_run_context`.
- **Step 13 risk-gate result per order:** only `gates_input.propFirmActive`.
- **Game Plan on the order:** `game_plan_id` null; the bias sits only in the decision row's pairConfig.
- **Correlation / cooldown / caps / news / spread / session:** text in `gates_output`, no ids.
- **Primary engine vs contributors:** not recorded. `signalSource "standalone"` is the only hint.
- **Dry-run outcome:** hypothetical fills never close, so they have no outcome, P/L or R.

**Duplicated / inconsistent**
- **Two scores for one decision:** gate "Score 61.6" vs `scoreGate.score` 63.35 (77134ab8). The second is after the direction-verdict adjustment; neither is labelled raw or adjusted.
- **Two R:R values:** the legacy gate shows "2.13 effective", from the confluence engine's pre-override geometry; the order's effective R:R is **1.00**.
- **Two config hashes** (above).
- `stop_loss` / `initial_stop_loss` / `entry_stop_loss` / `route2Stop.limit.sl`, and four places for the entry price.

**Overwritten later**
- **`strategy_version`** is replaced at fill: unfilled order 7014e1ab keeps `smc-zone-impulse-control-v1`; filled 77134ab8 shows `smc-route2-confirmation-lifecycle-v2`.
- **Same-level refresh** overwrites the order's `stop_loss` / `take_profit` / `size` / `signal_score` without touching `dry_run_context`, `config_hash` or the decision. 2 / 72 pre-reset orders had their stop overwritten; 0 dry-run orders so far.
- **Positions:** management overwrites `stop_loss` / `take_profit` / `size`, and writes `exitAttribution` into `signal_reason`.
- **`dry_run_context`** is extended at fill (the fill keys are added); nothing guards the decision keys.

**Where the chain breaks**

| Hop | Today | Break |
|---|---|---|
| decision → order | none (time ± symbol ± stop price heuristic) | **yes** |
| order → superseding order | none | **yes** |
| order → position | `source_pending_order_id` (Route 2) | ok for Route 2; market path had none |
| position → history | `source_pending_order_id`, `position_id`, `source_position_row_id` (5 / 39) | partial before 10-05 |
| history → ledger | `history_id` | ok since 10-05 |
| dry-run fill → outcome | none | **yes** |

## 3. Canonical object: `trade_attribution` (one row per trade lifecycle)

`signal_id uuid` is minted **once**, when the scanner evaluates a candidate. It is **the same id** used for the `smc_scan_decision` row: minted before either insert and passed to both. It then follows the lifecycle through `pending_orders.signal_id` → `paper_positions.signal_id` → `paper_trade_history.signal_id` → the ledger (via `history_id`).

Sections. **I** = immutable once the row exists. **W1** = write-once (NULL → value, never changed). **A** = append-only events.

**A. Identity and versions (I)**
- `signal_id`, `decision_id` (= `smc_scan_decision.id`), `scan_cycle_id`, `user_id`, `bot_id`, `symbol`, `direction`, `dry_run`;
- `decision_at` (closed strategy bar + wall clock);
- `config_version` = md5 of the stored `config_json` (the change-log hash), plus `config_hash_mapped` (the existing 16-hex);
- `strategy_version`;
- `sizing_version` (e.g. `fill_time_v1` + riskPercent / maxLots);
- `stop_version` (`route2_limit_anchor_v1` + floor / cap / anchor);
- `management_version` (`none_v1`: BE / trailing / partial / max-hold off);
- `risk_profile_version` (profile id + md5 of the threshold columns);
- `caps_version` (`unified 3/1`).

**B. Engines (I)**
- `primary_engine`: decided **by rule at decision time**, not inferred later. The engine whose hard gate was *required* for admission **and** that supplied the entry. Today: `impulse_zone` (IZ hard gate + `entry_source refinedEntry`). The future control arm is `ob_fvg`. `unified` only if Unified modifiers are on and Unified set the entry.
- `primary_engine_rule` version.
- `contributors jsonb`: `[{engine, role, value}]`, with role ∈ `gate | context | scoring | detected_only | stop_source | confirmation`. For example:
  - Unified `detected_only` (never "Unified trade" while modifiers are off);
  - Game Plan `context`;
  - SMC score `scoring` (log-only);
  - direction verdict `gate`.

**C. Decision evidence (I)**
- **Game Plan:** state on / off, bias, confidence, aligned / opposed / below-threshold, focus pair.
- **Impulse:** detected, selected TF, leg high / low, zone type / bounds / fib / refined entry / score.
- **OB/FVG / confluence zone:** source zone, type, bounds.
- **Unified:** detected, state, score, would-be entry / SL / risk (comparison only).
- **Score:** raw score, adjusted score, threshold, components (factorScores, tier counts).
- **Gate verdicts**, each `{gate_id, mode (gate | log | off), passed, would_block, reason}`:
  - score, news, ICT FVG, reaction, legacy R:R, order R:R;
  - direction, P/D, correlation, cooldown, consecutive-loss, conflict, spread, session;
  - caps (global and per symbol);
  - **step 13 risk gate** (allowed, daily loss, equity, thresholds).
- **Old vs new rules:** `legacy_would_admit`, `logged_only_would_block[]`.

**D. Order plan (I, set at placement)**
- entry depth used;
- limit price;
- stop (price, source swing / impulse / floor, distance pips, floor, cap);
- the old market-anchored stop;
- target;
- raw R:R, effective R:R after costs, cost in price;
- intended risk % and $;
- planned uncapped / final lots;
- `order_placed_at`, `expires_at`.

**E. Lifecycle (W1 columns + A events)**
- **W1:** `touched_at`, `confirmed_at` (tier / type / TF), `terminal_status` (`filled | hypothetical_fill | cancelled | expired | superseded | invalidated | blocked_risk_gate | blocked_caps | entries_locked`), `terminal_reason`, `terminal_at`, `superseded_by_signal_id`, `supersedes_signal_id`.
- **A** (`trade_attribution_events`, append-only): `refreshed_in_place` (old → new stop / target / size), re-arm / reset, prop-firm lock skip, and so on.

**F. Fill (W1)**
- `fill_kind` real / hypothetical;
- `filled_at`, fill price;
- stop distance at fill and its vs-floor flag (the open fill-floor policy);
- intended risk $;
- uncapped / final lots;
- actual risk % and $;
- cap reason;
- `position_row_id`.

**G. Close and outcome (W1)**
- `closed_at`, exit price;
- `exit_reason` (`stop | target | manual | prop_firm_emergency | kill_switch | reset_flatten | reverse_signal | hypothetical_stop | hypothetical_target | open_at_horizon`);
- `close_source` (the ledger source);
- realized P/L, realized R (gross from the initial stop, net after costs);
- `history_id`, `ledger_id`;
- `outcome_kind` real / hypothetical (+ `outcome_method` bar-replay version for dry run).

**Immutable vs mutable**
- **A–D:** insert-only.
- **E–G:** write-once columns, filled by the code path that owns that transition.
- **Refresh-in-place:** no longer silently overwrites the plan; the new geometry is an event, and the fill section records the geometry actually used.
- **Enforcement:** a `BEFORE UPDATE` trigger rejects any change to an I column, and any change to a W1 column that already has a value (same pattern as the dry-run immutability trigger, step 8).

## 4. How the record survives each path

| Path | What happens to the row |
|---|---|
| superseded order | old row: `terminal_status superseded`, `superseded_by_signal_id = new`. The new row's `supersedes_signal_id = old`. Both keep their own decision evidence |
| same-level refresh | same row; `refreshed_in_place` event with old → new stop / target / size; plan section (D) unchanged |
| cancelled (direction flip, thesis, impulse broken, zone exit) | `terminal_status cancelled` / `invalidated` + the terminal reason; no fill / close |
| expired | `expired` at the 8 h TTL |
| hypothetical dry-run fill | F with `fill_kind hypothetical`. G filled later by the outcome resolver (bar replay, the same rules as `position_book.py`) with `outcome_kind hypothetical` |
| real fill | F inside `route2_claim_and_fill` (same transaction as the position insert) |
| stop / target close | G inside `settle_paper_position` (same transaction as the ledger + history write), from the ledger source |
| manual close | same RPC; `close_source paper_trading_manual` → `exit_reason manual` |
| emergency / prop-firm / kill switch / reset flatten | same RPC; sources `prop_firm_emergency` / `kill_switch` / `account_reset_flatten` |
| partial TP (off in the freeze) | event + a partial ledger entry; G only at the final close |
| blocked at fill (caps, step 13 lock, entries locked) | `terminal_status blocked_*` or an event (the order may still expire) |

## 5. The comparisons it enables (all plain `GROUP BY`s, never pooled across `config_version`)

- **Impulse vs OB/FVG control:** `primary_engine`.
- **Game Plan aligned vs opposed vs below-threshold:** `gp_alignment`.
- **Unified present vs absent:** contributor `unified detected_only`.
- **Old-rule would-block vs new-rule admitted:** `legacy_would_admit`, `logged_only_would_block` gate ids.
- **Per pair, per route, per config version:** `symbol`, `route`, `config_version`.
- **Real vs hypothetical:** `outcome_kind`.

## 6. Migration impact

Additive only; no backfill of history (pre-step-15 rows stay as they are).
- **New tables:**
  - `trade_attribution`;
  - `trade_attribution_events`;
  - the I / W1 guard trigger;
  - RLS: service role writes, owner reads.
- **New columns:**
  - `signal_id` on `pending_orders`, `paper_positions`, `paper_trade_history`, `smc_scan_decision` (nullable, indexed);
  - `bot_configs.config_version` as a generated md5 column, the same expression as the change-log trigger, read with the config so the hash is exact.
- **RPC changes:**
  - `route2_claim_and_fill` writes F;
  - `settle_paper_position` writes G (+ copies `signal_id` to history).
- **New function:** a dry-run outcome resolver (Edge function + cron, read-only on prices) writing hypothetical G once.
- **Applied by hand before the dependent code is merged**, as with every migration in this project.

## 7. Code paths affected

- `bot-scanner`:
  - mint `signal_id` per evaluated candidate, put it in the decision capture;
  - order insert → attribution A–D;
  - supersede / refresh / cancel / expire / invalidation branches → E;
  - hunt touch / confirm / fill / dry-run fill / blocked → E / F;
  - the step 13 gate result into C.
- `_shared/route2FillClaim.ts` + the `route2_claim_and_fill` RPC.
- `_shared/paperSettlement.ts` + `settle_paper_position` / `settle_paper_partial`. This one change covers every close path: `paper-trading` (auto / manual / partial), the scanner breach check, reverse signal, prop-firm emergency, kill switch, reset flatten.
- A new `_shared/attribution.ts` (builders, primary-engine rule, version constants).
- The new resolver function.
- Not touched: zone-confirmation-scanner (off), IPO.

## 8. Example: a completed record for dry-run order 77134ab8 (CHF/JPY long), built from today's data

The decision was found **only by a time + stop-price heuristic**. That is exactly the break `signal_id` fixes.

```json
{
  "signal_id": "<minted at decision>",
  "decision_id": "185f6945-2200-4de3-97c6-de7e0c95358d",
  "symbol": "CHF/JPY", "direction": "long", "dry_run": true,
  "decision_at": "2026-10-07T00:10:06Z",
  "config_version": "e3eb2e67b221fa1aeaae73a39270bb43", "config_hash_mapped": "0d569b4ee88f2c60",
  "strategy_version": "smc-zone-impulse-control-v1 (placement) — overwritten to smc-route2-confirmation-lifecycle-v2 at fill today",
  "sizing_version": "fill_time_v1 (0.5%, max 20 lots)", "stop_version": "route2_limit_anchor_v1 (floor 25p, cap = max(floor×1.5, leg×1.2))",
  "management_version": "none_v1", "risk_profile_version": "inactive at decision (step 13 activated 01:53:48)", "caps_version": "unified 3/1",
  "route": "route2_pending_confirmation",
  "primary_engine": "impulse_zone",
  "contributors": [
    {"engine": "smc_score", "role": "scoring", "value": {"raw": 61.6, "adjusted": 63.35, "threshold": 20, "mode": "log"}},
    {"engine": "direction_verdict", "role": "gate", "value": {"verdict": "long", "confidence": 75, "agreement": 0.5}},
    {"engine": "game_plan", "role": "context", "value": {"bias": "bearish", "confidence": 36, "alignment": "below_threshold", "focus_pair": true}},
    {"engine": "unified", "role": "detected_only", "value": null},
    {"engine": "stop", "role": "stop_source", "value": "floor"},
    {"engine": "confirmation_5m", "role": "confirmation", "value": {"tier": 3, "type": "bullish_reversal_pattern"}}
  ],
  "impulse": {"detected": true, "tf": "1H", "leg": {"low": 189.9432, "high": 190.49909}, "zone": {"type": "OB", "low": 189.99417, "high": 190.14972, "fib": 0.786, "refined_entry": 190.142885, "score": 3.5}},
  "zone_id": "CHF/JPY|1H|long|189.9942|190.1497", "entry_source": "refinedEntry", "entry_depth": 0.55,
  "gates": [
    {"gate_id": "reaction", "mode": "log", "passed": false, "would_block": true},
    {"gate_id": "score", "mode": "log", "passed": true, "would_block": false},
    {"gate_id": "rr_legacy", "mode": "log", "passed": true, "note": "2.13 on legacy geometry"},
    {"gate_id": "rr_order", "mode": "gate", "passed": true, "effective_rr": 1.0},
    {"gate_id": "ict_fvg", "mode": "off", "would_block": false},
    {"gate_id": "news", "mode": "log", "passed": true},
    {"gate_id": "correlation", "passed": true, "threshold": 0.8},
    {"gate_id": "cooldown", "passed": true}, {"gate_id": "consecutive_losses", "passed": true},
    {"gate_id": "caps", "passed": true, "global": "0/3", "per_symbol": "0/1", "mode": "unified"},
    {"gate_id": "risk_profile", "passed": null, "note": "profile inactive at 00:10"}
  ],
  "legacy_would_admit": false, "logged_only_would_block": ["reaction"],
  "plan": {"limit": 190.142885, "stop": 189.892885, "stop_source": "floor", "stop_pips": 25.0, "floor": 25, "cap": 66.71,
           "market_anchored_stop": {"stop": 189.93208, "pips": 21.08, "below_floor": true},
           "target": 190.417885, "raw_rr": 1.10, "effective_rr": 1.00, "intended_risk_pct": 0.5, "intended_risk_usd": 500,
           "planned_lots": 3.16, "placed_at": "2026-10-07T00:10:06Z", "expires_at": "2026-10-07T08:10:06Z"},
  "lifecycle": {"touched_at": "2026-10-07T01:25:01Z", "confirmed_at": "2026-10-07T01:33:02Z", "terminal_status": "hypothetical_fill"},
  "fill": {"kind": "hypothetical", "at": "2026-10-07T01:33:02Z", "price": 190.1643, "stop_pips_at_fill": 27.14, "inside_floor": false,
           "uncapped_lots": 2.9177, "lots": 2.91, "actual_risk_usd": 498.67, "actual_risk_pct": 0.4987, "capped": false},
  "outcome": {"kind": "hypothetical", "method": "5m bar replay v1 (stop-first on ambiguous bars)", "exit_reason": "hypothetical_stop",
              "closed_at": "2026-10-07T08:00:00Z", "exit_price": 189.892885, "realized_r_gross": -1.0, "realized_pnl_usd": -498.67}
}
```
