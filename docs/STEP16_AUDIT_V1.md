# Step 16 — read-only audit: minimal frozen config, reporting, open items

**Date:** 2026-10-08, ~00:30–01:30 UTC.

> **Correction (16-A):** the stop floor is **per pair** (`MIN_SL_PIPS`): 25 pips on GBP/USD, USD/JPY and CHF/JPY, and **20 pips** on EUR/USD, NZD/CAD and NZD/CHF. Earlier wording in this audit said "25-pip floor" throughout; every order so far was on a 25-pip pair except EUR/USD 74f225b1, whose recorded `floorPips` is 20. See `STEP16_FROZEN_BASELINE_V1.md` §4.
**Code:** `main` @ `316e2c7d`.
**Nothing was changed:** no config writes, cron changes, migrations or PRs.

**Production state, verified at the start:**
- account $100,000, paused, entries-locked, kill switch off;
- 0 positions;
- 0 ledger and 0 trade-history rows since the 10-06 20:46 reset;
- resolver cron running: 0 resolver writes, consistent with 3 pending fills;
- #645 live hash proof still **open**: no Route 2 order has been placed since 19:21 UTC.

**Scanner health:** the scanner is alive. Its latest full scan was at 00:20, and all 180 decisions since 19:21 are explained by gates.

**Full field inventory:** `docs/step16/STEP16_CONFIG_INVENTORY_V1.md`.
- 287 rows: 195 stored paths plus 92 runtime keys that have no stored source.
- Each row has file:line references by area, the field's live status and its class.
- Built by a sub-audit. The claims below that change the plan were re-verified against code **and** production data; one of its claims was wrong (§2.2).

---

## 1. Live effective config and version

| | Value |
|---|---|
| `bot_configs` | one global row `327912ae…`, connection_id null, updated 2026-10-07 12:55 (Step 14 patch) |
| canonical hash | `config_version` = **`3d5b8fb0d756b3596ed46d133e873a88`** |
| runtime | the 00:20 scan recorded `__configVersion = 3d5b8fb0…`, `__styleOverridesMode = off`, `__timeframeProfileMismatch = null` |
| per-pair runtime | identical on all 6 pairs except **EUR/USD `zoneEntryDepth` 0.5** (see §2.1) |
| attribution | all 3 attributed orders record `3d5b8fb0…`, `unified_3_1`, `fill_time_v1;risk=0.5;maxLots=20`, `route2_limit_anchor_v1;floor=25;capMult=1.5`, `management none_v1`, primary `impulse_zone`, Unified `detected_only`, risk profile `rp1:ec30780dc5f41c44` |
| Step 13 profile | `ftmo_2step`, active, daily entry-stop 3% / flatten 4%, overall $92k / $91k, `reduce_size_near_limit` false, `profit_target_pct` null, Europe/Prague day |
| backtest instruments | the Backtest page builds its list from `instruments.allowedInstruments`, which holds exactly the 6 live pairs; backtest-engine itself takes `body.instruments` |

### Intended frozen behaviour vs what actually runs

