# Config field inventory: live `bot_configs.config_json` vs. code (actual references)

> **Corrections after verification (16-A, 2026-10-08).** This inventory was produced by a sub-audit; its claims were re-checked against code and production. Two are wrong:
> 1. **`skipped_tp_too_small` does fire.** The "cannot fire today" reasoning under (a) misses `let tp = analysis.takeProfit` (bs:7313). That value survives when there is no recent swing beyond price and the analysis stop already clears the floor. Production: **78 of 432 decisions** (2026-10-07 13:00 → 10-08 00:50 UTC), legacy targets 6.7–19.4 pips. See `PRE_UNLOCK_DECISIONS_V1.md`.
> 2. **The stop floor is per pair**: 25 pips on GBP/USD, USD/JPY and CHF/JPY; 20 pips on EUR/USD, NZD/CAD and NZD/CHF. Rows that say "25-pip floor" refer to GBP/USD only.
>
> Everything else cited in `STEP16_AUDIT_V1.md` and `STEP16_FROZEN_BASELINE_V1.md` was re-verified there.

**Repo:** `connect-assist-settlement` @ `main` `316e2c7d` ("Step 15 PR 3"). This was a read-only audit: no repo, database or network changes were made.

**Inputs:**
- `/tmp/s16/stored_config.json` and `stored_flat.json` (195 stored leaf paths).
- `/tmp/s16/runtime_pairconfig_GBPUSD.json`, the effective per-pair runtime config (~199 flat keys).

**Rows:**
- 195 stored paths.
- 92 runtime keys that have **no stored source** (they run on `RUNTIME_DEFAULTS`). 56 are non-ICT and 36 are ICT. `id` is included even though it is the injected `bot_configs.id`, not a setting.

**Method:**
- **Mapping.** Every stored path was matched against the `??` chains in `mapNestedToFlat` (`supabase/functions/_shared/configMapper.ts:434-774`) and `resolveSimplification` / `resolvePositionCaps`.
- **Reference search.** Every leaf and runtime key was searched with a word-boundary search over:
  - `supabase/functions/**`, `src/**`, `supabase/migrations`, `supabase/cron`, `supabase/queries`, `supabase/tests`, `tests`, `local-runner`, `scripts`, and `run-backtest-local.ts`;
  - hits were grouped by area, and comment-only hits and dead code were flagged.
- **Live effect.** Each key's live effect was then read in context in the code, against the live values.
- **Who did what.** The section tables were produced by parallel section audits that followed one shared convention. The cross-cutting claims below were re-verified by the assembler.

## Legend

**Path abbreviations:**

| Abbreviation | Path |
|---|---|
| bs | supabase/functions/bot-scanner/index.ts |
| sh/X | supabase/functions/_shared/X |
| cm / M / "mapper" | sh/configMapper.ts (D: = RUNTIME_DEFAULTS line) |
| SM | sh/scannerManagement.ts |
| pt | supabase/functions/paper-trading/index.ts |
| be | backtest-engine/index.ts |
| bc | bot-config/index.ts |
| zcs | zone-confirmation-scanner/index.ts (the second Route 2 poller; **disabled** by `simplification.secondPollerEnabled=false`) |
| BCM | src/components/BotConfigModal.tsx |
| AR | src/lib/applyRecommendation.ts |
| RD | src/components/RecommendationsDashboard.tsx |
| BT | src/pages/Backtest.tsx |
| dr / wa | bot-daily-review / bot-weekly-advisor (these only build LLM prompt text) |
| mig/… | supabase/migrations/… |

**Not counted as consumers:**
- configMapper default and mapping lines (they are cited in column 3 instead).
- bot-scanner's dead `DEFAULTS` (bs:157-378).
- `STYLE_OVERRIDES` (bs:501-566). It is inert because `simplification.styleOverridesMode="off"` (bs:2408-2419).
- `_legacyLoadConfigMapping` (bs:1082-1408).
- `sh/smcAnalysis.ts` `DEFAULTS` (:344-410), which is exported but imported by nothing live.
- Comment-only lines.

**Universal record-only references.** These apply to every stored key and are not repeated per row:
- md5(`config_json`) = `bot_configs.config_version`, written into `trade_attribution.config_version` (Step 15; bs:1074, bs:8286-8290).
- The full flat config is upserted to `bot_config_history` (bs:2332-2335; `configHash` sh/route2Forward.ts:133).
- `sanitizeConfigForCapture(pairConfig)` is captured into `smc_scan_decision.confluence_input` (bs:5448-5452).

The Attr (S15) column lists only key-specific attribution use: `buildAttribution` inputs (bs:8294-8330) → sh/attribution.ts version strings, and the `entryConfigSnapshot` allow-list (sh/smcTradeTelemetry.ts:124-136).

**Live status vocabulary:**

| Status | Meaning |
|---|---|
| active-gating | Can block or cancel today |
| active-sizing | Sets position size today |
| active-geometry | Sets entry, stop or target today |
| active-other(…) | Changes live behaviour in another way |
| active-logging-only | Evaluated, but the result is only recorded |
| scoring-only | Feeds the confluence score, which is log-only because `simplification.scoreGateMode="log"` |
| dormant-by-value | The code is live but the current value switches it off |
| shadowed-by-X | Another stored key wins in the mapper |
| superseded-by-X | Another owner decides, e.g. the step 12 unified caps or step 9 fill-time sizing |
| read-nowhere | No live reader |

**Classes:**

| Class | Rule |
|---|---|
| KEEP | Active live control, including a dormant control whose stored "off" value is load-bearing because the code default is "on" (noted per row) |
| DEPRECATE | No live effect, but still referenced by the UI, backtest, replay, attribution, LLM advisors, templates or presets |
| REMOVE-CANDIDATE | Zero non-test references outside the mapper and dead code. The proving grep is shown under the table |

Log-only gates (score, news, ICT gate modes "off") are classed DEPRECATE: they have no live effect, but they are measurement inputs.

**Unverified (database or runtime state, not checked):**
- Whether the step 13 risk profile (`prop_firm_config`) is active. This determines whether Gates 7 and 8 are delegated.
- `paper_accounts.execution_mode`, which affects only the broker-mirror spread checks.
- `entries_locked`, which affects dry-run.
- Live decision-log frequencies of any status.

## Summary counts

| Section | Rows | KEEP | DEPRECATE | REMOVE-CANDIDATE |
|---|---|---|---|---|
| exit.* | 25 | 12 | 13 | 0 |
| risk.* | 15 | 3 | 12 | 0 |
| entry.* | 12 | 4 | 8 | 0 |
| account.* | 3 | 1 | 2 | 0 |
| sessions.* | 8 | 6 | 2 | 0 |
| strategy.* (part 1 of 2) | 30 | 10 | 20 | 0 |
| strategy.* (part 2 of 2) | 20 | 9 | 11 | 0 |
| protection.* | 4 | 3 | 1 | 0 |
| instruments.* | 24 | 4 | 20 | 0 |
| openingRange.* | 7 | 0 | 7 | 0 |
| tradingStyle.* | 1 | 1 | 0 | 0 |
| factorWeights.* | 22 | 0 | 22 | 0 |
| Top-level keys | 5 | 3 | 2 | 0 |
| simplification.* | 17 | 17 | 0 | 0 |
| pairGateOverrides.* | 2 | 0 | 2 | 0 |
| Runtime-default-only keys (no stored source) — non-ICT | 56 | 12 | 38 | 6 |
| Runtime-default-only keys (no stored source) — ICT | 36 | 1 | 34 | 1 |
| **Stored paths (195)** | 195 | 73 | 122 | 0 |
| **Runtime-only (92)** | 92 | 13 | 72 | 7 |
| **All rows** | 287 | 86 | 194 | 7 |


## Specific questions (a–g)

Abbreviations as in the legend. All line numbers are at `316e2c7d`.

### a) `skipped_tp_too_small` and `zone_setup_rejected_distance`

**`skipped_tp_too_small`. Hard-coded, not driven by config. Unreachable with the live values.**
- Produced at bs:7641-7658. `MIN_TP_PIPS` is a literal table inside the scan loop (bs:7644-7649): GBP/USD 20, EUR/USD 15, USD/JPY 20, and a fallback of `?? 12` for CHF/JPY, NZD/CAD and NZD/CHF (bs:7650). No config key feeds it.
- It measures `|tp − analysis.lastPrice|`. That is the **market-anchored** target from the legacy chain, taken before the Route 2 block recomputes the target from the limit entry at bs:7989-8036. So it does not test the target of the order actually placed.
- The only config inputs are indirect, through `tp`: `tpRatio` (`exit.tpRRRatio` 1.1), the stop chain, and `regimeAdaptiveTPEnabled` (off).
- Why it cannot fire today: every `tp` assignment in the chain is `lastPrice ± risk × tpRatio` (bs:7321, 7328, 7372-7374, 7435-7437, 7472-7474, 7597-7599; smcAnalysis.ts:2445/2460 for `rr_ratio`). After the floor step (bs:7362-7375), risk is at least the static floor. Nothing later can make the stop tighter: the Impulse override only widens (bs:7430), Unified requires at least the floor (bs:7467), and the anchored stop is off. The minimum target is therefore 1.1 × the floor, which clears `MIN_TP_PIPS` on every enabled pair:

  | Pair | Minimum target (1.1 × floor) | `MIN_TP_PIPS` |
  |---|---|---|
  | EUR/USD | 22 | 15 |
  | GBP/USD | 27.5 | 20 |
  | USD/JPY | 27.5 | 20 |
  | CHF/JPY | 27.5 | 12 |
  | NZD/CAD | 22 | 12 |
  | NZD/CHF | 22 | 12 |

- It becomes reachable if `tpRatio` drops below about 0.6–0.8, or if a `pairGateOverrides.<pair>.minStopPips` lowers the floor. I did not check this against the production decision logs.

**`zone_setup_rejected_distance`. Hard-coded constant. Active.**
- Produced at bs:7941-7967 by the Route 2 distance guard. `passesDistanceGuard(pendingDistanceAtr(lastPrice, limitEntry.price, H1 ATR14))` comes from sh/route2Forward.ts:46-67. The H1 ATR is computed with `calculateATR(hourlyCandles, 14)` (bs:7957). It deliberately does **not** use `atrForConsumers`.
- The limit is `ROUTE2_MAX_PENDING_DISTANCE_ATR = 1.5` (sh/route2Forward.ts:32, commented "Pre-registered … Not a tunable"). Exactly 1.5 passes. A null ATR (fewer than 15 1h candles) **fails**.
- **`entry.limitOrderMinDistancePips` and `limitOrderMaxDistancePips` play no part.**
  - `limitOrderMaxDistancePips` (runtime default 30) is read only inside `computeLimitEntryPrice` (bs:3427). That function returns null when `limitOrderEnabled` is false (bs:3424, live value false). It is also never called when an Impulse `bestZone` exists (`zoneEngineWillOverride`, bs:7833-7835).
  - `limitOrderMinDistancePips` has **no live reader** (only RUNTIME_DEFAULTS:248 and mapper:762).
  - The comment at bs:7947-7950 says the same thing.

### b) Route 2 stop computation

The market-anchored chain runs first (bs:7310-7456). It is then re-run from the order's own limit entry by `route2StopFromLimit` (sh/route2StopGeometry.ts:45-72, called at bs:7989-8036). It applies because `simplification.stopAnchor = "limit"` (bs:8025-8034). Under this anchor the stop chooses **swing → Impulse origin (only if wider and within the cap) → floor**, and then sets the target to limit ± risk × `tpRatio` 1.1.

| Element | Where | Config or hard-coded | Live value / effect |
|---|---|---|---|
| **25-pip floor** (GBP/USD) | `resolveStaticFloorPips` bs:579-583 → `MIN_SL_PIPS` sh/smcAnalysis.ts:2619-2659 | **Hard-coded table**. A per-pair override `pairGateOverrides.<pair>.minStopPips` exists (configMapper:853) but none is set | GBP/USD, USD/JPY, CHF/JPY: 25. EUR/USD, NZD/CAD, NZD/CHF: 20. Floor = max(static, ATR layer) at bs:7340. Passed as `minSlPips: effectiveMinSlPips` (bs:8007) |
| ATR floor layer | bs:7338-7340: `atrForConsumers × ATR_SL_FLOOR_MULTIPLIER` | Hard-coded 1.5 (smcAnalysis.ts:2662). Gated by `atrDerivedFloorsEnabled` (runtime default false, bs:5486) | **Dormant**: `atrForConsumers = 0` |
| `impulseSlCapMultiplier` 1.5 | bs:7425 `floorCapPips = staticMinSlPips × (pairConfig.impulseSlCapMultiplier ?? 4)` | **Config**: `strategy.impulseSlCapMultiplier` (stored, mapper:519) | Cap = max(25 × 1.5 = 37.5p, leg × 1.2) for GBP/USD. Passed as `impulseCapPips` (bs:8006). It also caps the Unified (bs:7466) and anchored (bs:7550) stops, which are inert. Written into attribution `stop_version` `capMult=` (sh/attribution.ts) |
| `legStopCapMultiple` 1.2 | bs:7422-7427, clamped to [1, 3] | **Config key, runtime default only** (RUNTIME_DEFAULTS:169, mapper:523; not stored). Fallback literal 1.2 at bs:7424 | Active: leg cap = leg × 1.2 |
| `legStopBufferPct` 0.02 | bs:7401-7405, clamped to [0, 0.2]; buffer = max(pip buffer, leg × 0.02) | **Config key, runtime default only** (RUNTIME_DEFAULTS:165, mapper:522). Fallback literal 0.02 | Active: Impulse-origin stop = origin ∓ buffer |
| `slBufferPips` 1 | `adjustedSlBuffer = instrumentBuffers[pair]?.slBufferPips ?? slBufferPips × assetProfile.slBufferMultiplier` (bs:5287-5290; forex multiplier 1.0, smcAnalysis.ts:326) | **Config**: `entry.slBufferPips` (stored, mapper:592). `instrumentBuffers` is {} | Swing stop = nearest of the last 3 swing lows/highs ∓ 1 pip (bs:7319/7326) → `swingSL` (`slFloorTrace.slBeforeFloor`, bs:8004). Also the pip floor of the Impulse buffer (bs:7403) and the anchored-stop shadow (bs:7547-7548) |
| Swing fallback | If there is no swing on the correct side, `sl = analysis.stopLoss` from `calculateSLTP` (smcAnalysis.ts:2331-2370) | `exit.stopLossMethod` "structure", `fixedSLPips` 10, `slATRPeriod` (ATR for SL) | Fallback only. In the limit-anchored function, a swing stop on the wrong side of the limit is dropped and the floor applies |
| Route 2 target | sh/route2StopGeometry.ts:69-70 | `tpRatio` ← `exit.tpRRRatio` 1.1 (mapper:615) | Active |
| Order R:R gate | bs:8038-8050, `orderEffectiveRR` (cost = `SPECS.typicalSpread` + commission) | `simplification.orderRRMin` 1.0, `rrGateMode` `order_geometry` | Active. Blocks with `zone_setup_rejected_rr` |

**Route 2 TTL.** `ROUTE2_TTL_MINUTES = ROUTE2_TTL_HOURS (8) × 60 = 480` (sh/route2Forward.ts:34-35). It is used at bs:7985-7986 as `route2ExpiresAt(placedAt)`, fixed from creation and not extended by an in-place refresh. Expiry is enforced at bs:3645-3661, with `EXPIRED_NEVER_TOUCHED` / `EXPIRED_AFTER_TOUCH_NO_CONFIRMATION` (sh/route2Forward.ts:113). It is **hard-coded**: `entry.limitOrderExpiryMinutes` (480) and `stylePendingExpiryMinutes` are bypassed (comment at bs:7972-7981). The 480 stored value matches only by coincidence.

**Confirmation hunt settings.**

| Setting | Source | Live value |
|---|---|---|
| Confirmation timeframe | `resolveConfirmationTimeframe(style, config.confirmationTimeframe, styleOverridesMode)` (sh/styleTimeframes.ts:76-81, bs:2408). **Config**: `strategy.confirmationTimeframe` | "5m". The style is used only when overrides are "legacy" |
| Candle fetch for the hunt | bs:4194-4196 | 5m |
| Minimum candles | `MIN_CONFIRMATION_CANDLES = 10` (styleTimeframes.ts:38) | Hard-coded |
| Detector | `detectZoneConfirmation(…, DEFAULT_ZONE_CONFIRMATION_CONFIG, …)` (sh/zoneConfirmation.ts:73-82) | Hard-coded: `minDisplacement` 0.4, `maxLookbackCandles` 10, tiers 1–3 enabled. No config path |
| Tier 1 requirement | bs:4265 requires Tier 1 when there is no refined zone | Hard-coded |
| Minimum observation window | `confirmationMinObservationUntil(touch, confirmationTF)` (route2Lifecycle.ts:127-133, bs:3995). ORDINARY resets are deferred until it ends; HARD resets fire at once (`RESET_SEVERITY`, route2Lifecycle.ts:157-171) | One closed 5m bar after the touch |
| Zone-exit handling | `strategy.zoneExitDirectionAware` **true (stored)** + `zoneChaseMaxZoneWidths` 1 (runtime default), bs:4111-4128 | A favourable exit within 1 zone width keeps the hunt alive. `left_breach` and `left_favourable_far` reset the order to `pending` (bs:4147-4178). A reset is not a cancel |
| Arming | `classifyTouch` on the last entry-TF bar (bs:3960-3969) | Hard-coded |
| Fill size | `fillTimeSize` with `simplification.riskPercent` 0.5 and `maxLotsPerTrade` 20 (bs:4368-4379) | Active |
| Fill-time caps | Unified 3/1 (bs:4286) + `allowSameDirectionStacking` false (bs:4336) | Active |
| Account risk gate | Step 13 gate at bs:4505 | Active |
| Dry-run fill | bs:4515+ | Hypothetical only |

### c) Config keys that cancel pending orders while live

| Terminal reason / effect | Where | Config keys | Live state |
|---|---|---|---|
| `CANCELLED_DIRECTION_FLIP` | bs:3766-3881 → sh/thesisValidator.ts | `thesisValidationEnabled` (default true, bs:3487/3766) **and** `thesisCheckDirectionFlip` (default true, bs:3819). Also `thesisDirectionStyleAware` false, so the legacy D1/4H/1H engine is used; `structureLookback` 50 and `priceAwareStructureBlocks` false reach it through `dirConfig` (bs:3835-3838). The 0.6 confidence threshold is a constant (thesisValidator.ts:147) | **ACTIVE cancel**. Both switches rely on **implicit runtime defaults** (not stored) |
| `CANCELLED_THESIS_FOTSI` | thesisValidator fotsi_veto | `thesisCheckFotsiVeto` (default true, bs:3820) | **Dormant by value**: `strategy.useFOTSI` false → `_fotsiResult` null (bs:3374) → "no FOTSI result available" |
| gp_bias_reversal | thesisValidator.ts:288-330 | `thesisCheckGpBiasReversal` (default true, bs:3821) + `gamePlanGateMode` (bs:3825) | **Observe-only**: may cancel only when the mode is "hard" (thesisValidator.ts:307-308); the mode is soft. Its threshold is the constant `DEFAULT_GP_BIAS_MIN_CONFIDENCE` 60 (thesisValidator.ts:148), not `gamePlanGateMinConfidence`. If it ever fired, it would be labelled `CANCELLED_THESIS_FOTSI` (bs:3853-3854 maps every non-direction check to that) |
| `CANCELLED_SL_INVALIDATION` | bs:3700-3753 | No switch. A closed entry-TF bar beyond the order's stop | Active. The stop comes from §b |
| `CANCELLED_IMPULSE_BROKEN` | bs:4081-4094 (`awaiting_confirmation` only) | No switch (`isImpulseBroken`, zoneConfirmation.ts:525) | Active |
| Zone-exit reset (not a cancel) | bs:4111-4178 | `zoneExitDirectionAware` true, `zoneChaseMaxZoneWidths` 1, timing from `confirmationTimeframe` | Active |
| `CANCELLED_POSITION_CAP` | bs:4286-4346 | `simplification.capsMode` unified, `maxOpenPositions` 3, `maxPerSymbol` 1, `allowSameDirectionStacking` false | Active at confirmation |
| `CANCELLED_SUPERSEDED` | `route2_place_order` RPC (mig/20261008010000_step15_pr2_attribution_lifecycle.sql:240) when the same symbol and direction is re-placed at a different price. Same price is refreshed in place (bs:8089-8128) | None | Active |
| `EXPIRED_*` | bs:3645 | Constant `ROUTE2_TTL_MINUTES` | Active |
| Step 13 account gate | bs:4505 (blocks the fill, no cancel); bs:3544-3589 flatten/close-all | `prop_firm_config` (not `config_json`) | Active if a profile is active |
| `CANCELLED_REFINED_ZONE_FAILURE`, and the second poller's own `IMPULSE_BROKEN` / `POSITION_CAP` | zcs:387/494/593/606 | `simplification.secondPollerEnabled` **false** | Dormant |
| `structureInvalidationEnabled` | sh/scannerManagement.ts:681-683 | `exit.structureInvalidationEnabled` false | Applies to **open positions** (stop tightening), never to pending orders. Dormant by value |
| `CANCELLED_ZONE_EXIT` | Listed in `TERMINAL_REASONS` | — | **No writer.** Zone exits are resets |

### d) Game Plan: `gamePlanGateMode="soft"`, `gamePlanGateMinConfidence=50`

Neither key is stored. Both run on RUNTIME_DEFAULTS:216-217 (mapper:545-546).
- **Entry gate (bs:7240-7263).** In soft mode it never blocks. It pushes a `passed: true` gate whose reason text depends on the confidence. `gamePlanGateMinConfidence` 50 only decides **which reason text** is written: "below gate threshold" versus "handled by GP Bias Confidence scoring". It would block only under "hard", for a `misaligned` bias at confidence ≥ 50.
- **Thesis validator (bs:3825).** Soft means a GP bias reversal is recorded but cannot cancel (thesisValidator.ts:307-308). That check uses its own constant 60, not 50.
- **What Game Plan still does live (`gamePlanEnabled` true):**
  - Generates a plan every session or every `gamePlanRefreshHours` 4 (bs:4887-5090), which costs candle fetches.
  - Injects `_gamePlanContext` (bs:5425-5441) into the direction verdict as ±5 × conf/100 when conf ≥ 50. That 50 is a **separate hard-coded constant** (sh/directionVerdict.ts:372-381) and does not read `gamePlanGateMinConfidence`. It can move the verdict across `minConfidence` 40 or `blockThreshold` 25 (directionVerdict.ts:129-131). **Gate 1 is not log-only**, so Game Plan can still tip a block or a pass at the margin.
  - Feeds the `gamePlanKeyLevel` score factor (scoring only; the score is log-only).
  - Supplies `newsImpacts` to the news-alignment gate (log-only).
  - Bounds the age of the thesis plan (bs:3503).
  - Records `game_plan.enabled` and the alignment into attribution.
  - The DOL TP extension is off (`dolTPExtensionEnabled` false). It would only touch the legacy target anyway.

### e) Spread filter: `spreadFilterEnabled=true`, `instruments.maxSpreadPips=0`

- The only enforcing check is `fetchBrokerSpread` (bs:429-484): `effectiveMax = maxSpreadPips > 0 ? maxSpreadPips : SPECS[pair].maxSpread` (bs:437), and `passed = !spreadFilterEnabled || spread <= effectiveMax` (bs:475). With 0, the **per-instrument `SPECS.maxSpread`** applies (sh/smcAnalysis.ts:249-276): EUR/USD 2, GBP/USD 3, USD/JPY 2, CHF/JPY 4, NZD/CAD 4, NZD/CHF 5 pips.
- **It runs only on broker-mirror paths, which require `account.execution_mode === "live"`.** Those paths are the Route 2 fill mirror (bs:4629-4651) and the market-order mirror (bs:8731-8751, 8920). The market path is unreachable (`marketEntriesEnabled` false), and dry-run orders never become positions.
- **So no spread threshold applies on the paper / dry-run Route 2 path today.** Gate 21 is info-only (bs:2071-2076, `spreadGateReason`, an indicative spread/ATR ratio, confluenceScoring.ts:2468-2490). The order R:R gate subtracts `SPECS.typicalSpread` as a cost (sh/simplification.ts:147-148), but that is not a spread filter.
- The second poller has the same function (zcs:124-160) but is disabled. Backtest uses a different rule: it filters only when `maxSpreadPips > 0` (be:543), so it **never** filters with 0.

