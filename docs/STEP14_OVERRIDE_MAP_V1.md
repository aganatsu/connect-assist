# Step 14 — hidden and indirect config overrides: research map (no changes made)

> **Corrections from the Step 16 audit (2026-10-08, re-verified in code and production; see `STEP16_FROZEN_BASELINE_V1.md`):**
> 1. **`zoneEntryDepth` does not reach Route 2 orders** (§1, "yes: EUR/USD impulse-zone entry depth" is wrong). The limit is the Impulse refined entry, or the zone midpoint (bs:7843-7859). The depth reaches only the Unified engine and attribution. Of the 19 orders after the reset, none sits at 0.55; EUR/USD's 0.50 coincides with the midpoint fallback.
> 2. **Gate 15 is not delegated** to the step 13 profile (§3 / §5 say the daily-loss gates are). Only Gates 7 and 8 are. Gate 15 ($3,000 net realised loss since UTC midnight) runs alongside the profile (bs:1827).
> 3. **The conflict counter cannot block** (§7, "active"). With Displacement, AMD, FOTSI and Daily Bias off, at most 2 of the 6 possible opposing factors can count, below the block at 3. There were 0 occurrences in 432 decisions after Step 14.
> 4. **Correlation is checked at placement only**, not when the hunt fills.

> **Correction (found while building, see `STEP14_EXPLICIT_CONFIG_V1.md`):** the correlation filter's three settings are written by the UI under `instruments.*`, but the mapper read only `strategy.*`. The runtime therefore used the defaults: on, 2, and **0.8**. `maxCorrelation` was never mapped, so the 0.75 shown in the UI never applied. The rows below that call the correlation settings "explicit" are wrong on this point.

**Date:** 2026-10-07.

**Inputs:**
- the live `bot_configs.config_json` (hash `e3eb2e67`);
- the output of the production mapper (`mapNestedToFlat`) for that config;
- **the effective per-pair config the scanner actually used** (`smc_scan_decision.confluence_input.pairConfig`, 02:00 UTC scan);
- 7,306 decisions since 09-29;
- the dry-run orders;
- the pre-reset snapshot;
- the code on `main` (`441d5770`).

## 1. Measured: stored config → mapper → what the scanner actually ran with

Seven fields differ between the mapper's output and the runtime `pairConfig`:

| Field | Mapper (from stored config) | **Runtime** | Who changed it | Live effect today |
|---|---|---|---|---|
| `maxHoldEnabled` | false (`exit.maxHoldEnabled false`) | **true** | scalper STYLE_OVERRIDES; `maxHoldEnabled` is not in the protected list, only `maxHoldHours` is | **none**: hours = 0 (explicit), and both management engines require hours > 0; paper-trading also reads live `exit.maxHoldEnabled false`. It is recorded as `true` in every new position's `exitFlags` |
| `entryTimeframe` | 15min (default) | **5m** | style (always wins) | yes: the entry/structure timeframe of every scan |
| `htfTimeframe` | 1day (default) | **1h** | style (always wins) | yes: bias timeframe |
| `impulseSlCapMultiplier` | 4 (default) | **1.5** | style (always wins) | Impulse-stop cap = max(floor × 1.5 = 37.5p, leg × 1.2). On the 6 dry-run orders the leg cap (61.8–66.7p) dominated, so it never bound. The default 4 would allow up to 100p. Also caps the logged Unified plan |
| `slBufferPips` | 2 (default) | **1** | style (no explicit `entry.slBufferPips`) | yes: swing-stop buffer |
| `dolTPExtensionEnabled` | absent | **true** | `!== false` default in bot-scanner | only extends the *legacy* TP from a Game Plan liquidity target. Route 2 recomputes the TP from the limit (risk × 1.1), so no effect on orders |
| `zoneEntryDepth` | 0.55 | **0.50 on EUR/USD only** | `pairGateOverrides["EUR/USD"]` | yes: EUR/USD impulse-zone entry depth (the AUD/USD override is inert; not enabled) |

Plus one value the mapper never passes through:

| Field | UI / stored | **Runtime** | Why | Effect |
|---|---|---|---|---|
| `gamePlanEnabled` | **false** (top-level key) | **true** | `mapNestedToFlat` does not copy `gamePlanEnabled`, `gamePlanNotify`, `ipdaRangesEnabled` or `dolTPExtensionEnabled`; bot-scanner reads `config.gamePlanEnabled !== false` | **live**: Game Plans are generated every session (10-06 20:00, 10-07 00:10), costing candle fetches. GP bias feeds the direction verdict: of 1,234 recorded verdicts since 09-29, GP aligned in 239 and opposed in 29, each a ±5 × confidence context adjustment. Also feeds the score (log-only) and the legacy TP |

## 2. Style presets and resolvers