| Intended | Runtime | Verdict |
|---|---|---|
| FX only: EUR/USD, GBP/USD, USD/JPY, CHF/JPY, NZD/CAD, NZD/CHF | `instruments` = those 6 | ✅ |
| Impulse required | `impulseZoneGateMode "hard"` (stored) **and** `impulseZoneEnabled true` (default only; false skips the whole hard-gate branch) | ✅, but one half is implicit |
| Route 2 only, zone-based limit entries, no market entries | `marketEntriesEnabled false`, `marketFillAtZone false` | ✅ |
| **EUR/USD entry depth 0.50, others 0.55** | **does not reach Route 2 orders** | ❌ **§2.1** |
| Game Plan ON | `gamePlanEnabled true`, gate mode soft: it never blocks, but its bias moves direction-verdict confidence by up to ±5 and can tip Gate 1 | ✅ as context, no gate |
| Unified logging only | `unifiedModifiersEnabled false`; the limit stays the Impulse entry | ✅ |
| score logged only | `scoreGateMode log` | ✅ |
| news logged only | `newsGateMode log`; both news readers return logged passes (still one API call per pair) | ✅ |
| ICT FVG gate off | `ictFVGInvalidationGateMode off` | ✅ (note: `ictHTFEnabled true`, a default, feeds the weekly bias into Gate 1) |
| 0.5% at fill | `sizingMode fill_time`, `riskPercent 0.5`, measured 0.4977–0.4992% on all 7 dry-run fills | ✅ |
| stop anchored to the limit | `stopAnchor limit` → `route2StopFromLimit` | ✅ |
| stop buffer 1 pip | `slBufferPips 1` (swing-stop buffer) | ✅ |
| stop cap 1.5 | `impulseSlCapMultiplier 1.5`; actual cap = max(per-pair floor × 1.5, **leg × 1.2**), with leg buffer 0.02. The last two are **defaults only** | ✅, incomplete spec |
| TP ratio 1.1 | `exit.tpRRRatio 1.1` (**if deleted, falls back to `risk.minRiskReward` = 1**) | ✅ |
| order-geometry RR ≥ 1.0 | `rrGateMode order_geometry`, `orderRRMin 1.0` | ✅ |
| caps 3 / 1 | `capsMode unified` 3 / 1 at placement, hunt fill and scan stop | ✅ (dry-run fills are invisible to the caps, §4) |
| correlation on / 2 / 0.8 | stored and mapped | ✅ at **placement only**; not re-checked at the hunt fill |
| 6 losses → 4 h pause | Gate 14 | ✅ |
| 5 min cooldown | `cooldownMinutes 5` | ✅ |
| conflict block at 3 | stored, but **unreachable**: only 6 factors can count as opposing and 4 of them are off; 0 mentions in 432 decisions since Step 14 | ⚠️ inert |
| no size reduction / no profit target | profile false / null | ✅ |
| no max-hold / BE / trailing / partial / TP extension | all false/0; `dolTPExtensionEnabled false`; `regimeAdaptiveTPEnabled false` | ✅ (**`exit.breakEven` default is `true`**; the stored false is load-bearing) |
| style overrides off | `styleOverridesMode off` | ✅ |
| single poller | `secondPollerEnabled false`; zone-confirmation cron unscheduled at step 11 | ✅ |
| Step 13 profile active | yes | ✅ |

---

## 2. Contradictions to resolve before any Step 16 PR

### 2.1 Entry depth 0.50 / 0.55 is not what places the order

**Code:**
- The Route 2 limit is `izData.bestZone.refinedEntry` (the lower-timeframe POI edge: `bestLTF.high` for longs, `impulseZoneEngine.ts:1172`), or the zone **midpoint** if there is no refinement (bs:7843-7859).
- `impulseZoneEngine.ts` never reads an entry depth.
- `zoneEntryDepth` reaches only `decideZone` → the Unified engine (bs:5903 → `unifiedZoneEngine.ts:501`), which is modifiers-off and cannot set the limit.
- Attribution records the depth (bs:8326) but does not use it.

**Production check:** all 19 Route 2 orders since the reset, measured as depth from the zone's near edge:
- 9 orders at exactly **0.5**: the midpoint fallback;
- 10 orders between **0.044 and 0.423**: the refined LTF edge;
- **none at 0.55**.

The EUR/USD "0.50" only coincides with the midpoint.

This contradicts `STEP14_OVERRIDE_MAP_V1.md` §1, which said "yes: EUR/USD impulse-zone entry depth".

**Options:**
- **(a) Recommended. Correct the frozen spec, not the code.** The entry is "Impulse refined entry, else zone midpoint". `strategy.zoneEntryDepth` and the `pairGateOverrides.*.zoneEntryDepth` entries become DEPRECATE (recorded only).
- **(b)** Wire the depth into the Route 2 limit. That changes which trades happen, so it is a strategy change under the freeze and needs explicit approval and its own measurement.

### 2.2 Live blockers that are not on the frozen list

Since Step 14 (432 decisions):

