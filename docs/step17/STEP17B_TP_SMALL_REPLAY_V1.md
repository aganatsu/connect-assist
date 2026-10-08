# Post-MIN_TP_PIPS replay of the 18 TP-refused setups (bot-scanner, 2026-10-07 13:00Z → 2026-10-08 03:53Z)

READ-ONLY. All inputs are what the scanner stored (smc_scan_decision, smc_scan_context, smc_scan_manifest + smc_scan_bars, scan_logs.details_json, pending_orders, route2_poll_log, trade_attribution). Production shared functions are imported unmodified from the repo (`decideZone`, `reconstruct`, `calculateATR`, `pendingDistanceAtr`/`passesDistanceGuard`, `route2StopFromLimit`, `orderEffectiveRR`, `resolveSimplification`, `detectZoneConfirmation`, `resolveHypothetical`, `reanchorFill`). No market-data API was called.

## Summary counts

- Setups: **18** (92 refusal rows). Grouping (symbol, direction, gaps ≤ 30 min) reproduces 18: USD/JPY 6, NZD/CAD 6, GBP/USD 4, NZD/CHF 2.
- Would progress past the TP gate: **18/18** (log-only; nothing between the TP gate and the Route 2 branch can stop them — market branch impossible: `marketFillAtZone=false`, a bestZone always gives a limit).
- Still fail a later gate: **8/18**, all at the order-geometry R:R gate (`zone_setup_rejected_rr`): NZD/CAD ×6 (spread 2.5p vs 20p floor stop → effective R:R 0.975), NZD/CHF ×2 (spread 3p vs 20p → 0.95). 0 fail the distance guard, 0 fail stop geometry.
- Pass distance + stop + R:R: **10/18** (GBP/USD ×4, USD/JPY ×6; every row: stop = 25p/25p floor from the limit, effective R:R 1.04 GBP/USD, 1.06 USD/JPY).
- Of those 10, **would create a new hypothetical order: 6** (setups 1, 2, 3, 16, 17, 18); **4** create none because a real order for the same symbol/direction was live at every refusal scan (setups 4, 13, 14, 15: refreshed in place or duplicate on the unique-active index).
- Hypothetical orders: **6 certain + 1 conditional** (setup 18's second order exists only if its first was still `pending` at 01:00:18 — not reproducible).
- Reachability (limit touched within 480 min, validated rule): **7/7**; all touch in the creation bar or the bar before it (6 of 7 limits sit on the far side of price at creation: long limits ABOVE market).
- **Measurable production outcomes: 0.** The confirmation/fill step cannot be replayed faithfully from stored data (see fidelity F8), so fill and outcome are NOT reported as facts. Proxy outcomes are shown separately and labelled.

## Fidelity (done first)

| # | Step | Population | Result |
|---|---|---|---|
| F1 | Zone: `decideZone` on slots rebuilt from smc_scan_manifest + smc_scan_bars (digest-verified by production `reconstruct`) + stored htf_confluence / liquidity_pools / engine_args | 327 decisions with snapshots (92 TP + 139 known-outcome + 86 watching) | **327/327 MATCH** (hasZone, selectedTF, impulse hi/lo, bestZone type/high/low/refinedEntry/refinedSL/priceAtZone/priceAtZoneStrict/sideOk/totalScore/fibLevel/ltfRefined) |
| F2 | Route 2 path (stored bestZone): limit → branch → distance guard → `route2StopFromLimit` → `orderEffectiveRR` | `dry_run_setup_active` (placed) n=16 | status 16/16, limit 16/16, stop 16/16, target 16/16, stopSource 16/16, capPips 16/16, effRR 16/16 |
| F2 | Route 2 path (replayed bestZone): limit → branch → distance guard → `route2StopFromLimit` → `orderEffectiveRR` | `dry_run_setup_active` (placed) n=16 | status 16/16, limit 16/16, stop 16/16, target 16/16, stopSource 16/16, capPips 16/16, effRR 16/16 |
| F2 | Route 2 path (stored bestZone): limit → branch → distance guard → `route2StopFromLimit` → `orderEffectiveRR` | `analyzed` (refreshed in place) n=21 | status 21/21, limit 21/21, stop 21/21, target 21/21, stopSource 21/21, capPips 21/21, effRR 21/21 |
| F2 | Route 2 path (replayed bestZone): limit → branch → distance guard → `route2StopFromLimit` → `orderEffectiveRR` | `analyzed` (refreshed in place) n=21 | status 21/21, limit 21/21, stop 21/21, target 21/21, stopSource 21/21, capPips 21/21, effRR 21/21 |
| F2 | Route 2 path (stored bestZone): limit → branch → distance guard → `route2StopFromLimit` → `orderEffectiveRR` | `zone_setup_insert_failed` (duplicate) n=7 | status 7/7, limit 7/7, stop 7/7, target 7/7, stopSource 7/7, capPips 7/7, effRR 7/7 |
| F2 | Route 2 path (replayed bestZone): limit → branch → distance guard → `route2StopFromLimit` → `orderEffectiveRR` | `zone_setup_insert_failed` (duplicate) n=7 | status 7/7, limit 7/7, stop 7/7, target 7/7, stopSource 7/7, capPips 7/7, effRR 7/7 |
| F2 | Route 2 path (stored bestZone): limit → branch → distance guard → `route2StopFromLimit` → `orderEffectiveRR` | `zone_setup_rejected_distance` (distance) n=57 | status 57/57, distanceAtr 57/57 |
| F2 | Route 2 path (replayed bestZone): limit → branch → distance guard → `route2StopFromLimit` → `orderEffectiveRR` | `zone_setup_rejected_distance` (distance) n=57 | status 57/57, distanceAtr 57/57 |
| F2 | Route 2 path (stored bestZone): limit → branch → distance guard → `route2StopFromLimit` → `orderEffectiveRR` | `zone_setup_rejected_rr` (R:R) n=38 | status 38/38, limit 38/38, stop 38/38, target 38/38, stopSource 38/38, capPips 38/38, effRR 38/38 |
| F2 | Route 2 path (replayed bestZone): limit → branch → distance guard → `route2StopFromLimit` → `orderEffectiveRR` | `zone_setup_rejected_rr` (R:R) n=38 | status 38/38, limit 38/38, stop 38/38, target 38/38, stopSource 38/38, capPips 38/38, effRR 38/38 |
| F3 | Geometry vs the actual orders | 16 pending_orders created by these scans | **16/16** entry, stop, target, h1_atr_at_creation, pending_distance_atr, initial SL/TP (≤1e-9; all 82 detail comparisons and 57 distance values are bit-identical) |
| F4 | Impulse-origin stop candidate (bs:7412-7459 formula: leg buffer max(1p, 2% leg), cap max(floor×1.5, 1.2×leg)) | 166 rows where scan detail recorded `impulseZoneSLOverride` | **166/166** |
| F5 | Duplicate / refresh model: real order status timeline from route2_poll_log (unique index on pending/awaiting), same-level via exact/0.001-pip equality | 44 known placement outcomes (16 placed, 21 refreshed_in_place [logged as `analyzed`], 7 `zone_setup_insert_failed`) | **44/44** |
| F6 | The TP gate itself, recomputed from stored slFloor / impulseZoneSLOverride (tp = 1.1 × final stop) | 92 refusals | **92/92** (value to 0.1p and < min) |
| F7 | Reachability rule: first 5m bar from (creation bar − 1 bar) whose range reaches the limit | 24 real Route 2 orders with polls | **24/24** first-touch bar = production `zone_touch_bar_time` (only 14/24 if the pre-creation bar is excluded: production's first poll often reads the previous 5m bar as `lastCandle`) |
| F8 | Confirmation hunt, 5m-close approximation using production `detectZoneConfirmation` (no minute polls, no zone-exit resets, no thesis checks) | 10 real dry-run fills | **NOT FAITHFUL**: same 5m bar 6/10, within 5 min 7/10, exact fill price **0/10** (misses up to +2.6 h: 99d453eb approx 09:50 vs real 07:12) |
| F9 | `resolveHypothetical` on stored 5m bars | 4 real dry-run fills already resolved by production | **4/4** exit reason, R, exit price, close time |

Why F8 fails: the hunt runs every minute (route2_poll_log: ~1 poll/min) on the live 5m series including the forming bar, fills at the live `currentPrice`, and resets/re-arms on refined-zone exits minute by minute (3758fd3a re-armed 30 times in 3.7 h). Only closed 5m bars (plus one forming bar per 10-minute scan) are stored, so the minute path is unrecoverable. **Steps after the touch (confirmation, fill price/time, fill re-anchor, outcome) are therefore marked not reproducible for the 18.** Everything up to and including placement/duplicate state is reproduced exactly.

Data notes: every relevant decision has smc_scan_context + 10 manifest slots. All slots rebuild with matching digests except `context:1d`, which is one bar short in all 327 scans (299 vs 300) — the daily series is not read by the scalper zone slots or the Route 2 path, so nothing here depends on it. **Correction to the brief: weekly bars ARE stored** (manifest slot `context:1w`, 299–300 bars, digests match); weekly is only needed by swing/ICT paths, not this pipeline. 5m bars are retained continuously from 2026-10-06 11:00 to the latest scan (no gaps in any TTL window used).

## Code path replayed (line numbers = committed e55384b3, copy saved at /tmp/s17b/bot-scanner_e55384b3.ts; logic identical to the versions live in the window)

Note: the worktree currently has UNCOMMITTED edits to bot-scanner/index.ts, _shared/attribution.ts and new tpSmallGate.ts files made by another session during this run (not by this replay); none of the shared modules imported here is among them, and all line numbers below are from the committed file.

Deploys in the window (gh deploy-functions runs): d1915b5e 12:55Z → 0212a6af 17:16Z (attribution + atomic `route2_place_order`) → 148374be 19:21Z → 316e2c7d 23:35Z → 65d11baa 02:12Z → c847ac3f 02:37Z (same-level tolerance 0.001 pip instead of exact equality) → 45fb9a2a 03:08Z → 741ddde1 03:48Z. `git diff d1915b5e e55384b3` shows no change to smcZoneDecision, unifiedZoneEngine, impulseZoneEngine, smcAnalysis, smcScanSnapshot, route2Forward, route2StopGeometry, simplification, zoneConfirmation, confirmationHierarchy; bot-scanner changes in the window touch only attribution, supersede atomicity and same-level comparison — none changes an outcome here (all level comparisons are exactly equal or ≥ 1 pip apart).

Gates that precede the TP gate (already passed by these rows): Step 13 risk `runPropFirmGate` bs:3546 (cycle level); unified gate bs:6565-6596 and impulse hard gate bs:6630 (`skipped_no_impulse_zone`) / bs:6638 (`watching_zone`); zone score bs:6711; conflict/rejection gates bs:7092-7151; `runSafetyGates` (cooldown, caps, correlation, loss limits) bs:7227 with `allPassed` required at bs:7339. TP gate: bs:7671-7688.

After the TP gate, in order:
1. bs:7690-7743 portfolio correlation advisory — non-blocking (size only). bs:7753-7781 sizing — no gate.
2. bs:7863-7903 limit entry: `zoneEngineWillOverride` (hard + bestZone) → legacy `computeLimitEntryPrice` skipped; `bestZone.refinedEntry` if truthy else zone midpoint. Unified override requires `unifiedGatePassed`, which needs `unifiedModifiersEnabled` (false in every row) — 87 post-gate rows had Unified detected, modifiers off, and the replayed limit still matched production.
3. bs:7905-7969 branch: `useMarketFillAtZone = strict && sideOk && marketFillAtZone(false) && …` → always false; `effectiveLimitEnabled` = hard && limit → true; so never `market_entry_disabled` (bs:7957) / `dry_run_market_skipped` (bs:7965) for a setup with a bestZone.
4. bs:7987-7999 distance guard: `calculateATR(hourlyCandles,14)` on the 1h series the scanner fetched (= manifest slot `context:1h`, incl. forming bar), reject if > 1.5 ATR.
5. bs:8031-8061 `route2StopFromLimit` (swingSL = slFloor.slBeforeFloor, impulse candidate, floor = effectiveMinSlPips, tpRatio 1.1); `zone_setup_rejected_stop` only on invalid inputs.
6. bs:8070-8081 `orderEffectiveRR` (spread from SPECS.typicalSpread, commission 0 — `_avgCommissionPerLot` = 0 in every pairConfig, recorded costInPrice = spread only) `< orderRRMin` (1) → `zone_setup_rejected_rr`.
7. bs:8083-8116 limit sizing / fill-time planned sizing — never blocks.
8. bs:8122-8196 stale `pending` orders same symbol/direction: same level → refresh in place, no new order (decision logged as `analyzed`, `pendingOrder.action=refreshed_in_place`); moved level → superseded inside placement.
9. bs:8324-8372 attribution must build with a 32-hex config hash (only after 17:16Z) → else `attribution_invalid`; not observed in the window (no such status in 612 decisions; orders after 17:16Z all carry signal_id) — assumed to pass, unverified per row.
10. bs:8377-8402 `placeRoute2Order` (RPC): `attribution_write_failed`, `duplicate` → `zone_setup_insert_failed` "Zone setup already active" (unique index `idx_pending_orders_unique_active` on user/bot/symbol/direction where status in pending/awaiting_confirmation), other insert failure; else `dry_run_setup_active` (bs:8409).

## The 18 setups

| # | Symbol | Dir | First refusal | Last refusal | Refusals | Recorded TP pips (min–max) vs min | Refusals whose impulse stop sat inside the floor |
|---|---|---|---|---|---|---|---|
| 1 | GBP/USD | long | 2026-10-07T15:50:14Z | 2026-10-07T16:00:20Z | 2 | 8.7–14.2 vs 20 | 2/2 |
| 2 | GBP/USD | long | 2026-10-07T16:40:19Z | 2026-10-07T18:40:12Z | 12 | 10.2–19.3 vs 20 | 12/12 |
| 3 | GBP/USD | long | 2026-10-07T19:10:17Z | 2026-10-08T00:30:15Z | 29 | 11.0–19.4 vs 20 | 29/29 |
| 4 | GBP/USD | long | 2026-10-08T01:20:15Z | 2026-10-08T01:40:13Z | 3 | 11.3–12.0 vs 20 | 3/3 |
| 5 | NZD/CAD | short | 2026-10-07T18:50:14Z | 2026-10-07T20:00:22Z | 7 | 7.4–12.0 vs 12 | 7/7 |
| 6 | NZD/CAD | short | 2026-10-07T20:50:16Z | 2026-10-07T20:50:16Z | 1 | 11.3–11.3 vs 12 | 1/1 |
| 7 | NZD/CAD | short | 2026-10-07T21:20:21Z | 2026-10-07T21:40:13Z | 2 | 7.7–8.4 vs 12 | 2/2 |
| 8 | NZD/CAD | short | 2026-10-07T22:10:17Z | 2026-10-07T22:10:17Z | 1 | 11.7–11.7 vs 12 | 1/1 |
| 9 | NZD/CAD | short | 2026-10-07T23:50:16Z | 2026-10-08T00:50:14Z | 5 | 9.8–12.0 vs 12 | 5/5 |
| 10 | NZD/CAD | short | 2026-10-08T01:20:15Z | 2026-10-08T01:40:13Z | 3 | 7.8–9.8 vs 12 | 3/3 |
| 11 | NZD/CHF | long | 2026-10-07T14:20:14Z | 2026-10-07T14:20:14Z | 1 | 6.8–6.8 vs 12 | 1/1 |
| 12 | NZD/CHF | long | 2026-10-07T15:00:20Z | 2026-10-07T15:10:13Z | 2 | 11.0–11.2 vs 12 | 2/2 |
| 13 | USD/JPY | long | 2026-10-07T13:00:18Z | 2026-10-07T13:00:18Z | 1 | 17.8–17.8 vs 20 | 1/1 |
| 14 | USD/JPY | long | 2026-10-07T14:00:22Z | 2026-10-07T14:00:22Z | 1 | 18.6–18.6 vs 20 | 1/1 |
| 15 | USD/JPY | long | 2026-10-07T14:50:13Z | 2026-10-07T14:50:13Z | 1 | 8.1–8.1 vs 20 | 1/1 |
| 16 | USD/JPY | long | 2026-10-07T15:30:29Z | 2026-10-07T16:10:12Z | 4 | 6.7–14.8 vs 20 | 4/4 |
| 17 | USD/JPY | long | 2026-10-07T21:50:16Z | 2026-10-07T23:00:20Z | 8 | 7.9–18.8 vs 20 | 8/8 |
| 18 | USD/JPY | long | 2026-10-08T00:50:14Z | 2026-10-08T02:20:14Z | 9 | 4.4–16.7 vs 20 | 9/9 |

Why the TP gate fired (F6): the legacy market stop is the Impulse-origin override, which replaces the floor-widened stop whenever it is wider than the *pre-floor* swing stop (bs:7460 compares with `actualSlDistance`, measured before the floor). In all 92 refusals the override was applied AND was narrower than the floor (e.g. 16.8p vs a 25p floor on USD/JPY), so tp = 1.1 × that stop fell under MIN_TP_PIPS; with the floor stop instead, tp ≥ 1.1 × floor (27.5p / 22p) would have cleared every MIN_TP_PIPS value involved. The Route 2 order re-runs the stop from its own limit and lands on the floor, so its target is never that small.

## Per-setup result

| # | Symbol | Later gate | Route 2 geometry (first refusal) | Duplicate / refresh vs real orders | New hypothetical order? | Reached limit in TTL | Confirmation / fill / outcome |
|---|---|---|---|---|---|---|---|
| 1 | GBP/USD long | none | limit 1.322245 (zoneMid), stop 1.319745 (floor, 25.0p), target 1.324995, eff R:R 1.040 (spread 1.5p), dist 1.03 ATR | NEW ORDER ×1; own order live → no new order (else not reproducible) ×1 | Yes — at refusal #1 (15:50:14Z) | 15:50:14Z: yes, bar 15:50 (or the bar before) | not reproducible (F8) |
| 2 | GBP/USD long | none | limit 1.322245 (zoneMid), stop 1.319745 (floor, 25.0p), target 1.324995, eff R:R 1.040 (spread 1.5p), dist 0.81 ATR | NEW ORDER ×1; own order live → no new order (else not reproducible) ×10; duplicate of real order ×1 | Yes — at refusal #1 (16:40:19Z) | 16:40:19Z: yes, bar 16:40 (or the bar before) | not reproducible (F8) |
| 3 | GBP/USD long | none | limit 1.322245 (zoneMid), stop 1.319745 (floor, 25.0p), target 1.324995, eff R:R 1.040 (spread 1.5p), dist 0.44 ATR | duplicate of real order ×7; refreshed real order ×11; NEW ORDER ×1; own order live → no new order (else not reproducible) ×10 | Yes — at refusal #19 (22:50:15Z) | 22:50:15Z: yes, bar 22:50 (or the bar before) | not reproducible (F8) |
| 4 | GBP/USD long | none | limit 1.322245 (zoneMid), stop 1.319745 (floor, 25.0p), target 1.324995, eff R:R 1.040 (spread 1.5p), dist 1.05 ATR | duplicate of real order ×3 | No | n/a | not reproducible (F8) |
| 5 | NZD/CAD short | **zone_setup_rejected_rr** on all 7 rows (eff R:R 0.975 < 1) | limit 0.799260 (zoneMid), stop 0.801260 (floor, 20.0p), target 0.797060, eff R:R 0.975 (spread 2.5p), dist 0.40 ATR | n/a | No | n/a | n/a |
| 6 | NZD/CAD short | **zone_setup_rejected_rr** on all 1 rows (eff R:R 0.975 < 1) | limit 0.799260 (zoneMid), stop 0.801260 (floor, 20.0p), target 0.797060, eff R:R 0.975 (spread 2.5p), dist 0.84 ATR | n/a | No | n/a | n/a |
| 7 | NZD/CAD short | **zone_setup_rejected_rr** on all 2 rows (eff R:R 0.975 < 1) | limit 0.799260 (zoneMid), stop 0.801260 (floor, 20.0p), target 0.797060, eff R:R 0.975 (spread 2.5p), dist 0.45 ATR | n/a | No | n/a | n/a |
| 8 | NZD/CAD short | **zone_setup_rejected_rr** on all 1 rows (eff R:R 0.975 < 1) | limit 0.799260 (zoneMid), stop 0.801260 (floor, 20.0p), target 0.797060, eff R:R 0.975 (spread 2.5p), dist 0.89 ATR | n/a | No | n/a | n/a |
| 9 | NZD/CAD short | **zone_setup_rejected_rr** on all 5 rows (eff R:R 0.975 < 1) | limit 0.799260 (zoneMid), stop 0.801260 (floor, 20.0p), target 0.797060, eff R:R 0.975 (spread 2.5p), dist 0.93 ATR | n/a | No | n/a | n/a |
| 10 | NZD/CAD short | **zone_setup_rejected_rr** on all 3 rows (eff R:R 0.975 < 1) | limit 0.799260 (zoneMid), stop 0.801260 (floor, 20.0p), target 0.797060, eff R:R 0.975 (spread 2.5p), dist 0.73 ATR | n/a | No | n/a | n/a |
| 11 | NZD/CHF long | **zone_setup_rejected_rr** on all 1 rows (eff R:R 0.950 < 1) | limit 0.465435 (zoneMid), stop 0.463435 (floor, 20.0p), target 0.467635, eff R:R 0.950 (spread 3p), dist 0.18 ATR | n/a | No | n/a | n/a |
| 12 | NZD/CHF long | **zone_setup_rejected_rr** on all 2 rows (eff R:R 0.950 < 1) | limit 0.465435 (zoneMid), stop 0.463435 (floor, 20.0p), target 0.467635, eff R:R 0.950 (spread 3p), dist 0.78 ATR | n/a | No | n/a | n/a |
| 13 | USD/JPY long | none | limit 158.163890 (refinedEntry), stop 157.913890 (floor, 25p), target 158.438890, eff R:R 1.060 (spread 1p), dist 0.40 ATR | refreshed real order ×1 | No | n/a | not reproducible (F8) |
| 14 | USD/JPY long | none | limit 158.163890 (refinedEntry), stop 157.913890 (floor, 25p), target 158.438890, eff R:R 1.060 (spread 1p), dist 0.44 ATR | refreshed real order ×1 | No | n/a | not reproducible (F8) |
| 15 | USD/JPY long | none | limit 158.145985 (zoneMid), stop 157.895985 (floor, 25p), target 158.420985, eff R:R 1.060 (spread 1p), dist 0.02 ATR | duplicate of real order ×1 | No | n/a | not reproducible (F8) |
| 16 | USD/JPY long | none | limit 158.144970 (refinedEntry), stop 157.894970 (floor, 25p), target 158.419970, eff R:R 1.060 (spread 1p), dist 0.12 ATR | duplicate of real order ×3; NEW ORDER ×1 | Yes — at refusal #4 (16:10:12Z) | 16:10:12Z: yes, bar 16:10 (or the bar before) | not reproducible (F8) |
| 17 | USD/JPY long | none | limit 158.145985 (zoneMid), stop 157.895985 (floor, 25p), target 158.420985, eff R:R 1.060 (spread 1p), dist 0.44 ATR | NEW ORDER ×1; own order live → no new order (else not reproducible) ×7 | Yes — at refusal #1 (21:50:16Z) | 21:50:16Z: yes, bar 21:50 (or the bar before) | not reproducible (F8) |
| 18 | USD/JPY long | none | limit 157.680425 (zoneMid), stop 157.430425 (floor, 25p), target 157.955425, eff R:R 1.060 (spread 1p), dist 0.18 ATR | NEW ORDER ×1; level moved, not reproducible ×1; own order live → no new order (else not reproducible) ×2; duplicate of real order ×4; refreshed real order ×1 | Yes — at refusal #1 (00:50:14Z); +1 conditional | 00:50:14Z: yes, only via the pre-creation bar (validated rule: first poll arms it); 01:00:18Z (conditional): yes, bar 01:00 (or the bar before) | not reproducible (F8) |

Notes per setup:
- GBP/USD 1–4 all use the same zone and the identical limit 1.322245 / stop 1.319745 / target 1.324995 as the real dry-run orders 4d8eab45, 896572f4, 3758fd3a (68a11a83 differs only in stop 1.31967); all four filled via real confirmation and stopped out at −1R. Setup 1 (15:50Z) and setup 2 (16:40Z) would each create an order on their first refusal because no GBP/USD long order was live then; setup 3 creates one only at its 19th refusal (22:50:15Z) after 3758fd3a filled at 22:42Z; setup 4 is a duplicate of 68a11a83 (awaiting confirmation) on all 3 rows. **Cross-setup caveat:** each setup is evaluated against the REAL order timeline. If setup 1's order had been placed it would still be live (same level) at setup 2's and possibly setup 3's scans, making them refreshes/duplicates, and it would also have turned the real placements at 18:10/18:50/19:00/01:10Z into refreshes/duplicates. Whether it was still live depends on its confirmation/fill (not reproducible).
- USD/JPY 13 and 14: limit 158.16389 = the live real order 578bd39c (pending) → refreshed in place with identical stop/target: no new order. Setup 15: 578bd39c was awaiting confirmation at 14:50Z → duplicate. Setup 16: rows 1–3 (first row limit 158.14497 refinedEntry, then 158.145985 zoneMid) duplicate of 146c5890 (awaiting); row 4 (16:10:12Z) creates an order at 158.145985 after 146c5890 was cancelled (impulse broken) at 16:09Z. Setup 17: creates an order at its first refusal (21:50:16Z, limit 158.145985). Setup 18: creates an order at 00:50:14Z (limit 157.680425, the only limit on the near side of price); at 01:00:18Z the level moved to 157.9145925 — a second order superseding the first if the first was still `pending`, a duplicate if it was `awaiting_confirmation` (the validated touch rule says the 00:45 bar already reached 157.680425, so the first poll would have armed it; its state at 01:00 is not reproducible).
- After an order is created, later refusals in the same setup are at the same level: no additional order while that order is live (refresh if pending, duplicate if awaiting); if it had already filled/cancelled, a new order — not reproducible.

## Counterfactual outcome

Production behaviour after placement: touch → `awaiting_confirmation` → minute-level `detectZoneConfirmation` hunt → fill at the live price (dry run: hypothetical fill + Step 17-A re-anchor) → `resolveHypothetical`. Only the touch is reproducible (F7). **No fill, fill price, or outcome below is a production fact.**

| Setup | Order created | Limit | Live until | Touched (validated rule) | Approx 5m confirmation (NOT production) | Proxy A: fill at limit on touch | Proxy B: fill at touch-bar close | Proxy C: fill at approx confirmation |
|---|---|---|---|---|---|---|---|---|
| 1 | 10-07T15:50:14Z | 1.322245 | 10-07T23:50Z (TTL) | yes | confirmed_approx 10-07T18:25 | fill 1.322245 @ 10-07T15:50Z, reanchor not_needed, hypothetical_stop -1R gross / -1.06R net | fill 1.320560 @ 10-07T15:55Z, reanchor reanchored, pending: no stop / target touch yet | fill 1.321640 @ 10-07T18:25Z, reanchor reanchored, pending: no stop / target touch yet |
| 2 | 10-07T16:40:19Z | 1.322245 | 10-08T00:40Z (TTL) | yes | confirmed_approx 10-07T18:25 | fill 1.322245 @ 10-07T16:40Z, reanchor not_needed, hypothetical_stop -1R gross / -1.06R net | fill 1.320880 @ 10-07T16:45Z, reanchor reanchored, pending: no stop / target touch yet | fill 1.321640 @ 10-07T18:25Z, reanchor reanchored, pending: no stop / target touch yet |
| 3 | 10-07T22:50:15Z | 1.322245 | 10-08T06:50Z (TTL) | yes | confirmed_approx 10-07T22:55 | fill 1.322245 @ 10-07T22:50Z, reanchor not_needed, hypothetical_stop -1R gross / -1.06R net | fill 1.321670 @ 10-07T22:55Z, reanchor reanchored, pending: no stop / target touch yet | fill 1.321670 @ 10-07T22:55Z, reanchor reanchored, pending: no stop / target touch yet |
| 16 | 10-07T16:10:12Z | 158.145985 | 10-08T00:10Z (TTL) | yes | impulse_broken_approx 10-07T18:45 | fill 158.145985 @ 10-07T16:10Z, reanchor not_needed, hypothetical_stop -1R gross / -1.04R net | fill 158.037340 @ 10-07T16:15Z, reanchor reanchored, hypothetical_stop -1R gross / -1.04R net | — |
| 17 | 10-07T21:50:16Z | 158.145985 | 10-08T05:50Z (TTL) | yes | impulse_broken_approx 10-08T00:15 | fill 158.145985 @ 10-07T21:50Z, reanchor not_needed, hypothetical_stop -1R gross / -1.04R net | fill 158.082290 @ 10-07T21:55Z, reanchor reanchored, hypothetical_stop -1R gross / -1.04R net | — |
| 18 | 10-08T00:50:14Z | 157.680425 | 10-08T01:00Z if superseded at 01:00:18Z (only if still pending; else TTL) | yes | no touch from creation bar | — | — | — |
| 18 (conditional) | 10-08T01:00:18Z | 157.914592 | 10-08T09:00Z (TTL) | yes | impulse_broken_approx 10-08T01:15 | fill 157.914592 @ 10-08T01:00Z, reanchor not_needed, hypothetical_target 1.10R gross / 1.06R net | fill 157.820280 @ 10-08T01:05Z, reanchor reanchored, hypothetical_target 1.10R gross / 1.06R net | — |

Proxy A ("fill at the limit on first touch") is NOT production behaviour, and for the 6 orders whose limit was already through price at creation it is not even an upper bound (a long limit above market fills at the limit only if price comes back up to it). Proxy B/C use `reanchorFill` (fill inside the 25p floor → stop/target re-anchored) and the production resolver; "pending" means neither level touched by the last stored bar. The real same-level GBP/USD orders (same limit/stop/target) filled via real confirmation and all four stopped out at −1R (production resolver, reproduced 4/4 in F9) — context, not a counterfactual.

## Assumptions and limits (explicit)

- Inputs: the per-pair scan detail in scan_logs (joined on __meta.scan_cycle_id + pair; 612/612 decisions joined, status 612/612 equal) supplies lastPrice, slFloor.slBeforeFloor / effectiveMinSlPips / staticMinSlPips and the impulse leg; the replayed `decideZone` bestZone is identical to the stored one on all rows (F1), so both give the same result.
- pairConfig = smc_scan_decision.confluence_input.pairConfig (the effective per-pair config; all rows: impulseZoneGateMode hard, marketFillAtZone false, limitOrderEnabled false, tpRatio 1.1, slBufferPips 1, legStopBufferPct 0.02, legStopCapMultiple 1.2, impulseSlCapMultiplier 1.5, simplification {stopAnchor limit, rrGateMode order_geometry, orderRRMin 1, unifiedModifiersEnabled false, marketEntriesEnabled false, dryRunWhenLocked true}). `config.marketFillAtZone` / `config.tpRatio` (global) are assumed equal to the pairConfig values (Step 14 explicit config); the replay matched production on all 139 known rows under that assumption.
- Placement timing: the order is written between smc_scan_context.scanned_at and the decision flush; real-order state was evaluated at both instants and agreed on every row.
- Real orders' pending/awaiting state comes from route2_poll_log transitions (exact to the poll), terminal times from pending_orders.
- Hypothetical order state after a touch is unknown (refresh vs duplicate does not change the "no new order" answer, but a fill/cancel before the next scan would).
- Attribution (config hash) assumed valid for rows after 17:16Z (no attribution_invalid anywhere in the window); rows before 17:16Z ran code without that step.
- Second-order effects (a hypothetical order changing later real decisions, Telegram, cap books, `hypotheticalCapBook`) are not modelled.

Scripts: /tmp/s17b/q.py, group.py, fetch_bars.py, load.py, replay.ts, fidelity.py, placement.py, setups_eval.py, sequence.py, hunt.ts, resolver_check.ts, assemble.py. Data snapshots in /tmp/s17b/data/. Machine-readable: /tmp/s17b/replay_results.json.
