# Step 14 — explicit config: no hidden style, default or mapper overrides (pre-merge report)

**Status:** built and tested (PR, not merged). The account stays **paused and entries-locked**; the step 13 profile stays active.
**Research map:** `STEP14_OVERRIDE_MAP_V1.md`.
**Config patch:** `step14_config_patch.json` (46 keys).

## What changes in code (all behind switches whose defaults keep today's behaviour)

| Change | Where |
|---|---|
| `simplification.styleOverridesMode` ("legacy" / "off"). Off: the style writes **nothing**; the scan interval comes from `entry.scanIntervalMinutes`; the explicit timeframes are checked against the style's timeframe profile and any disagreement is logged | `simplification.ts`, bot-scanner style block and scan interval |
| Route 2 confirmation timeframe from `strategy.confirmationTimeframe` when overrides are off (`resolveConfirmationTimeframe`) | `styleTimeframes.ts`, hunt (touch window and confirmation candles) |
| `simplification.marketEntriesEnabled`. False refuses every market entry, including Market Fill at Zone (`market_entry_disabled`), before the dry-run guard and the only market insert | bot-scanner |
| One risk-percent owner `effectiveRiskPercent`: under fill-time sizing every planning, record, heat-fallback and broker-mirror use reads `simplification.riskPercent` (0.5); no 1% path remains | `simplification.ts`, 5 sizing/record sites, Gate 6 fallback, broker mirror |
| Gate 14 pause hours from `protection.consecutiveLossPauseHours` (was hard-coded 4) | runSafetyGates |
| **Mapper pass-through** of keys the UI writes but the mapper dropped: `gamePlanEnabled`, `gamePlanNotify`, `gamePlanRefreshHours`, `dolTPExtensionEnabled`, `ipdaRangesEnabled` (top level); `strategy.entryTimeframe` / `htfTimeframe` / `confirmationTimeframe`; `protection.consecutiveLossPauseHours`; `exit.structureInvalidationEnabled`; **`instruments.correlationFilterEnabled` / `maxCorrelatedPositions` / `maxCorrelation`** (read from `strategy.*` only, so the UI values were ignored; `maxCorrelation` was never mapped) | `configMapper.ts` |
| Decision record `maxPortfolioHeat` read a key that doesn't exist (always null) | bot-scanner |

**Not deleted:** STYLE_OVERRIDES, the ICT module, the dead defaults and mapper, `stylePendingExpiryMinutes`, the second poller, the UI presets.

## New findings while building (both preserved, now explicit)

- **Correlation threshold:** the UI shows 0.75; the runtime used 0.8 (the default, because the key was never mapped). The patch stores **0.8**, so behaviour is unchanged and the UI now shows what runs.
- **Correlation filter keys:** all three were read from the wrong section; the defaults (on, 2) happened to match the UI.

## Effect, simulated on the live config

The **live** config + patch, run through the new mapper with overrides off, was compared key by key with the runtime `pairConfig` recorded by the 02:20 UTC scan (all 6 pairs):

| Key | Runtime today | After | Behaviour |
|---|---|---|---|
| `riskPerTrade` | 1 | **0.5** | planned-size records, heat-gate fallback, market path (now disabled). Route 2 fills were already 0.5% |
| `maxHoldEnabled` | true (style) | **false** | none (hours were 0) |
| `ictRiskEnabled` / `ictRiskBasePercent` | true / 0.01 | **false** / 0.005 | none (log-only) |
| `dolTPExtensionEnabled` | true (default) | **false** | none on orders (legacy TP only) |
| `maxOpenPositions` / `maxPerSymbol` (flat) | 7 / 3 | 3 / 1 | none (the unified caps own them) |
| `gamePlanEnabled`, `gamePlanNotify`, `gamePlanRefreshHours`, `ipdaRangesEnabled`, `maxCorrelation`, `consecutiveLossPauseHours`, `confirmationTimeframe` | unseen defaults (on, on, 4, on, 0.8, 4, style 5m) | **same values, now stored** | none |

Every other key is identical: the timeframes stay 5m / 1h, the Impulse cap multiplier 1.5, the stop buffer 1, `tpRatio` 1.1, BE / trailing / partial off, Impulse hard gate, Unified off, caps 3/1, and EUR/USD's entry depth 0.50.

Plus the code switch **market entries off**: 0 market entries since 09-29, 0 in the dry run.

## UI / stored / runtime

After the patch, every value the settings screen shows equals the runtime value: caps 3 / 1, risk 0.5%, `minRR` 1, max-hold off, correlation on / 2 / 0.8, Game Plan on, DOL TP off, IPDA on, backtest instruments = the six live pairs.

Not shown in the UI (stored, documented): the `simplification.*` switches and the new timeframe keys.

**Caveat:** clicking a style preset in the UI still *writes* its values into the config. With overrides off, those values then run as stored, so UI and runtime still agree, but the frozen config would change. Don't click presets during the freeze; the presets come out with the later dead-code removal.

## Kept as timeframe profile (not an override)

`tradingStyle.mode = "scalper"` still selects the zone engine's and direction engine's timeframe slots. It is stored and shown, and the explicit 5m / 1h / 5m are asserted equal to that profile.

## Tests

- `step14ExplicitConfig.test.ts` covers: switches, the risk owner, the confirmation timeframe, mapper pass-through (Game Plan, timeframes, pause, structure invalidation, correlation), the patched frozen config, backtest instruments, the profile check, and the wiring.
- The step 8 switch-object test now includes the new switches.

## Deploy order (after approval)

1. Apply the config patch **first** (service-key PATCH of `bot_configs`, as in steps 8–12). Before the merge, only `risk.riskPerTrade 0.5`, the caps fields and `minRiskReward` take effect; everything else is read only by the new code.
2. Merge (CI green); functions deploy.
3. Verify on the next full scan's recorded `pairConfig`: the expected values above, `__styleOverridesMode "off"`, no timeframe mismatch.
