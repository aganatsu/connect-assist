# Step 8 — simplification plan and measured behavioural effect

**Status:** plan, before any change. The account is reset ($100,000), **paused and entries-locked**. Nothing here can trade until step 19.

**Source:**
- `SMC_SIMPLIFICATION_RESEARCH_V1.md` (classification);
- the decision log in the final pre-reset snapshot `2026-10-06_pre_reset_final`, covering 6,994 decisions over 8 days from the 09-29 config change to 10-06;
- the 75 Route 2 orders placed in that window.

The effects below are measured, not estimated, except where marked.

**Baseline, 8 days:**
- Route 2 orders were placed for **28 distinct opportunities** (symbol + direction + day). That's 75 orders, of which 16 filled, 14 expired and 42 were cancelled.
- 24 of the 42 cancellations were superseded orders, 11 were impulse-broken, and 4 hit the position cap.

## A. Gates removed from the frozen minimal configuration

| Change | Class | Measured effect (8 days) |
|---|---|---|
| **Reaction-confirmation gate (G3b)** — needs a config switch added; then off | DISABLE | sole blocker on 119 decisions; joint on 175 more |
| **R:R gate as implemented (G10)** — replace with a **spread-viability check on the order as placed** (effective R:R incl. spread ≥ min) | DISABLE (replace) | sole blocker on 317 decisions; joint on 186 more. The replacement will still refuse spread-dominated orders; its exact effect can only be measured after step 10 (stop from limit). |
| **ICT FVG-invalidation hard gate** | DISABLE | 140 decisions |
| **Score gate** (threshold 20; checked twice) — off in the frozen config, kept as a logged TEST signal | TEST | 214 below-threshold decisions (31 opportunities) never reached the gates; plus 44 joint blocks |
| **News filter (G16)** | TEST | 17 decisions |
| Conflict counter (+10 raise) | DISABLE | moves the score threshold; no direct blocks |

**Combined:**
- Up to **61 more distinct opportunities** would reach Route 2 placement (783 decisions).
- Up to **31 more** would come from the score gate.
- Against the baseline of 28, that's roughly **2–3× the Route 2 order count**.
- Each order still needs a zone touch plus 5-minute confirmation: 16 of the 75 orders (21%) filled in this window.

**Kept (unchanged):**
- the Impulse hard gate;
- data sufficiency;
- the same-direction stacking guard (it was the only blocker on 241 decisions);
- the hedge/correlation guard;
- the 5-minute cooldown;
- the target-too-small check (18);
- the Route 2 distance guard (57);
- pending dedupe (49 — these are what the log mislabels "insert failed");
- the Route 2 cancels: expiry, SL invalidation, impulse broken, superseded.

## B. Make the logged score honest (no trade effect once the score gate is off)

