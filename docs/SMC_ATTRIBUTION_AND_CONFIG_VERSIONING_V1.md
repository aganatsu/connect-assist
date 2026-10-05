# SMC attribution and config versioning — design V1

Status: **design.** Implementation is the PR *after* the settlement ledger:
it touches every entry path in bot-scanner and zone-confirmation-scanner, and
shipping it in the same release as the money-path change would make a fault
in either harder to isolate. No behaviour change: it only records.

## 1. What exists today (2026-10-05 snapshot, 34 trades since the $100k reset)

| Field (paper_trade_history) | Populated | Values |
|---|---|---|
| `entry_route` | 11/34 | `route2_pending` 9, `legacy_unknown` 2 |
| `strategy_name` / `strategy_version` | 9/34 | `smc-route2-confirmation-lifecycle…` 8, `smc-zone-impulse-control-v1` 1 |
| `entry_config_snapshot` | 6/34 | 16 keys (riskPerTrade, tpRatio, breakEvenEnabled, marketFillAtZone, …) |
| `entry_decision_snapshot` | 9/34 | setupId, zone bounds, zoneType |
| `initial_risk_price` / `realized_r_gross` | 9/34 | |
| config hash | **0/34** | — but `bot_config_change_log` has md5 `previous_hash`/`next_hash` for every change since 2026-07-31 |

The 34 trades opened under **10 different config hashes** (21 config changes
since 2026-09-15, derived in `research_snapshots/2026-10-05_pre_reset_v1/derived/config_timeline.json`).
Any one performance number for the period therefore mixes ten configurations.

## 2. Required on every signal, order and trade

Columns added (nullable, additive) to `paper_positions`, `pending_orders`,
`staged_setups`, `rejected_setups` and `paper_trade_history`. The history
copy is carried from the position by `carryToHistory`, which the settlement
RPC already writes.

| Column | Type | Source at decision time |
|---|---|---|
| `signal_id` | uuid | minted once per evaluated candidate in bot-scanner; the same id follows the candidate into staged_setups → pending_orders → position → history |
| `signal_timestamp` | timestamptz | the closed strategy bar the decision was made on (`strategy_bar_time` already exists on positions — reuse) |
| `primary_engine` | text | the engine that **initiated** — see §3 |
| `contributing_engines` | jsonb | `[{engine, version, role, value}]` for every engine that scored, gated, set the zone, set the entry, set SL/TP or sized |
| `strategy_engine` / `strategy_version` | text | exists; made mandatory (`smc` + a version string bumped on any logic change) |
| `execution_route` | text | `route1_market_at_zone` / `route2_pending_confirmation` / `watchlist_promotion` / `manual` (rename of `entry_route` semantics; `entry_route` kept for compatibility) |
| `config_version` | text | md5 of the exact `config_json` used for the decision — the same hash function as `bot_config_change_log.next_hash` |
| `symbol`, `timeframe`, `direction` | text | exist; `timeframe` = entry timeframe (`entry_zone_timeframe` today carries a zone label, not a timeframe — split them) |
| `entry_reason` | text | one-line human summary, e.g. "Route 2: 1H bullish OB refined by unified engine, CHoCH confirmation on 5m" |
| `contributing_factors` | jsonb | the scored factors that were present, with weights (from the analysis score breakdown) |
| `risk_model_version` | text | sizing + SL-floor logic version (`unifiedPositionSizing` + ATR floor flags) |
| `management_model_version` | text | BE / trailing / partial / max-hold logic version |

Closing side (on history, written by `settle_paper_position`): `close_engine`
(which code path closed: the ledger `source` already records it —
`scanner_breach_check`, `paper_trading_auto`, …) and `close_reason`.

## 3. Primary initiator vs contributors

An engine is the **primary initiator** only if, without it, no order would
have been placed. From the code:

- The base `impulseZoneEngine` is a gate + zone selector + SL override; it never places an order by itself.
- `unifiedZoneEngine` sets the Route 2 entry price when its zone exists.
- The SMC score/gate stack decides whether a candidate becomes an order.

So for current production, `primary_engine` is `smc_core` for every order. `contributing_engines` records the impulse gate result, the unified entry, the zone source (OB/FVG/IZ), the direction verdict and the confirmation method.

If an engine ever gains the ability to initiate on its own (a future independent Impulse strategy), it becomes the `primary_engine` of its own orders. Agreement from other engines then goes in `contributing_engines` with `role: "agreed"`. Overlap reporting reads exactly these two fields; nothing is inferred after the fact.

## 4. Config versioning

- `bot_configs` gets `config_version text GENERATED ALWAYS AS (md5(config_json::text)) STORED`. That is byte-for-byte the expression the existing change-log trigger uses for `next_hash` (`baseline_schema.sql:2641`), so a trade's version joins straight to the change log with no second hash implementation. Every write path that reads config for a decision stamps that value on the record.
- A performance query **must group by `config_version`** (or by an explicitly declared set of equivalent versions). The reporting view `smc_performance_by_config` returns one row per (engine, route, config_version) and never a pooled total across versions.
- Changes to target, break-even, instruments, thresholds, risk %, filters or engine settings all change the hash, because the hash covers the whole `config_json`.
- A trade is tied to its exact config by `config_version`. The full JSON is recoverable from `bot_config_change_log.next_config` where `next_hash = config_version`.

## 5. Tests to ship with it

- A PGlite test: a position → settle → history row carries every attribution column unchanged.
- A source assertion: every insert into `pending_orders` / `paper_positions` / `staged_setups` passes `signal_id`, `primary_engine`, `config_version`, `execution_route`.
- A PGlite test: `bot_configs.config_version` equals the `next_hash` the change-log trigger writes for the same update.
