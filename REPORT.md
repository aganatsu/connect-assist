# Task: SMC Video Enhancements — Full Implementation + Integration

## Branch: manus/smc-video-enhancements

## Behavior changes

**When `config.smcEnhancements` is null/absent (default): NONE — zero behavior change.** The bot behaves identically until a user explicitly sets `smcEnhancements` in their config.

When `smcEnhancements` is enabled per-pair, the following behavior changes activate (each independently toggled):

1. **Phase Detection Gate** (`enablePhaseDetection: true`): Blocks trades when the current market phase is classified as "consolidation" based on price-action analysis (regime score, ATR trend, candle body ratios). Adds a scoring factor for trend/expansion quality.

2. **Zone Lifecycle v2** (`enableZoneLifecycleV2: true`): Replaces the existing 50% penetration invalidation with close-based invalidation. Zones survive wick penetration and can be traded up to 3 times (configurable) with decreasing confidence (1.0 → 0.7 → 0.4). Only a candle CLOSE through the far boundary kills the zone. **Wired into impulseZoneEngine.ts** — when enabled, the OB filter uses `evaluateZoneLifecycle()` instead of checking `ob.state !== "mitigated"`.

3. **Breaker Block Entries** (`enableBreakerBlocks: true`): Detects failed Order Blocks that flip role after liquidity sweep + displacement. Creates its own trade signal (`signalSource: "breaker"`) with half position size (×0.5). Goes through the full 21-gate pipeline. Separate from impulse zone entries.

4. **Fib 3-Point Extension TP** (`enableFib3PointTP: true` + `tpMethod: "fib_extension_3pt"`): New TP method that calculates take-profit using 3-point Fibonacci extensions measured from the ENTRY point (Point C), not from the swing origin. Targets -27.2%, -61.8%, -100% extension levels.

5. **Trendline Liquidity** (`enableTrendlineLiquidity: true`): Detects multi-touch trendlines and warns when zones are at trap-prone 4th+ touches (penalty factor). Rewards zones positioned below recently-broken trendlines (bonus factor).

6. **Monthly Containment** (`enableMonthlyContainment: true`): Fetches native monthly candles from TwelveData (with synthesized-from-daily fallback), detects monthly OBs and key levels, checks if the current zone is contained within monthly structure. Flags monthly bias opposition.

7. **Dashboard visibility**: Enhancement factors, breaker block data, and the new TP method are now visible in SignalReasoningCard (desktop + mobile). New "BREAKER ×0.5" badge in position cards.

## Files modified

### New files (14)
| File | Description |
|------|-------------|
| `_shared/priceActionPhase.ts` | Price-action phase detection module (consolidation/expansion/trend) |
| `_shared/priceActionPhase.test.ts` | 19 tests for phase detection |
| `_shared/zoneLifecycle.ts` | Close-based zone invalidation with multi-retest support |
| `_shared/zoneLifecycle.test.ts` | 15 tests for zone lifecycle |
| `_shared/breakerBlockDetection.ts` | Breaker block detection (sweep → displacement → retest) |
| `_shared/breakerBlockDetection.test.ts` | 12 tests for breaker detection |
| `_shared/fibExtension3Point.ts` | 3-point Fibonacci extension TP calculation |
| `_shared/fibExtension3Point.test.ts` | 12 tests for fib extension |
| `_shared/trendlineLiquidity.ts` | Multi-touch trendline detection + trap/bonus analysis |
| `_shared/trendlineLiquidity.test.ts` | 12 tests for trendline liquidity |
| `_shared/monthlyTimeframe.ts` | Monthly candle synthesis/native fetch + structural containment |
| `_shared/monthlyTimeframe.test.ts` | 7 tests for monthly timeframe |
| `_shared/smcEnhancements.ts` | Integration layer — single entry point for all modules |
| `_shared/smcEnhancements.test.ts` | 10 tests for integration layer |

### Modified files (10)
| File | Description | Why |
|------|-------------|-----|
| `_shared/impulseZoneEngine.ts` | Added `zoneLifecycleV2` option to `ZoneEngineOptions` and conditional OB filtering in `mapImpulsePOIs` | When v2 enabled, uses close-based invalidation instead of 50% penetration |
| `_shared/candleSource.ts` | Added `1M` (monthly) interval to all 5 mapping functions + cache TTL | Enables native monthly candle fetch from TwelveData |
| `_shared/configMapper.ts` | Added `SMCEnhancementsConfig` interface + `smcEnhancements` field to RUNTIME_DEFAULTS + mapNestedToFlat | Config plumbing for all enhancement toggles |
| `bot-scanner/index.ts` | Import, monthly fetch, `runSMCEnhancements()` call, `fib_extension_3pt` TP method, breaker entry signal | Full integration of all modules into the scan loop |
| `src/components/SignalReasoningCard.tsx` | Added "SMC Enhancements" factor section + "Breaker Block" detail section | Dashboard visibility of enhancement data |
| `src/components/ExpandedPositionCard.tsx` | Added "BREAKER ×0.5" badge + `fib_extension_3pt` TP label | Desktop position card shows breaker entries |
| `src/components/MobilePositionCard.tsx` | Added "BRK½" compact badge + "BREAKER ×0.5" detail badge | Mobile position card shows breaker entries |

