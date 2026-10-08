# Step 17-B — `skipped_tp_too_small` log-only in the locked dry run: effect report

**Status:** built and tested; PR open, **not merged**.

**No migration. Nothing else changes:**
- no config, cron or resolver change;
- no fill-floor change and no live fill-path change;
- the account stays $100,000, paused and entries-locked.

## 1. Exact code path changed

`supabase/functions/bot-scanner/index.ts`, the Minimum TP distance gate (committed e55384b3: bs:7671-7688):

| | Before | After |
|---|---|---|
| Measurement | `actualTpPips = |tp − lastPrice| / pip` vs `MIN_TP_PIPS[pair] ?? 12` | **unchanged** (same table, same measurement) |
| Dry run active (`account.entries_locked && simp.dryRunWhenLocked`, bs:2571) | `skipped_tp_too_small` + `continue` | **not blocked:** `detail.tpTooSmall = {gateId "tp_too_small", wouldBlock true, mode "log", symbol, tpPips, minTpPips, basis "legacy_market_target_from_last_price", reason}`, and `tp_too_small` appended to `detail.loggedOnlyGates`. The setup continues |
| Dry run NOT active (unlocked / live) | `skipped_tp_too_small` + `continue` | **identical:** the same statements, verbatim, behind `if (tpGate.block)` |

The decision is in `_shared/tpSmallGate.ts` (`evaluateTpSmallGate`): `block = tpPips < minTpPips && !dryRunActive`. The gate is **not removed**.

**Every later gate still applies, unchanged** (test-enforced order; none reads the tag):
1. market-entry refusal (`market_entry_disabled`);
2. the 1.5 × H1 ATR distance guard;
3. `route2StopFromLimit`;
4. the order-geometry R:R gate (`zone_setup_rejected_rr`);
5. the duplicate / refresh logic;
6. attribution fail-closed;
7. placement.

Safety gates, caps, correlation, cooldown, Step 13 risk and the Impulse hard gate all run **before** the TP gate, so they are untouched.

## 2. Tagging (existing structures; no migration)

| Record | What it gets |
|---|---|
| `smc_scan_decision.final_decision` | `tpTooSmall` **only when present** (untagged decisions keep exactly their previous shape and hash) |
| `pending_orders.dry_run_context` | `tpTooSmall` (null unless tagged); `loggedOnlyWouldBlock` includes `tp_too_small` |
| `trade_attribution.gates` | a verdict `{gate_id "tp_too_small", mode "log", passed false, would_block true, reason, tp_pips, min_tp_pips, basis}` |
| `trade_attribution.logged_only_would_block` | includes `tp_too_small` |
| `trade_attribution.legacy_would_admit` | `false` (the old rule would have refused) |
| Identity | symbol, direction, `decision_id`, `signal_id`, `scan_cycle_id` on the row as before |

A real-Postgres test places a tagged dry-run order through `route2_place_order` and reads all of this back from the production schema, so no column is missing.

**Reporting:** the counterfactual cohort is `'tp_too_small' = ANY(logged_only_would_block)` (or the `tp_too_small` gate verdict). Its resolver outcomes can be compared separately from the frozen cohort. The 16-B cap-book already reports per row; filtering on the tag needs no code change.

## 3. Replay of the 18 historical setups

Full report: `docs/step17/STEP17B_TP_SMALL_REPLAY_V1.md`.

**Method:**
- read-only; production shared functions run on what the scanner stored (bars by first-seen time, the zone-engine inputs in `smc_scan_context`, the per-pair config, the real order timeline);
- window: 2026-10-07 13:00 → 2026-10-08 03:53 UTC;
- **fidelity proved first**, on decisions with known outcomes.

### Fidelity

| Step | Population | Match |
|---|---|---|
| zone (`decideZone`) | 327 decisions | **327/327** |
| Route 2 path (limit → branch → distance → stop → R:R) | 139 known outcomes (16 placed, 21 refreshed, 7 duplicates, 57 distance, 38 R:R) | **100%**, bit-identical |
| geometry vs actual orders | 16 orders | **16/16** |
| duplicate / refresh model | 44 placements | **44/44** |
| TP-gate value recomputed | 92 refusals | **92/92** |
| reachability rule | 24 real orders | **24/24** |
| confirmation / fill (hunt) | 10 real fills | **NOT faithful** (same 5-min bar 6/10, fill price 0/10). The hunt runs every minute on the live series; only scan-time bars are stored |

### Result

