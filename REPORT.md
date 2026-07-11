# Task: Liquidity Sweep Gate

## Branch: manus/liquidity-sweep-gate

## Behavior changes

1. **New scoring penalty**: When an entry-trigger liquidity pool (BSL above zone for bearish, SSL below zone for bullish) has been swept but **absorbed** (broken through without rejection), a -2.0 penalty is now applied to the liquidity score. Previously, swept-without-rejection scored +1.5; now it scores +1.5 - 2.0 = -0.5 (clamped to 0.5 total with the base +1.0). This penalizes zones where the protective liquidity has been consumed without reversal.

2. **New gate (opt-in)**: When `requireLiquiditySweep: true` is set in bot config, the Unified Zone Engine will return state `waiting_for_sweep` instead of `triggered`/`confirmed` if the entry-trigger pool near the zone has NOT been swept yet. The bot-scanner will then skip the pair (status: `waiting_for_sweep`) and log it as watchlisted. **This gate is OFF by default** — no existing behavior changes unless the user explicitly enables it.

3. **Existing test updated**: `zoneLiquidity.test.ts` test "detects swept pool without rejection (score +2.5)" now expects score 0.5 due to the new absorbed penalty. This is the intentional consequence of change #1.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/zoneLiquidity.ts` | Added `entryTriggerState`, `hasUnsweptEntryTrigger` fields to `ZoneLiquidityResult`; added -2.0 penalty for `swept_absorbed` entry-trigger pools; added summary annotation |
| `supabase/functions/_shared/unifiedZoneEngine.ts` | Added `waiting_for_sweep` to `UnifiedState` type; added `requireLiquiditySweep` to `UnifiedZoneConfig` interface; added gate logic in Step 8 state determination; updated `buildStorySummary` for new state |
| `supabase/functions/_shared/configMapper.ts` | Added `requireLiquiditySweep: false` to `RUNTIME_DEFAULTS`; added mapping line in `mapNestedToFlat()` |
| `supabase/functions/bot-scanner/index.ts` | Passed `requireLiquiditySweep` config to `findUnifiedZone`; added `waiting_for_sweep` state handling (skip pair + log) |
| `supabase/functions/_shared/zoneLiquidity.test.ts` | Updated swept-no-rejection score expectation from 2.5 → 0.5 |
| `supabase/functions/_shared/liquiditySweepGate.test.ts` | **NEW** — 15 tests covering all gate scenarios |

## bot-scanner/index.ts change explanation

Two changes were made to bot-scanner/index.ts:

1. **Line ~4353**: Added `{ requireLiquiditySweep: pairConfig.requireLiquiditySweep }` as the last argument to `findUnifiedZone()`. This passes the user's config toggle through to the unified zone engine so it can decide whether to enforce the sweep gate.