| Blocker | Since Step 14 | Source | Note |
|---|---|---|---|
| **`skipped_tp_too_small`** | **78 (18%)** | hard-coded `MIN_TP_PIPS` table (bs:7641-7658): GBP/USD 20, USD/JPY 20, EUR/USD 15, others 12 | Measured from `lastPrice` to the **legacy market-anchored TP**, before any Route 2 geometry exists. Measured from the order's entry, a Route 2 target is ≥ 27.5 pips on 25-pip pairs and ≥ 22 pips on 20-pip pairs (1.1 × the per-pair floor), so this gate refuses setups based on a target the order would never use. Examples: "TP 15.3p < min 20p" (GBP/USD), "TP 10.0p < min 12p" (NZD/CAD). The sub-audit said it "cannot fire"; that is **wrong**, it is the second-largest blocker |
| `zone_setup_rejected_distance` | 43 (10%) | hard-coded `ROUTE2_MAX_PENDING_DISTANCE_ATR = 1.5` × H1 ATR (`route2Forward.ts:32`, bs:7941-7967) | `limitOrderMaxDistancePips` is unreachable and `limitOrderMinDistancePips` is read nowhere |
| `zone_setup_rejected_rr` | 29 | the order-geometry RR gate | listed ✅ |
| `skipped_no_impulse_zone` | 187 | the Impulse hard gate | listed ✅ |
| thesis direction-flip cancel of live orders | — | `thesisValidationEnabled` + `thesisCheckDirectionFlip`, **defaults only** | the FOTSI veto is dormant (`useFOTSI false`); GP reversal is observe-only |
| per-pair stop floor (25 pips GBP/USD, USD/JPY, CHF/JPY; 20 pips EUR/USD, NZD/CAD, NZD/CHF), TTL 480 min, confirmation-hunt settings (minimum 10 candles, Tier-1 required without a refined zone) | — | hard-coded (`MIN_SL_PIPS`, `ROUTE2_TTL_MINUTES`, `zoneConfirmation.ts`) | fixed parts of the experiment |
| direction engine (simple direction, confirmed trend, H1 BOS 8 / H4 CHoCH 10, fib 0.25, swing 5) | — | **defaults only** | Gate 1 |
| Gate 15: $3,000 realised daily loss | dormant in the dry run | bs:1827, **not** handed off to Step 13 (only Gates 7 and 8 are) | UTC day and realised P/L, vs Step 13's Prague day and equity |

**Decision needed:**
- Either confirm these as part of the frozen experiment (they become documented KEEP rows), or name the ones to change.
- **My recommendation:**
  - keep all of them frozen for now and document them;
  - store the defaults-only controls explicitly (§3);
  - treat `MIN_TP_PIPS` on the legacy TP as a **known mis-measurement**, decided like the fill floor: measured, not changed under the freeze. Changing it would add trades.

---

## 3. KEEP / DEPRECATE / REMOVE

Per-field references are in the inventory.

| | KEEP | DEPRECATE | REMOVE candidate | Total |
|---|---|---|---|---|
| stored paths | 73 | 122 | **0** | 195 |
| runtime-only keys | 13 | 72 | 7 | 92 |

### KEEP (active live controls)

- **Instruments:** `instruments.enabled`.
- **Impulse:** `strategy.impulseZoneGateMode`, `strategy.impulseSlCapMultiplier`, `entry.slBufferPips`, `strategy.structureLookback`.
- **Timeframes:** `strategy.entryTimeframe`, `strategy.confirmationTimeframe`, `entry.scanIntervalMinutes`, `tradingStyle.mode` (the timeframe-profile check).
- **`exit.tpRRRatio`.**
- **All `simplification.*` (17):** caps, RR gate, sizing, stop anchor, the news / score / reaction modes, style off, single poller, market entries off, Unified modifiers off, dry-run-when-locked.
- **Protection:**
  - `protection.maxConsecutiveLosses` and `consecutiveLossPauseHours`;
  - `entry.cooldownMinutes`;
  - correlation × 3;
  - `risk.maxPortfolioHeat` (cannot bind);
  - `risk.allowSameDirectionStacking`;
  - `protection.maxDailyLoss` (Gate 15).
- **Sessions and days** (non-binding: all enabled).
- **Game Plan:** `gamePlanEnabled`, `gamePlanRefreshHours`, `gamePlanNotify`, and `strategy.liquidityPoolMinTouches` (GP key levels).
- **`account.startingBalance`** (reset bankroll).
- **Stored "off" values that are load-bearing.** Delete the key and the code default turns the behaviour **on**:
  - `exit.breakEven` / `breakEvenEnabled` (default true);
  - `exit.partialTP`, `exit.trailingStop` (and their `*Enabled` twins), `exit.maxHoldEnabled`, `exit.timeExitHours`, `exit.structureInvalidationEnabled`;
  - `entry.marketFillAtZone` (default true);
  - `strategy.minZoneScore` (default 4), `strategy.tier1GateEnabled`, `strategy.stagingEnabled`, `strategy.fibMaxRetracement` (default 0.786), `strategy.zoneExitDirectionAware`;
  - `strategy.useAMD`, `useFOTSI`, `useDailyBias`, `useDisplacement`, `useLiquiditySweep`, `useStructureBreak`, `regimeScoringEnabled`: these keep factors out of the conflict counter and keep the regime out of Gate 1.