| | Setups | Detail |
|---|---|---|
| Distinct setups (92 refusal rows) | **18** | USD/JPY 6, NZD/CAD 6, GBP/USD 4, NZD/CHF 2 |
| Would progress past the TP gate | **18** | nothing between the TP gate and the Route 2 branch can stop them |
| **Still fail a later gate** | **8** | **all at the order-geometry R:R gate:** NZD/CAD ×6 (2.5-pip spread on a 20-pip floor stop → effective R:R 0.975) and NZD/CHF ×2 (3.0 on 20 → 0.95). The same arithmetic as the 17-A NZD finding |
| Pass distance + stop + R:R | **10** | GBP/USD ×4, USD/JPY ×6. Stop = the 25-pip floor from the limit; effective R:R 1.04 / 1.06; distance 0.02–1.29 H1 ATR |
| **Would create a new hypothetical order** | **6** (+1 conditional) | setups 1, 2, 3, 16, 17, 18. Setup 3 only at its 19th refusal; setup 16 at its 4th. Setup 18's second order depends on an order state that cannot be reproduced |
| No new order | 4 | a real order for the same symbol + direction was live at every refusal (refresh in place / duplicate) |
| Reach their limit within the 480-min TTL | **7/7** | validated touch rule |
| **Measurable production outcomes** | **0** | confirmation / fill cannot be replayed faithfully, so **no outcome is presented as fact**. Proxy outcomes (fill at limit on touch, etc.) are in the replay report, clearly labelled |

**Why the gate fired** (all 92 refusals): the legacy market stop was the impulse-origin override, wider than the pre-floor stop but narrower than the floor. The legacy target (1.1 × that stop, measured from price) fell under the minimum. A Route 2 order at the floor would have cleared it.

**Interaction caveat:**
- GBP/USD setups 1–3 have the **same geometry** (limit 1.322245 / stop 1.319745 / target 1.324995) as the real GBP/USD orders that this morning resolved −1R.
- Had setup 1's order existed, the later real placements on that zone would likely have been refreshes or duplicates.
- So the cohort is **not additive** to the frozen cohort. The 16-B cap-book's per-symbol cap handles that overlap in totals.

### Expected live effect while locked

- Roughly **6 extra dry-run orders per day** at the observed rate (GBP/USD and USD/JPY only; NZD setups still stop at the R:R gate).
- Each is tagged, resolved by the Step 15 resolver (with the 17-A re-anchor on dry-run fills), and visible as a separate cohort.

## 4. Live / unlocked behaviour: unchanged (evidence)

- `evaluateTpSmallGate` returns `block = true` whenever dry run is not active. The hard-block branch is the previous code verbatim (regex-pinned).
- Mutation check: forcing log-only everywhere fails the test.
- `dryRunActive` is defined once (bs:2571) as `entries_locked && dryRunWhenLocked`, so unlocking turns the gate back into a hard block automatically.

## 5. Tests

| Suite | Coverage |
|---|---|
| `step17bTpSmallLogOnly.test.ts` (9) | locked dry run + TP small → logged / tagged, not blocked; unlocked / live → the existing block, verbatim; TP ≥ minimum untouched in both modes (`<` boundary); the logged branch tags and does **not** skip; **no later gate is bypassed** (market-entry refusal, distance guard, Route 2 stop, order R:R, placement all after the TP gate, in order, none reading the tag; safety gates and the Impulse gate before it); tags reach `final_decision` (only when present), `dry_run_context` and `buildAttribution`; attribution: tagged → verdict with numbers + logged-only + `legacy_would_admit false`; untagged → unchanged |
| `paperSettlementLedger.test.ts` (+1, real Postgres) | a tagged dry-run order through `route2_place_order`: attribution stores the verdict (tp_pips 14.9, min 20, basis), `logged_only_would_block = [reaction, tp_too_small]`, `legacy_would_admit false`; the order's `dry_run_context.tpTooSmall` |
| R:R / distance / caps still fail a TP-small setup | structural (gate order and no short-circuit, above) plus the replay: 8 of 18 historical setups still stop at the order R:R gate |
| Mutation check (reverted) | log-only everywhere → 1 fail; threshold `<=` → 1 fail |
| No historical rows rewritten | the change only affects new scans; no SQL, no backfill |

**Suites:** Deno **3,457 passed, 0 failed**; `deno check` clean (bot-scanner, attribution, gate module, tests).

## 6. Status carried

- **17-A** merged (e55384b3); migration applied and verified by you.
- **17-A live behaviour:** not yet observed. The last fill (09:47) predates the 10:13 deploy; the first post-deploy dry-run fill will be checked for `fill_sizing.reanchor`.
- **17-C:** not started.