### f) Can `newsFilterEnabled` block anything when `newsGateMode="log"`?

**No.** It has exactly two live readers:
- Gate 16 (bs:1843-1880, `gateId: "news_event"`).
- The news-alignment gate (bs:7265-7290, `gateId: "news_alignment"`).

Both IDs are in `loggedOnlyGateIds` when `newsGateMode` is "log" (sh/simplification.ts:115). `applyLoggedOnlyGates` (bs:7292-7298) turns a failure into `passed: true, wouldBlock: true`, recorded on `detail.loggedOnlyGates` and in attribution `loggedOnlyWouldBlock`. Nothing in management, the pending loop, zcs or staging reads `newsFilterEnabled`. The only other mention, bs:8654, copies it into `signal_reason` for the record. Gate 16 still runs its news fetch, so it costs API calls but cannot block. Backtest forces it off (be:360). `newsFilterPauseMinutes` 60 is the Gate 16 window (bs:1858), so it is log-only as well.

### g) Backtest instrument list: `instruments.allowedInstruments` vs `instruments.enabled`

- **backtest-engine reads neither key.** It takes `body.instruments` with the default `RUNTIME_DEFAULTS.instruments` (12 symbols) (be:1249-1250, used at be:1281-1357). `mapConfig` → `mapNestedToFlat` (be:356-357) does compute `config.instruments` from `instruments.enabled`, but nothing in be reads `config.instruments`.
- **The frontend Backtest page chooses the list from `instruments.allowedInstruments`** (true entries only), from the live config on mount and when "Use current config" is toggled (src/pages/Backtest.tsx:237-240, 255-258), and posts it as `instruments` (Backtest.tsx:361).
- `instruments.enabled` is the live list: it wins over `allowedInstruments` at configMapper:632-636, feeding the scan list and Gate 4 (bs:1607). It is also read by local-runner/r2-universe.ts:51 and bot-weekly-advisor:1494.
- Today `allowedInstruments` has exactly the same six symbols set to true as `instruments.enabled`, so the two agree. This is no longer the "EUR/USD only" state described in STEP14_OVERRIDE_MAP §3.

## Cross-cutting findings: where the live value and the code disagree, or something is surprising

Each item was re-verified by the assembler against the code at `316e2c7d`, unless it is marked "(section audit)".

### 1. Settings that look live but do not change the order

- **`strategy.zoneEntryDepth` 0.55 and `pairGateOverrides.EUR/USD.zoneEntryDepth` 0.5 do not move the Route 2 limit price.**
  - The depth reaches only the Unified engine's entry story: `decideZone` → `unifiedZoneEngine` (sh/smcZoneDecision.ts:223-227; sh/unifiedZoneEngine.ts:408, 471-515).
  - The Unified entry is used only when `unifiedGatePassed`. `simplification.unifiedModifiersEnabled=false` prevents that (bs:6545-6551).
  - The limit is the Impulse engine's `refinedEntry`, the near edge of the LTF POI (sh/impulseZoneEngine.ts:1172-1182), or a hard-coded zone midpoint (bs:7851-7854).
  - So the depth is record-only: `trade_attribution.entry_depth` (bs:8326) and `entryDepthInUse`.
  - This contradicts STEP14_OVERRIDE_MAP_V1 §1 ("yes: EUR/USD impulse-zone entry depth").
- **The conflict-counter hard block (`risk.conflictBlockAt` 3) cannot fire with today's toggles.**
  - Only six factors can be `_opposing` (sh/confluenceScoring.ts:1130, 1352, 1575, 1606, 1707, 1766).
  - The counter skips factors whose toggle is false (FACTOR_TOGGLE_MAP :2587-2600, skip at :2640). `useDisplacement`, `useAMD`, `useFOTSI` and `useDailyBias` are all false, so at most 2 factors (Reversal Candle, Confluence Stack) can oppose.
  - Two opposing factors only trigger `conflictThresholdRaise` 2, which raises the **log-only** score threshold.
- **`skipped_tp_too_small` is unreachable with the live values.** See answer (a): 1.1 × the static floor already clears every `MIN_TP_PIPS` entry.
- **No spread filter runs on the paper or dry-run Route 2 path.** See (e): the only enforcing check is in the `execution_mode === "live"` broker mirrors.
- **`entry.limitOrderExpiryMinutes` 480 equals `ROUTE2_TTL_MINUTES` only by coincidence.** The constant wins (bs:7985).
- **`limitOrderMaxDistancePips` / `limitOrderMinDistancePips` play no part.** The constant 1.5 H1-ATR guard is what bounds Route 2 distance.
- **`gamePlanGateMinConfidence` 50 only selects reason text.** The confidence floors that act are hard-coded: 50 in sh/directionVerdict.ts:372, and 60 in sh/thesisValidator.ts:148.
- **`protection.circuitBreakerPct` 20 never applies.** `maxDrawdown = Math.min(risk.maxDrawdown 10, 20)` (cm:671-674).
- **`risk.atrVolatilityMultiplier` is not mapped.** `pairConfig.atrVolatilityMultiplier` (bs:7733, 8063, 8877) is therefore always undefined (section audit B).
- **Read nowhere, but still written by UI presets, the bot-config template or AR:**
  - `strategy.premiumDiscountEnabled` (no mapper line)
  - `strategy.enableCHoCH` (no mapper line)
  - `strategy.regimeScoringStrength`
  - `strategy.normalizedScoring` (scoring is always a percentage, confluenceScoring.ts:3015; only the cm:464 autoscale reads it, and 20 > 10 so it does nothing)
  - `strategy.htfTimeframe` (only the profile-mismatch log, bs:2413/2418; the bias timeframe comes from `tradingStyle.mode`)
  - `entry.defaultOrderType`, `maxSlippagePips`, `entryRefinement`, `trailingEntry`, `trailingEntryPips`, `refinementTimeframe` (the 4 SQL hits are a different JSON field)
  - `account.mode`, `account.leverage`
  - `fvgMinSizePips` / `fvgOnlyUnfilled` are inside the FVG scoring block, which `useFVG=false` switches off.

### 2. Settings that look inert but do act

- **Game Plan still affects Gate 1 although `gamePlanGateMode="soft"`.**
  - `_gamePlanContext` (bs:5425) adjusts direction-verdict confidence by ±5 × conf/100 when conf ≥ 50 (sh/directionVerdict.ts:372-381).
  - That can push the verdict across `minConfidence` 40 or `blockThreshold` 25 (:129-131), and Gate 1 is not log-only.
  - Game Plan also costs a generation every session or every 4 h (bs:4887-5090).
- **`strategy.regimeScoringEnabled=false` is not scoring-only.**
  - It nulls `analysis.regimeInfo` (confluenceScoring.ts:374-376), so the direction verdict runs with no regime source and no regime veto (Gate 1).
  - It also leaves `volCtx` undefined and makes the regime TP impossible.
  - The UI describes it as a score bonus (section audit D).
- **`ictHTFEnabled` (runtime default true, not stored) is the one live ICT key.**
  - It forces a weekly fetch for every pair.
  - Its `weeklyBias` feeds the direction verdict (bs:6509-6515; directionVerdict.ts:335-352).
  - The ICT HTF hard block at bs:7073 has **no mode check**. It is safe only because the "off" and "soft" modes force `passed=true` (sh/ictHTFIntegration.ts:179-184).
- **Factor toggles feed the conflict counter's exclusion list.** `useStructureBreak=false` and `useLiquiditySweep=false` remove their factors from the counter as well as from the score. Because that block cannot fire today (item 1), the practical effect is nil, but the toggles are load-bearing if the four "off" toggles change.
- **ICT FVG validation runs with the gate "off", and its would-block reaches attribution.** `ictFVGInvalidationEnabled`, `ictFVGBodyCloseOnly` and `ictFVGRuleOfTwo` drive `ictFVGGate.wouldBlock` (bs:7100-7101). That feeds attribution gate `ict_fvg` and `legacyWouldAdmit` (sh/attribution.ts:141-146).

### 3. Shadowing and precedence that hides the stored value

| Stored key | Shadowed by (wins) | Mapper line |
|---|---|---|
| `strategy.enableOB` true | `strategy.useOrderBlocks` false → runtime `enableOB=false` | :474 |
| `strategy.enableFVG` true | `strategy.useFVG` false | :475 |
| `strategy.enableLiquiditySweep` true | `strategy.useLiquiditySweep` false | :476 |
| `strategy.enableBOS` true | `strategy.useStructureBreak` false | :477 |
| `exit.trailingStopEnabled` | `exit.trailingStop` | :619 |
| `exit.breakEvenEnabled` | `exit.breakEven` | :622 |
| `exit.breakEvenPips` (also the offset fallback) | `exit.breakEvenTriggerPips` | :623-624 |
| `exit.partialTPEnabled` | `exit.partialTP` | :625 |
| `exit.maxHoldHours` | `exit.timeExitHours` | :629 |
| `risk.minRiskReward` | `risk.minRR` | :579 |
| `risk.maxOpenPositions` | `risk.maxConcurrentTrades` | :578 (both superseded by the unified caps) |
| `instruments.allowedInstruments.*` | `instruments.enabled` | :632-636 (but the Backtest page reads `allowedInstruments`) |

- **The two management engines read different names.** paper-trading's own management loop reads the **raw** `exit.breakEvenEnabled` / `trailingStopEnabled` / `trailingStopPips` / `maxHoldEnabled` (pt:1095, 1137, 1177; it runs only when the UI polls `status`). bot-scanner and scannerManagement read the mapped key, where `exit.breakEven` / `exit.trailingStop` win.
  - The settings UI writes both names, so they agree today.
  - AR:107/110/112 writes only the `*Enabled` names, so an applied AI recommendation would split the two engines (section audit A).
- **AR:58-60 maps "Liquidity Sweep" / "Order Block" / "Fair Value Gap" recommendations to the shadowed `enable*` keys.** Those recommendations silently do nothing on this config.

### 4. Load-bearing implicit defaults and load-bearing "off" values

- **Live controls that exist only as RUNTIME_DEFAULTS (not stored).** Deleting or renaming the default silently changes trading:
  - `legStopBufferPct` 0.02 and `legStopCapMultiple` 1.2 (Route 2 stop)
  - `impulseZoneEnabled` (hard Impulse gate)
  - `thesisValidationEnabled` and `thesisCheckDirectionFlip` (pending-order cancels)
  - `zoneChaseMaxZoneWidths` 1
  - `useSimpleDirection`, `simpleDirectionH4ChochLookback` 10, `simpleDirectionH1BosLookback` 8
  - `useConfirmedTrend`, `confirmedTrendFibFactor` 0.25, `confirmedTrendSwingLookback` 5
  - `ictHTFEnabled`
  - Not live controls today, but they select the current mode: `gamePlanGateMode` "soft", `priceAwareStructureBlocks` false, `thesisDirectionStyleAware` false.
- **Stored "off" values whose code default is "on".** Removing the key turns the behaviour on:

  | Key | Effect if the key is removed |
  |---|---|
  | `exit.breakEven` | Default true, and SM:317 `?? true` |
  | `entry.marketFillAtZone` | Default true. Every at-zone setup would then lose its limit order and be refused as `market_entry_disabled` (bs:7919-7930) |
  | `strategy.minZoneScore` 0 | Default 4 |
  | `strategy.tier1GateEnabled`, `stagingEnabled`, `smtOppositeVeto`, `ictRiskEnabled` | Each default true |
  | `strategy.useAMD`, `useFOTSI`, `useDailyBias`, `useDisplacement` | Each default true. This would also make the conflict block reachable |
  | `strategy.structuralConvictionEnabled` | Mapper uses `!== false` |
  | `dolTPExtensionEnabled` | Default true (legacy TP only) |
  | `exit.tpRRRatio` | `tpRatio` falls to `risk.minRiskReward` **1**, not the 2.0 default (cm:615). Every Route 2 target changes |

### 5. Hard-coded constants that look like config

| Constant | Where | Shadowed / decorative config key |
|---|---|---|
| `ROUTE2_TTL_MINUTES` 480 | sh/route2Forward.ts:34-35 | `entry.limitOrderExpiryMinutes`, `stylePendingExpiryMinutes` |
| `ROUTE2_MAX_PENDING_DISTANCE_ATR` 1.5 | sh/route2Forward.ts:32 | `limitOrderMaxDistancePips`, `limitOrderMinDistancePips` |
| `MIN_TP_PIPS` | bs:7644-7650 | none |
| `MIN_SL_PIPS` (25 for GBP/USD) | sh/smcAnalysis.ts:2619-2659 | per-pair `pairGateOverrides.minStopPips` (unset) |
| `ATR_SL_FLOOR_MULTIPLIER` 1.5 | smcAnalysis.ts:2662 | gated off by `atrDerivedFloorsEnabled` |
| `DEFAULT_ZONE_CONFIRMATION_CONFIG` | sh/zoneConfirmation.ts:73-82 | none |
| `MIN_CONFIRMATION_CANDLES` 10 | styleTimeframes.ts:38 | none |
| Tier 1 required without a refined zone | bs:4265 | none |
| Thesis thresholds 0.6 / 60 | thesisValidator.ts:147-148 | none |
| Direction-verdict GP floor 50, min 40 / block 25 | directionVerdict.ts:129-131, 372 | `gamePlanGateMinConfidence` |
| Standalone 0.5× size cut | bs:7755, 8074 | Superseded under fill-time sizing |
| Asset `slBufferMultiplier` (forex 1.0) | smcAnalysis.ts:326 | `entry.slBufferPips` multiplied by it |

### 6. Documentation now stale (STEP14_OVERRIDE_MAP_V1)

- §3 says `protection.maxDailyLoss` $3,000 is "delegated to the step 13 profile". **Gate 15 (bs:1827-1842) has no `propFirmActive` check and runs regardless.** Only Gates 7 and 8 delegate (bs:1662, 1680).
- §8 says "nothing reads `canTrade`". bs:7116-7123 would hard-block on `!ictRiskResult.canTrade` if `ictRiskEnabled` were true. It is dormant today.
- Several statements are now overtaken by the stored values:
  - `gamePlanEnabled` is now stored true.
  - `risk.riskPerTrade` is now stored 0.5.
  - `risk.minRiskReward` is now 1.
  - `allowedInstruments` now has the six live pairs true, not EUR/USD only.
  - The `zoneEntryDepth` claim is wrong (item 1).

### 7. Bugs and oddities found along the way

- **Mislabelled thesis cancels.** bs:3853-3854 labels every non-direction thesis cancel `CANCELLED_THESIS_FOTSI`. A gp_bias_reversal cancel (possible only in "hard" mode) would be mislabelled.
- **`CANCELLED_ZONE_EXIT` has no writer.** Zone exits are resets, not cancels.
- **`structureLookback` is ignored by the thesis validator.** It is passed in `dirConfig` (bs:3836), but `DirectionConfig` has no such field (section audit D).
- **The legacy second-poller cap reads the wrong key.** It reads `risk.maxPerSymbol`; the stored key is `risk.maxPositionsPerSymbol` (positionCaps.ts:86). The path is dormant.
- **The correlation filter (Gate 22) runs at placement only, not at confirmation fill.**
- **The backtest's fallbacks differ from live (section audit A):**
  - be:790 ignores `maxHoldEnabled` and checks only hours > 0.
  - be:726 treats a missing `structureInvalidationEnabled` as on.
  - be:543 never applies a spread filter when `maxSpreadPips` is 0.
  - be:360 forces the news filter off.
- **The calculateSLTP ATR floor is not gated.** `calculateSLTP`'s own 1.5 × ATR floor (smcAnalysis.ts:2378) is not gated by `atrDerivedFloorsEnabled`. It affects only the `analysis.stopLoss` fallback (section audit A).
- **API cost without trade effect:**
  - `ictHTFEnabled`: weekly fetches.
  - `newsFilterEnabled`: `fundamentals` calls. The gate is log-only.
  - `gamePlanEnabled`: plan generation.
  - In the other direction, `useSMT=false` and `useFOTSI=false` save fetches.


## Inventory tables

### exit.*

Legend (this part): bs = supabase/functions/bot-scanner/index.ts; sh/X = supabase/functions/_shared/X; SM = sh/scannerManagement.ts (`manageOpenPositions`, run every minute by cron `manage-positions-1min` → bot-scanner, bs:2660, with the flat runtime `config`, per-position `trade_overrides` winning, SM:371-384); pt = supabase/functions/paper-trading/index.ts (its own management loop inside action `status`, pt:953-1330, runs only when the UI polls status — src/lib/api.ts:367; reads RAW `config_json.exit.*` first via `liveFlag = liveExit[k] ?? liveConfig[k]`, pt:1017-1023, precedence per-trade override > raw live config > `exitFlags` snapshot, pt:1135-1136); be = backtest-engine (uses mapNestedToFlat be:357 + shared smcAnalysis, builds its own exitFlags be:2173-2182); bc = bot-config (`getDefaultConfig` template bc:376+, validator bc:219+); BCM = src/components/BotConfigModal.tsx (lines 232-422 = default config + style presets that WRITE values when clicked); exitFlags = bs:7805-7828, copied onto `pending_orders.exit_flags` (bs:8257) and onto the position at fill (bs:4356) — the snapshot pt reads.
Universal record-only references (config_version md5, bot_config_history, smc_scan_decision.confluence_input) apply to every row and are not repeated.
Management toggles are all OFF live, so every dependent parameter is dormant. The fallback that applies if a key is deleted is noted where it would change behaviour.

