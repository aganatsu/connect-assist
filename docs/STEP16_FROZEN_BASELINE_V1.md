# Step 16 — frozen Impulse + Route 2 baseline, as implemented

**Status:** documentation of what runs. Written 2026-10-08 against `main` @ `316e2c7d`. Nothing here changes behaviour.

**Config:** live `bot_configs` row `327912ae…`, canonical version **`1037e6170289f865e4d6618dcf28b94d`** since 2026-10-08 03:46 UTC (behaviour-equivalent to `3d5b8fb0…`; see §11).

**Account:** $100,000, **paused and entries-locked**. Route 2 runs as a **dry run**: hypothetical fills, never positions (`simplification.dryRunWhenLocked`).

**Sources:**
- the audit, `STEP16_AUDIT_V1.md`, and the field inventory, `step16/STEP16_CONFIG_INVENTORY_V1.md`;
- every row below was re-checked in code. `bs` = `supabase/functions/bot-scanner/index.ts`; `sh/` = `supabase/functions/_shared/`.

"Default-only" means the value comes from `RUNTIME_DEFAULTS` in `sh/configMapper.ts`; nothing is stored. Deleting a stored "off" key marked **load-bearing** would turn the behaviour on.

## 1. Universe and cadence

| Rule | Value | Source |
|---|---|---|
| Instruments | EUR/USD, GBP/USD, USD/JPY, CHF/JPY, NZD/CAD, NZD/CHF | `instruments.enabled` (wins over `allowedInstruments`; the backtest page reads `allowedInstruments`, which holds the same 6) |
| Sessions / days | all four sessions, Mon–Fri (non-binding) | `sessions.*` |
| Full scan | every 5 min | cron `bot-scanner-every-5min`, `entry.scanIntervalMinutes 5` |
| Route 2 hunt (the only poller) | every minute | cron `manage-positions-1min` → bot-scanner `{"action":"manage"}`; `simplification.secondPollerEnabled false` |
| Timeframes | entry 5m, HTF 1h, confirmation 5m | `strategy.entryTimeframe`, `htfTimeframe`, `confirmationTimeframe`; style overrides **off** (`simplification.styleOverridesMode`); `tradingStyle.mode "scalper"` only selects the timeframe profile and checks it, logging any mismatch (bs:2408) |

## 2. Direction and admission

| Rule | Value | Source |
|---|---|---|
| Direction engine | simple direction + confirmed trend: H4 CHoCH lookback 10, H1 BOS lookback 8, fib factor 0.25, swing lookback 5 | **default-only**: `useSimpleDirection`, `useConfirmedTrend`, `simpleDirectionH4ChochLookback`, `simpleDirectionH1BosLookback`, `confirmedTrendFibFactor`, `confirmedTrendSwingLookback` (configMapper 175–178, 218–219) |
| Direction context | Game Plan bias moves verdict confidence by up to ±5 (Game Plan never blocks: soft mode); the ICT HTF weekly bias feeds the verdict | `gamePlanEnabled true`; `ictHTFEnabled` **default-only**. `regimeScoringEnabled false` (load-bearing) keeps the regime out of Gate 1 |
| **Impulse required** | no impulse zone → skip | `strategy.impulseZoneGateMode "hard"` (bs:6570) **and** `impulseZoneEnabled true` (**default-only**; false skips the hard-gate branch) |
| Unified engine | detection and attribution only; cannot set the entry, stop or size, or bypass Impulse | `simplification.unifiedModifiersEnabled false` (bs:6545-6547) |
| Market entries | refused (`market_entry_disabled`), including Market Fill at Zone | `simplification.marketEntriesEnabled false` (bs:7927); `entry.marketFillAtZone false` (load-bearing: default true) |
| Logged-only gates | score, news, reaction, ICT gate modes, legacy R:R: evaluated, never block | `simplification.scoreGateMode / newsGateMode / reactionGateMode "log"`; ICT `*GateMode "off"` |

## 3. Entry