- **Defaults-only live controls (13), proposed to be stored explicitly with no behaviour change:**
  - `legStopBufferPct` 0.02, `legStopCapMultiple` 1.2, `impulseZoneEnabled` true;
  - `useSimpleDirection`, `useConfirmedTrend`, `confirmedTrendFibFactor` 0.25, `confirmedTrendSwingLookback` 5, `simpleDirectionH1BosLookback` 8, `simpleDirectionH4ChochLookback` 10;
  - `zoneChaseMaxZoneWidths` 1, `thesisValidationEnabled`, `thesisCheckDirectionFlip`, `ictHTFEnabled`.

### DEPRECATE (no live effect; kept for UI, presets, backtest, replay, attribution or history)

- **Superseded by `simplification.*`:**
  - the caps fields (`risk.maxOpenPositions`, `maxConcurrentTrades`, `maxPositionsPerSymbol`);
  - `risk.riskPerTrade`, `minRR`, `minRiskReward`, `conflictThresholdRaise`;
  - `risk.maxDailyLoss` and `maxDrawdown` (delegated to the Step 13 profile);
  - `protection.circuitBreakerPct`.
- **Logged or scoring only:**
  - all 22 `factorWeights.*`;
  - `strategy.confluenceThreshold`, `normalizedScoring`, `enableOB` / `enableFVG` / `enableBOS` / `enableCHoCH` / `enableLiquiditySweep`;
  - ICT scoring and gate keys;
  - `sessions.newsFilterEnabled` and `newsFilterPauseMinutes`.
- **Dormant by value:** BE, trailing and partial parameters; ATR / fixed TP / SL alternatives; `openingRange.*`.
- **Decorative (read nowhere, still written by the UI):**
  - `entry.defaultOrderType`, `maxSlippagePips`, `entryRefinement`, `trailingEntry` / `Pips`, `refinementTimeframe`, `limitOrderExpiryMinutes` (Route 2 uses the 480 constant);
  - `account.mode` and `leverage`;
  - `strategy.premiumDiscountEnabled`, `regimeScoringStrength`, `htfTimeframe` (only in a mismatch log);
  - `risk.atrVolatilityMultiplier` (never mapped).
- **`strategy.zoneEntryDepth` + `pairGateOverrides.*`** (§2.1). The AUD/USD entry is inert.

### REMOVE candidates

- **No stored path qualifies.** Every one is written by the UI presets, the bot-config template or `src/lib/applyRecommendation.ts`.
- **7 runtime-only defaults** are referenced only by the dead bot-scanner `DEFAULTS` and the dead legacy mapper:
  - `useVWAP`, `vwapProximityPips`, `cascadeZoneMode`, `cascadeZoneDailyATRMult`, `limitOrderPreferZone`, `limitOrderMinDistancePips`, `ictRiskFVGRuleOfTwoExit`;
  - proven by `grep -rnw` over src, supabase, local-runner, scripts, tests and run-backtest-local.ts.
- **Removing them changes nothing at runtime**, and is not worth a PR on its own.

### Hazards found while classifying (not fixed)

- **Two management engines read different key names:**
  - paper-trading reads the raw `exit.*Enabled` names, while the scanner reads the mapper's precedence;
  - the UI writes both, so they agree today;
  - `applyRecommendation` writes only `*Enabled` and would split them.
- **A UI style preset click still writes its values.** Do not click presets.
- **Mislabelled cancel reason:** any thesis cancel other than direction-flip is labelled `CANCELLED_THESIS_FOTSI`.
- **Dormant second-poller cap reads the wrong key:** `risk.maxPerSymbol`, while the stored key is `maxPositionsPerSymbol`.
- **Backtest fallbacks differ from live** for max-hold, structure invalidation, spread and news.

---

## 4. Runtime path: scan → admission → Route 2 order → fill → attribution → outcome

1. **Cron `bot-scanner-every-5min`:**
   - `loadConfig` reads `bot_configs` + `config_version` → `mapNestedToFlat` + `applyPairOverrides`;
   - style overrides off; `dryRunActive = entries_locked && dryRunWhenLocked` (bs:2569);
   - Step 13 `propFirmGate` is evaluated before the hunt.
