# Task: Liquidity Sweep Gate

## Branch: manus/liquidity-sweep-gate

## Behavior changes

1. **New scoring penalty**: When an entry-trigger liquidity pool (BSL above zone for bearish, SSL below zone for bullish) has been swept but **absorbed** (broken through without rejection), a configurable penalty (default: -2.0) is applied to the liquidity score. Previously, swept-without-rejection scored +1.5; now it scores +1.5 - penalty. Configurable via `sweptAbsorbedPenalty` (0 = disabled, default 2.0).

2. **New gate (opt-in)**: When `requireLiquiditySweep: true` is set in bot config, the Unified Zone Engine will return state `waiting_for_sweep` instead of `triggered`/`confirmed` if the entry-trigger pool near the zone has NOT been swept yet. The bot-scanner will then skip the pair (status: `waiting_for_sweep`) and log it as watchlisted. **This gate is OFF by default** — no existing behavior changes unless the user explicitly enables it.

3. **Staging for `waiting_for_sweep`**: When the gate fires, the pair is staged (setup_type='sweep_watch') for automatic re-evaluation when the pool gets swept — same pattern as `watching_zone`.

4. **Existing test updated**: `zoneLiquidity.test.ts` test "detects swept pool without rejection (score +2.5)" now expects score 0.5 due to the new absorbed penalty. This is the intentional consequence of change #1.

## Files modified

| File | Description |
|------|-------------|
| `_shared/zoneLiquidity.ts` | Added `entryTriggerState`, `hasUnsweptEntryTrigger` to result; configurable `sweptAbsorbedPenalty` in `ZoneLiquidityConfig`; penalty + summary annotation |
| `_shared/unifiedZoneEngine.ts` | Added `waiting_for_sweep` to `UnifiedState`; added `requireLiquiditySweep` + `sweptAbsorbedPenalty` to `UnifiedZoneConfig`; gate logic in Step 8; story summary; passes penalty config to findZoneLiquidity |
| `_shared/configMapper.ts` | Added `requireLiquiditySweep` (default: false) + `sweptAbsorbedPenalty` (default: 2.0) to `RUNTIME_DEFAULTS`; mapping lines in `mapNestedToFlat()`; backward-compat alias for `liquiditySweepRequired` |
| `bot-scanner/index.ts` | Passed `requireLiquiditySweep` + `sweptAbsorbedPenalty` config to `findUnifiedZone`; added `waiting_for_sweep` state handling with staging logic (setup_type='sweep_watch') |
| `_shared/zoneLiquidity.test.ts` | Updated swept-no-rejection score expectation from 2.5 → 0.5 |
| `_shared/liquiditySweepGate.test.ts` | **NEW** — 20 tests covering all gate + penalty scenarios |

## bot-scanner/index.ts change explanation

Three changes were made to bot-scanner/index.ts:

1. **Line ~4353**: Added `{ requireLiquiditySweep: pairConfig.requireLiquiditySweep, sweptAbsorbedPenalty: pairConfig.sweptAbsorbedPenalty ?? 2.0 }` as the last argument to `findUnifiedZone()`. This passes the user's config through to the unified zone engine.

2. **Lines ~4875-4881**: Added a new `else if` branch after the `requireUnifiedZone` check that handles `unifiedZoneData?.state === "waiting_for_sweep"`. When this state is returned, the pair is skipped with status `"waiting_for_sweep"` and a descriptive log message.

3. **Lines ~4882-4900**: Added staging logic within the `waiting_for_sweep` block — inserts into `staged_setups` with setup_type='sweep_watch' so the pair is automatically re-evaluated.

Neither change modifies the 21 gate definitions. The new branch is a state-handling block, not a new gate definition.

## Tests added