**The Route 2 limit price:**
1. the **Impulse refined entry** (`bestZone.refinedEntry`: the lower-timeframe OB/FVG edge, the top for longs and the bottom for shorts) when the zone has one;
2. otherwise the **Impulse zone midpoint** (bs:7843-7859, `sh/impulseZoneEngine.ts:1172`).

**`zoneEntryDepth` (0.55; EUR/USD 0.50) is recorded / legacy.** It reaches only the Unified engine (bs:5903) and attribution (bs:8326), never the Route 2 limit.

**Production check:** the 19 orders since the reset sit at 0.5 (midpoint, 9 orders) or 0.044–0.423 (refined edge, 10 orders) from the near edge. None sits at 0.55.

## 4. Stop

Computed from the **limit price** by `route2StopFromLimit` (`sh/route2StopGeometry.ts:45`, called at bs:8001; `simplification.stopAnchor "limit"`):

| Element | Value | Source |
|---|---|---|
| Candidates | swing stop (structure, `entry.slBufferPips` **1** pip buffer) → the impulse-origin stop if it is wider and within the cap → else the floor | bs:7401-7430 |
| **Floor** | **per pair**: GBP/USD, USD/JPY, CHF/JPY **25 pips**; EUR/USD, NZD/CAD, NZD/CHF **20 pips** | `MIN_SL_PIPS` (`sh/smcAnalysis.ts:2619`), via `resolveStaticFloorPips` (bs:579). No per-pair `minStopPips` override is set. The ATR floor layer is off: `atrDerivedFloorsEnabled false`, **default-only**, so `atrForConsumers = 0` (bs:5486). Recorded per order as `route2Stop.floorPips` and in attribution `stop_version` (`floor=<per order>`) |
| **Impulse-stop cap** | **max(floor × 1.5, leg × 1.2)** | `strategy.impulseSlCapMultiplier 1.5` (stored); `legStopCapMultiple 1.2` (**default-only**, clamped 1.0–3.0); impulse-origin buffer = max(1 pip, leg × `legStopBufferPct` **0.02**, **default-only**) (bs:7401-7427) |
| At fill | the stop does **not** move. Fill-time sizing keeps risk at 0.5%. A better-than-limit fill can sit inside the floor (open decision, `PRE_UNLOCK_DECISIONS_V1.md`) | — |

## 5. Target and R:R

| Rule | Value | Source |
|---|---|---|
| Target | limit ± stop distance × **1.1** | `exit.tpRRRatio 1.1` (load-bearing: if deleted, it falls back to `risk.minRiskReward` = 1) |
| Order R:R gate | effective R:R from the order geometry net of estimated cost ≥ **1.0** → else `zone_setup_rejected_rr` | `simplification.rrGateMode "order_geometry"`, `orderRRMin 1.0` |
| No TP extension | Game Plan DOL extension off; regime-adaptive TP off | `dolTPExtensionEnabled false`, `regimeAdaptiveTPEnabled false` |

## 6. Order placement and lifetime

| Rule | Value | Source |
|---|---|---|
| **Distance cap** | entry more than **1.5 × H1 ATR** from price → `zone_setup_rejected_distance`. It rejects the setup and never moves the entry; a missing ATR also fails | `ROUTE2_MAX_PENDING_DISTANCE_ATR` (`sh/route2Forward.ts:32`, pre-registered, "not a tunable"), bs:7941-7967 |
| Placement | `route2_place_order` RPC: attribution (A–D) + supersede + order in one transaction; fails closed without attribution | bs:8349 |
| One live order per symbol + direction | duplicate → links to the tracked setup ("Zone setup already active") | `idx_pending_orders_unique_active` |
| Same level re-detected | refreshed in place (stop, target, size), lifetime **not** extended. A moved level supersedes. **Known defect:** an exact float comparison (bs:8111) treats float noise as a move (planned fix: PR 16-C) | bs:8095-8160 |
| **Lifetime** | **480 minutes**, fixed from creation; `entry.limitOrderExpiryMinutes` is ignored | `ROUTE2_TTL_MINUTES` (`sh/route2Forward.ts:35`) |
| **Thesis direction-flip cancel** | a live order is cancelled when the direction verdict flips against it (`CANCELLED_DIRECTION_FLIP`) | `thesisValidationEnabled`, `thesisCheckDirectionFlip` (both **default-only**, true; bs:3766-3854). The FOTSI veto is dormant (`useFOTSI false`); the GP-reversal check is observe-only |
| Other live-order cancels | stop invalidation (closed bar beyond the stop), impulse broken: hard-coded | — |
| Zone exit | resets the hunt (direction-aware); it does not cancel | `strategy.zoneExitDirectionAware true` (load-bearing: default false); `zoneChaseMaxZoneWidths 1` (**default-only**) |