| Owner | Path | What it overwrites | Reachable |
|---|---|---|---|
| `STYLE_OVERRIDES[scalper]` | bot-scanner 499–565, applied at 2383–2453 | **Always:** `entryTimeframe`, `htfTimeframe`, `scanIntervalMinutes`, `impulseSlCapMultiplier`, **`maxHoldEnabled`**. **Only if not explicit in the raw config:** `minConfluence`, `tpRatio`, trailing×3, BE×3, partial×3, `maxHoldHours`, `riskPerTrade`, `slBufferPips` | yes. Live diffs in §1. Explicit values protect: `tpRatio 1.1`, `minConfluence 20`, BE/trailing/partial false, `maxHoldHours 0`, `riskPerTrade 1` |
| `styleConfirmationTimeframe` | `_shared/styleTimeframes.ts` | Route 2 5-minute confirmation timeframe (scalper → 5m); no config key | yes: the hunt's confirmation TF comes only from the style |
| `stylePendingExpiryMinutes` | styleTimeframes.ts | caps scalper expiry at 60 min | **bypassed** for Route 2 (fixed `ROUTE2_TTL_MINUTES` 8 h); was used by the second poller (off) |
| `decideZone({ style })` | bot-scanner 5840 | the style selects the impulse/unified zone timeframe slots | yes: a timeframe-profile selector, not a value override |
| `manageOpenPositions` (scannerManagement) | reads `config.tradingStyle` for "style-aware management" | management defaults: `breakEvenEnabled ?? **true**`, `trailingStopPips ?? 15`, `breakEvenPips ?? 20` | only if the key is missing; today explicit `false` |
| UI style presets (BotConfigModal 232–423) | front end | choosing a preset **writes** its values into config. Scalper writes `maxHoldEnabled true`, `maxHoldHours 4`, `maxOpenPositions 3`, `maxPositionsPerSymbol 1`, `minRiskReward 1.5`, … | yes, by one click. It would re-introduce a 4 h max-hold |

## 3. Displayed value ≠ runtime value

| Key | UI shows | Runtime | Live effect |
|---|---|---|---|
| `exit.maxHoldEnabled` | false | **true** (style) | none today (hours 0) |
| `gamePlanEnabled` | false | **true** (mapper drop) | **yes**: direction verdict context, API usage |
| `risk.maxConcurrentTrades` / `maxOpenPositions` / `maxPositionsPerSymbol` | 7 / 3 / 3 | **3 / 1** (step 12 unified) | none (superseded; UI is misleading) |
| `risk.riskPerTrade` | 1% | Route 2 fills **0.5%** (step 9); 1% still used by the planned-size record, the market path, the heat-gate fallback and the correlation advisory | fills: none. Plan records and any market entry: yes |
| `risk.minRR` / `risk.minRiskReward` | UI field `minRR` 1; stored `minRiskReward` 1.5 | legacy R:R gate reads **1** (`minRR` wins); also `tpRatio` falls back to `minRiskReward` (1.5) if `exit.tpRRRatio` is removed | none (legacy R:R is log-only) |
| `risk.maxDailyLoss 3%`, `risk.maxDrawdown 10`, `protection.maxDailyLoss $3,000`, `protection.circuitBreakerPct 20` | shown as active | **delegated** to the step 13 profile while it is active | none while the profile is active |
| `entry.limitOrderExpiryMinutes` | 480 | Route 2 uses the constant `ROUTE2_TTL_MINUTES` (480) | none (coincidentally equal) |
| `instruments.allowedInstruments` | (backtest page only) | live uses `instruments.enabled` (6 FX); **`allowedInstruments` has only EUR/USD true** | live none; **backtests read it → EUR/USD only** |
| `strategy.enableFVG` / `enableOB` (true) | true | runtime `enableFVG false`, `enableOB false` (mapper reads `useFVG` / `useOrderBlocks`, both false) | scoring only (score is log-only) |
| `entry.defaultOrderType "market"`, `maxSlippagePips`, `entryRefinement`, `trailingEntry(Pips)`, `refinementTimeframe`, `exit.timeBasedExitEnabled`, `account.*` | shown | **read nowhere** in mapper or scanner (`timeBasedExitEnabled` only as a paper-trading max-hold fallback) | decorative |

## 4. Silent fallbacks when a key is missing

| Key (absent today) | Fallback | Matters because |
|---|---|---|
| `strategy.impulseZoneGateMode` | **"hard"** (RUNTIME_DEFAULTS) | "Impulse required" holds only through a default; nothing in the config says so |
| `gamePlanEnabled` (flat) | **on** | see §1 |
| `dolTPExtensionEnabled`, `ipdaRangesEnabled`, `weekendCryptoEnabled` | on | inert today (no legacy TP use; FX only so weekend crypto intersects to nothing) |
| `entry.limitOrderEnabled` | false | Route 2 happens through the Impulse hard gate (`effectiveLimitEnabled`), not this key |
| `exit.tpRRRatio` (present 1.1) | would fall to `risk.minRiskReward` **1.5** | a deleted key would silently change every target |
| `entry.slBufferPips` | style 1 / default 2 | see §1 |
| BE / trailing in scannerManagement | `breakEvenEnabled ?? true` | a dropped key would turn break-even **on** |
| `useSimpleDirection` | true | direction engine choice |
| ICT gate modes (`ictHTFGateMode`, …) | "off" | fine, but implicit |

## 5. Duplicate owners of one setting