| Test | Assertion |
|------|-----------|
| `entryTriggerState = 'unswept' when entry-trigger pool exists but not swept` | Unswept BSL → entryTriggerState="unswept", hasUnsweptEntryTrigger=true |
| `entryTriggerState = 'swept_rejected' when pool swept + rejected` | Swept+rejected → entryTriggerState="swept_rejected" |
| `entryTriggerState = 'swept_absorbed' when pool swept but broken through` | Swept+absorbed → entryTriggerState="swept_absorbed" |
| `entryTriggerState = 'none' when no entry-trigger pool exists` | Target pool only → entryTriggerState="none" |
| `entryTriggerState = 'none' when no pools at all` | Empty pools → entryTriggerState="none" |
| `swept_absorbed entry-trigger applies -2.0 penalty` | Score = 0.5, summary includes "ABSORBED" |
| `swept_rejected does NOT apply penalty` | Score = 3.0, no ABSORBED in summary |
| `configMapper: requireLiquiditySweep defaults to false` | null config → false |
| `configMapper: requireLiquiditySweep maps from strategy section` | strategy.requireLiquiditySweep=true → true |
| `configMapper: requireLiquiditySweep maps from top-level` | raw.requireLiquiditySweep=true → true |
| `unified engine: waiting_for_sweep is a valid state` | Type system accepts state |
| `regression: gate OFF does not change existing behavior` | Gate off → no blocking |
| `regression: configMapper defaults preserve existing behavior` | All other fields unchanged |
| `bullish: SSL below zone = entry_trigger, unswept` | SSL below zone for bullish → entry_trigger |
| `bullish: SSL below zone swept + rejected` | Score 3.0, hasUnsweptEntryTrigger=false |
| `configurable penalty: custom sweptAbsorbedPenalty=3.0` | Score = -0.5 with penalty 3.0 |
| `configurable penalty: sweptAbsorbedPenalty=0 disables penalty` | Score = 2.5 with penalty 0 |
| `configMapper: sweptAbsorbedPenalty defaults to 2.0` | Default → 2.0 |
| `configMapper: sweptAbsorbedPenalty from strategy section` | strategy.sweptAbsorbedPenalty=1.5 → 1.5 |
| `configMapper: sweptAbsorbedPenalty from top-level raw` | raw.sweptAbsorbedPenalty=3.0 → 3.0 |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/_shared/liquiditySweepGate.test.ts \
    supabase/functions/_shared/zoneLiquidity.test.ts \
    supabase/functions/_shared/unifiedZoneEngine.test.ts \
    supabase/functions/_shared/configMapper.test.ts

ok | 90 passed | 0 failed (434ms)
```

**Pre-existing failures** (6 tests in `beTrailingRace.test.ts` and `brokerFillPriceBE.test.ts`) fail identically on `main` — unrelated to this change.

## Regression check

1. **Gate OFF (default)**: When `requireLiquiditySweep: false`, the sweep gate branch is never entered. All 8 existing `unifiedZoneEngine.test.ts` tests pass unchanged.
2. **Scoring regression**: The absorbed penalty only applies to `swept_absorbed` entry-trigger pools. With `sweptAbsorbedPenalty: 0`, the old behavior is fully restored. Default 2.0 is intentional.
3. **configMapper regression**: All 51 existing configMapper tests pass. New fields are additive with safe defaults.
4. **bot-scanner**: The `waiting_for_sweep` branch only triggers when `unifiedZoneData?.state === "waiting_for_sweep"`, which requires `requireLiquiditySweep: true`. With default `false`, unreachable.
5. **Staging**: Uses the same `staged_setups` insert pattern as `watching_zone`. No new tables or schema changes.

## Dashboard UI changes (smc-trading-dashboard)

Added to the Bot Config Panel → Strategy → Liquidity section:
- **"Require Entry-Trigger Sweep"** toggle → maps to `strategy.requireLiquiditySweep`
- **"Absorbed Penalty"** number input (0-5, step 0.5) → maps to `strategy.sweptAbsorbedPenalty`

Both fields added to `StrategySettings` interface and `DEFAULT_CONFIG`. Dashboard tests pass (25/25 botConfig + botConfigRoutes).

The configMapper has a backward-compat alias: it reads both `strategy.requireLiquiditySweep` AND `strategy.liquiditySweepRequired` (the existing field name in the dashboard).

## Open questions

None — all three follow-up items implemented.

## Suggested PR title and description

**Title:** feat: Liquidity Sweep Gate — configurable toggle + staging + absorbed penalty

**Description:**

Adds a new opt-in gate (`requireLiquiditySweep`) that blocks trade entry until the entry-trigger liquidity pool near the zone has been swept and rejected.

**What it does:**
- When ON: If an entry-trigger pool (BSL above zone for shorts, SSL below zone for longs) exists but hasn't been swept yet, the engine returns `waiting_for_sweep`. The pair is staged for auto-re-evaluation.
- When OFF (default): No behavior change — existing flow is preserved.
- Configurable `sweptAbsorbedPenalty` (default 2.0): Penalizes zones where the protective liquidity was consumed without rejection. Set to 0 to disable.
- Dashboard UI: Toggle + slider added to Liquidity section of bot config.

**Files:** zoneLiquidity.ts, unifiedZoneEngine.ts, configMapper.ts, bot-scanner/index.ts, liquiditySweepGate.test.ts
**Tests:** 20 new tests, 90 total passing