2. **Per pair:**
   - analysis → direction verdict (simple direction + confirmed trend + GP context ± 5 + ICT HTF weekly bias) → `runSafetyGates` (bs:1412: caps via `resolvePositionCaps`, Gates 7/8 delegated, 14, 15, correlation, cooldown; news / score / reaction / ICT log-only);
   - the Impulse hard gate (bs:6570) → `skipped_no_impulse_zone`;
   - `MIN_TP_PIPS` on the legacy TP (bs:7641) → `skipped_tp_too_small`;
   - entry = Impulse refined entry / midpoint (bs:7843);
   - market path refused (`market_entry_disabled`, bs:7927);
   - the ATR distance cap (bs:7941) → `zone_setup_rejected_distance`.
3. **Route 2 geometry:** `route2StopFromLimit` (bs:8001: swing / impulse-origin within the cap, per-pair floor 25 / 20), TP = limit ± 1.1R; the order-geometry RR ≥ 1.0 → `zone_setup_rejected_rr`.
4. **Placement:**
   - `buildAttribution` (bs:8295) + `placeRoute2Order` → **`route2_place_order` RPC** (bs:8349): attribution A–D + supersede + order in one transaction, failing closed;
   - same price → refresh in place (bs:8110: **exact float equality**, §6);
   - `dry_run_context` is recorded.
5. **Cron `manage-positions-1min`** (bot-scanner `{"action":"manage"}`) = **the Route 2 hunt** (bs:2208):
   - touch → `detectZoneConfirmation` (bs:4217, confirmation TF 5m) → caps `hunt_fill` (bs:4286; counts **real** positions only) → Step 13 gate (bs:4504);
   - then the **dry-run branch** (bs:4513): `status filled` + `fill_sizing`, never a position;
   - (live: `entries_locked` refusal, then `route2_claim_and_fill`).
6. **Attribution:** the `pending_orders_attribution` trigger writes E/F (touch, confirm, terminal, `fill_kind = hypothetical`, fill geometry, risk dollars) plus events.
7. **Cron `attribution-outcome-resolver-15m`:** stored final 5m bars → `resolveHypothetical` → `attribution_resolve_hypothetical` (section G, once) or `attribution_defer_hypothetical`.

### Cron jobs

pg_cron is not readable through the API. Expected from the applied history:

| Job | Schedule | Role in the experiment |
|---|---|---|
| bot-scanner-every-5min | */5 | scan + placement |
| manage-positions-1min | * | **the Route 2 hunt** (touch / confirm / fill) |
| attribution-outcome-resolver-15m | 7,22,37,52 | dry-run outcomes |
| settlement-monitor-4h | 17 */4 | ledger integrity (last PASS 20:17) |
| scanner-operational-health-1min | * | health function |
| outcome-tracker-hourly | 15 * | outcome tracker (not part of Route 2) |
| kv-cache-cleanup-hourly | 15 * | cache |
| daily-cleanup | 0 3 | data-cleanup |

Expected absent:
- zone-confirmation-scanner-every-minute (step 11);
- ipo-paper-runner-15min (step 8);
- prop-firm-daily-reset-summer / winter (step 13);
- settlement-monitor-final (self-unscheduled 10-06).

**To confirm:** run `research_snapshots/STEP16_AUDIT_CRON_JOBS_READONLY.sql`, which is SELECT only. It lists every job, its target, its last run and 24 h failures; anything not listed above is a finding.

---

## 5. Reporting: raw vs cap-adjusted (prototype on today's data)

**Model** (`docs/step16/capped_book_prototype.py`, read-only):
- Hypothetical fills are processed in time order.
- A fill occupies a slot from `filled_at` until its resolver `closed_at`, or until now while unresolved.
- Caps are checked in the live fill order: global 3, then per symbol 1.
- A blocked fill takes no slot. It gets a reason (`blocked_by_global_cap` / `blocked_by_symbol_cap`) and the open fills that blocked it.
- **Raw rows are never modified.**

**Why it is needed:** in a dry run the hunt checks the caps against *real* open positions, which are always 0 (bs:4286). So the scanner re-arms the same zone after each hypothetical fill.

### Attributed fills (Step 15 raw truth, 00:31 UTC)

| Fill | Symbol | Filled | Outcome | Cap model |
|---|---|---|---|---|
| 088f22f7 / 4d8eab45 | GBP/USD | 18:22 | pending | **admissible** |
| 4be9b5c9 / 896572f4 | GBP/USD | 18:52 | pending | blocked_by_symbol_cap ← 4d8eab45 |
| fff2ae4e / 3758fd3a | GBP/USD | 22:42 | pending | blocked_by_symbol_cap ← 4d8eab45 |