## 7. Hunt and fill

1. **Touch:** the hunt (every minute) sees price at the zone.
2. **Confirmation:** `detectZoneConfirmation` on the 5m confirmation timeframe (bs:4217). The minimum candle count and the Tier-1-without-refined-zone requirement are hard-coded.
3. **Caps at fill:** `resolvePositionCaps("hunt_fill")` (bs:4286). These count **real** positions only; dry-run fills are invisible to them.
4. **Account gate:** the Step 13 gate (bs:4503-4511) decides fills, dry run included.
5. **Dry-run fill:** status `filled` at the confirmation price + `fill_sizing`. **Never a position**; a DB trigger refuses one (bs:4513).
6. **Sizing:** risk **0.5%** of the account at fill, from the actual fill → stop distance (`simplification.sizingMode "fill_time"`, `riskPercent 0.5`). Lots are capped at `maxLotsPerTrade` 20. Measured 0.4977–0.4992% on all 7 dry-run fills. No size reduction near limits.

## 8. Position and portfolio limits

| Rule | Value | Source |
|---|---|---|
| **Caps** | **3 global / 1 per symbol**, at placement, hunt fill and scan stop | `simplification.capsMode "unified"`, `maxOpenPositions 3`, `maxPerSymbol 1`. This supersedes `risk.maxOpenPositions / maxConcurrentTrades / maxPositionsPerSymbol` and per-pair `maxPerSymbol` |
| **Correlation** | max **2** correlated positions at threshold **0.8**, plus the hedge block. Checked **at placement only** (`runSafetyGates`, bs:1944); **not** re-checked when the hunt fills | `instruments.correlationFilterEnabled true`, `maxCorrelatedPositions 2`, `maxCorrelation 0.8` |
| Same-direction stacking | off (redundant under 1 per symbol) | `risk.allowSameDirectionStacking false` |
| Portfolio heat | 5% (cannot bind: 3 × 0.5%) | `risk.maxPortfolioHeat` |
| **Conflict counter (block at 3)** | **INERT.** Only 6 factors can count as opposing (`sh/confluenceScoring.ts` 1130, 1352, 1575, 1606, 1707, 1766). Displacement, AMD, FOTSI and Daily Bias are off (`useDisplacement / useAMD / useFOTSI / useDailyBias false`, all load-bearing), leaving at most 2 possible, so 3 cannot be reached. 0 occurrences in 432 decisions since Step 14. Not an effective blocker | `risk.conflictBlockAt 3` (bs:4878, 7000) |

## 9. Account risk

| Rule | Value | Source |
|---|---|---|
| Step 13 FTMO equity profile | **active**:<br>• daily entry stop 3%, daily flatten 4% (Europe/Prague day, equity-based);<br>• overall entry stop $92,000, flatten $91,000;<br>• hard limits 5% / $90k;<br>• size reduction off, profit target off;<br>• missing data fails closed and never flattens | `prop_firm_config` (`ftmo_2step`); `sh/accountRiskLimits.ts`, `sh/propFirmGate.ts`. Gates 7 / 8 delegate to it |
| **Gate 15** | **$3,000 net realised daily loss** blocks new entries. Uses closed trades since **UTC** midnight (`paper_trade_history`, since the reset). **Not** delegated to the Step 13 profile; it runs alongside it. Dormant in the dry run (no real closes) | `protection.maxDailyLoss 3000` (bs:1827) |
| Gate 14 | **6** consecutive losses → **4 h** pause | `protection.maxConsecutiveLosses 6`, `consecutiveLossPauseHours 4` |
| Cooldown | **5 min** per symbol | `entry.cooldownMinutes 5` |

