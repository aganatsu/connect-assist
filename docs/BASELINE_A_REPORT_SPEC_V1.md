# Baseline A strategy report — spec V1

Read-only measurement of the frozen production strategy, before any strategy change.
Code: `supabase/functions/_shared/baselineReport.ts` (pure metrics) · `local-runner/baseline-a-report.ts` (SELECT-only CLI) ·
`docs/BASELINE_A_REPORT_READONLY.sql` (SQL-editor subset, no MAE/MFE) · tests `supabase/tests/_shared/baselineReport.test.ts`.
Nothing here changes trading logic, config, scanner, cron, risk, schema or data.

```
deno run --allow-read --allow-net --allow-env local-runner/baseline-a-report.ts [--json]
# from a git worktree: LOCAL_RUNNER_ENV=<main checkout>/local-runner/.env.local deno run …
```

## Source of truth
`trade_attribution`: one row per placed Route 2 order, written in the same transaction as the order and kept current
by the lifecycle trigger (touch, confirmation, terminal, fill) and by settlement (close, P/L, R).
`trade_attribution_events` supplies resets. `smc_scan_bars` (5m, latest revision per bar — the outcome resolver's
`loadBars`) supplies MAE/MFE. `smc_scan_decision` supplies pre-order context only.
`paper_trade_history` is **not** used: settlement never copies the entry-telemetry columns
(`entry_stop_loss`, `initial_risk_*`, `realized_r_*`) into it, so they are NULL on settled rows.

## Cohorts (never pooled)
| Cohort | Filter |
|---|---|
| **Baseline A** | `dry_run = false` · `config_version = 1037e6170289f865e4d6618dcf28b94d` · `route = route2_pending_confirmation` · `primary_engine = impulse_zone` · `decision_at ≥ 2026-10-09 17:22:40.402828+00` (the unlock: `paper_accounts.entries_locked_at`) |
| **Historical dry-run context** | `dry_run = true` · `decision_at < unlock` (configs `1037e617…` and its equivalence class `3d5b8fb0…`) |
| excluded | everything else — counted, never measured |

The dry-run rows are **not** Baseline A: the 17-A fill re-anchor and the 17-B log-only TP gate applied to them only
(17-B from 2026-10-08 11:49Z; earlier dry-run decisions had the hard TP gate), position caps never bound (dry fills
create no positions), and their outcomes are 5m bar replays (stop wins a same-bar tie), not settlements.

## Metrics
- **Signal** = a placed Route 2 order (an attribution row). Funnel: orders → touched (first touch) → confirmed → fills → closed; open orders / open positions.
- **Rates** ÷ orders: touch, fill, invalidated, cancelled, expired (split `EXPIRED_NEVER_TOUCHED` / `EXPIRED_AFTER_TOUCH_NO_CONFIRMATION`), superseded, blocked (caps / risk gate / entries locked).
- **Outcomes** (closed with R): wins (R > 0), losses, breakeven, win rate; average gross R and net R; average win / loss.
  R = (exit − fill) / |fill − stop at fill| (direction-signed); net R subtracts `cost_in_price` (the order's spread + commission estimate).
  **Expectancy** = mean net R per closed trade (= win rate × avg win − loss rate × |avg loss|); gross shown beside it.
  **Realized P/L** = `realized_pnl_usd` = the ledger amount (real) / `pnl_usd` from the resolver (hypothetical).
- **MAE / MFE** in pips and R between fill and close, from stored 5m bars. Bar-granular upper bounds (the fill bar and the
  close bar can include price just outside the trade). A missing bar while the FX market was open → `gap`, reported, never averaged.
- **Risk**: intended vs at-fill risk ($, %, ratio); planned stop distance vs at fill; stop source; fills inside the floor.
- **Timing** (minutes, median · mean · n): decision→order, order→first touch, touch→confirmation, confirmation→fill, fill→close, decision→fill; resets per order (events).
- **Breakdowns**: by pair, entry source (`refinedEntry` / `zoneMid`), confirmation tier and type (confirmed orders only).

## Pre-order context
Per-scan decisions for the same window: counts by final status. `zone_setup_insert_failed` with
"Zone setup already active" is reported as **`redetection_of_active_order`** — the setup was re-detected while its order
sat in `awaiting_confirmation` (unique active-order index). It is neither a new signal nor a failure.
Refused setups (`zone_setup_rejected_*`, `skipped_tp_too_small`) are deduplicated **approximately** by
pair · direction · entry · status — decisions carry no zone id.

## Known limits
- Baseline A has no real orders at the time of writing; every Baseline A metric is n/a until it does.
- decision→order and confirmation→fill are ~0 by construction (the order is inserted in the deciding scan; a confirmed
  Route 2 fill happens at the confirmation instant). They are kept so a change in that wiring would show.
- touch time is the first touch; later touches are resets (events).
- net R uses the order's cost estimate, not a broker fill cost (paper account).
- Small samples: report n beside every number; do not read a rate off a handful of orders.

## Control B (design only — not implemented)
Baseline A = the current Impulse-zone entry (`refinedEntry`, else zone midpoint). Control B = the same system with
**one** variable changed: the entry-zone selection uses the OB/FVG confluence zone.
Identical in both arms: the signal stream (direction decision, all gates, and the impulse requirement kept as a signal
filter), the stop rules (limit-anchored chain, per-pair floor, 1.5× cap), TP ratio 1.1, the order R:R gate, 0.5%
fill-time sizing, 480-minute lifetime, 1.5× H1 ATR distance cap, the confirmation rules, caps, risk gates, config hash.
Limit price, stop distance and target then follow from the different entry through the same rules — a consequence of
the one variable, not a second one. Dropping the impulse requirement in Control B would change the signal set too
(a two-variable test).
Mechanism (later): paired — every Baseline A signal also yields a Control B entry, run as a live shadow (dry-run orders
under a separate bot id) because the Route 2 confirmation cannot be replayed from bars; both arms judged by the same
bar replay, Baseline A's real fills as a replay-fidelity check. Risk to resolve first: `detectFVGs` scans only the last
50 bars, so OB/FVG zone detection fidelity must be verified before any comparison is trusted.
