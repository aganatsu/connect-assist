# Task: Unified Gate Wiring
## Branch: manus/unified-gate-wiring
## Behavior changes

1. **New gate: Unified Zone Gate** — When the unified engine's state is `triggered` or `confirmed` AND `entryReady === true`, the unified gate passes and becomes the primary signal source. This bypasses the impulse zone hard gate (same as cascade gate already does).

2. **Signal source size multiplier** — Trades sourced from the unified engine get full size (1.0x). Trades from the standalone fallback (impulse zone engine alone) get half size (0.5x). This applies to both market orders and limit orders.

3. **Unified SL override** — When the unified gate passes and provides `entry.slPrice`, the SL is overridden to the unified engine's value (subject to the same min/max pip guards as cascade SL). TP is recalculated for proper R:R.

4. **Unified entry override** — When the unified gate passes and provides `entry.entryPrice`, the limit entry is overridden to the unified engine's value (takes priority over cascade entry override).

5. **signalSource label** — Every trade detail now includes `signalSource: "unified" | "standalone"` for downstream analytics and debugging.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added unified gate check (before cascade gate), modified impulse zone gate bypass to include `unifiedGatePassed`, added unified SL override (after cascade SL override), added signal source size multiplier (before positionId), added unified entry override (after cascade entry override), applied size multiplier to limit order path |
| `supabase/functions/_shared/unifiedGateWiring.test.ts` | New test file: 15 tests covering gate decision logic and size multiplier behavior |

## Tests added

| Test | Assertion |
|------|-----------|
| `Unified Gate: passes when state=triggered AND entryReady=true` | Gate passes, signalSource = "unified" |
| `Unified Gate: passes when state=confirmed AND entryReady=true` | Gate passes, signalSource = "unified" |
| `Unified Gate: fails when state=watching` | Gate fails, signalSource = "standalone" |
| `Unified Gate: fails when entryReady=false even if state=triggered` | Gate fails, signalSource = "standalone" |
| `Unified Gate: fails when hasZone=false` | Gate fails, signalSource = "standalone" |
| `Unified Gate: fails when unifiedZoneData is null` | Gate fails, signalSource = "standalone" |
| `Unified Gate: fails when unifiedZoneData is undefined` | Gate fails, signalSource = "standalone" |
| `Unified Gate: fails when confirmation is null` | Gate fails, signalSource = "standalone" |
| `Size Multiplier: unified signal gets full size (1.0x)` | 0.10 -> 0.10 |
| `Size Multiplier: standalone signal gets half size (0.5x)` | 0.10 -> 0.05 |
| `Size Multiplier: standalone rounds to 2 decimal places` | 0.07 -> 0.04 |
| `Size Multiplier: standalone floors at 0.01 minimum` | 0.01 -> 0.01 (floor) |
| `Size Multiplier: very small standalone still gets 0.01` | 0.005 -> 0.01 (floor) |
| `Size Multiplier: unified preserves large size` | 1.50 -> 1.50 |
| `Size Multiplier: standalone halves large size correctly` | 1.50 -> 0.75 |

## Tests run

```
ok | 1142 passed | 0 failed (15s)
```

(1127 existing + 15 new tests)

Note: There is a pre-existing flaky test in `zoneLiquidity.test.ts` that intermittently fails on different test cases between runs. This is unrelated to our changes (confirmed by running on stashed/clean state).

## Regression check

- **Gate logic**: The unified gate is additive — it only fires when `unifiedZoneData` meets all three conditions (hasZone + state + entryReady). When the unified engine is not ready (which is the current state for most pairs until the unified engine produces results), `unifiedGatePassed = false` and the code falls through to the existing cascade/impulse zone logic unchanged.
- **Size impact**: When `signalSource = "standalone"` (which is the default when unified engine hasn't produced a ready signal), size is halved. This IS a behavior change — existing trades will be half-sized until the unified engine starts producing confirmed signals. This is intentional per the task design (standalone = lower conviction = lower size).
- **Brace balance**: Verified programmatically — 2750 open braces, 2750 close braces.
- **All 21 gates untouched**: The unified gate is evaluated BEFORE the 21 safety gates. It does not modify any gate definition or threshold.

## Open questions

1. **Immediate size reduction**: The 0.5x standalone multiplier will immediately halve all trade sizes until the unified engine starts producing `entryReady: true` signals. Is this the desired behavior for the transition period, or should there be a config flag to disable the multiplier during rollout?

2. **Unified vs Cascade priority**: Currently, when BOTH unified and cascade gates pass, the unified entry/SL override runs AFTER cascade (so unified wins). Is this the correct priority order?

3. **Pre-existing flaky test**: `zoneLiquidity.test.ts` has an intermittent failure (different test each run). This is unrelated to our changes but worth investigating separately.

## Suggested PR title and description

**Title:** Wire unified engine as primary signal source with 0.5x standalone fallback

**Description:**
Adds the unified zone engine as the primary signal source in bot-scanner's trade decision flow. When the unified engine's state is `triggered`/`confirmed` and `entryReady === true`, it becomes the signal source with full position size. Otherwise, the existing cascade/impulse zone path is used as a standalone fallback at 0.5x size.

Changes:
- Unified gate check before cascade gate
- Unified SL/entry overrides (after cascade overrides, so unified takes priority)
- Signal source size multiplier: 1.0x unified, 0.5x standalone
- `signalSource` label on trade detail for analytics
- 15 new tests

**BEHAVIOR CHANGE**: All trades will be half-sized until the unified engine starts producing ready signals. This is by design — standalone signals have lower conviction.