## 10. Management

**None:**
- no break-even;
- no trailing;
- no partial exits;
- no max-hold;
- no time exit;
- no structure-invalidation exit;
- no TP extension (`management_version none_v1`).

**Stored "off" values that are load-bearing:**
- `exit.breakEven` and `breakEvenEnabled` (code default **true**);
- `exit.partialTP` / `partialTPEnabled`, `trailingStop` / `trailingStopEnabled`;
- `maxHoldEnabled false` with `maxHoldHours 0`, `timeExitHours 0`;
- `structureInvalidationEnabled false`.

paper-trading reads the raw `exit.*Enabled` names; the scanner reads the mapper's precedence. The UI writes both, so they agree.

## 11. Config versions

| Version | Status | Meaning |
|---|---|---|
| `3d5b8fb0d756b3596ed46d133e873a88` | superseded 2026-10-08 03:46:21 UTC | Step 14 patch (2026-10-07 12:55) |
| `1037e6170289f865e4d6618dcf28b94d` | **LIVE since 2026-10-08 03:46:21 UTC** (verified) | **Step 16-E: the explicit frozen-config boundary.** The same effective configuration with **26** live code-default-only controls stored explicitly |

**The 26 keys:**

| Group | Keys |
|---|---|
| Set A, `strategy` (14) | `impulseZoneEnabled` true, `legStopBufferPct` 0.02, `legStopCapMultiple` 1.2, `useSimpleDirection` true, `useConfirmedTrend` true, `confirmedTrendFibFactor` 0.25, `confirmedTrendSwingLookback` 5, `simpleDirectionH1BosLookback` 8, `simpleDirectionH4ChochLookback` 10, `zoneChaseMaxZoneWidths` 1, `thesisValidationEnabled` true, `thesisCheckDirectionFlip` true, `ictHTFEnabled` true, **`atrDerivedFloorsEnabled` false** |
| Set B, `strategy` (10) | `gamePlanGateMode` "soft", `zoneAnchoredStop` false, `requireUnifiedZone` false, `priceAwareStructureBlocks` false, `thesisDirectionStyleAware` false, `htfBiasHardVeto` false, `ictHTFGateMode` "off", `ictKillZoneGateMode` "off", `ictJudasSwingGateMode` "off", `ictDisplacementMSSGateMode` "off" |
| Set B, other sections (2) | `sessions.killZoneOnly` false, `entry.limitOrderEnabled` false |

**`1037e617…` is behaviour-equivalent to `3d5b8fb0…`, NOT identical:**
- **Proof:** `supabase/tests/_shared/step16eExplicitDefaults.test.ts`. The full effective runtime config is byte-identical on all six pairs, as are simplification, caps at every stage, and every behaviour category. The production SQL `docs/step16/STEP16E_PATCH_AB_26.sql` is executed in real Postgres.
- **Reporting** pools the two only through the explicit registry, `CONFIG_EQUIVALENCE_CLASSES["frozen_impulse_route2_v1"]` (`_shared/hypotheticalCapBook.ts`).
- **Live verification (2026-10-08):**
  - PATCH applied 03:46:21 UTC; the audit change log records `3d5b8fb0 → 1037e617`; the stored config equals the proven object exactly.
  - The first full scan after it (03:50:11) recorded `__configVersion = 1037e617…` on all six pairs, with 199 settings each and **0 differences** from the mapper on the new config **and 0 from the old `3d5b8fb0` config**. Style overrides still off.
  - Account $100,000, paused, entries-locked; 0 positions.
  - **Still open:** no order has been placed since the PATCH, so the first attribution row carrying `1037e617…` is not yet observed. It is test-proven via #645's wiring and will be checked opportunistically.

## Not part of the baseline (open, decided before unlock)

See `PRE_UNLOCK_DECISIONS_V1.md`:
- the **fill floor**;
- **`skipped_tp_too_small`** (`MIN_TP_PIPS` measured on the legacy market-entry target).

Both run today and are documented there; neither is endorsed as final strategy logic.