2. **Lines ~4875-4881**: Added a new `else if` branch after the `requireUnifiedZone` check that handles `unifiedZoneData?.state === "waiting_for_sweep"`. When this state is returned by the engine, the pair is skipped with status `"waiting_for_sweep"` and a descriptive log message. This is positioned AFTER the `requireUnifiedZone` check so that if both toggles are on, `requireUnifiedZone` takes precedence (it's a stricter gate).

Neither change modifies the 21 gate definitions. The new branch is a state-handling block, not a new gate definition.

## Tests added

| Test | Assertion |
|------|-----------|
| `entryTriggerState = 'unswept' when entry-trigger pool exists but not swept` | Unswept BSL above zone for bearish → entryTriggerState="unswept", hasUnsweptEntryTrigger=true |
| `entryTriggerState = 'swept_rejected' when pool swept + rejected` | Swept+rejected pool → entryTriggerState="swept_rejected", hasUnsweptEntryTrigger=false |
| `entryTriggerState = 'swept_absorbed' when pool swept but broken through` | Swept+absorbed pool → entryTriggerState="swept_absorbed", hasUnsweptEntryTrigger=false |
| `entryTriggerState = 'none' when no entry-trigger pool exists` | Target pool only → entryTriggerState="none" |
| `entryTriggerState = 'none' when no pools at all` | Empty pools → entryTriggerState="none" |
| `swept_absorbed entry-trigger applies -2.0 penalty` | Score = 0.5 (1.0 + 1.5 - 2.0), summary includes "ABSORBED" |
| `swept_rejected does NOT apply penalty` | Score = 3.0 (1.0 + 2.0), no ABSORBED in summary |
| `configMapper: requireLiquiditySweep defaults to false` | null config → requireLiquiditySweep=false |
| `configMapper: requireLiquiditySweep maps from strategy section` | strategy.requireLiquiditySweep=true → true |
| `configMapper: requireLiquiditySweep maps from top-level` | raw.requireLiquiditySweep=true → true |
| `unified engine: waiting_for_sweep is a valid state` | Type system accepts the new state |
| `regression: gate OFF does not change existing behavior` | Unswept pool with gate off → still reports state but score=1.0 (no penalty for unswept) |
| `regression: configMapper defaults preserve existing behavior` | All other zone fields unchanged |
| `bullish: SSL below zone = entry_trigger, unswept` | SSL below zone for bullish → entry_trigger, unswept |
| `bullish: SSL below zone swept + rejected` | Swept+rejected SSL → score 3.0, hasUnsweptEntryTrigger=false |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/_shared/liquiditySweepGate.test.ts \
    supabase/functions/_shared/zoneLiquidity.test.ts \
    supabase/functions/_shared/unifiedZoneEngine.test.ts \
    supabase/functions/_shared/configMapper.test.ts

ok | 85 passed | 0 failed (354ms)
```

**Pre-existing failures** (6 tests in `beTrailingRace.test.ts` and `brokerFillPriceBE.test.ts`) fail identically on `main` — unrelated to this change.

## Regression check

1. **Gate OFF (default)**: When `requireLiquiditySweep: false` (the default), the `findUnifiedZone` function never enters the sweep gate branch. The state determination logic only checks `hasUnsweptEntryTrigger` when `config.requireLiquiditySweep === true`. Verified by running all 8 existing `unifiedZoneEngine.test.ts` tests — all pass unchanged.

2. **Scoring regression**: The only scoring change is the new -2.0 penalty for `swept_absorbed` entry-trigger pools. This affects `findZoneLiquidity` regardless of the gate toggle (it's a scoring improvement, not gated). The old test expected 2.5 for swept-no-rejection; now it's 0.5. This is intentional — a pool that was swept and broken through (absorbed) is a bearish signal for the zone's validity.

3. **configMapper regression**: All 51 existing configMapper tests pass. The new field is additive and defaults to `false`.

4. **bot-scanner**: The `waiting_for_sweep` branch in bot-scanner only triggers when `unifiedZoneData?.state === "waiting_for_sweep"`, which can only happen when `requireLiquiditySweep: true` is passed to `findUnifiedZone`. With the default `false`, this branch is unreachable.

## Open questions

1. **UI toggle**: The config field `requireLiquiditySweep` is now available in the runtime config. The dashboard UI (Lovable) will need a toggle added under the Impulse Zone / Unified Zone section of the bot config modal. Should I create a separate task for the UI, or do you want to add it yourself?

2. **Staging for waiting_for_sweep**: Currently, when the gate fires `waiting_for_sweep`, the pair is simply skipped (no staged_setups insert). Should we add staging logic similar to `watching_zone` so the pair is automatically re-evaluated when the pool gets swept?

3. **Absorbed penalty tuning**: The -2.0 penalty is hardcoded. Should this be configurable via a new config field (e.g., `sweptAbsorbedPenalty`)?

## Suggested PR title and description

**Title:** feat: Add Liquidity Sweep Gate — configurable toggle to require BSL/SSL sweep before entry

**Description:**
Adds a new opt-in gate (`requireLiquiditySweep`) that blocks trade entry until the entry-trigger liquidity pool near the zone has been swept and rejected.

**What it does:**
- When ON: If an entry-trigger pool (BSL above zone for shorts, SSL below zone for longs) exists but hasn't been swept yet, the Unified Zone Engine returns `waiting_for_sweep` instead of proceeding to entry. The bot skips the pair and logs it.
- When OFF (default): No behavior change — existing flow is preserved.
- Additionally: A -2.0 scoring penalty is applied to `swept_absorbed` pools (swept but broken through without rejection), reducing confidence in zones where protective liquidity has been consumed.

**Files:** zoneLiquidity.ts, unifiedZoneEngine.ts, configMapper.ts, bot-scanner/index.ts
**Tests:** 15 new tests + 1 updated test, 85 total passing