| Stored path | Value | Runtime key ← configMapper line (precedence/shadowing) | LIVE scan/order refs (what each does) | Mgmt/close refs | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| exit.breakEven | false | breakEvenEnabled ← cm:622 (`exit.breakEven ?? exit.breakEvenEnabled ?? raw ?? default true`) — **wins over exit.breakEvenEnabled** | bs:7815 exitFlags (record onto order/position); bs:8300 attribution input | SM:317 (`?? true`) gates BE move SM:464, max-hold BE SM:414-427, scalper session-close BE SM:787; pt:1137 only as last legacy fallback (`exitFlags.breakEven`) | be:2173 → be:691 (BE sim) | BCM:1582 (writes breakEven AND breakEvenEnabled), Backtest.tsx:718, ExpandedPositionCard:251/547, TradeOverrideEditor:65, exitSettings.ts:67 | — | management_version `be=` (sh/attribution.ts:185); entryConfigSnapshot | 22 (configMapper.test.ts:511) | active-gating (value off → BE never fires). **Deleting it flips BE ON** (RUNTIME_DEFAULTS true cm:91, SM `?? true`) | KEEP |
| exit.partialTP | false | partialTPEnabled ← cm:625 (`exit.partialTP ?? exit.partialTPEnabled ?? false`) — wins over exit.partialTPEnabled | bs:7820 exitFlags; bs:8301 attribution | SM:314 gates partial SM:658 and its trailing block SM:521; pt:1251/1217 read snapshot `exitFlags.partialTPEnabled ?? exitFlags.partialTP` | be:2179 → be:800 | BCM:1604 (writes both), Backtest.tsx:719, ExpandedPositionCard:570, TradeOverrideEditor:70 | — | management_version `partial=` | 10 (configMapper.test.ts:513) | active-gating (off; fallback also false) | KEEP |
| exit.tpRRRatio | 1.1 | tpRatio ← cm:615 (`exit.tpRRRatio ?? risk.defaultRR ?? risk.minRiskReward ?? raw.tpRatio ?? 2`) — if deleted, falls to stored risk.minRiskReward (1) | sets target: Route 2 TP = limit ± risk×tpRatio (sh/route2StopGeometry.ts:70 via bs:8009; legacy limit TP bs:7993-7995); market-chain TP bs:7321/7373/7436 feeds the MIN_TP gate bs:7647 (`skipped_tp_too_small`); zone-engine plans bs:5902/5992/6576 (record); exitFlags.tpRatio bs:7827 (+45 more incl. sh/smcAnalysis.ts:2460, sh/unifiedZoneEngine.ts:579) | — (SM style table SM:43-66 is a separate constant) | be:2178/710; bot-daily-review:740 (prompt) | BCM:1498, Backtest.tsx:700, applyRecommendation.ts:72-74 (writer), RecommendationsDashboard:148 | — | entryConfigSnapshot (sh/smcTradeTelemetry.ts:126) | 13 (TpRatioFieldVisible.test.ts) | active-geometry (every Route 2 target) | KEEP |
| exit.fixedSLPips | 10 | fixedSLPips ← cm:610 | sh/smcAnalysis.ts:2364 fallback SL distance when slMethod "structure" finds no swing (also :2333/:2340/:2352 other methods) → analysis.stopLoss → bs:7311 initial `sl`; survives only if bs:7316-7329 finds no swing → slBeforeFloor → Route 2 swingSL (bs:8004) | — | bc:417 template; daily-review/weekly-advisor prompts | BCM:1447 + presets 241-400, Backtest.tsx:663, applyRecommendation.ts:68-69 | — | — | 14 (botConfigAudit.test.ts:95) | active-geometry, marginal: no-swing fallback only; 10p is below every live floor (MIN_SL_PIPS 20-25, sh/smcAnalysis.ts:2619) so it is always widened to the floor | KEEP (marginal) |
| exit.fixedTPPips | 20 | fixedTPPips ← cm:614 | sh/smcAnalysis.ts:2414 (tpMethod fixed_pips), :2449 (next_level fallback) — neither branch reached with rr_ratio; analysis.takeProfit never survives to an order anyway (see takeProfitMethod) | — | bc:418 | BCM:1484 + presets, Backtest.tsx:694, applyRecommendation.ts:70-71 | — | — | 4 (botConfigAudit.test.ts:96) | dormant-by-value (tpMethod rr_ratio) | DEPRECATE |
| exit.slATRPeriod | 14 | slATRPeriod ← cm:612 | sh/confluenceScoring.ts:2970 ATR(period) for calculateSLTP: the ungated 1.5×ATR SL floor sh/smcAnalysis.ts:2378-2385, atr_based SL, atr_multiple TP → analysis.stopLoss (no-swing fallback only, as fixedSLPips) | — | bc:417 | BCM:1456, Backtest.tsx:674 | — | — | 1 (e2e-pipeline.test.ts:377) | active-geometry, marginal (5m ATR×1.5 < floor; fallback only). Note: this ATR is NOT gated by atrDerivedFloorsEnabled | KEEP (marginal) |
| exit.maxHoldHours | 0 | maxHoldHours ← cm:629 (`exit.timeExitHours ?? exit.maxHoldHours ?? 0`) — **shadowed by exit.timeExitHours** | none (only via runtime maxHoldHours, owned by timeExitHours) | none raw (pt reads exitFlags.maxHoldHours) | bot-daily-review:1005 reads `risk.maxHoldHours` (different path) | BCM:1630-1635 display fallback + slider writes both keys; applyRecommendation.ts:116 (writer) | — | — | (shared with runtime key) | shadowed-by-exit.timeExitHours | DEPRECATE |
| exit.trailingStop | false | trailingStopEnabled ← cm:619 (`exit.trailingStop ?? exit.trailingStopEnabled ?? raw ?? false`) — wins over exit.trailingStopEnabled | bs:7809 exitFlags; bs:8300 attribution | SM:311 gates trailing SM:517-640 (+adaptive SM:582); pt:1177 legacy fallback only | be:2175 → be:706 | BCM:1554 (writes both), Backtest.tsx:717, ExpandedPositionCard:515, TradeOverrideEditor:67, exitSettings.ts:68 | — | management_version `trail=` | 17 (configMapper.test.ts:510) | active-gating (off; fallback false) | KEEP |
| exit.slATRMultiple | 1.5 | slATRMultiple ← cm:611 | sh/smcAnalysis.ts:2337 only when slMethod = atr_based | — | bc:417; weekly-advisor:708 | BCM:1453, Backtest.tsx:670, applyRecommendation.ts:94 | — | — | 1 | dormant-by-value (slMethod structure) | DEPRECATE |
| exit.timeExitHours | 0 | maxHoldHours ← cm:629 (wins over exit.maxHoldHours) | bs:7826 exitFlags.maxHoldHours; bs:8301 attribution | SM:324 (needs >0 and maxHoldEnabled, SM:414); pt:1096/1101 time_exit needs exitFlags.maxHoldHours>0 | be:2182 → be:790 (backtest ignores maxHoldEnabled, uses hours>0 only) | BCM:1634 (writes both keys), Backtest.tsx:758, applyRecommendation.ts:118 | — | management_version maxHold hours (only if enabled); entryConfigSnapshot | 2 (configMapper.test.ts:515) | active (0 = "no limit"; second guard behind maxHoldEnabled in both engines) | KEEP |
| exit.tpATRMultiple | 2 | tpATRMultiple ← cm:616 | sh/smcAnalysis.ts:2454 only when tpMethod = atr_multiple | — | bc:418 | BCM:1505, Backtest.tsx:706, applyRecommendation.ts:93 | — | — | 1 | dormant-by-value | DEPRECATE |
| exit.maxHoldEnabled | false | maxHoldEnabled ← cm:628 | bs:7825 exitFlags; bs:8301 attribution | SM:323 gates max-hold SM:414; **pt:1095 RAW `liveExit.maxHoldEnabled ?? liveExit.timeBasedExitEnabled`** — global veto of time_exit even for open positions | bot-daily-review/weekly-advisor (prompt schema) | BCM:1626 (writes maxHoldEnabled + timeBasedExitEnabled; shows a stale "Scalper forces this on" note), BotView:763, exitSettings.ts:69, applyRecommendation.ts:115 | — | management_version, entryConfigSnapshot | 15 | active-gating (off) | KEEP |
| exit.partialTPLevel | 1 | partialTPLevel ← cm:627 | bs:7822 exitFlags | SM:316/662, pt:1253-1259 — only when partial on | be:2181/802 | BCM:1615, Backtest.tsx:752 | — | — | 15 | dormant-by-value (partial off) | DEPRECATE |
| exit.stopLossMethod | "structure" | slMethod ← cm:609 (`exit.stopLossMethod ?? exit.slMethod ?? raw ?? "structure"`) | sh/smcAnalysis.ts:2331 picks calculateSLTP branch → analysis.stopLoss; bs:7316-7329 re-implements "structure" unconditionally whenever swing points exist, so this only matters in the no-swing fallback (then floor-widened) | — | bot-daily-review:997 reads `strategy.slMethod` (wrong path); bc:417 | BCM:1435-1463, Backtest.tsx:656-667, applyRecommendation.ts:92 | — | — | 5 (configMapper.test.ts:83) | active-geometry, marginal (no-swing fallback only) | KEEP (marginal) |
| exit.breakEvenEnabled | false | breakEvenEnabled ← cm:622 — **shadowed by exit.breakEven in the mapper** | none (scanner uses exit.breakEven) | **pt:1137 reads it RAW** (`resolveFlag("breakEvenEnabled")` → `liveExit.breakEvenEnabled` before the snapshot) | bot-daily-review:1008, weekly-advisor:1553 (raw, default true) | BCM:1582 writes both; applyRecommendation.ts:110 writes ONLY this key | — | — | 78 (shared name) | shadowed in scanner/SM; ACTIVE in pt's UI-polled BE loop (off) — duplicate owner with exit.breakEven | KEEP (duplicate — collapse into one key) |
| exit.partialTPEnabled | false | partialTPEnabled ← cm:625 — **shadowed by exit.partialTP** | none | none raw (pt reads snapshot exitFlags) | bot-daily-review:1009 (raw) | BCM:1604 writes both; applyRecommendation.ts:112 writes ONLY this key | — | — | 20 (shared) | shadowed-by-exit.partialTP | DEPRECATE |
| exit.partialTPPercent | 50 | partialTPPercent ← cm:626 | bs:7821 exitFlags | SM:315/661, pt:1262/1327 — only when partial on | be:2180/810 | BCM:1609, Backtest.tsx:748 | — | — | 16 | dormant-by-value | DEPRECATE |
| exit.takeProfitMethod | "rr_ratio" | tpMethod ← cm:613 (`exit.takeProfitMethod ?? exit.tpMethod ?? raw`) | sh/smcAnalysis.ts:2410 → analysis.takeProfit. Never reaches an order: market-chain tp is recomputed from tpRatio on every swing/floor/impulse branch (bs:7321-7437; the 10p fallback stop is always floor-widened), and Route 2 recomputes the target from the limit | — | bot-daily-review:999 (`strategy.tpMethod`); bc:418 | BCM:1472-1503, Backtest.tsx:687-704, applyRecommendation.ts:91 | — | — | 10 | no live effect (analysis.takeProfit is only a truthiness check bs:7309 and log-only Gate 10) | DEPRECATE |
| exit.trailingStopPips | 8 | trailingStopPips ← cm:620 | bs:7810 exitFlags | SM:312/579 (snapshot first), pt:1178 (`liveExit.trailingStopPips` raw) — only when trailing on | be:2176/706-714 | BCM:1559, Backtest.tsx:724 | — | — | 20 | dormant-by-value (trailing off) | DEPRECATE |
| exit.breakEvenOffsetPips | 5 | breakEvenOffsetPips ← cm:624 (`exit.breakEvenOffsetPips ?? exit.breakEvenPips ?? raw`) | bs:7817 exitFlags | SM:322/379 (default 3), pt:1151 (snapshot) — only when BE on | bc:421 | BCM:1593 | — | — | 7 | dormant-by-value (BE off) | DEPRECATE |
| exit.trailingStopEnabled | false | trailingStopEnabled ← cm:619 — **shadowed by exit.trailingStop in the mapper** | none | **pt:1177 reads it RAW** (`liveExit.trailingStopEnabled`) | bot-daily-review:1007, weekly-advisor:679/1552 (raw, default true) | BCM:1554 writes both; applyRecommendation.ts:107 writes ONLY this key | — | — | 35 (shared) | shadowed in scanner/SM; ACTIVE in pt's trailing loop (off) — duplicate owner | KEEP (duplicate — collapse) |
| exit.breakEvenTriggerPips | 15 | breakEvenPips ← cm:623 (`exit.breakEvenTriggerPips ?? exit.breakEvenPips ?? raw`) | bs:7816 exitFlags | SM:318/464 R-based trigger; pt:1138 reads raw `exit.breakEvenPips` (absent) then snapshot (=15) — only when BE on | bc:421 | BCM:1587, Backtest.tsx:740, applyRecommendation.ts:111 | — | — | 1 | dormant-by-value (BE off) | DEPRECATE |
| exit.timeBasedExitEnabled | false | — (not mapped) | none | pt:1095 fallback only when exit.maxHoldEnabled is absent | bc:422 | BCM:1626-1630 (writes it with maxHoldEnabled), BotView.tsx:764 (display gate), applyRecommendation.ts:117 | — | — | 0 | shadowed-by-exit.maxHoldEnabled | DEPRECATE |
| exit.trailingStopActivation | "after_1r" | trailingStopActivation ← cm:621 | bs:7811 exitFlags | SM:313/487/538, pt:1209-1213 (snapshot) — only when trailing on | be:2177/710 | BCM:1564, Backtest.tsx:728 | — | — | 10 | dormant-by-value | DEPRECATE |
| exit.structureInvalidationEnabled | false | structureInvalidationEnabled ← cm:591 | none at entry | SM:681-683 (tighten SL on adverse CHoCH) | be:726 reads `!== false` — backtest treats a MISSING key as ON | BCM:1644, SignalStatusPanel:113, applyRecommendation.ts:119 | — | — | 19 | active-gating (off; live fallback false, backtest fallback on) | KEEP |

### risk.*

