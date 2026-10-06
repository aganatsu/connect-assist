# Unified vs Impulse — preserved before Unified stopped modifying trades (step 8)

Source: final pre-reset snapshot `research_snapshots/2026-10-06_pre_reset_final` (read-only).
Rows: `docs/exports/unified_vs_impulse_v1.csv`.

## What was compared

For every Route 2 order whose entry, stop and size came from Unified (`signalSource = unified`, or `entry_source = unified`) — **27 orders** — the table puts Unified's placed values next to the Impulse values the same setup would have used:

| Leg | Entry | Stop | Target |
|---|---|---|---|
| Unified | `entry_price` as placed | `stop_loss` as placed | `take_profit` as placed |
| Impulse | refined entry, else the zone midpoint | impulse origin (leg low for longs, high for shorts; `refinedSL` also recorded) | entry ± Impulse risk × the order's own target ratio |

## Results

| Measure | Value |
|---|---|
| Stop distance, Unified ÷ Impulse | **median 0.94**, range 0.26–2.39 |
| Entry difference, Unified − Impulse (signed in trade direction) | median −1.9 pips (FX); crypto rows use 0.01 "pips" and show large values |
| Unified orders that filled | 4: CHF/JPY TP +$1,146.27 · CHF/JPY TP +$527.69 · GBP/USD SL −$971.50 · CHF/JPY SL −$1,283.93 |

Size is not compared. Unified traded at 1.0× while standalone trades got 0.5×; step 9 replaces both with a flat 0.5% risk.

## From step 8 on

Unified is still detected on every scan:
- `detail.unifiedDetected` (state, score, confirmation, `modifiersApplied: false`);
- `detail.unifiedComparison` (both legs, entry difference, risk ratio);
- on dry-run orders, `dry_run_context.unifiedComparison`, plus `legacyGeometryDiffers`.

So Unified's effect stays measurable as its own arm.