All DISABLE. Removing them only changes the *logged* score that the later TEST arm will use:
- Tier-1 impulse credit and the +1.0 `impulseZoneBonus` (circular);
- the direction-verdict score adjustment;
- Game Plan factors (map `gamePlanEnabled`, so the UI's "off" is respected);
- the AMD "present" leak.

The Game Plan also drives thesis cancels. Only 2 happened in the window (direction flip), so the effect is negligible.

## C. Unified as a modifier → off (Unified stays computed and logged)

- **25 of the 75 orders (33%) were Unified-sourced, and all 25 also had an Impulse zone.** So the bypass removes **0 orders**.
- What changes: those orders get Impulse's entry price and stop instead of Unified's.
- Size (1.0× vs 0.5×) becomes flat 0.5% risk in step 9.
- 5 of the 16 fills were Unified-sourced.

## D. Second entry path

- **Watchlist staging and promotion → off.** It produced **0 orders** in the window, plus the 5 failed inserts from the constraint defect. **No effect on orders.**

## E. Management and overrides

| Change | Effect |
|---|---|
| Max-hold explicit off (with its unprotected style overwrite) | none — inert since 09-29 |
| Close-on-reverse explicit off | none — off since 09-29 |
| Per-position `trade_overrides` and manual SL/TP edits disabled | none recorded |
| Regime-adaptive TP | not set in the effective config → no effect; remove the code path |
| `pairGateOverrides` removed | EUR/USD entry depth 0.50 → 0.55 (the global value); a slightly deeper entry on EUR/USD only |

## F. Non-trading

None of these change trades:
- Shadow engines that compute every scan (ICT HTF, Judas, kill zones, thesis conviction, FOTSI inputs) → off. This saves compute.
- Advisors (daily review, weekly advisor, strategy advisor) → disabled in the UI and backend during the experiment.
- IPO runner cron → unscheduled. It saves 288 API credits a day against the starved budget.
- The always-false scanner-heartbeat alert → disabled.
- The two cron changes are SQL you run.

## G. Needs your decision before the freeze (step 16)

- **Instruments:** FX only (drop BTC, ETH)? Crypto lost in both periods. Since 09-29, ETH and BTC account for 195 of the 783 newly admitted decisions.
- **Control arm** for the Impulse experiment: (a) order-block/FVG zone, or (b) market.

## Not in step 8 (later steps)

- Route 2 sizing at fill (step 9: 0.5%, caps as a ceiling, no 0.5× cut);
- stop from the limit (step 10);
- the second fill poller (step 11);
- one cap set (step 12);
- FTMO daily loss and drawdown (step 13);
- explicit config / no style layer (step 14);
- attribution (step 15).

## Implementation approach

- Everything is behind **explicit config switches** written into the frozen configuration. Code is only deleted later (REMOVE LATER).
- Each switch has a test proving the off-state skips the feature.
- One PR. Migrations are applied by hand before merge.
- The account stays locked.

## Implementation (as built)

**Switches:** `config_json.simplification`, resolved by `_shared/simplification.ts`. An absent value means the legacy behaviour.

| Switch | Value set for the experiment | Effect |
|---|---|---|
| `scoreGateMode` | `log` | The score is computed and recorded (`detail.scoreGate.wouldBlock`); it no longer gates. |
| `reactionGateMode` | `log` | G3b's result is recorded as `[logged only — would block]`. |
| `rrGateMode` / `orderRRMin` | `order_geometry` / 1.0 | The legacy G10 is logged only. The effective R:R of the placed Route 2 order (spread + commission) must be ≥ 1.0; always recorded as `detail.orderRR`. |
| `newsGateMode` | `log` | The news-event and news-alignment gates are logged only. |
| `unifiedModifiersEnabled` | `false` | No Impulse bypass and no Unified entry/SL/size. `detail.unifiedDetected` and `detail.unifiedComparison` are recorded. |
| `dryRunWhenLocked` | `true` | While entries are locked: full pipeline, Route 2 orders inserted with `dry_run`, hypothetical fills only. |

**Existing switches set in config:**
- `strategy.ictFVGInvalidationGateMode = "off"` — still computed; `detail.ictFVGGate.wouldBlock` recorded;
- `strategy.stagingEnabled = false`;
- `instruments.enabled` = FX only (EUR/USD, GBP/USD, USD/JPY, CHF/JPY, NZD/CAD, NZD/CHF).

**Safety (migration `20261007000000`):** while entries are locked, the database refuses every position and every non-dry-run order. A dry-run order can never become a position (even when unlocked), and `dry_run` is immutable.

**Funnel:** `local-runner/recon/route2_funnel.py` (deduplicated: candidate decisions → unique orders → touches → confirmations → fills). The before window is real; the after window is dry-run, with the legacy-rules subset reported separately.

**Before funnel, real, 2026-09-29 05:11 → 10-06 19:14, all 8 symbols:**

| Stage | Count |
|---|---|
| Candidate decisions | 1,813 (65 opportunities) |
| Unique orders | 75 |
| Touches | 34 |
| Confirmations | 16 |
| Fills | 16 |

22 of the 75 orders were BTC/ETH.