| Stored path | Value | Runtime key ← configMapper line (precedence/shadowing) | LIVE scan/order refs (what each does) | Mgmt/close refs | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| risk.minRR | 1 | `minRiskReward` ← :579 (`risk.minRR ?? risk.minRiskReward ?? raw.minRiskReward`) — **wins** | bs:1726-1729 Gate 10 `rr_legacy` (would block; turned into logged pass by rrGateMode=order_geometry, sh/simplification.ts:114); sh/smcAnalysis.ts:2435 next_level TP target skip (tpMethod rr_ratio → not reached); pairGateOverrides.minRiskReward can override (sh/configMapper.ts:849; none set) | — | be:447-448 backtest R:R gate; bot-daily-review:558 / bot-weekly-advisor:1032 (LLM prompt text) | BCM:1287 input; Backtest.tsx:603; applyRecommendation.ts:75-76; RecommendationsDashboard.tsx:150 | — | gate verdict recorded as `rr_legacy` (mode log) via loggedOnlyWouldBlock / classifyGate (sh/attribution.ts:60) | 12 (configMapper.test.ts:496) | active-logging-only (superseded-by simplification.orderRRMin for Route 2, bs:8034-8047) | DEPRECATE |
| risk.minRiskReward | 1 | `minRiskReward` ← :579 — **shadowed by risk.minRR**; also 3rd fallback of `tpRatio` ← :615 (`exit.tpRRRatio ?? risk.defaultRR ?? risk.minRiskReward`) — inert while exit.tpRRRatio (1.1) exists | none (shadowed) | — | bc:274-275 validation `risk.minRiskReward`; bc:409 template | BCM presets 232/287/339/391 write it; applyRecommendation.ts:76 maps it to risk.minRR | — | — | 41 (TpRatioFieldVisible.test.ts:49) | shadowed-by-risk.minRR (latent: becomes tpRatio if exit.tpRRRatio is deleted) | DEPRECATE |
| risk.maxDrawdown | 10 | `maxDrawdown` ← :671-674 `Math.min(risk.maxDrawdown, protection.circuitBreakerPct ?? 100)` = min(10,20)=10 | bs:1677-1690 Gate 8 drawdown block — **skipped ("delegated to prop firm gate") when propFirmActive** (bs:1680, arg bs:7201); profile is active per memory/settlement notes (STEP13 doc:5 says Gates 7/8/15 run until is_active=true) | pt:1499 is a metric, not this key | be:454-458, be:1648-1650 backtest DD gate; bc:268-269 validation; bc:408 template; LLM advisors | BCM:1307-1351 input (+$ view); Backtest.tsx:625-627; presets | — | — | 31 | superseded-by step 13 risk profile (fallback gate if profile inactive) | DEPRECATE |
| risk.fixedLotSize | 0.1 | `fixedLotSize` ← :576 | bs:7731, 8061, 8875 → computePositionSize → sh/smcAnalysis.ts:2688-2690 only when method=fixed_lot | — | be:2146-2147; bc:409; LLM advisors | BCM:1190 (shown only for fixed_lot); applyRecommendation.ts:85 | — | — | 3 | dormant-by-value (positionSizingMethod=percent_risk; and fill_time sizing ignores it) | DEPRECATE |
| risk.maxDailyLoss | 3 | `maxDailyLoss` ← :577 (`risk.maxDailyDrawdown ?? risk.maxDailyLoss ?? raw.maxDailyLoss`; maxDailyDrawdown absent) | bs:1659-1675 Gate 7 daily-loss % block — skipped when propFirmActive (bs:1662) | — | be:470-471, be:1657 backtest; bc:265-266 validation; bot-daily-review:1003 (LLM context) | no UI input (presets 231/285/337/389 only); Backtest page has none for risk.* daily loss | — | — | 17 | superseded-by step 13 risk profile (fallback gate if profile inactive) | DEPRECATE |
| risk.riskPerTrade | 0.5 | `riskPerTrade` ← :574 (STYLE_PROTECTED :822) | bs:5193 `pairRiskPercent = effectiveRiskPercent(simp, riskPerTrade)` → returns simplification.riskPercent under fill_time (sh/simplification.ts:102-104); bs:1649 Gate 6 SL-missing fallback, same function. No live read uses the raw value | — | be:2149 backtest sizing; bc:262-263 validation; bot-daily-review/weekly-advisor (LLM context, rr_achieved denominators) | BCM:1218-1221 input; Backtest.tsx:599; applyRecommendation.ts:66-67 | — | bs:8299 `legacyRiskPercent` → sh/attribution.ts sizing_version only when sizingMode≠fill_time (else unused); entryConfigSnapshot sh/smcTradeTelemetry.ts:129 | 37 | superseded-by simplification.riskPercent (equal value 0.5 today) | DEPRECATE |
| risk.conflictBlockAt | 3 | `conflictBlockAt` ← :584 | bs:4878 `Number(..)||6`; bs:7000-7067 **hard block** "Conflict counter BLOCKED" when opposingFactorCount ≥ 3 (status rejected) | — | be:2039 backtest; LLM advisors | BCM:1368-1369 slider; presets; applyRecommendation.ts:133 | — | — | 5 | active-gating in code, but **currently unreachable**: only 6 factors can be `_opposing` (sh/confluenceScoring.ts:1130/1352/1575/1606/1707/1766) and 4 of them are skipped because their toggles are false (useDisplacement, useAMD, useFOTSI, useDailyBias → FACTOR_TOGGLE_MAP :2587-2600, skip at :2640), so opposingFactorCount ≤ 2 < 3 [assembler-verified] | KEEP (live block whose threshold cannot be reached with today's toggles) |
| risk.maxOpenPositions | 3 | `maxOpenPositions` ← :578 — **shadowed by risk.maxConcurrentTrades** | none in unified mode; legacy-only raw read in sh/positionCaps.ts:85 (second_poller path, used by zcs:586 which exits early: secondPollerEnabled=false, zcs:300) | — | bc:271-272 validation; bc:409 template | BCM presets 232/286/338/390 write it; applyRecommendation.ts:78 maps `maxOpenPositions`→`risk.maxConcurrent` (sic) | — | — | 48 | shadowed-by-risk.maxConcurrentTrades; superseded-by simplification.capsMode | DEPRECATE |
| risk.maxPortfolioHeat | 5 | `portfolioHeat` ← :582 | bs:1633-1657 Gate 6 heat block (sum of |entry−SL| risk of OPEN positions ≥ 5%); bs:7677 decision-record field | — | be:482-483 backtest | BCM:1292; Backtest.tsx:615; presets; applyRecommendation.ts:82 | — | — | 9 | active-gating (cannot bind today: caps 3 × 0.5% ≈ 1.5%) | KEEP |
| risk.maxConcurrentTrades | 3 | `maxOpenPositions` ← :578 — wins over risk.maxOpenPositions | none: placement bs:1615, hunt fill bs:4286, scan-stop bs:4852, decision record bs:7670 all call resolvePositionCaps → unified branch (sh/positionCaps.ts:49-58) ignores the flat value | — | be:410-411, be:1643 backtest; LLM advisors | BCM:1284 input; Backtest.tsx:607; applyRecommendation.ts:80 | — | caps_version uses the RESOLVED cap (unified_3_1), not this key | 8 | superseded-by simplification.capsMode/maxOpenPositions | DEPRECATE |
| risk.conflictThresholdRaise | 2 | `conflictThresholdRaise` ← :583 | bs:4877; bs:7002-7004 raises score threshold +10 when ≥2 opposing → only feeds scoreGate (log-only) and staging promotion (stagingEnabled=false) | — | be:2041 backtest; LLM advisors | BCM:1362-1363; presets; applyRecommendation.ts:134 | — | threshold recorded in decisionScoreGate (bs:7131) | 3 | scoring-only (raises a log-only threshold) | DEPRECATE |
| risk.positionSizingMethod | "percent_risk" | `positionSizingMethod` ← :575 | bs:7730 market-path size; bs:7785 provenance record; bs:8060 placement fallback size (overwritten when fillTimeSize ok, bs:8075-8083); bs:8874 broker mirror | — | be:2146; bc:408; LLM advisors | BCM:1176-1216 select (offers "volatility_adjusted", which smcAnalysis.ts:2693 handles; mapper type says "atr_volatility") | — | sizing provenance only | 3 | superseded-by simplification.sizingMode=fill_time (fallback planned size only) | DEPRECATE |
| risk.maxPositionsPerSymbol | 1 | `maxPerSymbol` ← :580 | none in unified mode (resolvePositionCaps ignores it); legacy second_poller reads `risk.maxPerSymbol` — a DIFFERENT key never stored (sh/positionCaps.ts:86) | — | bc:409 template; LLM advisors | BCM:1295; Backtest.tsx:619; presets; applyRecommendation.ts:84 | — | — | 7 | superseded-by simplification.capsMode/maxPerSymbol | DEPRECATE |
| risk.atrVolatilityMultiplier | 1.5 | **not mapped** (no line in mapNestedToFlat; absent from runtime pairConfig) | bs:7733, 8063, 8877 read `pairConfig.atrVolatilityMultiplier` → always undefined → sh/smcAnalysis.ts:2696 default 1.5; only used by method volatility_adjusted | — | LLM advisors list it (bot-daily-review:557, weekly:1031) | BCM:1196-1199 slider; applyRecommendation.ts:135 | — | — | 0 | read-nowhere (stored value never reaches code) | DEPRECATE |
| risk.allowSameDirectionStacking | false | `allowSameDirectionStacking` ← :581 (pair-overridable :851) | bs:1625 Gate 5 blocks same-symbol same-direction; bs:4336 hunt-fill cancel CANCELLED_POSITION_CAP; bs:7678 record | — | bc:325 (pair override validation); LLM advisors | BCM:1298 toggle, 2301/2423 pair override; applyRecommendation.ts:132 | — | — | 19 | active-gating (redundant today: unified maxPerSymbol=1 blocks any 2nd position on the symbol) | KEEP |

### entry.*

| Stored path | Value | Runtime key ← configMapper line | LIVE scan/order refs | Mgmt/close refs | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| entry.slBufferPips | 1 | slBufferPips ← cm:592 (`entry.slBufferPips ?? raw ?? 2`) | bs:5287-5290 adjustedSlBuffer = slBufferPips × asset multiplier (forex 1.0, sh/smcAnalysis.ts:326) unless instrumentBuffers[pair]; → swing stop bs:7319/7326 (= Route 2 swingSL), impulse pip-buffer floor bs:7404 (max with 2% of leg), anchored stop bs:7547 (shadow), calculateSLTP buffer sh/smcAnalysis.ts:2327 | — | bc:295 (instrumentBuffers validator) | BCM:1386/1824, Backtest.tsx:642, applyRecommendation.ts:95 | — | — | 35 | active-geometry | KEEP |
| entry.trailingEntry | false | — (not mapped) | none | none | bc:413 template only | BCM presets/defaults 237/292/344/396 only (no field, no reader) | — | — | 0 | read-nowhere (writer-only) | DEPRECATE |
| entry.closeOnReverse | false | closeOnReverse ← cm:589 | bs:8482 — market-insert path only, unreachable (marketEntriesEnabled=false → bs:7925) | — | be:429 | BCM:1389, Backtest.tsx:646, applyRecommendation.ts:120 | — | — | 2 | dormant-by-value (false, and market path disabled) | DEPRECATE |
| entry.cooldownMinutes | 5 | cooldownMinutes ← cm:588 (`entry.cooldownMinutes ?? 0`) | Gate 13 bs:1782-1795 blocks placement if last close on symbol (paper_trade_history) < 5 min; not re-checked at hunt fill | — | be:489/1659 | BCM:1383, Backtest.tsx:638, applyRecommendation.ts:124 | — | — | 8 | active-gating | KEEP |
| entry.entryRefinement | false | — | none | none | bc:412 | BCM presets/defaults only | — | — | 0 | read-nowhere (writer-only) | DEPRECATE |
| entry.maxSlippagePips | 1 | — | none | none | bc:413 | BCM presets/defaults only | — | — | 0 | read-nowhere (writer-only) | DEPRECATE |
| entry.defaultOrderType | "market" | — | none (route chosen by izGateMode/limitEntry, bs:7922) | none | bc:412 | BCM presets/defaults only | — | — | 0 | read-nowhere (writer-only); value contradicts live Route-2-only | DEPRECATE |
| entry.marketFillAtZone | false | marketFillAtZone ← cm:764 (default **true**, cm:250) | bs:7919 useMarketFillAtZone. If true, at-zone setups lose effectiveLimitEnabled (bs:7922) and are refused as `market_entry_disabled` (bs:7925) | — | run-backtest-local.ts:164 | BCM:1417 (shows `?? true`) | — | entryConfigSnapshot | 37 | active-gating (value off is load-bearing: **deleting the key turns it on and turns at-zone Route 2 setups into refusals**) | KEEP |
| entry.trailingEntryPips | 3 | — | none | none | bc:413 | BCM presets/defaults only | — | — | 0 | read-nowhere (writer-only) | DEPRECATE |
| entry.refinementTimeframe | "1m" | — | none | none | bc:412 | BCM presets/defaults only | the 4 SQL hits (mig/20260914000000_baseline_schema.sql:4358/4395, mig/20260916000000_frozen_decision_version_allowed.sql:174/216) are `confirmation.refinementTimeframe` inside frozen-decision JSON, NOT this config key | — | 0 | read-nowhere (writer-only) | DEPRECATE |
| entry.scanIntervalMinutes | 5 | scanIntervalMinutes ← cm:587 | bs:2362-2364 scan-interval gate (styleOverridesMode off → stored value, fallback 15) | — | scheduled-tasks:194 (writer); be:362 forces 0 | BCM:833-845, BotView:570, applyRecommendation.ts:125 | — | — | 23 | active-other (scan cadence) | KEEP |
| entry.limitOrderExpiryMinutes | 480 | limitOrderExpiryMinutes ← cm:760 | none: Route 2 TTL is the constant ROUTE2_TTL_MINUTES = 8h (sh/route2Forward.ts:34-35, bs:7984-7985); equal to 480 only by coincidence | — | prompts only | BCM:1405 (UI default 60), applyRecommendation.ts:123 | — | — | 5 | superseded-by-ROUTE2_TTL_MINUTES | DEPRECATE |

### account.*

| Stored path | Value | Runtime key ← configMapper line | LIVE scan/order refs | Mgmt/close refs | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| account.mode | "paper" | — (not mapped) | none (execution mode is the `paper_accounts.execution_mode` column) | none | bc:446 template | BCM:266 default + presets 318/370/422 only | — | — | 0 | read-nowhere (writer-only) | DEPRECATE |
| account.leverage | 100 | — | none (sizing uses a hard-coded 10× notional cap, sh/smcAnalysis.ts:2677, sh/fillTimeSizing.ts:88) | none | bc:446 | BCM:266/318/370/422 only | — | — | 0 | read-nowhere (writer-only) | DEPRECATE |
| account.startingBalance | 100000 | — (not mapped) | none on scan/order path | pt:1826 `getConfiguredStartingBalance` → `status` response startingBalance (pt:1473, UI return base BotView:887/1277); bankroll for `reset_balance_only` (pt:1863) and `reset_account` (pt:1879) via `reset_paper_account` RPC | bc:446 template | BCM:1164 field + derived $ labels 1221-1351 | — | — | 3 (be test uses request-body startingBalance) | active-other (paper-account reset bankroll; UI baseline) | KEEP |

### sessions.*

| Stored path | Value | Runtime key ← configMapper line | LIVE scan/order refs | Mgmt/close refs | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sessions.filter | ["london","newyork","asian","offhours"] | `enabledSessions` ← :639-650 (normalizeSessionFilter; legacy asianEnabled… and raw.enabledSessions fallbacks) | bs:5163-5171 per-pair session skip (`isSessionEnabled`, sh/sessions.ts:234-237; offhours implicitly allowed when 3 core on) | — | be:533-538, be:1630-1631 backtest session gate | BCM:1852-1871 session toggles; sessionSchedule.ts:11-82 (display); Backtest.tsx:279, 773 | — | — | 39 (enabledSessions) | active-gating (non-binding: all four sessions enabled) | KEEP |
| sessions.activeDays.mon | true | `enabledDays` ← :655-665 | bs:2517 whole-scan "Day not enabled" early return (NY local day; Sun ≥17:00 counts as Mon) | — | bc:335-336 validation, bc:435 template | presets only (BCM:259/314/366/418); no editor; Backtest.tsx:80/1199 display of enabledDays | — | — | 5 | active-gating (non-binding: Mon–Fri all true) | KEEP |
| sessions.activeDays.tue | true | same ← :655-665 | bs:2517 | — | bc:335, 435 | presets only | — | — | 5 | active-gating (non-binding) | KEEP |
| sessions.activeDays.wed | true | same | bs:2517 | — | bc:335, 435 | presets only | — | — | 5 | active-gating (non-binding) | KEEP |
| sessions.activeDays.thu | true | same | bs:2517 | — | bc:335, 435 | presets only | — | — | 5 | active-gating (non-binding) | KEEP |
| sessions.activeDays.fri | true | same | bs:2517 | — | bc:335, 435 | presets only | — | — | 5 | active-gating (non-binding) | KEEP |
| sessions.newsFilterEnabled | true | `newsFilterEnabled` ← :691 | bs:1843-1880 Gate 16 (calls `fundamentals` fn `high_impact_check` per gated pair; gateId news_event); bs:7269 news-alignment gate (gateId news_alignment); bs:8654 recorded in market-path signal_reason. Both gateIds are log-only under newsGateMode=log (sh/simplification.ts:115) | — | be:360 forces it false in backtests; bc:436 template; LLM advisors; local-runner/r2-cadence.ts:25 | BCM:1889 toggle; presets; SignalStatusPanel.tsx:123; applyRecommendation.ts:97 | — | would-block recorded in loggedOnlyWouldBlock / trade_attribution.gates (mode log) | 3 | active-logging-only (cannot block; one fundamentals call per pair reaching gates) | DEPRECATE (log-only under simplification.newsGateMode="log"; becomes KEEP if newsGateMode returns to "gate") [assembler: harmonised with the log-only policy used for the score/ICT gates] |
| sessions.newsFilterPauseMinutes | 60 | `newsFilterPauseMinutes` ← :692 | bs:1858 `withinMinutes` of Gate 16, reason text 1865/1867; bs:8654 record | — | bc:338-339 validation, bc:436; LLM advisors | BCM:1892-1893; presets; applyRecommendation.ts:98 | — | via gate reason text | 3 | active-logging-only | DEPRECATE (log-only under simplification.newsGateMode="log"; becomes KEEP if newsGateMode returns to "gate") [assembler: harmonised with the log-only policy used for the score/ICT gates] |

### strategy.* (part 1 of 2)

Legend specific to this part: `cs` = sh/confluenceScoring.ts; `izE` = sh/impulseZoneEngine.ts; `uzE` = sh/unifiedZoneEngine.ts; `szd` = sh/smcZoneDecision.ts; `BT` = src/pages/Backtest.tsx; `RD` = src/components/RecommendationsDashboard.tsx; `aR` = src/lib/applyRecommendation.ts; `adv` = bot-daily-review/index.ts:~600 + bot-weekly-advisor/index.ts:~1075 (LLM prompt key lists, text only). "presets" = BCM:223/277/329/381 style presets + bc:380-405 default template (they WRITE the key). smcAnalysis.ts:344-410 `DEFAULTS` is exported but imported nowhere (dead) — not counted. Backtest-engine maps through mapNestedToFlat (be:356-357) and runs the same cs scorer, so every scoring toggle also affects backtests.

**Conflict-counter fact used below (verified):** only six factors can ever be marked `_opposing` (cs:1130 Reversal Candle, 1352 Displacement, 1575 AMD Phase, 1606 Currency Strength, 1707 Daily Bias, 1766 Confluence Stack), and the counter skips any factor whose FACTOR_TOGGLE_MAP toggle is false (cs:2587-2600, 2636-2640). Each of those factors is also only scored inside its `if (toggle)` branch. With useDisplacement/useAMD/useFOTSI/useDailyBias all false, the maximum `opposingFactorCount` is 2 (Reversal Candle + Confluence Stack), which is below `risk.conflictBlockAt` = 3. **The conflict-counter hard block (bs:6999-7067) therefore cannot fire with today's values.** Those four toggles are what keeps it unreachable: deleting any of them restores the default `true`.

| Stored path | Value | Runtime key ← configMapper line (precedence) | LIVE scan/order refs | Mgmt/close | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| strategy.useAMD | false | useAMD ← :487 (`?? true`) | cs:1534 AMD factor disabled (scoring); cs:2597 toggle map, so AMD is excluded from the conflict counter; cs:2717/2857 Po3 tieredMax term (scoring) | — | be:1337 toggle map; adv | BCM:999 toggle; BT:581; RD:233; aR:155 | — | — | 5 (configMapper.test:466) | active-other: keeps AMD out of the conflict counter (one of the 4 that make the block unreachable); otherwise scoring-only | KEEP (load-bearing: deleting it gives default true) |
| strategy.useFVG | false | enableFVG ← :475 (`useFVG ?? enableFVG ?? true`); **wins over enableFVG=true** | via enableFVG: cs:650 FVG factor (scoring), which also gates fvgMinSizePips/fvgOnlyUnfilled; cs:2590 toggle map (FVG is never opposing) | — | be:1330; adv | BCM:987 toggle (binds useFVG); BT:569; RD:227; aR:149 | — | — | 2 | scoring-only | DEPRECATE (deleting it lets enableFVG=true take over, which affects scoring only) |
| strategy.useSMT | false | useSMT ← :483 (`?? true`) | bs:5203 skips the SMT correlated-pair candle fetch; cs:1444 SMT factor disabled (scoring); cs:2595 toggle map (SMT is never opposing); with the factor disabled, Gate 9b (bs:1700-1707) could not veto anyway | — | be:1335/1374/1770; adv | BCM:995; BT:577; RD:231; aR:153 | — | — | 3 | active-other (saves one SMT pair fetch per pair per scan, which affects API credits); scoring-only for trades | DEPRECATE (caveat: deleting it re-adds SMT fetches; trades change only if smtOppositeVeto is also on) |
| strategy.enableOB | true | enableOB ← :474, **shadowed by useOrderBlocks=false** | runtime enableOB=false → cs:494 OB factor (scoring) | — | be:1329; bc:380 template | presets only (BCM:223,277,329,381); aR:59 | — | — | 14 | shadowed-by-strategy.useOrderBlocks | DEPRECATE |
| strategy.useFOTSI | false | useFOTSI ← :488 (`?? true`) | bs:3374 skips the 28-pair FOTSI fetch, so `_fotsiResult` is null. That disables Gate 17 (bs:1889, passes "data unavailable"), the FOTSI −2 score penalty (bs:6442) and the thesis `fotsi_veto` (sh/thesisValidator.ts:285 records "no FOTSI result available" and cannot cancel). cs:1586 Currency Strength disabled; cs:2598 toggle map excludes it from the conflict counter (opposing-eligible, cs:1606) | thesis fotsi_veto on pending orders (bs:3820): dormant through this key | be:613/1338/2022; run-backtest-local.ts:166 | BCM:1000; BT:582 | — | — | 8 | active-other: suppresses the FOTSI fetch, the pending-order FOTSI cancel and conflict-counter eligibility | KEEP (load-bearing: default true would re-arm the thesis FOTSI cancel and 28 fetches) |
| strategy.enableBOS | true | enableStructureBreak ← :477, **shadowed by useStructureBreak=false** (enableBOS is read only when useStructureBreak is undefined) | runtime enableStructureBreak=false (consumed in part 2 / elsewhere) | — | bc:380 template | presets only (BCM:223/277/329/381) | — | — | 0 | shadowed-by-strategy.useStructureBreak | DEPRECATE |
| strategy.enableFVG | true | enableFVG ← :475, **shadowed by useFVG=false** | runtime enableFVG=false → cs:650 FVG factor (scoring); cs:2590 toggle map | — | be:1330; bc:380 template | presets only (BCM:223/277/329/381); aR:60 | — | — | 14 | shadowed-by-strategy.useFVG | DEPRECATE |
| strategy.enableCHoCH | true | **not mapped** (no line in mapNestedToFlat) | none | — | bc:380 template (writer) | presets only (BCM:223/277/329/381, writers) | — | — | 0 | read-nowhere. Writers only, so it fails the REMOVE rule | DEPRECATE (presets/template still write it)[^choch] |
| strategy.htfTimeframe | "1h" | htfTimeframe ← :596 | bs:2413 profile-mismatch check (log); bs:2418 log. **No candle fetch or engine reads it**: the bias TF comes from `tradingStyle.mode` (resolvedStyle, e.g. bs:6482 scalper → 1h) | — | local-runner only | not bound (BCM:806 shows STYLE_PARAMS, not this key) | — | — | 6 (step14ExplicitConfig) | active-logging-only (asserted against the scalper profile) | DEPRECATE (caveat: deleting it falls back to default "1day", which logs a timeframe-mismatch warning every scan) |
| strategy.minZoneScore | 0 | minZoneScore ← :518 (default 4) | bs:6679-6686 Zone Score Gate (`totalScore < 0` never true); entryConfigSnapshot (sh/smcTradeTelemetry.ts:126) | — | local-runner/r2-state2.ts:24 | BCM:860 slider; ZoneStoryPanel:160-516 and BotView:822-2024 (display of the threshold) | comment only in mig/20260925090000:150 (smc_scan_context.engine_args) | entry_config_snapshot | 53 (minZoneScoreGate.test) | dormant-by-value (0 disables the gate) | KEEP (load-bearing: deleting it gives default 4, which turns the zone gate back on) |
| strategy.useDailyBias | false | useDailyBias ← :491 (`?? true`) | cs:1616 Daily Bias factor (scoring, opposing-eligible cs:1707); cs:2599 toggle map excludes it from the conflict counter; also suppresses the "Gate 1 will BLOCK" detail text (cs:1660) | — | be:1339; run-backtest-local.ts:167; adv | BCM:998; BT:580; RD:234; aR:156 | — | — | 5 | active-other: conflict-counter eligibility (one of the 4); otherwise scoring-only | KEEP (load-bearing) |
| strategy.entryTimeframe | "5m" | entryTimeframe ← :595 | bs:5198-5199 entry-TF candle series for every pair (all SMC analysis on 5m); bs:3671-3672 pending-order touch detection and SL-invalidation bars; bs:4968 Game Plan entry series; bs:1742 Gate 11 OR timing (OR disabled); bs:1506 P/D label; bs:2412 profile check; bs:5471/8671 telemetry; recorded in signal_reason (bs:8250/8654) | sh/scannerManagement.ts:689 reads `signalData.entryTimeframe` (from signal_reason) for structure invalidation (disabled by exit.structureInvalidationEnabled=false) | be:1292 entry interval; local-runner; run-backtest-local.ts:155 | not bound in the UI (BCM:805 shows STYLE_PARAMS); BT:81/1199 result display | — | — | 29 | active-other (sets the entry/touch timeframe) | KEEP |
| strategy.fvgMinSizePips | 5 | fvgMinSizePips ← :503 (default 0) | cs:655 (inside the `enableFVG !== false` block only) | — | bc:251 validation, bc:383 template | BCM:1147 input; presets | — | — | 0 | shadowed (dormant): runtime enableFVG=false, so cs:650 block never runs | DEPRECATE |
| strategy.ictRiskEnabled | false | ictRiskEnabled ← :741 (default true) | bs:6329 ICT risk assessment skipped (it would query the non-existent `trade_history`, bs:6342); bs:7120 ICT RISK hard block (dormant) | — | bc:405 template | BCM:200 ICT module enabledField | — | — | 6 (step14ExplicitConfig:183) | dormant-by-value | DEPRECATE (caveat: default true re-enables a failing query each pair; canTrade stays true because the table is missing — unverified at runtime) |
| strategy.stagingEnabled | false | stagingEnabled ← :568 (default true) | bs:2978/2992 staged-setup load skipped; bs:6413 staged invalidation; bs:6612 watch-zone staging; bs:7009 promotion (with staging on, a score-passing staged setup `continue`s as `staged_confirming` until minStagingCycles); bs:9139/9260 new and expired staging; bs:9470 summary | — | — | none | — | — (route `watchlist_promotion` in attribution only when promoted) | 5 | dormant-by-value | KEEP (load-bearing: default true re-enables staging, which can delay or skip entries) |
| strategy.useOrderBlocks | false | enableOB ← :474 (**wins over enableOB=true**) | via enableOB: cs:494 OB factor (scoring); cs:2589 toggle map (OB never opposing) | — | be:1329; adv | BCM:986 toggle (binds useOrderBlocks); BT:568; RD:226; aR:148 | — | — | 2 | scoring-only | DEPRECATE |
| strategy.zoneEntryDepth | 0.55 (EUR/USD 0.5 via pairGateOverrides, configMapper:861-864) | zoneEntryDepth ← :538 (default 1) | bs:5903/5993 passed as `entryDepth` into decideZone → szd:227 → **only** uzE:408/501-512 (Unified EntryStory entryPrice). With `unifiedModifiersEnabled=false`, `unifiedGatePassed` stays false for scalper (bs:6546-6552), so the Unified entry override (bs:7861-7871) never runs. The Route 2 limit comes from izE `refinedEntry` (izE:1172-1182, LTF OB/FVG edge) or the hard-coded zone midpoint (bs:7851). Depth reaches only unifiedComparison (bs:6574-6580, log) and szd:318 entryDepthInUse (log) | — | local-runner replays (engine_args) | BCM:909-932 slider and example | smc_scan_context.engine_args (mig/20260925090000:149, comment); **trade_attribution.entry_depth** (mig/20261008000000_step15_attribution_schema.sql:88) | buildAttribution entryDepth (bs:8326 → sh/attribution.ts:227) | 32 (perPairZoneEntryDepth, zoneEntryDepth*) | active-logging-only. **Does not move the live Route 2 limit** | DEPRECATE (becomes live only if unifiedModifiersEnabled=true) |
| strategy.fvgOnlyUnfilled | true | fvgOnlyUnfilled ← :504 (default true) | cs:656 (inside the `enableFVG !== false` block only) | — | bc:383 template | BCM:1153; presets | — | — | 0 | shadowed (dormant): enableFVG=false | DEPRECATE |
| strategy.htfBiasRequired | true | htfBiasRequired ← :469 (`requireHTFBias ?? htfBiasRequired ?? raw ?? true`) | bs:1448-1480 legacy Gate 1 HTF veto, **only when directionVerdict is null** (the verdict threw, bs:6524-6527); cs:1660 detail text (inside Daily Bias, off) | — | be:573 (backtest Gate 1); bc:381 | presets only | — | — | 20 | active-gating on the error fallback only; dormant in normal scans | KEEP (equals default; it is the Gate 1 safety fallback) |
| strategy.smtOppositeVeto | false | smtOppositeVeto ← :484 (`?? true`) | bs:1700 Gate 9b not evaluated | — | be:653 | BCM:996 | — | — | 2 | dormant-by-value. Even at default true, useSMT=false means the SMT factor is never "opposite", so no veto | DEPRECATE (caveat: deleting both useSMT and this key re-arms a live veto) |
| strategy.useDisplacement | false | useDisplacement ← :478 (`?? true`) | cs:1325 Displacement factor (scoring, opposing-eligible cs:1352); cs:2592 toggle map excludes it from the conflict counter | — | be:1332; adv | BCM:990; BT:572; RD:230; aR:57/152 | — | — | 2 | active-other: conflict-counter eligibility (one of the 4); otherwise scoring-only. Note Gate 3b reaction (log-only) lists Displacement as a reaction factor | KEEP (load-bearing) |
| strategy.useMacroWindows | false | useMacroWindows ← :482 (`?? true`) | cs:906 Session Quality macro term (scoring) | — | adv | BCM:994; BT:576; RD:236; aR:158 | — | — | 2 | scoring-only | DEPRECATE |
| strategy.useSilverBullet | false | useSilverBullet ← :481 (`?? true`) | cs:905 Session Quality SB term (scoring) | — | adv | BCM:993; BT:575; RD:235; aR:157 | — | — | 2 | scoring-only | DEPRECATE |
| strategy.useUnicornModel | false | useUnicornModel ← :480 (`?? true`) | cs:484 skip detectUnicornSetups; cs:1409/1427 factor (scoring); cs:2594 toggle map (never opposing) | — | be:1334; adv | BCM:992; BT:574; RD:237; aR:49/159 | — | — | 10 | scoring-only | DEPRECATE |
| strategy.tier1GateEnabled | false | tier1GateEnabled ← :510 (default true) | bs:2045-2053 Gate 19 passes "DISABLED by config" | — | be:561 | BCM:867-868 | — | — | 16 (pairGateOverrides.test:220-261) | dormant-by-value | KEEP (load-bearing: default true turns Gate 19 back on at minTier1Factors=3, which blocks) |
| strategy.useBreakerBlocks | false | useBreakerBlocks ← :479 (`?? true`) | cs:483 skip detectBreakerBlocks (also starves Unicorn); cs:1360/1398 factor (scoring); cs:2593 toggle map (never opposing) | — | be:1333; adv | BCM:991; BT:573; RD:228; aR:48/150 | — | — | 10 | scoring-only | DEPRECATE |
| strategy.useVolumeProfile | false | useVolumeProfile ← :489 (`?? true`) | cs:1466 factor (scoring; computeVolumeProfile still runs at cs:1465); cs:2596 toggle map (never opposing) | — | be:1336; adv | BCM:997; BT:578; RD:232; aR:154 | — | — | 4 | scoring-only | DEPRECATE |
| strategy.fibMaxRetracement | 1 | fibMaxRetracement ← :521 (default 0.786) | bs:5906/5988/6062/6078 → izE:796-800, clamped to [0.5,1]. **≥1.0 adds the 1.0 (origin) Fib level**, so deeper POIs qualify as Impulse zones (izE:1272-1280 rejects POIs off the allowed levels) | — | local-runner replays (engine_args) | BCM:940-951 select | smc_scan_context.engine_args (mig/20260925090000:148, comment) | — | 1 | active-other: Impulse-zone qualification, which decides whether a Route 2 setup exists | KEEP |
| strategy.normalizedScoring | false | normalizedScoring ← :471 (default true); also conditions the minConfluence 0-10 autoscale at :464 (moot: confluenceThreshold=20 > 10) | none: cs:3015 emits a literal `normalizedScoring: true`; scoring is always a percentage | — | bc:390 template; adv | BCM:1122-1123 "Percentage Scoring" toggle (shows OFF while scoring is always %); presets; RD:223; aR:145 | — | — | 13 | read-nowhere (live) | DEPRECATE |
| strategy.obLookbackCandles | 20 | obLookbackCandles ← :502 (default 50) | cs:321 detectOrderBlocks (unconditional, not gated by enableOB). OBs feed the Confluence Stack factor (cs:1720, opposing-eligible but the conflict block is unreachable, see top), the Reversal Candle at-OB tag (cs:1083), and chart overlays (bs:5765). calculateSLTP uses OBs only for slMethod "below_ob" (smcAnalysis.ts:2343; live is "structure") | — | bc:248 validation, bc:381 template | BCM:1141 input; presets | — | — | 15 | scoring-only (plus conflict-counter input that cannot bind today) | DEPRECATE |

[^choch]: `python3 /tmp/s16/work/refs.py enableCHoCH` returns only writers: bc:380 and BCM:223/277/329/381 (object literals in presets/template), with 0 reads in mapper, scanner, _shared, backtest or SQL, and 0 tests. It is not classed REMOVE-CANDIDATE only because those UI and template writers exist; deleting the four preset literals and the bc template entry would make it removable.

### strategy.* (part 2 of 2)

Abbreviations per CONVENTIONS.md (bs = bot-scanner/index.ts, sh/ = _shared/, be = backtest-engine, bc = bot-config, zcs = zone-confirmation-scanner, BCM = src/components/BotConfigModal.tsx, AR = src/lib/applyRecommendation.ts, RD = src/components/RecommendationsDashboard.tsx, BT = src/pages/Backtest.tsx, dr/wa = bot-daily-review / bot-weekly-advisor AI-prompt text). "Mapper" lines = sh/configMapper.ts. Dead code (bs DEFAULTS 157-378, STYLE_OVERRIDES 501-566, legacy mapper 1082-1408, sh/smcAnalysis.ts DEFAULTS:344-410, which is exported but imported nowhere) is not counted as a consumer.

| Stored path | Value | Runtime key ← configMapper line (precedence/shadowing) | LIVE scan/order refs (what each does) | Mgmt/close refs | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| strategy.onlyBuyInDiscount | false | onlyBuyInDiscount ← :498 (`strategy.onlyBuyInDiscount ?? false`) | bs:1525 Gate 2 P/D: blocks longs in premium (only when true) | — | be:603 (same gate in backtest); bc:386 template; dr:600 / wa:1074 AI prompt text | BCM:1042 toggle (displays `?? true`), BCM:226/280/332/384 presets write it; RD:224; AR:146; BT:589 | — | — | 1 (e2e-pipeline.test.ts:364) | dormant-by-value (false → Gate 2 never blocks longs; gate pushes "P/D zone OK") | DEPRECATE |
| strategy.onlySellInPremium | false | onlySellInPremium ← :499 | bs:1527 Gate 2: blocks shorts in discount (only when true) | — | be:605; bc:386; dr:601 / wa:1075 | BCM:1043 toggle (`?? true`), presets 226/280/332/384; RD:225; AR:147; BT:590 | — | — | 1 (e2e-pipeline.test.ts:365) | dormant-by-value | DEPRECATE |
| strategy.structureLookback | 50 | structureLookback ← :505 (`strategy ?? raw ?? 50`) | sh/confluenceScoring.ts:305-309 window `sc.slice(-50)` → analysis.structure (swingPoints) → bs:7316-7328 swing SL → `slFloorTrace.slBeforeFloor` → route2StopFromLimit swingSL (bs:8004) **sets stop**; bs:5740 structure-lag observer window (log only); bs:3836 passed in thesis `dirConfig` but DirectionConfig (sh/directionEngine.ts:234+) has no such field → ignored | — | be:1550 (`|| 100`, own use) + be:357 mapper→confluence; bc:245-246 validation (5–200), bc:384 template; dr:594 / wa:1068 | BCM:1144 input, presets 225/279/331/383; RD:218; AR:140 | — | — | 20 (e.g. structureTfAnalysis.test.ts:74) | active-geometry (structure window → swing stop candidate for Route 2); also every structure-derived factor (scoring) | KEEP |
| strategy.useLiquiditySweep | false | enableLiquiditySweep ← :476 (`useLiquiditySweep ?? enableLiquiditySweep ?? true`) — **wins** over enableLiquiditySweep=true | via enableLiquiditySweep: sh/confluenceScoring.ts:1139 Liquidity Sweep factor off (scoring only); :2591 FACTOR_TOGGLE_MAP → factor excluded from tiered score **and from opposingFactorCount** (conflict hard block bs:6995-7067); :2718/:2858 Po3 bonus impossible | — | be:1331 toggle map (via mapper be:357); dr:605 / wa:1079 | BCM:988 toggle; RD:229; AR:151; BT:570 | — | — | 2 (configMapper.test.ts:456; liveBacktestParity.test.ts:58) | active-other (excludes the sweep factor from the ACTIVE conflict counter; otherwise scoring-only — score is log) | KEEP |
| strategy.useStructureBreak | false | enableStructureBreak ← :477 (`useStructureBreak ?? (enableBOS ?? true)`) — **wins** over strategy.enableBOS=true | sh/confluenceScoring.ts:391 Market Structure factor (weight 5, the largest) off; :2588 toggle map → excluded from score and conflict counter; :2716/:2856 Po3 impossible | — | be:1328 (via mapper); dr:614 / wa:1088 | BCM:989 toggle; RD:238; AR:160; BT:571 | — | — | 2 (configMapper.test.ts:457; liveBacktestParity.test.ts:59) | active-other (conflict-counter exclusion); scoring-only otherwise | KEEP |
| strategy.ictRiskBasePercent | 0.005 | ictRiskBasePercent ← :742 | bs:6333 ICT risk config — inside `if (pairConfig.ictRiskEnabled)` (bs:6328); result would feed ICT risk hard gate bs:7116 | — | — | — | — | — | 2 (configMapper.test.ts:311,321) | dormant-by-value (strategy.ictRiskEnabled=false; block never runs) | DEPRECATE (non-test live ref only in the dormant ICT-risk block; removable with it) |
| strategy.confluenceThreshold | 20 | minConfluence ← :461-468 (`confluenceThreshold ?? minConfluenceScore ?? raw.minConfluence ?? 55`; autoscale only if 0<x≤10 — 20 not scaled) | bs:5291 adjustedMinConfluence (+asset minConfluenceAdj=0 for forex, sh/smcAnalysis.ts:326) → bs:7003 conflict raise (+10) → bs:7130-7132 score decision gate (**log**: scoreGateMode) ; bs:1693 Gate 9 (gateId score, log); bs:7009 staging promotion (stagingEnabled=false); bs:9101/9239 rejected-setup / below-threshold logging | — | bc:238-239 validation, bc:381; dr:71/741/1004, wa:1202/1550 AI review reads it; local-runner/r2-candidates.ts:42 | BCM:853 slider, BCM:809, presets 224/278/330/382; RD:160; AR:86; BT:562; BotView.tsx:843,1159; botStyleClassifier.ts:14+ | — | entryConfigSnapshot `minConfluence` (sh/smcTradeTelemetry.ts:126); scoreGate threshold → buildAttribution decisionScoreGate (bs:8316) → legacy_would_admit | 23 (configMapper.test.ts:62) | active-logging-only (score gate is log; threshold only decides recorded would-block) | DEPRECATE |
| strategy.impulseZoneGateMode | "hard" | impulseZoneGateMode ← :517 (default "hard") | bs:6570 izGateMode; bs:6589-6605 **gates** (no zone → skipped_no_impulse_zone; not at zone → watching_zone); bs:6678 zone-score gate; bs:7376 impulse SL candidate (geometry); bs:7836-7859 limit entry = refinedEntry/zoneMid; bs:7922 effectiveLimitEnabled → **Route 2 exists because of this** (+9 more incl. bs:9471 summary) | — | be:1859 (`|| "hard"`); run-backtest-local.ts:157,1239; local-runner/r2-state*.ts | BCM:885 select, 893-897 badge, 1396/1401; SignalStatusPanel.tsx:58 | — | izGateMode → buildAttribution (bs:8306) → primary_engine (sh/attribution.ts:138); entryConfigSnapshot (sh/smcTradeTelemetry.ts:127) | 28 (impulseZoneGateModeConfig.test.ts) | active-gating + active-geometry (Route 2 enabler) | KEEP |
| strategy.enableLiquiditySweep | true | enableLiquiditySweep ← :476 — **shadowed** by strategy.useLiquiditySweep=false | (none of its own; runtime value false comes from useLiquiditySweep) | — | bc:380 template | BCM:223/277/329/381 presets write it; AR:58 maps AI "Liquidity Sweep" → enableLiquiditySweep (no effect while useLiquiditySweep stored) | — | — | 8 (via runtime key; e.g. htfPOIAlignment.test.ts:74) | shadowed-by-strategy.useLiquiditySweep | DEPRECATE |
| strategy.regimeScoringEnabled | false | regimeScoringEnabled ← :494 | sh/confluenceScoring.ts:374-376 gates regime classification → analysis.regimeInfo = null ⇒ bs:6504 direction verdict gets **no regime source** (no regime veto / weight, sh/directionVerdict.ts regime block) = Gate 1 input; bs:7711 volCtx undefined (legacy computePositionSize only); bs:7612 regime TP impossible; :2456 info factor | — | be:551 (regime gate in backtest); bc:388; dr:595/wa:1069; run-backtest-local.ts:165,801 | BCM:1048-1049 toggle, presets 227/281/333/385; RD:219; AR:141 | — | — | 2 | active-other (false removes regime from the ACTIVE direction verdict / Gate 1; UI describes it as scoring only) | KEEP |
| strategy.confirmationTimeframe | "5m" | confirmationTimeframe ← :597 (default null → style TF) | bs:2408 resolveConfirmationTimeframe (sh/styleTimeframes.ts:76-81: explicit wins because styleOverridesMode off; must be in 1m/5m/15m/30m/1h) → bs:3995 min-observation window at arm; bs:4194-4196 hunt confirmation candles (CHoCH tiers) ; bs:2414 profile-mismatch log | — | zcs uses style TF (second poller disabled) | none reading the config key (src/lib/botStyleClassifier.ts:11-67 is a per-style profile table with the same field name) | — | (confirmTF in confirmation record, sh/route2Confirmation.ts) | 10 (step14ExplicitConfig.test.ts:68) | active-other (Route 2 confirmation hunt timeframe + protected window) | KEEP |
| strategy.regimeScoringStrength | 1 | regimeScoringStrength ← :495 | **none** (only dead sh/smcAnalysis.ts:403 DEFAULTS) | — | bc:388 template; dr:596/wa:1070 AI prompt text | BCM:1052-1053 slider, presets 227/281/333/385; RD:220; AR:142 | — | — | 1 (liveBacktestParity.test.ts:89, local copy) | read-nowhere | DEPRECATE (UI/AI write it; nothing reads it) |
| strategy.impulseSlCapMultiplier | 1.5 | impulseSlCapMultiplier ← :519 (default 4; style 1.5 inert) | bs:7425-7428 floorCapPips = MIN_SL_PIPS×1.5 (GBP/USD 37.5p, EUR/USD 30p) in cap = max(floorCap, leg×legStopCapMultiple 1.2) → impulseStopCandidate.capPips → route2StopFromLimit `over_cap` (sh/route2StopGeometry.ts:59) **sets stop**; bs:7466 unified SL cap (unified gate); bs:7550 zone-anchored cap (zoneAnchoredStop=false → shadow log); bs:5884 zoneMaxSlPips → decideZone/unified plan executable flag (display) | — | run-backtest-local.ts:177-193,950,966; local-runner/smc-route1-*.ts, smc-zone-replay.ts:62 (constant) | ZoneStoryPanel.tsx:660 (tooltip text only) | — | bs:8302 → sh/attribution.ts:103,182 `stop_version …;capMult=1.5`; entryConfigSnapshot (sh/smcTradeTelemetry.ts:130) | 19 (legRelativeStop.test.ts:82) | active-geometry (lower bound of the Impulse-stop cap; binds only when leg×1.2 < floor×1.5, i.e. legs ≲31p on GBP/USD) | KEEP |
| strategy.premiumDiscountEnabled | false | **not mapped** (no configMapper line) | **none** | — | bc:386 template only | BCM:226/280/332/384 presets write it; AR:56 maps AI "Premium/Discount" → strategy.premiumDiscountEnabled, AR:258 toggle coercion | — | — | 0 | read-nowhere | DEPRECATE (UI/AI write it; zero engine readers — removable once presets/AR mapping drop it) |
| strategy.zoneExitDirectionAware | true | zoneExitDirectionAware ← :535 (default false) | bs:4111-4128 classifyZoneExit + `resetsHuntRaw`: a favourable exit (within zoneChaseMaxZoneWidths=1) no longer resets awaiting_confirmation → keeps the hunt alive (pending-order lifecycle) | — | zcs:415 same rule (second poller disabled → no-op) | — | — | — | 7 (zoneExitDirectionAware.test.ts) | active-other (Route 2 hunt reset rule) | KEEP |
| strategy.adaptiveTrailingEnabled | false | adaptiveTrailingEnabled ← :561 | — | sh/scannerManagement.ts:582 momentum-fade trail, only inside Phase B trailing (needs trailingStopEnabled + activated) | — | — | — | — | 3 (configMapper.test.ts:361) | dormant-by-value (false; and trailing itself off) | DEPRECATE (live mgmt code still reads it) |
| strategy.liquidityPoolMinTouches | 2 | liquidityPoolMinTouches ← :506 | sh/confluenceScoring.ts:334 detectLiquidityPools (sweep/factors, computeSLTP inputs :2981 — tpMethod rr_ratio so no TP effect); bs:5326 HTF context pools (sh/smcHtfContext.ts:220) → bs:5886 combinedLiqPools → decideZone/unified; bs:4972 → sh/gamePlan.ts:652 daily pools → identifyDOL (:192) → determineBias → GP bias/confidence → direction verdict ±5 (Gate 1) | — | bc:385; local-runner/stage2h-parity.ts:214 (+9 replay scripts pass undefined); be via mapper | BCM:1150 input, presets 226/280/332/384 | — | — | 16 (smcHtfContext.test.ts:65) | active-other (indirect: GP DOL → GP bias → Gate 1 confidence; unified detection; scoring) | KEEP |
| strategy.regimeAdaptiveTPEnabled | false | regimeAdaptiveTPEnabled ← :558 | bs:7612 adjustTPForRegime on market-anchored `tp` (also needs regimeInfo, null because regimeScoringEnabled=false). Even if on, Route 2 recomputes TP from the limit (bs:7988-7996, sh/route2StopGeometry.ts:69-70); it could only move the market-anchored MIN_TP gate (bs:7641-7658) | — | — | — | — | — | 5 (configMapper.test.ts:358) | dormant-by-value (double: false + regimeInfo null) | DEPRECATE (live code still reads it; no UI/backtest/SQL) |
| strategy.ictFVGInvalidationGateMode | "off" | ictFVGInvalidationGateMode ← :726 | bs:6257-6290 FVG validation still runs (ictFVGInvalidationEnabled runtime true), mode tag log; bs:6920 soft score adj (only "soft"); bs:7101 ictFVGGate {mode, wouldBlock} recorded; bs:7102 blocks only when "hard" | — | bc:402 template | BCM:185 ICT module gateField; SignalStatusPanel.tsx:82 | — | bs:8320 ictFvgGate → sh/attribution.ts:141 gate `ict_fvg` mode log | 7 (step8Simplification.test.ts:140) | active-logging-only (would-block recorded, never blocks) | DEPRECATE |
| strategy.structuralConvictionEnabled | false | structuralConvictionEnabled ← :551 (`!== false`; only explicit false disables) | bs:1538 Gate 3: false → pass "DISABLED by config"; thresholds S2F/Opposite unused | — | dr:615 / wa:1089 AI prompt text | BCM:1010-1012 switch; RD:239; AR:161 | — | — | 6 (configMapper.test.ts:397) | dormant-by-value (Gate 3 skipped) | DEPRECATE |

### protection.*

| Stored path | Value | Runtime key ← configMapper line | LIVE scan/order refs | Mgmt/close refs | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| protection.maxDailyLoss | 3000 | `protectionMaxDailyLossDollar` ← :670 (`protection.maxDailyLoss ?? protection.dailyLossLimit ?? 0`; pair-overridable :855) | bs:1827-1842 **Gate 15** $ net daily loss block (paper_trade_history since reset) — **NOT delegated** to the step 13 profile (no propFirmActive check) | — | be:644-648 backtest; bc:319 pair override validation | BCM:1905 input; Backtest.tsx:794; presets 264/317/369/421; pair override BCM:2302 | — | gate verdict in trade_attribution.gates (generic) | 5 | active-gating (duplicate of the step 13 daily-loss limit) | KEEP |
| protection.circuitBreakerPct | 20 | folded into `maxDrawdown` ← :673 (`Math.min(risk.maxDrawdown, circuitBreakerPct ?? 100)`) | only via Gate 8 (bs:1685), itself delegated while profile active | — | via mapper in be (backtest maxDrawdown); LLM advisors | BCM:1913-1914; Backtest.tsx:804-806; presets | — | — | 9 | dormant-by-value (min(10,20) → risk.maxDrawdown wins) + Gate 8 delegated | DEPRECATE |
| protection.maxConsecutiveLosses | 6 | `maxConsecutiveLosses` ← :668 (pair-overridable :856) | bs:1798-1825 **Gate 14** blocks after 6 consecutive losses until pause expires | — | be:500-508, be:1668-1674; bc:322 pair override | BCM:1908; Backtest.tsx:798; presets; pair override BCM:2303 | — | — | 15 | active-gating | KEEP |
| protection.consecutiveLossPauseHours | 4 | `consecutiveLossPauseHours` ← :669 | bs:1812 Gate 14 auto-reset window (hours) | — | — | — (no UI field) | — | — | 5 (step14ExplicitConfig.test.ts:91) | active-gating (parameter of Gate 14) | KEEP |

### instruments.*

Legend: cm = configMapper.ts. The universal record-only references (config_version md5, bot_config_history, confluence_input capture) apply to every row and are not repeated.

| Stored path | Value | Runtime key ← cm line (precedence) | LIVE scan/order refs | Mgmt/close | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| instruments.enabled | [EUR/USD, GBP/USD, USD/JPY, CHF/JPY, NZD/CAD, NZD/CHF] | `instruments` ← cm:632-636. The array **wins** over `allowedInstruments` (cm:448-455), then raw.instruments, then defaults | bs:5104/5117/5146 scan order = the pair loop (which pairs are analysed at all); bs:1607 Gate 4 blocks a symbol not in the list (redundant, since the loop iterates the same list); bs:4960-4981 Game Plan generation list, bs:4994 news fetch list; bs:2500-2516 weekend-crypto intersection; bs:3084 rateMap pairs | — | bot-weekly-advisor:1494 (regime detection list); local-runner/r2-universe.ts:51 | BCM:1654-1687, 2350 (instrument picker) | — | — | 2 (configMapper.test.ts:423) | active-gating (defines the scanned universe) | KEEP |
| instruments.maxATR | 999 | `atrFilterMax` ← cm:697 | bs:1923 Gate 18 (inside `if (config.atrFilterEnabled)` bs:1914) | — | be:517 (ATR filter), bc:431 template; bot-daily-review:575 / bot-weekly-advisor:1049 (LLM prompt text) | BCM:1744, presets BCM:255/310/362/414; applyRecommendation.ts:104 | — | — | 1 | dormant-by-value (volatilityFilterEnabled=false; and even if on, bs:1919 reads ATR as 0 unless atrDerivedFloorsEnabled) | DEPRECATE |
| instruments.minATR | 0 | `atrFilterMin` ← cm:696 | bs:1922 Gate 18 (same guard) | — | be:516; bc:431; daily-review:574 / weekly-advisor:1048 | BCM:1741, presets; applyRecommendation.ts:103 | — | — | 1 | dormant-by-value (as above) | DEPRECATE |
| instruments.maxSpreadPips | 0 | `maxSpreadPips` ← cm:688 | bs:437/476 fetchBrokerSpread: 0 → `SPECS[pair].maxSpread` (sh/smcAnalysis.ts:249-276: EUR/USD 2, GBP/USD 3, USD/JPY 2, CHF/JPY 4, NZD/CAD 4, NZD/CHF 5). Called only from broker mirrors: bs:4650 (Route 2 fill mirror) and bs:8751/8920 (market path), all inside `account.execution_mode === "live"` (bs:4631, 8733). bs:8654 records it in signal_reason (market path only) | — | zcs:129/834 (second poller, off); be:543 (applies only when >0, so off at 0); bc:285 validation; daily-review/weekly-advisor prompt text | BCM:1709-1710 ("Auto" at 0), presets; RecommendationsDashboard:176; applyRecommendation.ts:101 | — | — | 2 | dormant on the paper / dry-run path: no spread check runs there. It would apply only to a live broker mirror | DEPRECATE (reconsider before any live execution) |
| instruments.maxCorrelation | 0.8 | `maxCorrelation` ← cm:756 (instruments > strategy > raw) | bs:1946 Gate 22 threshold: blocks hedges, caps correlated same-direction positions; bs:7676 decision record only | — | bc:431 template (0.7) | BCM:1760-1761, presets (0.7) | — | — | 9 (step14ExplicitConfig.test.ts:81) | active-gating (binds only when other positions are open) | KEEP |
| instruments.allowedInstruments.{EUR/USD, GBP/USD, USD/JPY, CHF/JPY, NZD/CAD, NZD/CHF} (6 paths) | true | `instruments` fallback ← cm:448-455, 634. **Shadowed by instruments.enabled** | none (live reads only the mapped `instruments`) | — | bc:282-283 type validation, bc:425 template | Backtest.tsx:237-241 and 255-259: seeds the backtest symbol list from this map. BCM presets 249/304/356/408 **write** this map but not `instruments.enabled` | — | — | 5 (configMapper.test.ts:430) | shadowed-by-instruments.enabled (live). Backtest default symbol selection only | DEPRECATE |
| instruments.allowedInstruments.{AUD/USD, BTC/USD, ETH/USD, EUR/GBP, GBP/JPY, NZD/USD, USD/CAD, XAG/USD, XAU/USD} (9 paths) | false | same | none | — | same | same (excluded from backtest default selection) | — | — | same | shadowed-by-instruments.enabled | DEPRECATE |
| instruments.spreadFilterEnabled | true | `spreadFilterEnabled` ← cm:687 | bs:475 fetchBrokerSpread `passed = !enabled \|\| spread <= effectiveMax`. Live-broker mirrors only (bs:4650, 8751, 8920 under execution_mode live). bs:8654 signal_reason record. Gate 21 (bs:2071-2075) is info-only and does not read this key | — | zcs:160/833 (off); be:543; bc:430; daily-review:571 / weekly-advisor:1045 | BCM:1704-1705, presets; SignalStatusPanel:128; RecommendationsDashboard:175; applyRecommendation.ts:100 | — | — | 3 | dormant on paper / dry-run (no spread check on the paper Route 2 path) | DEPRECATE (reconsider before any live execution) |
| instruments.maxCorrelatedPositions | 2 | `maxCorrelatedPositions` ← cm:755 | bs:1945 Gate 22 cap on correlated same-direction positions (`doublingHits >= 2` blocks); bs:7675 record | — | be:629-636 (backtest correlation gate); bc:431; daily-review:577 / weekly-advisor:1051 | BCM:1766-1767, presets; RecommendationsDashboard:216; applyRecommendation.ts:138 | — | — | 5 | active-gating (placement only, not re-checked at hunt fill) | KEEP |
| instruments.volatilityFilterEnabled | false | `atrFilterEnabled` ← cm:695 | bs:1914 Gate 18 guard | — | be:513; bc:430; daily-review:573 / weekly-advisor:1047 | BCM:1737-1748, presets; RecommendationsDashboard:177; applyRecommendation.ts:102 | — | — | 1 (+2 under atrFilterEnabled) | dormant-by-value | DEPRECATE |
| instruments.correlationFilterEnabled | true | `correlationFilterEnabled` ← cm:754 (instruments > strategy > raw) | bs:1944 enables Gate 22 | — | be:629; bc:431; daily-review:576 / weekly-advisor:1050 | BCM:1755-1780, presets; SignalStatusPanel:118; RecommendationsDashboard:215; applyRecommendation.ts:137 | — | — | 5 | active-gating | KEEP |

### openingRange.*

All 7 are merged as one object: `openingRange: { ...RUNTIME_DEFAULTS.openingRange, ...raw.openingRange }` (cm:677). Every sub-field is read only behind `openingRange.enabled`.

| Stored path | Value | Runtime key ← cm line | LIVE scan/order refs | Mgmt | Other edge fns | Frontend | SQL | Attr | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| openingRange.enabled | false | openingRange.enabled ← cm:677 | bs:1736 Gate 11 (OR wait) guard; sh/confluenceScoring.ts:1206/1210 OR factor; :2720/:2860 tieredMax +2 (scoring); bs:5202 `orFlag` (assigned, never read) | — | bc:447 template. Backtest goes through the shared runConfluenceAnalysis (be imports it, be:43), so OR scoring applies there | BCM:1931/1942, presets 267/319/371/423; Backtest.tsx:814-830 | — | — | 7 (configMapper.test.ts:625) | dormant-by-value | DEPRECATE |
| openingRange.useBias | false | ← cm:677 | sh/confluenceScoring.ts:1212 (scoring; only when enabled) | — | bc template | BCM:1936; Backtest.tsx:822 | — | — | 1 | dormant-by-value (enabled=false) | DEPRECATE |
| openingRange.candleCount | 24 | ← cm:677 | bs:1739 Gate 11; sh/confluenceScoring.ts:1207 → computeOpeningRange (sh/smcAnalysis.ts:2310) | — | bc:449 | BCM:1933; Backtest.tsx:818 | — | — | 2 | dormant-by-value | DEPRECATE |
| openingRange.useKeyLevels | false | ← cm:677 | sh/confluenceScoring.ts:1235 (scoring) | — | bc:452 | BCM:1938; Backtest.tsx:824 | — | — | 0 | dormant-by-value | DEPRECATE |
| openingRange.useJudasSwing | false | ← cm:677 | sh/confluenceScoring.ts:1218 (scoring) | — | bc:451 | BCM:1937; Backtest.tsx:823 | — | — | 0 | dormant-by-value | DEPRECATE |
| openingRange.waitForCompletion | false | ← cm:677 | bs:1736 Gate 11 (would block until the OR is formed) | — | bc:454 | BCM:1941; Backtest.tsx:827 | — | — | 0 | dormant-by-value (enabled=false; also false itself) | DEPRECATE |
| openingRange.usePremiumDiscount | false | ← cm:677 | sh/confluenceScoring.ts:1251 (scoring) | — | bc:453 | BCM:1939; Backtest.tsx:825 | — | — | 0 | dormant-by-value | DEPRECATE |

### tradingStyle.*

| Stored path | Value | Runtime key ← cm line | LIVE scan/order refs | Mgmt | Other edge fns | Frontend | SQL | Attr | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tradingStyle.mode | "scalper" | tradingStyle.mode ← cm:678 (merged object) → `resolvedStyle` bs:2397 | bs:2408-2419 timeframe-profile check (mismatch only logged; overrides off) and resolveConfirmationTimeframe (the explicit 5m wins when overrides are off, sh/styleTimeframes.ts:76-77). bs:5207 fetches 15m structure series for scalper. bs:5379-5392 simple-direction engine style/TF labels (direction = active gating via Gate 1). bs:5873/5894 decideZone zone slots (which timeframes the impulse/unified zone is taken from → limit price and stop). bs:6483 preferHourly: confirmedTrend on 1h for scalper (direction verdict). bs:3794-3802 thesis style candles. bs:7140 conviction candles (Gate 3 off). bs:6042/6541/7488 cascade (swing only, inactive). bs:6619 staging TTL (staging off). bs:1548 Gate 3 (off) | sh/scannerManagement.ts:308, 787 (scalper early-BE branch, only when BE is enabled → dormant) | be:1255-1268 (backtest applies STYLE_OVERRIDES[body.tradingStyle], a request param, not this key); zcs:353 (off); run-backtest-local.ts (own param) | BCM:780-785 style tab, presets 271-425 (clicking a preset writes many values), BCM:854/1219/1387 "StyleControlled" banners; botStyleClassifier.ts:105; BotView.tsx:543 | — | entryConfigSnapshot `tradingStyle` (sh/smcTradeTelemetry.ts:126); trading_style telemetry (bs:4428, 8180, 8600, 8622); frozenDecision.ts:138 | 20 | active-geometry and active-gating (timeframe profile only; it writes no values because overrides are off) | KEEP |

### factorWeights.*

All 22 come in through `factorWeights: raw.factorWeights \|\| {}` (cm:681). The scorer uses them in `resolveWeightScale` / `applyWeightScale` (sh/confluenceScoring.ts:147-162): points × (configured / DEFAULT_FACTOR_WEIGHTS), clamped at ≥0, so a weight of 0 removes the factor's points.

They affect only the confluence score, which is log-only today (`scoreGateMode=log`, staging off).

Conflict counter: the sign of the points is preserved, so a non-zero weight keeps a factor eligible to count as "opposing" (sh/confluenceScoring.ts:2630-2660). With the live toggles, the only opposing-capable factors not skipped by FACTOR_TOGGLE_MAP are Reversal Candle and Confluence Stack:
- Displacement, AMD, Currency Strength and Daily Bias are toggled off (useDisplacement, useAMD, useFOTSI and useDailyBias are all false).
- So opposingFactorCount ≤ 2.
- That is below `conflictBlockAt=3`, so the hard block is unreachable. A count of 2 only raises the log-only score threshold (see Notes).

Shared references for every row:
- **Other edge fns:** be uses the same scorer (runConfluenceAnalysis); bot-weekly-advisor:748 reads `factorWeights` for regime recommendations; bc:466 template `{}`. sh/adaptiveWeights.ts merges weights but is imported by nothing outside tests (dead).
- **Frontend:** BCM (14 refs, weight sliders); RecommendationsDashboard (33 refs); applyRecommendation.ts:208-267 (writes `factorWeights.<key>`).
- **Tests:** 20 (bidirectionalScoring.test.ts:126).
- **SQL / Attr:** none key-specific. The factors[] array is recorded in trade_attribution score/factors (bs:8318).

| Stored path | Value (default) | Scorer site | Live status | Class |
|---|---|---|---|---|
| factorWeights.amdPhase | 2.5 (1.0) | confluenceScoring.ts:1574 | scoring-only; factor toggled off (useAMD=false) | DEPRECATE |
| factorWeights.dailyBias | 1.75 (1.0) | :1706 | scoring-only; toggled off (useDailyBias=false) | DEPRECATE |
| factorWeights.judasSwing | 0 (0.75) | :978 | scoring-only (0 zeroes it) | DEPRECATE |
| factorWeights.orderBlock | 0 (2.0) | :554 | scoring-only (0, and enableOB runtime false) | DEPRECATE |
| factorWeights.pdPwLevels | 3 (1.0) | :1055 | scoring-only | DEPRECATE |
| factorWeights.breakerBlock | 1.75 (1.0) | :1401 | scoring-only; useBreakerBlocks=false | DEPRECATE |
| factorWeights.displacement | 3 (1.0) | :1351 | scoring-only; useDisplacement=false, so it is excluded from the conflict counter | DEPRECATE |
| factorWeights.fairValueGap | 0 (2.0) | :751 | scoring-only (0, and enableFVG runtime false) | DEPRECATE |
| factorWeights.unicornModel | 1.75 (1.5) | :1430 | scoring-only; useUnicornModel=false | DEPRECATE |
| factorWeights.smtDivergence | 1.75 (1.0) | :1458 | scoring-only; useSMT=false | DEPRECATE |
| factorWeights.volumeProfile | 1.5 (0.75) | :1517 | scoring-only; useVolumeProfile=false | DEPRECATE |
| factorWeights.liquiditySweep | 3 (1.5) | :1201 | scoring-only; enableLiquiditySweep runtime false | DEPRECATE |
| factorWeights.pullbackHealth | 3 (0.5) | :1834 | scoring-only | DEPRECATE |
| factorWeights.reversalCandle | 3 (1.5) | :1129-1130 | scoring-only. Non-zero keeps Reversal Candle eligible for opposingFactorCount, but the count is capped at 2 < block 3 (raise → log-only threshold) | DEPRECATE |
| factorWeights.sessionQuality | 3 (1.5) | :932 | scoring-only | DEPRECATE |
| factorWeights.confluenceStack | 3 (1.5) | :1765-1766 | scoring-only; same conflict-counter note as reversalCandle | DEPRECATE |
| factorWeights.htfPoiAlignment | 4 (2.0) | :1930 | scoring-only | DEPRECATE |
| factorWeights.marketStructure | 5 (2.5) | :474 | scoring-only (enableStructureBreak runtime false) | DEPRECATE |
| factorWeights.currencyStrength | 1.5 (1.5) | :1605 | scoring-only; useFOTSI=false → no FOTSI | DEPRECATE |
| factorWeights.gamePlanKeyLevel | 3 (1.0) | :2172 | scoring-only | DEPRECATE |
| factorWeights.htfFibPdLiquidity | 5 (2.5) | :2101 | scoring-only | DEPRECATE |
| factorWeights.premiumDiscountFib | 0 (2.0) | :893 | scoring-only (0 zeroes it) | DEPRECATE |

### Top-level keys

| Stored path | Value | Runtime key ← configMapper line | LIVE scan/order refs | Mgmt/close refs | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gamePlanEnabled | true | `gamePlanEnabled` ← :602 (`raw.gamePlanEnabled ?? default`) | bs:4887-4892 generates/reuses the session Game Plan (D1/4H/entry/1H fetches); → `_gamePlanContext` bs:5425-5441 → direction verdict ±5×conf/100 when conf≥50 (sh/directionVerdict.ts:372-381) → can push **Gate 1** block; GP entry gate bs:7233-7262 (soft: pass reasons only); thesis GP load bs:3487 (gated by thesisValidationEnabled, not this key); newsImpacts → news_alignment (log) | — | — | BCM:1950 master toggle, 1957/2003/2006 | — | bs:8308 `gamePlanEnabled` → sh/attribution.ts:139, 195 (`game_plan.enabled`, alignment "disabled" if false) | 7 | active-other (direction-verdict context, can gate via Gate 1; plus scoring + API cost) | KEEP |
| gamePlanNotify | true | `gamePlanNotify` ← :603 | bs:4888, 5076-5088 Telegram summary for NEW plans | — | — | BCM:1951 toggle | — | — | 2 | active-other (notification only, no trading effect) | KEEP |
| gamePlanRefreshHours | 4 | `gamePlanRefreshHours` ← :604 | bs:4889, 4930 plan regeneration cadence; bs:3503-3505 thesis-validation plan max age = 2×4 h | — | — | BCM:1954 input, 2009 help text | cron/setup_cron.sql:28 (comment only) | — | 3 | active-other (GP freshness; bounds gp_bias_reversal observation) | KEEP |
| ipdaRangesEnabled | true | `ipdaRangesEnabled` ← :606 | bs:4890, 4972 → sh/gamePlan.ts:614, 679-722 adds IPDA 20/40/60-day levels to GP keyLevels (not to bias) → consumed only by GP Key Level factor (sh/confluenceScoring.ts:2116-2164) and Telegram summary (gamePlan.ts:822-832) | — | — | BCM:1960 toggle | — | — | 10 | scoring-only | DEPRECATE |
| dolTPExtensionEnabled | false | `dolTPExtensionEnabled` ← :605 (bot-scanner re-reads as `!== false` bs:4891, 5443) | sh/confluenceScoring.ts:2973-2981 extends legacy `analysis.takeProfit` to GP DOL; Route 2 recomputes TP from the limit (sh/route2StopGeometry.ts:69-70) | — | — | BCM:1959 toggle | — | — | 13 | dormant-by-value (false; and legacy TP only) | DEPRECATE |

Legend/universal refs: see /tmp/s16/work/CONVENTIONS.md (config_version md5, bot_config_history, smc_scan_decision.confluence_input apply to every row). "LLM advisors" = bot-daily-review / bot-weekly-advisor prompt schemas and recommendation payloads (they name keys but do not enforce them); applyRecommendation.ts writes recommended values back into these paths.

### simplification.*

None of these is mapped by configMapper. All are read from the raw `config_json.simplification`:
- by `resolveSimplification` (sh/simplification.ts:76-95), called at bs:2568 (`simp`), bs:2360 and bs:1649, and at zcs:300;
- or by `resolvePositionCaps` (sh/positionCaps.ts:48-58).

No frontend, backtest or SQL consumer (one SQL comment only).

| Stored path | Value | Reader | LIVE scan/order refs | Mgmt | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| simplification.capsMode | "unified" | positionCaps.ts:49 | Caps from simplification.* at: bs:1615 Gate 4/5 placement, bs:4286 hunt-fill cancel (CANCELLED_POSITION_CAP), bs:4852 scan-stop (management-only cycle), bs:7672 decision record | — | zcs:586 (second poller, off) | — | — | caps_version via resolvePositionCaps (bs:8294 → attribution.ts caps_version) | 12 | active-gating (supersedes risk.maxConcurrentTrades/maxOpenPositions/maxPositionsPerSymbol and pairGateOverrides.*.maxPerSymbol) | KEEP |
| simplification.orderRRMin | 1.0 | simplification.ts:78 | bs:8041-8047 blocks Route 2 order if effective R:R < 1.0 (`zone_setup_rejected_rr`) | — | — | — | — | orderRR gate `rr_order` (attribution.ts:141) | 3 | active-gating | KEEP |
| simplification.rrGateMode | "order_geometry" | simplification.ts:82, 114 | bs:8043 enables the order-R:R block; makes Gate 10 `rr_legacy` log-only (applyLoggedOnlyGates bs:7287) | — | — | — | — | rr_order mode "gate" (attribution.ts:141) | 4 | active-gating | KEEP |
| simplification.sizingMode | "fill_time" | simplification.ts:87, 103 | bs:8080-8083 planned size; bs:4368-4379 fill-time size; effectiveRiskPercent → bs:5193 pairRiskPercent, bs:1649 Gate 6 heat fallback | — | zcs:335 (off) | — | — | sizing_version (attribution.ts:178), intendedPct (:151) | 11 | active-sizing | KEEP |
| simplification.stopAnchor | "limit" | simplification.ts:90 | bs:8012/8025 Route 2 stop = route2StopFromLimit; `zone_setup_rejected_stop` when unavailable | — | — | — | — | stop_version (attribution.ts:181) | 7 | active-geometry | KEEP |
| simplification.riskPercent | 0.5 | simplification.ts:88 (0 < x ≤ 5) | bs:8082 planned sizing, bs:4370 fill sizing, bs:5193 pairRiskPercent (market-path sizing), bs:1649 Gate 6 heat estimate | — | — | (src/pages/Journal.tsx `riskPercent` is an unrelated local) | — | sizing_version risk= (attribution.ts:179) | many (generic name) | active-sizing | KEEP |
| simplification.maxPerSymbol | 1 | positionCaps.ts:51 (int 1-10) | bs:1627 Gate 5, bs:4308 hunt-fill cancel | — | — | — | — | caps_version | (in capsMode tests) | active-gating | KEEP |
| simplification.newsGateMode | "log" | simplification.ts:84, 115 | Turns gateIds news_event (Gate 16, bs:1843-1879) and news_alignment (bs:7265-7286) into logged passes (bs:7287) | — | — | — | — | gate mode "log" in trade_attribution.gates (classifyGate attribution.ts:64) | 3 | active-other (neutralises news gates) | KEEP |
| simplification.scoreGateMode | "log" | simplification.ts:80, 113 | bs:7131-7132 decision gate bypass; Gate 9 `score` logged pass | — | — | — | — | decisionScoreGate mode (bs:8316) | 5 | active-other (score is log-only) | KEEP |
| simplification.maxLotsPerTrade | 20 | simplification.ts:89 | bs:8083 planned, bs:4371 fill → fillTimeSizing.ts:80-88 lot cap | — | — | — | — | sizing_version maxLots= (attribution.ts:179) | 10 | active-sizing (cap; binds only on very tight stops) | KEEP |
| simplification.dryRunWhenLocked | true | simplification.ts:86 | bs:2569 dryRunActive (with entries_locked) → Route 2 orders flagged dry_run (bs:8259), market path refused (bs:7932) | — | — | — | mig/20261007000000_step8_dry_run_orders.sql:4 (comment only) | dryRun in attribution (bs:8297) | 5 | active-other (the whole dry-run mode) | KEEP |
| simplification.maxOpenPositions | 3 | positionCaps.ts:50 (int 1-50) | bs:1616 Gate 4, bs:4289 hunt-fill cancel, bs:4855 scan-stop | — | — | — | — | caps_version | (capsMode tests) | active-gating | KEEP |
| simplification.reactionGateMode | "log" | simplification.ts:81, 112 | Gate 3b `reaction` (bs:1576-1603) → logged pass | — | — | — | — | gate mode "log" | 2 | active-other | KEEP |
| simplification.styleOverridesMode | "off" | simplification.ts:92; read at bs:2360 | bs:2362 scan interval from entry.scanIntervalMinutes; bs:2408-2419 STYLE_OVERRIDES skipped; styleTimeframes.ts:77 explicit confirmationTimeframe honoured | — | — | — | — | — | 12 | active-other (keeps style presets from writing runtime values) | KEEP |
| simplification.secondPollerEnabled | false | simplification.ts:91 | (bot-scanner does not read it) | — | zcs:300-302 skips the account entirely | — | — | — | 7 | active-other (single Route 2 poller) | KEEP |
| simplification.marketEntriesEnabled | false | simplification.ts:93 | bs:7926-7930 `market_entry_disabled` | — | — | — | — | — | 7 | active-gating | KEEP |
| simplification.unifiedModifiersEnabled | false | simplification.ts:85 | bs:6547 Unified detected but `unifiedGatePassed` stays false → no Unified entry/SL override, no impulse-gate bypass, signalSource standalone | — | — | — | — | primaryEngine & unified.modifiers_applied (attribution.ts:25-26, 138, 213) | 12 | active-geometry (keeps the Impulse refinedEntry/zoneMid as the limit) | KEEP |

### pairGateOverrides.*

Read via `pairGateOverrides: raw.pairGateOverrides` (cm:768) and applied by `applyPairOverrides` (cm:845-867; zoneEntryDepth is clamped to (0,1] at cm:861-864). It is called at bs:5195 per scanned pair and in backtest at be:1737. local-runner smc-route1-gates.ts:112 / counterfactual.ts:155 also call it.

| Stored path | Value | Runtime key ← cm line | LIVE scan/order refs | Mgmt | Other edge fns | Frontend | SQL | Attr | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| pairGateOverrides.EUR/USD.zoneEntryDepth | 0.5 | `zoneEntryDepth` (EUR/USD pairConfig only) ← cm:861-864 | bs:5903 and bs:5993 pass `entryDepth` into decideZone. It is consumed **only** by the Unified engine's buildEntryStory (sh/unifiedZoneEngine.ts:408, 471-515) and echoed as `entryDepthInUse` (sh/smcZoneDecision.ts:318). The Impulse engine (sh/impulseZoneEngine.ts) has no entryDepth input. With unifiedModifiersEnabled=false the Route 2 limit is izData.bestZone.refinedEntry, falling back to the hard-coded zone midpoint (bs:7843-7859). So this value does **not** move the placed order | — | be:1737 applies it, but be never reads zoneEntryDepth | BCM PairOverridesTab 2308-2340 handles the overrides object generically. OVERRIDE_FIELDS (BCM:2295-2304) has **no** zoneEntryDepth field; RECOMMENDED_OVERRIDES does not set it | — | attribution `entryDepth` (bs:8326) — records 0.5 although it did not shape the order | 32 (zoneEntryDepth; perPairStopFloor.test.ts:57) | active-logging-only (moves only the logged Unified entry story and attribution; no effect on placed orders while unifiedModifiersEnabled=false) | DEPRECATE |
| pairGateOverrides.AUD/USD.zoneEntryDepth | 0.5 | same | never applied live: AUD/USD is not in `instruments.enabled`, so bs:5195 never runs for it | — | be:1737 (only if AUD/USD is backtested; still unused) | generic overrides UI | — | — | (same) | dormant-by-value (pair not scanned) | DEPRECATE |

### Runtime-default-only keys (no stored source) — non-ICT

These keys have no stored path in the live `config_json`. The value shown is the runtime value from `runtime_pairconfig_GBPUSD.json`. Column 3 gives `D:` (the line of the RUNTIME_DEFAULTS literal) and `M:` (the mapNestedToFlat line and the stored path it would read), both in sh/configMapper.ts. All "0-*" hits (mapper, dead bs DEFAULTS, STYLE_OVERRIDES, legacy mapper) are excluded from the consumer columns. sh/smcAnalysis.ts `DEFAULTS` (line 344) is exported but never imported, so it is dead code and also excluded. local-runner/* scripts are listed under "Other" as replay/research harnesses.

Class rule used here: **KEEP** means the current value produces an active live effect (gating, geometry, direction or cancel). Feature flags that are OFF, and parameters of features that are OFF, count as **DEPRECATE** (dormant-by-value) whenever any non-test reference exists. These flags guard an alternate code path, so remove the flag together with that path. **REMOVE-CANDIDATE** means zero references outside the mapper and dead code (grep proof in the footnotes).

| Stored path | Value | Runtime key ← configMapper line | LIVE scan/order refs (what each does) | Mgmt/close refs | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| — | "327912ae-…" | `id`. Not a config_json key: `(flat).id = data.id` bs:1066 (bot_configs row id) | bs:6344 `.eq("bot_config_id", config.id)` on the ICT-risk `trade_history` query. Only runs if `ictRiskEnabled` (bs:6328) | — | — | — | — | Part of the hashed flat config (bs:2332) | — | dormant-by-value (ictRiskEnabled=false). Row-id passthrough, not a setting | DEPRECATE (drop with ICT risk path; not a config field) |
| — | true | `useVWAP`. D:52, M:485 `strategy.useVWAP ?? true` | none | — | — | — | — | — | 1 (configMapper.test.ts:465) | read-nowhere | REMOVE-CANDIDATE [1] |
| — | false | `killZoneOnly`. D:107, M:651 `sessions.killZoneOnly ?? false` | bs:1752 Gate 12. Would block outside the kill zones; when ICT KZ is not "off" it delegates to it (bs:1755-1757) | — | be:525 (same gate); bot-daily-review:568, bot-weekly-advisor:1042 (LLM prompt text) | BCM:1884 toggle; Backtest.tsx:786; RecommendationsDashboard.tsx:174; applyRecommendation.ts:99 | — | — | 2 | dormant-by-value (false → Gate 12 not evaluated) | DEPRECATE |
| — | false | `originOBRetest`. D:158, M:520 `strategy.originOBRetest ?? raw.originOBRetest` | bs:5907, 5989, 6063, 6079 passed to decideZone / impulse engine. sh/impulseZoneEngine.ts:724 synthesises an origin-OB POI only when true; :800 adds the fib 1.0 level when true **or** fibMaxRetracement>=1 | — | local-runner replay harnesses ×12 (r2-*, smc-zone-replay, stage2h-parity) | BCM:962-963 toggle | mig 20260925090000_smc_scan_bar_observability.sql:149 (comment only) | — | 1 | dormant-by-value. Note: live fibMaxRetracement=1 already adds the 1.0 level, so the only thing still behind this flag is the origin-OB synthesis | DEPRECATE |
| — | 25 | `watchThreshold`. D:240, M:569 `strategy.watchThreshold ?? raw.watchThreshold` | bs:2979 read. bs:9140, 9260 staging entry/exit (only inside `stagingEnabled`). bs:6629, 9192 written to staged_setups | — | — | WatchlistPanel.tsx:39-132 (displays the staged row's `watch_threshold` column) | — | — | 5 | dormant-by-value (stagingEnabled=false, bs:2978) | DEPRECATE |
| — | "prefer" | `cascadeZoneMode`. D:170, M:524 | none. The cascade engine (bs:6037, swing-only) does not read it | — | — | — | — | — | 0 | read-nowhere | REMOVE-CANDIDATE [1] |
| — | false | `htfBiasHardVeto`. D:35, M:470 `strategy.htfBiasHardVeto ?? raw.htfBiasHardVeto` | bs:1453 legacy Gate 1 fallback. Runs only when `directionVerdict` is null (bs:1427/1448). sh/confluenceScoring.ts:1674 Factor 22 ranging points (scoring only) | — | be:577; bot-daily-review:597, bot-weekly-advisor:1071 (prompt text) | BCM:1003; Backtest.tsx:588; RecommendationsDashboard.tsx:221; applyRecommendation.ts:143 | — | — | 3 | dormant (fallback path only, plus scoring-only) | DEPRECATE |
| — | 3 | `minTier1Factors`. D:142, M:511 `strategy.minTier1Factors ?? raw.minTier1Factors`. Also pair-overridable (configMapper:850) | sh/confluenceScoring.ts:2875 computes tier1GatePassed. bs:6757, 6807 impulse-zone Tier-1 credit recompute. Consumed only by Gate 19 (bs:2045-2053), which is skipped when tier1GateEnabled=false | — | bc:310-311 (pairGateOverrides validation) | BCM:871-872 slider; BCM:2286-2297 per-pair override presets | — | — | 27 | dormant-by-value (tier1GateEnabled=false) | DEPRECATE |
| — | "soft" | `gamePlanGateMode`. D:216, M:545 `strategy.gamePlanGateMode ?? raw.gamePlanGateMode` | bs:7242 GP entry gate. "soft" only pushes passing gates with reason text (bs:7249-7262). bs:3825 → sh/thesisValidator.ts:307-308: gp_bias_reversal may cancel only in "hard" | — | local-runner/r2-cadence.ts:25 | BCM:1967-1988 select; SignalStatusPanel.tsx:63 | — | — | 19 | active-logging-only. Soft = GP never blocks entry and never cancels a pending order. Mode selector; implicit: should be explicit | DEPRECATE (selector of an observe-only path; KEEP instead if selectors are kept as explicit policy — default equals live value) |
| — | 1 | `impulseZoneBonus`. D:153, M:516 | bs:6587, 6675, 6903 `impulseZonePenaltyVal = +bonus`. Added to the score (scoring only; score gate is log-only) | — | be:1874, 2015; run-backtest-local.ts:756 | — | — | — | 3 | scoring-only | DEPRECATE |
| — | 0.02 | `legStopBufferPct`. D:165, M:522 `strategy.legStopBufferPct ?? raw.legStopBufferPct` | bs:7401-7404 Impulse-origin stop buffer = max(slBufferPips×pip, leg×pct, clamped 0-0.2) → impulseSL → `impulseStopCandidate` (bs:7428) → route2StopFromLimit (bs:7990-8000) **sets stop** | — | — | — | — | Indirect, via stop_version / route2Stop | 2 (st/_shared/legRelativeStop.test.ts) | active-geometry. Implicit: should be explicit | KEEP |
| — | 1 | `minStagingCycles`. D:242, M:571 | bs:2981; bs:7010, 7049-7055 (promotion; needs stagingEnabled); bs:9200 insert | — | — | — | — | — | 2 | dormant-by-value (stagingEnabled=false) | DEPRECATE |
| — | 1.3 | `trailWidenFactor`. D:236, M:565 | — | sh/scannerManagement.ts:609 → sh/exitEngine.ts computeAdaptiveTrail. Only when `adaptiveTrailingEnabled` (scannerManagement:582) | — | — | — | — | 2 | dormant-by-value (adaptiveTrailingEnabled=false; trailing off) | DEPRECATE |
| — | false | `zoneAnchoredStop`. D:187, M:534 | bs:7542. When false: shadow record only, `detail.zoneAnchoredStop` (bs:7558; log only). When true: skip `skipped_zone_too_wide` (bs:7578) or move the stop (bs:7597-7602) | — | — | — | supabase/queries/zone_anchored_stop_shadow.sql:22-33 (ad-hoc analysis query over the shadow JSON, not a migration) | — | 7 | dormant-by-value (shadow logging only) | DEPRECATE |
| — | {} | `instrumentBuffers`. D:84, M:684 `raw.instrumentBuffers ?? entry.instrumentBuffers` | bs:5287 per-symbol slBufferPips override of adjustedSlBuffer (feeds the swing SL, the impulse buffer floor and the anchored SL) | — | bc:291-296 validation; bc:470 template | BCM:1797-1815 per-instrument buffer inputs | — | — | 21 | dormant-by-value (empty map → slBufferPips × asset multiplier is used) | DEPRECATE |
| — | false | `limitOrderEnabled`. D:245, M:759 `entry.limitOrderEnabled ?? raw.limitOrderEnabled` | bs:3424 computeLimitEntryPrice returns null unless true. bs:7923 `effectiveLimitEnabled = … (limitOrderEnabled \|\| (izGateMode==="hard" && !!limitEntry))`. Route 2 comes from the hard gate. bs:9471 scan-meta log | — | local-runner/r2-state*.ts; bot-daily-review:587, bot-weekly-advisor:1061 (prompt text) | BCM:1395-1401; RecommendationsDashboard.tsx:200; applyRecommendation.ts:122 | — | entryConfigSnapshot allow-list (smcTradeTelemetry.ts:127) | 50 | no live effect. Under the hard gate a bestZone always exists, so computeLimitEntryPrice is skipped (bs:7834-7836) and true would add nothing | DEPRECATE |
| — | 240 | `stagingTTLMinutes`. D:241, M:570 | bs:2980; bs:3006-3020 expiry of fetched staged rows (inside `if (stagingEnabled)` bs:2992); bs:6619-6621, 9173-9235 | — | — | — | — | — | 2 | dormant-by-value (stagingEnabled=false) | DEPRECATE |
| — | false | `tier1RequireAtPOI`. D:149, M:512 | sh/confluenceScoring.ts:2948-2958 → tier1GatePassed. Only Gate 19 consumes it, and Gate 19 is off | — | — | BCM:878 toggle | — | — | 5 | dormant-by-value (false, and tier1GateEnabled=false) | DEPRECATE |
| — | true | `useConfirmedTrend`. D:178, M:532 | bs:5362 dirConfig → decideDirection → sh/directionEngine.ts:493-524, 766-803 (the bias step of simpleDirection). bs:6486 computeConfirmedTrend → direction verdict input (Gate 1, **blocks**) | — | — | — | — | — | 10 | active-gating (direction engine + Gate 1). Implicit | KEEP |
| — | true | `useTrendDirection`. D:57, M:490 `strategy.useTrendDirection ?? true` | none (smcAnalysis.ts:398 is in the dead DEFAULTS) | — | — | Backtest.tsx:579 toggle (backtest config only) | — | — | 4 | read-nowhere live | DEPRECATE (UI ref only) |
| — | 15 | `vwapProximityPips`. D:53, M:486 | none | — | — | — | — | — | 0 | read-nowhere | REMOVE-CANDIDATE [1] |
| — | true | `impulseZoneEnabled`. D:151, M:514 | bs:6596 enables the **hard Impulse Zone gate** (`skipped_no_impulse_zone`, `watching_zone`, min zone score). bs:6897 soft branch. bs:5908 → sh/smcZoneDecision.ts:325 scoringEnabled | — | be:1862, 2009; run-backtest-local.ts:158; local-runner ×10 | SignalStatusPanel.tsx:57 | — | — | 5 | active-gating. With false the hard gate branch is skipped entirely. Implicit: should be explicit | KEEP |
| — | 2 | `impulseZonePenalty`. D:152, M:515 | bs:6901 soft-mode score penalty | — | be:2013 | BCM:902 (help text) | — | — | 3 | dormant-by-value (izGateMode=hard) | DEPRECATE |
| — | 1.2 | `legStopCapMultiple`. D:169, M:523 | bs:7422-7427 Impulse-stop cap = max(staticFloor×impulseSlCapMultiplier, leg×mult, clamped 1-3) → `capPips` → route2StopFromLimit impulse `over_cap` test (sh/route2StopGeometry.ts:59) **sets stop** | — | — | — | — | Indirect (route2Stop.capPips) | 2 | active-geometry. Implicit | KEEP |
| — | false | `requireUnifiedZone`. D:172, M:526 | bs:6589 `skipped_require_unified` when true | — | — | BCM:881 toggle | — | entryConfigSnapshot allow-list (smcTradeTelemetry.ts:127) | 16 | dormant-by-value | DEPRECATE |
| — | 0.6 | `trailTightenFactor`. D:235, M:564 | — | sh/scannerManagement.ts:608 (adaptive trail only) | — | — | — | — | 2 | dormant-by-value (adaptiveTrailingEnabled=false) | DEPRECATE |
| — | true | `useSimpleDirection`. D:175, M:529 | bs:5357 runs decideDirection. A null direction sets `_overrideDirection=null` (bs:5411-5416), so **no trade** for the pair. Spine of the direction verdict (Gate 1) | — | be:1694; run-backtest-local.ts:159, 475; local-runner ×10 | — | — | — | 11 | active-gating (owns analysis.direction). Implicit | KEEP |
| — | 0.75 | `rangingRRMultiplier`. D:231, M:560 | bs:7622 inside `if (config.regimeAdaptiveTPEnabled …)` (bs:7612) | sh/exitEngine.ts:88-124 | — | — | — | — | 5 | dormant-by-value (regimeAdaptiveTPEnabled=false) | DEPRECATE |
| — | false | `structureTfAnalysis`. D:214, M:544 | bs:5347-5350; sh/confluenceScoring.ts:300 (derive levels from the structure TF when true); bs:5522 shadow record | — | be:1793-1794 (forces false in backtest) | — | — | — | 16 | dormant-by-value | DEPRECATE |
| — | 1.5 | `baseTrailATRMultiple`. D:233, M:562 | — | sh/scannerManagement.ts:606 → exitEngine.ts:219-248 | — | — | — | — | 14 | dormant-by-value (adaptive trailing off) | DEPRECATE |
| — | "ob" | `limitOrderPreferZone`. D:249, M:763 | none. computeLimitEntryPrice does not read it | — | — | — | — | — | 2 (configMapper.test.ts:339) | read-nowhere | REMOVE-CANDIDATE [1] |
| — | true | `thesisCheckFotsiVeto`. D:207, M:541 | bs:3820 enabledChecks.fotsi_veto. sh/thesisValidator.ts records "no FOTSI result available" because `_fotsiResult` is null when useFOTSI=false (bs:3374) | — | — | — | — | — | 1 | dormant-by-value (the check can never run: useFOTSI=false) | DEPRECATE |
| — | 1.5 | `trendingRRMultiplier`. D:230, M:559 | bs:7621 (regime TP block, off) | exitEngine.ts:87-121 | — | — | — | — | 7 | dormant-by-value | DEPRECATE |
| — | true | `weekendCryptoEnabled`. D:109, M:652 `sessions.weekendCryptoEnabled ?? raw.weekendCryptoEnabled` | bs:2498-2507: when FX is closed, intersects ["BTC/USD","ETH/USD"] with config.instruments. The live list is FX-only, so the intersection is empty and nothing changes | — | — | BCM:1885 toggle; SessionStatusPill.tsx:65 | — | — | 0 | no live effect (FX-only instrument list) | DEPRECATE |
| — | 0.4 | `momentumFadeThreshold`. D:234, M:563 | — | scannerManagement.ts:607 → exitEngine.ts:220-234 | — | — | — | — | 2 | dormant-by-value | DEPRECATE |
| — | 1 | `zoneChaseMaxZoneWidths`. D:193, M:536 | bs:4111-4122 classifyZoneExit(…, zoneChaseMaxZoneWidths). With stored `strategy.zoneExitDirectionAware=true`, a favourable exit keeps the confirmation hunt alive only within 1 zone width; beyond that it resets (**pending-order lifecycle**) | — | zcs:419 (second poller, disabled by simplification.secondPollerEnabled=false) | — | — | — | 5 | active-other (Route 2 hunt reset boundary). Implicit | KEEP |
| — | false | `atrDerivedFloorsEnabled`. D:196, M:537 | bs:5486 `atrForConsumers` = 0 when false, which zeroes the ATR SL floor (bs:7339), regime TP ATR, ATR sizing input (bs:7730, 8058); bs:1919 Gate 18 ATR; bs:5538 record | — | (local-runner comment only) | — | — | entryConfigSnapshot allow-list (smcTradeTelemetry.ts:130) | 7 | dormant-by-value (the ATR floor never binds; the static MIN_SL_PIPS floor rules) | DEPRECATE |
| — | 2 | `cascadeZoneDailyATRMult`. D:171, M:525 | none | — | — | — | — | — | 0 | read-nowhere | REMOVE-CANDIDATE [1] |
| — | 0.25 | `confirmedTrendFibFactor`. D:218, M:547 | bs:5363 dirConfig (simpleDirection bias). bs:6487 computeConfirmedTrend → verdict. sh/smcDirectionDecision.ts:66 | — | — | — | — | — | 2 | active-gating (direction). Implicit | KEEP |
| — | 0.3 | `marketFillStrictATRMult`. D:251, M:765 `entry.marketFillStrictATRMult ?? raw…` | bs:5905, 5986, 6060, 6076 → impulseZoneEngine.ts:1335 strict threshold → `priceAtZoneStrict`/`sideOk`. Consumed only by Market Fill at Zone (bs:7891-7920; marketFillAtZone=false) and recorded (bs:8636) | — | run-backtest-local.ts:655, 727 | BCM:1422-1423 slider | — | — | 2 | dormant-by-value (MFaZ off and market entries disabled) | DEPRECATE |
| — | true | `thesisValidationEnabled`. D:205, M:539 | bs:3487 loads the last game plan (bounded by gamePlanRefreshHours×2). bs:3766 runs validatePendingOrderThesis on every pending order → **cancels** (CANCELLED_DIRECTION_FLIP, bs:3850-3858) | — | local-runner/r2-cadence.ts:25 | SignalStatusPanel.tsx:108 | — | — | 3 | active-gating (pending cancel). Implicit | KEEP |
| — | true | `thesisCheckDirectionFlip`. D:206, M:540 | bs:3819 enabledChecks.direction_flip → thesisValidator direction check (legacy D1/4H/1H engine, min conf 0.6 constant) → **cancel** | — | — | — | — | — | 2 | active-gating (pending cancel). Implicit | KEEP |
| — | 3 | `equalHighsLowsSensitivity`. D:278, M:507 | sh/confluenceScoring.ts:332 liquidity-pool tolerance (Liquidity Sweep, HTF factors: scoring). bs:5325 → sh/smcHtfContext.ts:219 HTF pools → `_htfLiquidityPools` and the unified engine (detected-only, bs:5886-5899). bs:4972 → gamePlan.ts:650 (GP liquidity / DOL) | — | bc:385 template; local-runner ×10 | — | — | — | 1 | scoring-only, plus GP DOL and unified detection. Unverified whether it can change opposingFactorCount (conflict block) | DEPRECATE (unverified; re-check before removal) |
| — | 50 | `gamePlanGateMinConfidence`. D:217, M:546 | bs:7243-7247. In "soft" mode it only chooses the reason text (bs:7253-7256). It does not drive the verdict's GP threshold (hard-coded 50 in directionVerdict.ts:372) or the thesis GP threshold (constant 60) | — | — | BCM:1992-1993 input | — | — | 5 | active-logging-only | DEPRECATE |
| — | 30 | `limitOrderMaxDistancePips`. D:247, M:761 | bs:3427, only inside computeLimitEntryPrice. That function is unreachable live (limitOrderEnabled=false, and skipped when bestZone exists) | — | (local-runner/r2-livedist.ts:4 comment) | — | — | — | 2 | dormant / unreachable. Route 2 distance is bounded by the hard-coded ROUTE2_MAX_PENDING_DISTANCE_ATR=1.5 instead | DEPRECATE (only reader is dead-in-practice code; REMOVE together with computeLimitEntryPrice) |
| — | 3 | `limitOrderMinDistancePips`. D:248, M:762 | none (bs:312, 1395 are dead DEFAULTS/legacy mapper) | — | — | — | — | — | 2 (configMapper.test.ts:338, 347) | read-nowhere | REMOVE-CANDIDATE [1] |
| — | false | `priceAwareStructureBlocks`. D:183, M:533 | bs:5370 dirConfig → directionEngine.ts:604, 878 (structural hard blocks). bs:3837 thesis dirConfig | — | — | SignalStatusPanel.tsx:102 | — | — | 14 | selector on an active path: false = legacy candle-count blocks, which run live in simpleDirection | DEPRECATE (feature OFF; KEEP if selectors are kept as explicit policy) |
| — | true | `thesisCheckGpBiasReversal`. D:208, M:542 | bs:3821. thesisValidator runs and records the check, but can cancel only when gamePlanGateMode="hard" (thesisValidator.ts:307-308) | — | — | — | — | — | 1 | dormant (observe-only under soft) | DEPRECATE |
| — | false | `thesisDirectionStyleAware`. D:209, M:543 | bs:3768. false → legacy D1/4H/1H engine is primary for direction_flip; the style engine is still judged and recorded on full scans (bs:3790-3800) | — | local-runner/r2-cadence.ts:25 | — | — | — | 2 | selector on an active cancel path (current = legacy engine decides) | DEPRECATE (feature OFF; KEEP if selectors are kept) |
| — | 5 | `confirmedTrendSwingLookback`. D:219, M:548 | bs:5364 dirConfig; bs:6487 computeConfirmedTrend; smcDirectionDecision.ts:67 | — | — | — | — | — | 2 | active-gating (direction). Implicit | KEEP |
| — | 0.35 | `structuralConvictionS2FLong`. D:223, M:552 | bs:1561 Gate 3 threshold. Gate 3 is skipped when structuralConvictionEnabled=false (bs:1538) | — | — | BCM:1015-1016 slider | — | — | 3 | dormant-by-value (Gate 3 off) | DEPRECATE |
| — | 8 | `simpleDirectionH1BosLookback`. D:177, M:531 | bs:5361 dirConfig → directionEngine (confirm-TF BOS lookback); smcDirectionDecision.ts:64 | — | be:1702; run-backtest-local.ts:485-513 | — | — | — | 1 | active-gating (direction). Implicit | KEEP |
| — | 0.2 | `structuralConvictionS2FShort`. D:224, M:553 | bs:1561 (Gate 3, off) | — | — | BCM:1021-1022 | — | — | 3 | dormant-by-value | DEPRECATE |
| — | 10 | `simpleDirectionH4ChochLookback`. D:176, M:530 | bs:5360 dirConfig → directionEngine (structure-TF CHoCH lookback); smcDirectionDecision.ts:63 | — | be:1701; run-backtest-local.ts:484-512 | — | — | — | 1 | active-gating (direction). Implicit | KEEP |
| — | 0.3 | `structuralConvictionOppositeLong`. D:225, M:554 | bs:1562 (Gate 3, off) | — | — | BCM:1027-1028 | — | — | 3 | dormant-by-value | DEPRECATE |
| — | 0.45 | `structuralConvictionOppositeShort`. D:226, M:555 | bs:1562 (Gate 3, off) | — | — | BCM:1033-1034 | — | — | 3 | dormant-by-value | DEPRECATE |

[1] REMOVE-CANDIDATE proof. Command, run from the repo root:
`grep -rn "<key>" src supabase local-runner scripts tests run-backtest-local.ts | grep -v "configMapper.ts\|\.test\.ts"`
- `useVWAP`: 1 hit, bs:1141 (dead `_legacyLoadConfigMapping`). 0 live/UI/SQL/backtest/attribution hits.
- `vwapProximityPips`: 1 hit, bs:1142 (dead legacy mapper). 0 otherwise.
- `cascadeZoneMode`: 0 hits.
- `cascadeZoneDailyATRMult`: 0 hits.
- `limitOrderPreferZone`: 2 hits, bs:313 (dead DEFAULTS) and bs:1396 (dead legacy mapper). 0 otherwise.
- `limitOrderMinDistancePips`: 2 hits, bs:312 (dead DEFAULTS) and bs:1395 (dead legacy mapper). 0 otherwise.
The only remaining references are the RUNTIME_DEFAULTS line, the mapNestedToFlat line and configMapper.test.ts round-trip assertions. These keys are also absent from bot-config, the BCM presets, backtest-engine, the migrations and attribution.

### Runtime-default-only keys (no stored source) — ICT

None of these 36 keys exist in the stored `config_json`. Each value comes from `RUNTIME_DEFAULTS`, read through the `strategy.X ?? raw.X ?? RUNTIME_DEFAULTS.X` chain in `mapNestedToFlat`. Column 3 gives "default line / mapping line" in `sh/configMapper.ts`.

Shared facts (all verified at 316e2c7d):
- **Off gates cannot block.** Every ICT gate mode is "off". The hard blocks at bs:7073 (HTF), bs:7082 (MSS), bs:7091 (Judas), bs:7103 (FVG), bs:7111 (KZ) and bs:7120 (risk) therefore never fire. `ictHTFResult.passed` is forced true in off mode (sh/ictHTFIntegration.ts:179-180). The bs:7073 check has no mode guard of its own; it relies on that.
- **Score adjustments are inert.** Score changes come only from "soft" modes (bs:6913-6925). The HTF score adjustment is zeroed in off mode (sh/ictHTFIntegration.ts:205-207) and again whenever a direction verdict exists (bs:6910). The score is log-only anyway.
- **What is recorded.** The detail fields `detail.ictHTF/ictMSS/ictJudas/ictFVG/ictKillZone` are written. The Judas and kill-zone configs go into `cap.ict_input` (bs:6237, bs:6306), which is persisted to `smc_scan_decision.ict_input` (column in mig/20260925210000_smc_scan_decision_observability.sql:49).
- **UI exposure.** The UI (BCM:155-200, the ICT module registry) shows only the `*Enabled` and `*GateMode` keys for HTF, MSS, Judas, FVG and KZ, plus `ictRiskEnabled`. `SignalStatusPanel.tsx` shows the same keys. No ICT numeric parameter (penalties, lookbacks, thresholds) appears in any UI.
- **No other consumers.** backtest-engine has 0 ICT references. bot-config has a new-config template at bc:395-405 (only the Enabled/GateMode keys). Management path: 0 references.
- **One ICT path is live.** `ictHTFEnabled` (default true) does three things:
  - forces a weekly fetch (bs:5208, bs:5221, cache pre-warm bs:5120);
  - runs `runICTHTFAnalysis` even for scalper (bs:6133);
  - passes the result's `weeklyBias` into the direction verdict (bs:6509-6512). There it moves confidence by +8×conf or −12×conf/100 when conf > 40 (sh/directionVerdict.ts:335-352). Gate 1 can block on that confidence (bs:1428-1441).

  The weekly-bias computation `analyzeWeeklyBiasAndDOL` (sh/ictHTFIntegration.ts:120-121) does not depend on any other HTF key.

| Stored path | Value | Runtime key ← configMapper line (precedence/shadowing) | LIVE scan/order refs (what each does) | Mgmt/close refs | Other edge fns | Frontend | SQL | Attr (S15) | Tests | Live status | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| — | true | ictHTFEnabled ← 281 / 700 | bs:5208 + bs:5221 weekly fetch (API cost); bs:5120 1w cache pre-warm; bs:5241, bs:6133 run HTF analysis; bs:6509-6512 weeklyBias → direction verdict → **Gate 1 block** (bs:1428); sh/ictHTFIntegration.ts:109 | — | bc:395 template | BCM:160 toggle; SignalStatusPanel.tsx:87 | — | indirect: directionVerdict passed to buildAttribution (bs:8310) | 7 (ictHTFIntegration.test.ts:123) | active-other (weekly fetch + weeklyBias source of direction verdict → Gate 1) | KEEP |
| — | "off" | ictHTFGateMode ← 282 / 701 | sh/ictHTFIntegration.ts:179-207: off → passed=true, score adj 0; bs:6150, bs:6187 log tag; bs:7073 HTF hard block cannot fire | — | bc:396 | BCM:161; SignalStatusPanel.tsx:88 | — | — | 13 (ictHTFIntegration.test.ts:130) | dormant-by-value (off; "hard" would block at bs:7073) | DEPRECATE |
| — | 2 | ictHTFAlignedBonus ← 283 / 702 | sh/ictHTFIntegration.ts:190, :194 score bonus; zeroed in off mode (:207) and when a verdict exists (bs:6910) | — | — | — | — | — | 4 | dormant-by-value (gate off; score log-only) | DEPRECATE |
| — | 3 | ictHTFMisalignedPenalty ← 284 / 703 | sh/ictHTFIntegration.ts:197, :200 score penalty; zeroed as above | — | — | — | — | — | 3 | dormant-by-value | DEPRECATE |
| — | 50 | ictHTFMinContainment ← 285 / 704 | sh/ictHTFIntegration.ts:159 containment % → zoneContained → only `passed` (hard) and score adj; detail log | — | — | — | — | — | 3 | active-logging-only (containment in detail.ictHTF) | DEPRECATE |
| — | true | ictWeeklyBiasRequired ← 286 / 705 | sh/ictHTFIntegration.ts:172 weeklyFailed → `passed` only in hard mode. Does NOT gate the weeklyBias that feeds the verdict | — | — | — | — | — | 5 | dormant-by-value (gate off) | DEPRECATE |
| — | true | ictDailyContainmentRequired ← 287 / 706 | sh/ictHTFIntegration.ts:173 containmentFailed → `passed` (hard only) | — | — | — | — | — | 4 | dormant-by-value | DEPRECATE |
| — | true | ictDisplacementMSSEnabled ← 290 / 709 | bs:6200 runs validateRecentMSS → detail.ictMSS (log) | — | bc:397 | BCM:168; SignalStatusPanel.tsx:68 | — | — | 3 | active-logging-only | DEPRECATE |
| — | "off" | ictDisplacementMSSGateMode ← 291 / 710 | bs:6913 soft penalty; bs:7082 hard block; bs:6210, :6214 log | — | bc:398 | BCM:169; SignalStatusPanel.tsx:69 | — | — | 4 (signalRegistry.test.ts:81) | dormant-by-value (off) | DEPRECATE |
| — | 0.6 | ictDisplacementMSSMinBodyRatio ← 292 / 711 | bs:6204 MSS detector param (result log-only) | — | — | — | — | — | 2 | active-logging-only | DEPRECATE |
| — | 1.2 | ictDisplacementMSSMinRangeATR ← 293 / 712 | bs:6205 MSS detector param | — | — | — | — | — | 2 | active-logging-only | DEPRECATE |
| — | 3 | ictDisplacementMSSLookback ← 294 / 713 | bs:6206 MSS detector param | — | — | — | — | — | 2 | active-logging-only | DEPRECATE |
| — | 2 | ictDisplacementMSSPenalty ← 295 / 714 | bs:6914 soft-mode score penalty only | — | — | — | — | — | 2 | dormant-by-value (gate off) | DEPRECATE |
| — | true | ictJudasSwingEnabled ← 298 / 717 | bs:6227 runs detectICTJudasSwing → detail.ictJudas; config into cap.ict_input (bs:6237) | — | bc:399 | BCM:176; SignalStatusPanel.tsx:75 | smc_scan_decision.ict_input (record) | — | 3 | active-logging-only | DEPRECATE |
| — | "off" | ictJudasSwingGateMode ← 299 / 718 | bs:6915 soft penalty; bs:7091 hard block; bs:6240 log | — | bc:400 | BCM:177; SignalStatusPanel.tsx:76 | — | — | 4 (signalRegistry.test.ts:81) | dormant-by-value (off) | DEPRECATE |
| — | 10 | ictJudasSwingLookback ← 300 / 719 | bs:6231 detector param (recorded in ict_input) | — | — | — | record via ict_input | — | 2 | active-logging-only | DEPRECATE |
| — | 0.1 | ictJudasSwingMinDepthATR ← 301 / 720 | bs:6232 detector param | — | — | — | record via ict_input | — | 2 | active-logging-only | DEPRECATE |
| — | true | ictJudasSwingRequireCloseBack ← 302 / 721 | bs:6233 detector param | — | — | — | record via ict_input | — | 2 | active-logging-only | DEPRECATE |
| — | 1.5 | ictJudasSwingPenalty ← 303 / 722 | bs:6916 soft-mode score penalty only | — | — | — | — | — | 2 | dormant-by-value | DEPRECATE |
| — | true | ictFVGInvalidationEnabled ← 306 / 725 | bs:6258 runs validateFVGBatch (analysis.fvgs is always returned, sh/confluenceScoring.ts:3017, even with enableFVG=false) → bs:7100-7101 detail.ictFVGGate.wouldBlock | — | bc:401 | BCM:184; SignalStatusPanel.tsx:81 | — | **yes**: ictFvgGate → buildAttribution (bs:8320) → sh/attribution.ts:141 `ict_fvg` gate (mode log, would_block) and :145-146 legacyWouldAdmit | 3 | active-logging-only (feeds attribution `ict_fvg` would_block) | DEPRECATE |
| — | true | ictFVGBodyCloseOnly ← 308 / 727 | bs:6262 FVG invalidation rule → wouldBlock (log) | — | — | — | — | indirect via ict_fvg would_block | 2 | active-logging-only | DEPRECATE |
| — | true | ictFVGRuleOfTwo ← 309 / 728 | bs:6263 exhaustion rule → wouldBlock (log) | — | — | — | — | indirect via ict_fvg would_block | 2 | active-logging-only | DEPRECATE |
| — | 1.5 | ictFVGExhaustedPenalty ← 310 / 729 | bs:6921 soft-mode score penalty only (strategy.ictFVGInvalidationGateMode="off") | — | — | — | — | — | 2 | dormant-by-value | DEPRECATE |
| — | 3 | ictFVGInvalidatedPenalty ← 311 / 730 | bs:6921 soft-mode score penalty only | — | — | — | — | — | 2 | dormant-by-value | DEPRECATE |
| — | true | ictKillZoneEnabled ← 314 / 733 | bs:6295 runs evaluateICTKillZone → detail.ictKillZone, cap.ict_input; bs:1755 Gate 12 delegation only when killZoneOnly (false live) | — | bc:403 | BCM:192; SignalStatusPanel.tsx:93 | smc_scan_decision.ict_input (record) | — | 3 | active-logging-only (Gate 12 path dormant: killZoneOnly=false) | DEPRECATE |
| — | "off" | ictKillZoneGateMode ← 315 / 734 | bs:6923 soft adj; bs:7111 hard block; bs:1755-1757 Gate 12 delegation; bs:6311 log | — | bc:404 | BCM:193; SignalStatusPanel.tsx:94 | — | — | 3 | dormant-by-value (off) | DEPRECATE |
| — | true | ictKillZoneSilverBullet ← 316 / 735 | bs:6299 KZ window config (log, recorded in ict_input) | — | — | — | record via ict_input | — | 2 | active-logging-only | DEPRECATE |
| — | true | ictKillZonePMSession ← 317 / 736 | bs:6300 KZ window config (log) | — | — | — | record via ict_input | — | 2 | active-logging-only | DEPRECATE |
| — | 1 | ictKillZoneOutsidePenalty ← 318 / 737 | bs:6924 soft-mode score adj only | — | — | — | — | — | 2 | dormant-by-value | DEPRECATE |
| — | 1.5 | ictKillZonePrimeBonus ← 319 / 738 | bs:6924 soft-mode score adj only | — | — | — | — | — | 2 | dormant-by-value | DEPRECATE |
| — | true | ictRiskDrawdownHalving ← 324 / 743 | bs:6334, inside `if (pairConfig.ictRiskEnabled)` (bs:6329), which is false (stored strategy.ictRiskEnabled) | — | — | — | — | — | 2 | dormant-by-value (ictRiskEnabled=false) | DEPRECATE |
| — | 3 | ictRiskMaxConsecLosses ← 325 / 744 | bs:6335 (same dormant block) | — | — | — | — | — | 2 | dormant-by-value | DEPRECATE |
| — | 0.01 | ictRiskDailyLimit ← 326 / 745 | bs:6336 (same dormant block) | — | — | — | — | — | 2 | dormant-by-value | DEPRECATE |
| — | 0.025 | ictRiskWeeklyLimit ← 327 / 746 | bs:6337 (same dormant block) | — | — | — | — | — | 2 | dormant-by-value | DEPRECATE |
| — | 3 | ictRiskMaxTradesPerDay ← 328 / 747 | bs:6338 (same dormant block) | — | — | — | — | — | 2 | dormant-by-value | DEPRECATE |
| — | true | ictRiskFVGRuleOfTwoExit ← 329 / 748 | none: never copied into riskConfig (bs:6331-6339). sh/ictRiskManagement.ts:51/:66 has an unrelated module field `fvgRuleOfTwoExit` that nothing reads | — | — | — | — | — | 2 (configMapper.test.ts:317, :327) | read-nowhere | REMOVE-CANDIDATE [1] |

[1] `python3 /tmp/s16/work/refs.py ictRiskFVGRuleOfTwoExit` (word match over supabase/functions, src, migrations, cron, queries, supabase/tests, tests, local-runner, scripts, run-backtest-local.ts). Hits:
- 0-mapper: configMapper.ts:329, :748
- 0-deadDEFAULTS: bs:365
- 0-legacyDeadMapper: bs:1390
- 7-tests: configMapper.test.ts:317, :327

That is 0 hits in live, management, other functions, frontend, SQL or attribution. The broader `refs.py -r "RuleOfTwoExit|ruleOfTwoExit|fvgRuleOfTwoExit"` adds only sh/ictRiskManagement.ts:51 and :66: the module's own interface field and default, never set from config and never read.

## Appendix: per-part notes and surprises (verbatim from the section audits)

### Notes: exit / entry / account

- **paper-trading reads the keys the mapper shadows.** The scanner and SM use `exit.breakEven` / `exit.trailingStop` (cm:619/622). paper-trading's `status` loop reads RAW `exit.breakEvenEnabled` / `exit.trailingStopEnabled` / `exit.trailingStopPips` / `exit.breakEvenPips` / `exit.maxHoldEnabled` (pt:1095, pt:1137-1178). The UI writes both names together, so they agree today. But `applyRecommendation.ts:107/110/112` writes ONLY the `*Enabled` names. An applied recommendation would therefore turn BE or trailing on in paper-trading while the scanner/SM stay off: the two engines diverge again.
- **Partial TP in paper-trading reads only the frozen snapshot** (`exitFlags`, pt:1251). BE and trailing read live config. A live toggle therefore reaches partial TP only through SM.
- **Deleting a key changes behaviour in two places.** `exit.breakEven` false matters because SM:317 and RUNTIME_DEFAULTS default to break-even ON. `entry.marketFillAtZone` false matters because the default is true (cm:250), and true would turn every at-zone Route 2 setup into `market_entry_disabled`. Both must stay explicit.
- If `exit.tpRRRatio` is removed, tpRatio silently becomes `risk.minRiskReward` = 1 (cm:615), not the 2.0 default.
- **SL/TP method keys barely matter.** `exit.stopLossMethod`, `fixedSLPips` and `slATRPeriod` only feed `analysis.stopLoss`. bs:7316-7329 recomputes the structural stop whenever swing points exist. In the no-swing case the 10-pip fixed stop is always below the 20-25p floor and gets widened. `takeProfitMethod`, `fixedTPPips` and `tpATRMultiple` never reach an order.
- calculateSLTP's 1.5×ATR stop floor (sh/smcAnalysis.ts:2378) is NOT gated by `atrDerivedFloorsEnabled`, unlike the scanner's ATR floor (bs:5486). It is only reachable in the no-swing fallback.
- **The backtest disagrees with live on two fallbacks.** be:790 ignores `maxHoldEnabled` and uses hours > 0 only. be:726 treats a missing `structureInvalidationEnabled` as ON.
- The UI time-exit toggle text (BCM:1628-1629, "Scalper forces this on") is stale: style overrides are off.
- `entry.defaultOrderType "market"`, `maxSlippagePips`, `entryRefinement`, `trailingEntry(Pips)`, `refinementTimeframe` and all of `account.mode` / `leverage` have no reader anywhere. They are only written by the BCM presets/defaults and the bc template, so they are one preset clean-up away from REMOVE-CANDIDATE.
- bot-daily-review and bot-weekly-advisor read several of these from the wrong section (`strategy.slMethod`, `risk.maxHoldHours`), with defaults that differ from live (true/48/60). Their AI prompts can therefore misstate the config. Not a trading effect.
- `trade_overrides` can re-enable BE, trailing, partial or max-hold per position in both SM (SM:371-384) and pt (pt:1130-1137). It is reachable only by manual action.

### Notes: risk / protection / sessions / top-level

- **Gate 15 ($ daily loss, protection.maxDailyLoss 3000) is NOT delegated** to the step 13 profile — bs:1827 has no `propFirmActive` check, unlike Gates 7/8 (bs:1662, 1680). docs/STEP14_OVERRIDE_MAP_V1.md §3 says it is delegated; that is wrong. It runs every gated scan as a second daily-loss limit beside the profile.
- **risk.atrVolatilityMultiplier is never mapped** by mapNestedToFlat. bot-scanner passes `pairConfig.atrVolatilityMultiplier`, which is always undefined (the key is absent from the runtime pairConfig). The UI slider has no effect. A second mismatch: the UI writes method `"volatility_adjusted"` (BCM:1181) but the mapper's type says `"atr_volatility"` (configMapper:68). smcAnalysis handles "volatility_adjusted", so only the type annotation is wrong.
- **risk.minRiskReward is latent.** It is shadowed by risk.minRR, but it is also the third link of the tpRatio chain (configMapper:615). Deleting exit.tpRRRatio would make tpRatio 1, which changes every Route 2 target.
- **Mis-named keys around the position caps.** The legacy second_poller cap path reads `risk.maxPerSymbol`, but the stored key is `risk.maxPositionsPerSymbol` (positionCaps.ts:86), so it would fall back to 2. applyRecommendation maps `maxOpenPositions` → `risk.maxConcurrent`, a key nobody reads (applyRecommendation.ts:78). Neither matters live: caps are unified and the second poller is off.
- **risk.riskPerTrade has no live read of its raw value.** pairRiskPercent and the Gate 6 fallback both go through effectiveRiskPercent, which returns simplification.riskPercent (0.5) under fill_time. The only uses left are attribution (legacyRiskPercent, which feeds sizing_version only in legacy mode), entryConfigSnapshot, backtest, the UI and the LLM advisors.
- **Gate 6 (heat 5%) cannot bind under the current caps.** Unified maxPerSymbol=1 also makes allowSameDirectionStacking=false redundant: any second position on the symbol is already blocked.
- **The session and day gates are live but non-binding.** All four sessions are enabled and Mon–Fri are all true. activeDays has no UI editor; only the presets write it.
- **newsFilterEnabled cannot block anything.** Its only two consumers are Gate 16 (news_event) and the news-alignment gate (news_alignment). Both are log-only under newsGateMode=log. No other live path reads it: not zcs, not scannerManagement, not paper-trading, not staging. It still costs one `fundamentals` function call per pair that reaches the gates.
- **circuitBreakerPct (20) has no effect even in the mapper.** Math.min(10, 20) gives 10, so risk.maxDrawdown governs. Gate 8 is delegated in any case.
- **conflictThresholdRaise is score-only.** It only raises the log-only score threshold and the staging promotion bar (staging is off). conflictBlockAt (3), by contrast, is a live hard block in code — but see the assembler note: with today's toggles at most 2 factors can oppose, so it cannot fire.
- **gamePlanEnabled can gate via Gate 1 even though the GP gate is "soft".** It feeds the direction verdict's context adjustment. The confidence floor there is a hard-coded 50, not gamePlanGateMinConfidence.

### Notes: strategy (part 1)

- **zoneEntryDepth does not move the live Route 2 entry.** `entryDepth` is consumed only by the Unified engine's EntryStory (uzE:501-512). With `simplification.unifiedModifiersEnabled=false`, Unified never passes the gate (bs:6546-6552), so the limit price is izE `refinedEntry` or the hard-coded zone midpoint. The global 0.55 and the EUR/USD 0.50 override (STEP14_OVERRIDE_MAP §1 says "yes: EUR/USD impulse-zone entry depth") reach only the logged unifiedComparison and `trade_attribution.entry_depth`. The attribution column therefore records a depth that did not shape the order.
- **The conflict-counter hard block (risk.conflictBlockAt=3) cannot fire.** Only six factors can be opposing; four of them are toggled off here (useDisplacement, useAMD, useFOTSI, useDailyBias), so at most 2 can oppose. Deleting any of these four keys reverts it to the default `true` and makes the block reachable again.
- **Dormant gates whose stored "off" is load-bearing.** minZoneScore 0 (default 4), tier1GateEnabled false (default true), stagingEnabled false (default true), smtOppositeVeto false (default true), ictRiskEnabled false (default true), and the four toggles above all have code-default ON. Deleting any of these keys from config_json silently turns the behaviour on. Remove the code first, then the key.
- **htfTimeframe is decorative at runtime.** It is only compared against the style profile and logged. The bias timeframe actually used comes from `tradingStyle.mode` (scalper → 1h at bs:6482).
- **normalizedScoring=false is shown in the UI ("Percentage Scoring" off), but scoring is always a percentage** (cs:3015 hard-codes true). The stored value only conditions the minConfluence autoscale, which does not trigger at 20.
- **Shadowed pairs.** enableOB/enableFVG (true) are overridden by useOrderBlocks/useFVG (false), and enableBOS (true) by useStructureBreak (false). The UI binds the `use*` keys; the presets and bc template still write the `enable*` keys plus enableCHoCH, which nothing reads. fvgMinSizePips (5) and fvgOnlyUnfilled live entirely inside the disabled FVG factor block.
- **useSMT=false still matters operationally.** It suppresses one correlated-pair fetch per pair per scan (bs:5203), which is relevant to the API-credit starvation.
- smcAnalysis.ts `DEFAULTS` (lines 344-410, including useAMD, useFOTSI, fvgMinSizePips and others) is exported but imported nowhere. It is a fourth dead defaults table.

### Notes: strategy (part 2)

- `strategy.regimeScoringEnabled=false` is not scoring-only: it nulls `analysis.regimeInfo` (sh/confluenceScoring.ts:374-376), so the ACTIVE direction verdict (Gate 1, bs:6504) runs without its regime source / regime veto, volCtx is undefined (bs:7711) and the regime-adaptive TP can never run (bs:7612). The UI (BCM:1048) describes it as a score bonus.
- `strategy.regimeScoringStrength` is read nowhere; the UI slider (BCM:1052) is decorative. Its only "live" hit is `sh/smcAnalysis.ts` DEFAULTS (:344-410), an exported object that nothing imports.
- `strategy.premiumDiscountEnabled` has no mapper line and no reader. UI presets and the AI-recommendation mapper (AR:56 "Premium/Discount" → strategy.premiumDiscountEnabled) still write it.
- AR:58-60 sends AI "Liquidity Sweep" / "Order Block" / "Fair Value Gap" recommendations to `enableLiquiditySweep` / `enableOB` / `enableFVG`. All three are shadowed in the mapper by the stored `useLiquiditySweep` / `useOrderBlocks` / `useFVG` (configMapper:474-476), so those recommendations silently do nothing on this config. (OB/FVG rows are outside my scope.)
- `structureLookback` is passed into the thesis validator's `dirConfig` (bs:3836), but `DirectionConfig` (sh/directionEngine.ts:234+) has no such field, so it is ignored there. Also, the same name means two different things: confluenceScoring uses it as a slice window (:305-309), while `analyzeMarketStructure(candles, structureLookback)` (sh/smcAnalysis.ts:929-933) treats its second argument as the swing-pivot lookback. That is harmless only because no live caller passes 50 there.
- `regimeAdaptiveTPEnabled`, even if switched on, cannot change a Route 2 order's TP: the limit-anchored TP is recomputed as limit ± risk × tpRatio. It would only change the market-anchored `skipped_tp_too_small` check.
- `impulseSlCapMultiplier` 1.5 is only the floor term of the cap `max(MIN_SL_PIPS×1.5, leg×1.2)`. It binds only on short legs. The STEP14 doc measured the leg term dominating on 6 dry-run orders (not re-measured here).
- If `ictRiskEnabled` were true, the ICT risk result WOULD block at bs:7116 (`!ictRiskResult.canTrade`). STEP14_OVERRIDE_MAP §8 says nothing reads canTrade, which is inaccurate for that branch. It is dormant today.
- `ictFVGInvalidationGateMode="off"` does not stop the FVG validation from running (it is gated by `ictFVGInvalidationEnabled`, runtime true, bs:6257). Its would-block flag reaches trade_attribution as gate `ict_fvg`, mode "log".
- `useStructureBreak=false` switches off the Market Structure factor, which carries factorWeights.marketStructure=5, the largest weight. Score is log-only, but the factor is also excluded from the active conflict counter.
- UI display defaults for onlyBuy/onlySell are `?? true` (BCM:1042-1043), while the runtime default is false. There is no mismatch today because both keys are stored explicitly as false.

### Notes: instruments / openingRange / tradingStyle / factorWeights / simplification / pairGateOverrides

1. **zoneEntryDepth does not reach the placed order.** This covers both pairGateOverrides.EUR/USD.zoneEntryDepth and, by the same code path, strategy.zoneEntryDepth=0.55, which another fork owns.
   - entryDepth feeds only `findUnifiedZone → buildEntryStory` (sh/unifiedZoneEngine.ts:408, 501-515).
   - The Route 2 limit comes from the Impulse engine's `refinedEntry`, which is LTF OB/FVG edge-based (sh/impulseZoneEngine.ts:1172-1182), or from a hard-coded zone midpoint (bs:7852).
   - The Unified entry overrides that only when `unifiedGatePassed`, which `unifiedModifiersEnabled=false` prevents (bs:6545-6551).
   - So the 0.5/0.55 depth is recorded (attribution entryDepth, entryDepthInUse) but does not shape live geometry. This contradicts docs/STEP14_OVERRIDE_MAP_V1.md §1 ("yes: EUR/USD impulse-zone entry depth").
2. **The conflict-counter hard block is unreachable with the live toggles** (cross-scope; the risk fork owns conflictBlockAt).
   - Only six factors can be "opposing" (sh/confluenceScoring.ts:1130, 1352, 1575, 1606, 1707, 1766).
   - Four of them are skipped through FACTOR_TOGGLE_MAP (useDisplacement, useAMD, useFOTSI, useDailyBias all false).
   - That leaves at most 2 (Reversal Candle, Confluence Stack), which is below `conflictBlockAt=3`. `conflictThresholdRaise=2` only raises the log-only score threshold.
   - Static reading; not checked against decision data.
3. **The spread filter never runs on the paper / dry-run path.**
   - fetchBrokerSpread is called only inside `account.execution_mode === "live"` broker mirrors (bs:4631/4650 Route 2 fill, bs:8733/8751/8920 market path). The zcs copy is off.
   - With maxSpreadPips=0, a live mirror would use SPECS.maxSpread: EUR/USD 2, GBP/USD 3, USD/JPY 2, CHF/JPY 4, NZD/CAD 4, NZD/CHF 5. The cm:120 comment is correctly implemented at bs:437.
   - Gate 21 is info-only and indicative (ATR-relative, confluenceScoring.ts:2468-2489).
   - The only spread figure that affects Route 2 is `SPECS.typicalSpread` inside orderEffectiveRR (simplification.ts:147), a constant, not config.
   - The execution_mode value in the DB is unverified.
4. **Which key the backtest uses for instruments.**
   - backtest-engine takes `body.instruments` (be:1250). It never reads `instruments.enabled` or `allowedInstruments`.
   - The Backtest page (src/pages/Backtest.tsx:237-241, 255-259) seeds that list from `instruments.allowedInstruments`; it falls back to a hard-coded [EUR/USD, GBP/USD, XAU/USD] (Backtest.tsx:205) when the map is empty.
   - Live scans use `instruments.enabled`. The two currently agree (6 true = the enabled 6).
   - BCM presets write only `allowedInstruments`, so a preset click changes backtest defaults but not the live universe.
5. **Gate 22 (correlation) is checked at placement only**, not at hunt fill (bs:4286-4345 re-checks only caps and same-direction). In dry run no positions open, so it can bind only on pre-existing real positions.
6. **Gate 18 is doubly dormant.** volatilityFilterEnabled=false, and even if on it reads ATR as 0 unless atrDerivedFloorsEnabled (bs:1919), so minATR=0/maxATR=999 would pass everything.
7. **Small dead pieces.** `orFlag` (bs:5202) is assigned and never used. sh/adaptiveWeights.ts is not imported by any non-test code. sh/smcAnalysis.ts `DEFAULTS` (:344-~400, maxSpreadPips 3) is imported only by backtest-engine/liveBacktestParity.test.ts, so it is not live.
8. **simplification.*.** All 17 have live consumers; none has a UI field. The UI cannot display or edit them, and BCM presets do not touch them.
9. **tradingStyle.mode** writes no values (overrides off), but it still selects the zone-engine slots, direction-engine timeframes, scalper 1h confirmedTrend, thesis style candles and the 15m structure fetch. It is therefore a live geometry/gating input, not decorative.

### Notes: runtime-only (non-ICT)

- **Live controls that run only on implicit defaults.** None of these keys is in the stored config: the hard Impulse gate's own enable (`impulseZoneEnabled`), Route 2 stop geometry (`legStopBufferPct` 0.02, `legStopCapMultiple` 1.2), the whole direction engine (`useSimpleDirection`, both lookbacks, `useConfirmedTrend`, `confirmedTrendFibFactor`, `confirmedTrendSwingLookback`), the pending-order cancel path (`thesisValidationEnabled`, `thesisCheckDirectionFlip`) and the hunt reset boundary (`zoneChaseMaxZoneWidths`). Deleting or renaming a default in configMapper would silently change live trading. These 12 should be written into config_json.
- **`gamePlanGateMinConfidence` (50) is decorative in soft mode.** The 50 that matters is a separate literal in sh/directionVerdict.ts:372 (GP ±5×conf/100 verdict adjustment). The thesis GP threshold is another literal, 60 (`DEFAULT_GP_BIAS_MIN_CONFIDENCE`, thesisValidator.ts). Changing the config value moves neither.
- **`thesisCheckFotsiVeto=true` can never act.** useFOTSI=false leaves `_fotsiResult` null (bs:3374). Also, if `gp_bias_reversal` ever cancelled (hard mode), it would be stamped terminal_reason `CANCELLED_THESIS_FOTSI` (bs:3853-3854 maps every non-direction_flip check to that label). That is a mislabel risk.
- **`limitOrderMaxDistancePips` / `limitOrderMinDistancePips` do not bound Route 2.** The live bound is the hard-coded `ROUTE2_MAX_PENDING_DISTANCE_ATR`=1.5 (sh/route2Forward.ts:32). The min-distance key is read nowhere. `limitOrderPreferZone` is read nowhere.
- **`originOBRetest=false` only half-disables the feature.** Live `strategy.fibMaxRetracement=1` already triggers the fib-1.0 level (impulseZoneEngine.ts:800). Only the origin-OB POI synthesis (line 724) remains behind the flag.
- **`weekendCryptoEnabled=true` does nothing** with the FX-only instrument list (bs:2499-2502).
- **sh/smcAnalysis.ts exports a second `DEFAULTS` (line 344) that nothing imports.** It is dead and still carries `useTrendDirection` and `killZoneOnly`.
- **`id` is not a config setting.** It is injected by loadConfig (bs:1066), and its only reader is the dormant ICT-risk `trade_history` query (bs:6344, a table noted elsewhere as missing).
- **Selector keys are a judgement call.** `gamePlanGateMode`, `priceAwareStructureBlocks` and `thesisDirectionStyleAware` choose the behaviour of active paths, but their current value is the off/legacy mode. They are classed DEPRECATE here. Move them to KEEP if the policy is to keep every selector explicit.

### Notes: runtime-only (ICT)

- **`ictHTFEnabled` is the only live ICT key, and it is not log-only.** With the HTF gate "off" it still triggers a weekly fetch per pair per scan, and it supplies the `weeklyBias` source to the direction verdict. That source has the asymmetric −12×conf/100 penalty when opposed versus +8 when aligned, so it can push Gate 1 into a block. Turning it off would drop the weekly source from the verdict for scalper (the swing style runs HTF regardless, bs:6133). The other HTF keys (gate mode, the Required flags, containment, bonus/penalty) do not affect `weeklyBias`.
- **The HTF hard-block line has no mode guard.** bs:7073 tests `ictHTFResult && !ictHTFResult.passed` with no gate-mode check. It is safe only because `runICTHTFAnalysis` forces `passed=true` in off and soft modes. The parent's citation "bs:7069" is actually bs:7073.
- **The ICT FVG keys still matter to attribution.** `ictFVGInvalidationEnabled`, `ictFVGBodyCloseOnly` and `ictFVGRuleOfTwo` are not pure dead weight even with the gate off. They decide `detail.ictFVGGate.wouldBlock`, which Step 15 attribution records as gate `ict_fvg` and uses in `legacyWouldAdmit` (sh/attribution.ts:141-146). FVG validation runs although runtime `enableFVG=false`, because `analysis.fvgs` is always returned (sh/confluenceScoring.ts:322, :3017).
- **The ICT risk block is fully skipped now.** Stored `strategy.ictRiskEnabled=false` skips the whole block, including the `trade_history` query (bs:6340-6345, a table that does not exist). The STEP14 doc's claim that "nothing reads canTrade" is outdated: bs:7120 would hard-block on `!canTrade` if `ictRiskEnabled` were turned back on. The query error is ignored, so that block would see zero trades.
- **Nothing outside the scanner reads these keys.** No ICT numeric parameter is exposed in the UI or read by backtest-engine, replay or SQL. `smc_scan_decision.ict_input` only records the Judas and kill-zone config objects.
- **The UI gate modes are decorative.** `ictKillZoneGateMode` and the other gate modes are UI-editable (BCM registry), so a single UI change could turn any of them into a live hard gate; today all are "off".