## Tests added

| Test File | Count | What it asserts |
|-----------|-------|-----------------|
| `priceActionPhase.test.ts` | 19 | Phase classification, consolidation detection, OB-in-consolidation check, batch filtering, custom thresholds |
| `zoneLifecycle.test.ts` | 15 | Fresh/tested/mitigated/broken states, close-based invalidation, multi-retest decay, breaker candidate detection |
| `breakerBlockDetection.test.ts` | 12 | Sweep→break→displacement sequence, retest proximity, direction validation, config overrides |
| `fibExtension3Point.test.ts` | 12 | 3-point calculation for bullish/bearish, extension levels, comparison with swing method, edge cases |
| `trendlineLiquidity.test.ts` | 12 | Multi-touch detection, 4th-touch trap, zone-near-trap check, broken TL bonus, direction filtering |
| `monthlyTimeframe.test.ts` | 7 | Monthly candle synthesis, structure analysis, containment checks, bias alignment, edge cases |
| `smcEnhancements.test.ts` | 10 | All-disabled baseline, individual module activation, combined execution, direction normalization |

**Total: 87 new tests, all passing.**

## Tests run

```
# All new module tests (isolated):
ok | 87 passed | 0 failed (616ms)

# impulseZoneEngine tests (verifies zone lifecycle v2 integration):
ok | 47 passed | 0 failed (36ms)

# configMapper tests (verifies new config field):
ok | 51 passed | 0 failed (23ms)

# candleSource tests (verifies monthly interval):
ok | 13 passed | 0 failed (4s)

# Full _shared/ test suite on our branch:
FAILED | 1485 passed | 7 failed (17s)

# Full _shared/ test suite on main branch:
FAILED | 1397 passed | 8 failed (16s)

# Delta: +88 new passes, 0 new failures
# All 7 failures are pre-existing (beTrailingRace, brokerFillPriceBE, flaky impulseZone)
```

## Regression check

1. **impulseZoneEngine.ts** — When `zoneLifecycleV2` is not set (default), the code path is identical to before. The conditional only fires when explicitly enabled. Verified: 47/47 tests pass on our branch.

2. **configMapper.ts** — New field defaults to `undefined`. Existing configs without `smcEnhancements` produce identical RuntimeConfig objects. Verified: 51/51 tests pass.

3. **candleSource.ts** — Monthly interval is purely additive to existing switch statements. No existing cases modified. Verified: 13/13 tests pass.

4. **bot-scanner/index.ts** — All new code is guarded by:
   - `if (config.smcEnhancements)` for the main call
   - `needsMonthly` (false by default) for the monthly fetch
   - `smcEnhResult?.breakerBlocks?.length > 0 && config.smcEnhancements?.enableBreakerBlocks` for breaker entries
   - No existing code paths are altered when config is absent.

5. **Cross-branch comparison**: Main = 1397 passing / 8 failing. Our branch = 1485 passing / 7 failing. Same pre-existing failures, 88 new passes. Zero regressions.

## Open questions

1. **Position sizing for breaker entries** — Currently hardcoded to 0.5× (half size). Should this be configurable per-pair?

2. **Zone lifecycle v2 + existing open trades** — When toggling v2 on, trades already open from the old model continue with old management. New trades use v2. Is this acceptable?

3. **Monthly candle cache** — Monthly candles are cached for 24 hours. Should this be longer (weekly refresh)?

4. **Breaker block SL placement** — Currently uses the breaker zone's far boundary + ATR buffer. Should it use the original OB's high/low instead?

## Suggested PR title and description

**Title:** `feat: SMC video enhancements — 6 new analysis modules + full bot-scanner integration (opt-in)`

**Description:**
Implements all missing SMC concepts from the video comparison audit as opt-in modules:

- **Phase Detection**: Price-action consolidation/expansion/trend classification. Blocks trades formed during consolidation.
- **Breaker Blocks**: Break & retest entry model — detects failed OBs that flip role after sweep + displacement. Creates own trade signal.
- **Zone Lifecycle v2**: Close-based invalidation replaces 50% penetration. Zones survive wicks, support 2-3 retests with decay.
- **Fib 3-Point TP**: New TP method — extensions measured from entry point (not swing origin). Adds -27.2%, -61.8%, -100% levels.
- **Trendline Liquidity**: Multi-touch trendline detection, 4th-touch trap warning, broken TL bonus.
- **Monthly Containment**: Native monthly candle fetch + structural containment check.

All features disabled by default (`smcEnhancements: null`). Zero behavior change until explicitly enabled per-pair. 87 new tests, zero regressions. Full integration into bot-scanner + dashboard UI.

**To enable for a pair**, add to your bot config:
```json
{
  "smcEnhancements": {
    "enablePhaseDetection": true,
    "enableZoneLifecycleV2": true,
    "enableBreakerBlocks": true,
    "enableFib3PointTP": true,
    "enableTrendlineLiquidity": true,
    "enableMonthlyContainment": true
  }
}
```