| Setting | Owners | Status |
|---|---|---|
| Position caps | resolved in step 12 (`resolvePositionCaps`) | done; UI still shows the old fields |
| Risk % | `risk.riskPerTrade` 1, `simplification.riskPercent` 0.5, style 0.5 (protected out), `ictRiskBasePercent` 0.01 (log-only) | four places |
| Daily loss / drawdown | Gate 7 / 8 / 15 (delegated) vs the step 13 profile | resolved at runtime by delegation; config still carries both |
| R:R | `risk.minRR`, `risk.minRiskReward`, `simplification.orderRRMin` (the one that gates) | three keys |
| Pending expiry | `ROUTE2_TTL_MINUTES`, `entry.limitOrderExpiryMinutes`, `stylePendingExpiryMinutes` | one wins silently |
| Max-hold / BE / trailing / partial | `scannerManagement` **and** paper-trading's own management loop, each with its own precedence (paper-trading: per-trade override > live config > snapshot) | two engines |
| Timeframes | `STYLE_OVERRIDES.entryTimeframe` and `styleTimeframes.STYLE_CONFIRMATION_TIMEFRAME` | two tables |
| Config defaults | `configMapper.RUNTIME_DEFAULTS` (live), bot-scanner `DEFAULTS` + `_legacyLoadConfigMapping` (dead), `smcAnalysis` defaults, `bot-config` template, UI presets | five |

## 6. Per-symbol overrides

- **`pairGateOverrides`** (`applyPairOverrides`) can override:
  - `minRiskReward`, `minTier1Factors`, `allowSameDirectionStacking`, `maxPerSymbol` (ignored under unified caps), `minStopPips`, `minConfluence`, `protectionMaxDailyLossDollar`, `maxConsecutiveLosses`, `zoneEntryDepth`.
  - **Set today:** `EUR/USD zoneEntryDepth 0.5` (live) and `AUD/USD zoneEntryDepth 0.5` (inert).
- **Per-position `trade_overrides`** (the UI "modify trade" action) can switch BE, trailing, partial or max-hold back on for one position in **both** management engines. Reachable by a manual action only.

## 7. Routes, stops, targets, sizing, cooldowns still reachable

| Path | Reachable? | Measured |
|---|---|---|
| **Market entry (Route 1)** | yes: when the Impulse hard gate passes but no limit entry is produced, the code falls through to a market entry at `riskPerTrade` 1% (plus correlation multiplier), market-anchored stop | 0 of 14 trades since 09-29 (all `route2_pending`); 0 `dry_run_market_skipped` in dry run |
| Market Fill at Zone | off (`entry.marketFillAtZone false`, explicit) | — |
| Gate 14: 6 consecutive losses, 4 h cooldown | **active** | not in the frozen list |
| Per-symbol cooldown, 5 min | **active** (`entry.cooldownMinutes 5`) | 1 block since 09-29 |
| Correlation filter (max 2 correlated, hedge block) | **active**: a second position limit beside 3/1 | 9 hedge blocks since 09-29 |
| Conflict counter (block at 3 opposing factors) | **active** | 11 decisions mention it |
| Portfolio heat 5% | active, cannot bind (3 × 0.5%) | 0 |
| Spread filter (per-instrument max), session filter (all sessions, Mon–Fri) | active | — |
| Correlation size multiplier | market path only (Route 2 fill-time sizing ignores it) | — |

## 8. The ICT risk path

- **Reads:** `trade_history` (`pnl_percent`, `closed_at`, by `bot_config_id`), a table that **does not exist** in production. The query error is ignored, so it always sees zero trades → `canTrade true`, effective risk 1%.
- **What it does with the result:** `modeTag = "OFF"`. It is logged to the console and recorded in `cap.risk_input` / `detail.ictRisk`. **Nothing reads `canTrade` or `effectiveRiskPercent`.** It cannot block, size or modify anything today.
- **`ictRiskFVGRuleOfTwoExit`:** consumed nowhere.
- **Cost:** one failing query per analysed pair per full scan.
- **Essential to anything?** No.

## 9. Frozen-baseline violations

| Intent | Today |
|---|---|
| no max-hold | runtime `maxHoldEnabled true` (inert only because hours = 0; one UI preset click makes it 4 h) |
| no hidden style overrides | scalper forces 5 values (`entryTimeframe`, `htfTimeframe`, `impulseSlCapMultiplier`, `slBufferPips`, `maxHoldEnabled`) plus the confirmation timeframe |
| Impulse required | true, but only through the default `impulseZoneGateMode "hard"` |
| Route 2 only | the market route is still reachable (never taken since 09-29) |
| caps 3/1 | correlation filter is a second, hidden position limit |
| (not in intent) Game Plan | UI says off, runtime on, and it influences the direction verdict |
| 0.5% sizing | `riskPerTrade 1` still drives plan records and the market path |

Already compliant: FX only, Unified modifiers off, score / news / ICT FVG log-only, 0.5% fill-time sizing, limit-anchored stop, single poller, caps 3/1, the step 13 profile, no size reduction, no profit target, no BE / trailing / partial.