|  | Raw | Cap-adjusted |
|---|---|---|
| Fills | 3 | **1** (2 blocked) |
| Resolved | 0 | 0 |
| Gross R / net R / hypothetical P/L | 0 / 0 / $0 | 0 / 0 / $0 |

### Context: all 7 dry-run fills since 09-24, incl. 4 from before attribution

Same resolver code; gross R only, because there are no attribution risk dollars for those 4.

| | Raw | Cap-adjusted |
|---|---|---|
| Fills | 7 | 4 (3 blocked: 02eb7948 ← 77134ab8, plus the two GBP/USD) |
| Resolved | 4 | 3 |
| **Gross R** | **−1.85R** | **−0.85R** |

A **43% overcount** of fills, and a different sign of magnitude in R.

### Proposed for the Step 16 PR

- A pure module `_shared/hypotheticalCapBook.ts`, with tests, and a read-only report showing all ten requested quantities and the per-fill reasons.
- No attribution mutation, no DB change, no resolver change.
- **Open choice:** the live correlation filter (max 2 correlated, 0.8) is also a placement limit, but the correlation matrix used at scan time is not recorded in attribution.
  - **Default (as you specified):** caps only.
  - Correlation is reported as "not modelled".

---

## 6. Known unresolved items

| Item | Active in prod? | Can it affect the frozen experiment? | Fix before unlock? | Can wait? |
|---|---|---|---|---|
| **Fake supersede from float equality** (bs:8110 `Number(a) === Number(b)`) | **yes** | **yes: 14 of 31 supersedes since 09-24 were float noise** (e.g. 0.8029075 vs 0.8029074999999999); 1 since the reset (10-06 23:50, pre-attribution), 0 since PR 2. Each fake one cancels and re-places the order with a **fresh 8 h TTL and reset confirmation state**, defeating the deliberate "never refresh `expires_at`" rule (NZD/CAD re-placed 4 × in 30 min on 09-28), and mints a new `signal_id` | **yes**: it changes which orders are live and when; use a sub-pip tolerance | the dry run is affected now; recommend fixing in Step 16 as execution plumbing, with your approval |
| **`reset_account` deletes positions without settlement** (paper-trading:1878) | reachable from the UI (`src/lib/api.ts:378`) | no while paused with 0 positions; after unlock it would erase open positions with no history row (the ledger epoch protects the balance; attribution logs `position_deleted_unsettled`) | **yes**: refuse while positions are open, or settle first | yes while locked; don't click it |
| `pending_id` naming | yes (logs) | no: `route2_poll_log.pending_id` = `order_id` text; the `route2_claim_and_fill` reply `pending_id` = row uuid | no | yes: reporting joins on `order_id` |
| `bot_config_history` table comment ("pending_orders.config_hash resolves here") | documentation | no; since #645 new orders resolve via `bot_config_change_log.next_hash` (the code comment was fixed in #645; the DB `COMMENT ON TABLE` was not) | no | yes: a one-line comment migration whenever convenient |
| **Fill-floor policy** | yes | yes: **4 of 7 dry-run fills landed inside their pair's floor** (all four on 25-pip pairs) (0.72, 4.95, 1.85, 6.45 pips); risk stayed 0.50% through fill-time sizing | **decision required** (documented in `ROUTE2_FILL_FLOOR_POLICY_OPEN_V1.md`) | **not touched in Step 16**, as instructed |

**Also found:**
- Gate 15 is not handed off to Step 13 (§2.2).
- Correlation is checked only at placement.
- The legacy `MIN_TP_PIPS` measurement (§2.2).
- `zoneEntryDepth` is inert (§2.1).
- The `CANCELLED_THESIS_FOTSI` mislabel.

---

## 7. What I propose for the Step 16 PR(s), after your decisions

1. **Config, no behaviour change:**
   - store the 13 defaults-only live controls explicitly;
   - mark DEPRECATE fields in docs;
   - delete **no** stored key (several "off" values are load-bearing).
   - Verified the Step 14 way: the runtime `pairConfig` must be byte-identical apart from the new keys, and the new `config_version` is recorded.
2. **Reporting:** `hypotheticalCapBook.ts` + the report (§5).
3. **Only with explicit approval:** the float-tolerance supersede fix, and the `reset_account` guard.
4. **Not in Step 16:**
   - fill floor;
   - entry-depth wiring;
   - `MIN_TP_PIPS` change;
   - Gate 15 handoff;
   - correlation-at-fill;
   - removing the 7 dead defaults.
