# Step 17-A — Route 2 fill-floor re-anchor (DRY RUN ONLY): effect report

**Status:** built and tested; PR open, **not merged**.

**Unchanged:**
- the account stays $100,000, paused and entries-locked;
- **live fills unchanged**;
- no config, cron or resolver change; `skipped_tp_too_small` unchanged.

**Requires one migration**, applied by hand **before** merge (§5). Its SQL-editor package is prepared after you approve the migration approach.

## 1. Policy as implemented

**Approved 2026-10-08.** On a **dry-run** fill (the hunt's dry-run branch only):

| Case | Action |
|---|---|
| fill → planned stop **≥** the pair's floor | **nothing changes** |
| fill → planned stop **<** the floor | stop = fill ∓ floor; target = fill ± floor × 1.1; size at 0.5% on fill → new stop |

**Pair floors:** `MIN_SL_PIPS`, read per order from `route2Stop.floorPips` (recorded at placement): 25 pips GBP/USD, USD/JPY, CHF/JPY; 20 pips EUR/USD, NZD/CAD, NZD/CHF. The policy never tightens a stop.

**A re-anchor that would break an existing constraint is REJECTED.** The fill keeps its original geometry (today's behaviour) and is tagged with the reason:

| Reason | Meaning |
|---|---|
| `floor_unknown` | the order recorded no floor |
| `fill_through_stop` | the fill is at or beyond the planned stop (no valid geometry) |
| `exceeds_stop_cap` | the floor exceeds the order's recorded stop cap (`route2Stop.capPips`) |
| `order_rr_below_min` | the re-anchored order fails the **order-geometry R:R gate**: the same `orderEffectiveRR` and `< orderRRMin` (1.0) as placement |
| `sizing_unavailable` | fill-time sizing cannot be computed for the new stop |

**Known consequence of the R:R constraint:** a re-anchored order has effective R:R `1.1 − cost/floor` (zero commission in paper mode).

| Pair | Floor | Typical spread | Effective R:R after re-anchor | Outcome |
|---|---|---|---|---|
| EUR/USD | 20 | 1.0 | 1.05 | re-anchors |
| GBP/USD | 25 | 1.5 | 1.04 | re-anchors |
| USD/JPY | 25 | 1.0 | 1.06 | re-anchors |
| CHF/JPY | 25 | 2.5 | **exactly 1.00** | decided by the same floating-point `<` test as placement; any commission rejects it |
| **NZD/CAD** | 20 | 2.5 | **0.975** | **always rejected** (tagged) |
| **NZD/CHF** | 20 | 3.0 | **0.95** | **always rejected** (tagged) |

Under the approved constraints, inside-floor fills on the NZD pairs keep today's geometry, tagged `order_rr_below_min`. Changing that would mean changing the policy (e.g. a different target ratio for re-anchored fills) and needs a separate decision.

**The live fill path is untouched:**
- `route2_claim_and_fill` still uses the order's stop and `fillSizingRecord`;
- `dryRunFillGeometry` is called exactly once, in the dry-run branch (test-enforced).

## 2. What is recorded

| Where | What |
|---|---|
| `pending_orders` (dry-run fill) | `stop_loss` / `take_profit` = the geometry used (re-anchored or original); `fill_sizing` (re-sized when re-anchored; `stopDistancePips` = final distance; `insideFloor` = where the fill LANDED vs the planned stop, its Step 15 meaning) + `fill_sizing.reanchor`; `dry_run_context.fillReanchor` |
| `trade_attribution` section B (plan) | unchanged: planned stop / target at placement |
| `trade_attribution` section F (fill) | `fill_stop_price` / `fill_target_price` = the geometry used; `fill_stop_distance_pips` = final (the floor when re-anchored); `fill_inside_floor` = landed inside; `fill_risk_usd` / `fill_lots` from the re-sized record. **The Step 15 resolver measures the re-anchored geometry automatically** (it reads section F) |
| `trade_attribution_events` `filled` (**needs the migration**) | `detail.fill_sizing.reanchor`: `status`, `reason`, `plannedStop`, `plannedTarget`, `fillPrice`, re-anchored `stop` / `target`, `floorPips`, `fillToOriginalStopPips`, `stopDistancePips`, `rawRR` / `effectiveRR` / `costInPrice`, `riskUsd`, `version` |

## 3. Replay of the existing dry-run fills (10 since the reset; the audit's 8 + 2 new)

Read-only, through the shipped module, with spread-only cost as the dry run sees it:

| Order | Pair | Fill → planned stop | Floor | Result | New stop / target |
|---|---|---|---|---|---|
| 2dee2910 | USD/JPY short | 24.28 | 25 | **re-anchored, +0.72 pips** | 158.46184 / 157.93684 (eff. R:R 1.06) |
| 77134ab8 | CHF/JPY long | 27.14 | 25 | not needed | — |
| 02eb7948 | CHF/JPY long | 35.85 | 25 | not needed | — |
| bcf0216f | CHF/JPY short | 35.62 | 25 | not needed | — |
| 4d8eab45 | GBP/USD long | 20.05 | 25 | **re-anchored, +4.95** | 1.31925 / 1.32450 (1.04) |
| 896572f4 | GBP/USD long | 23.15 | 25 | **re-anchored, +1.85** | 1.31956 / 1.32481 (1.04) |
| 3758fd3a | GBP/USD long | 18.55 | 25 | **re-anchored, +6.45** | 1.31910 / 1.32435 (1.04) |
| 68a11a83 | GBP/USD long | 23.40 | 25 | **re-anchored, +1.60** | 1.31951 / 1.32476 (1.04) |
| 12d67535 | CHF/JPY short | 44.25 | 25 | not needed | — |
| 99d453eb | USD/JPY short | 27.26 | 25 | not needed | — |

**5 re-anchored, 5 not needed, 0 rejected.** No NZD fill has occurred yet.

### Counterfactual outcome

Read-only: Step 15 resolver on stored bars, recorded geometry vs re-anchored geometry. **Historical rows are not rewritten**; 17-A applies to new fills only.

| Order | Recorded geometry (live resolver, 06:22) | Re-anchored geometry |
|---|---|---|
| 2dee2910 | stop −1R (margin 1.34 pips) | stop −1R (margin 0.61) |
| 4d8eab45 | stop −1R at 06:05 | **still open** (wider stop not reached) |
| 896572f4 | stop −1R at 06:05 | stop −1R (margin **0.20 pips**) |
| 3758fd3a | stop −1R at 06:05 | **still open** |
| 68a11a83 | stop −1R at 06:05 | stop −1R (margin 0.60) |

- 2 of 5 stops would not (yet) have been hit; dollar risk per stop is identical (0.5%).
- **Not evidence of edge:** n = 5, one GBP/USD move, and the 2 survivors are open.

## 4. Live data seen while building

| Event | Detail |
|---|---|
| **The resolver made its first live writes** (06:22) | the 4 attributed GBP/USD fills resolved `hypothetical_stop` at the 06:05 bar: −1R gross each (net −1.06 to −1.08, about −$498 each); margins 2.05 / 2.05 / 2.05 / 1.30 pips |
| **16-B cap-book on real outcomes** | raw 6 fills, −4R, −$1,994; **cap-adjusted 3 fills, −1R, −$499**. The 3 later GBP/USD fills are `blocked_by_symbol_cap ← 088f22f7/4d8eab45`, so one zone is not counted 4 times |
| **16-E open item closed** | the 3 orders placed after the PATCH (201851fc, 99d453eb, 7e082298) carry `1037e617…` on the order and the attribution |

## 5. Migration (hand-applied before merge)

`supabase/migrations/20261009000000_step17a_fill_reanchor_attribution.sql`:
- **`CREATE OR REPLACE` of `pending_orders_attribution()`** with **one change**: a fill's terminal event detail gains `fill_sizing` (only when `status = 'filled'`).
- The rest of the function is byte-identical to `20261008010000` (diff-verified). Cancel / expiry event detail is unchanged (test).
- **`md5(prosrc)` pre-check value:** current (PR 2) `d50ec8a4fd3a12088c94929d78d43d25` → after `d5067c30cde71430a929504dc9e670d7`. The apply script will refuse to run unless production matches the PR 2 value.
- **Without the migration**, section F is still correct (the re-anchored geometry is in `fill_stop_price` / `fill_target_price`), but the event would lack the re-anchor record. Hence: migration first.

## 6. Tests

| Suite | What it covers |
|---|---|
| `step17aFillReanchor.test.ts` (12) | pair floors; not needed (incl. exactly at the floor); long non-JPY, short JPY, 20-pip pair re-anchors with exact stop / target / R:R; every rejection reason; the NZD/CAD (0.975) and NZD/CHF R:R conflict; the CHF/JPY boundary (incl. with commission); `dryRunFillGeometry` (re-sized, not needed untouched, sizing failure → rejected, R:R rejection keeps the original); **the 10-fill production replay**; wiring (dry-run branch writes stop / target / sizing / record; the live path has no re-anchor; one call site) |
| `paperSettlementLedger.test.ts` (+2, real Postgres with the migration) | re-anchored dry-run fill → section F = re-anchored geometry, section B = plan untouched, `filled` event carries the full re-anchor record; cancel event detail unchanged |
| Updated pins | step 8, step 9 and step 15 PR 2 wiring tests now read the whole dry-run branch; the step 9 pin now matches the new `dry_run_context` |

**Mutation check** (temporary, reverted):

| Mutation | Result |
|---|---|
| R:R check removed | 3 fail |
| target not recomputed | 3 fail |
| stop on the wrong side | 4 fail |

**Suites:** Deno **3,447 passed, 0 failed**; `deno check` clean.

## 7. Deploy order (after approval)

1. **SQL editor:** apply migration `20261009000000` with its pre-check, then the rolled-back verify and a read-only post-check (package prepared on approval).
2. **Merge** → bot-scanner deploys.
3. **Verify:** the next dry-run fill records `fill_sizing.reanchor` (on the order and in the `filled` event), with section F matching. When a fill lands inside the floor: the widened stop, the 1.1R target, and risk ≈ 0.5%.
