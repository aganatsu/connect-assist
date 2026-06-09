# Task: Minimum Zone Score Gate

## Branch: manus/min-zone-score-gate

## Behavior changes

1. **New gate added:** Impulse zones scoring below `minZoneScore` (default: 4/9) are now rejected with status `skipped_weak_zone`. Previously, any zone that existed and had price at it would pass the hard gate regardless of quality.
2. **Affected trades:** Zones with totalScore < 4 (e.g., OB at Fib 50% with no S/R, no LTF refinement, no HTF confluence scoring ~1.0) will no longer trigger entries. This is the intended behavior — filtering out low-conviction setups.
3. **Configurable:** Users can adjust the threshold from 0 (disabled) to 9 (maximum strictness) via the Strategy tab slider in BotConfigModal.

## Files modified

- `supabase/functions/_shared/configMapper.ts` — Added `minZoneScore: 4` to RUNTIME_DEFAULTS and mapping line in mapNestedToFlat()
- `supabase/functions/bot-scanner/index.ts` — Added `minZoneScore: 4` to local DEFAULTS, added mapping in inline config builder (~line 747), inserted zone score gate check after priceAtZone confirmation (~line 4496-4504)
- `src/components/BotConfigModal.tsx` — Added Min Zone Score slider (0-9, step 0.5) in Strategy tab after Confluence Threshold
- `src/pages/BotView.tsx` — Added `skipped_weak_zone` status to STATUS_META for scan summary display
- `supabase/functions/_shared/minZoneScoreGate.test.ts` — NEW: 11 regression tests for the gate

## Tests added

1. `RUNTIME_DEFAULTS includes minZoneScore with default value 4` — verifies default exists
2. `mapNestedToFlat: null input returns minZoneScore = 4` — null config fallback
3. `mapNestedToFlat: reads minZoneScore from strategy object` — nested config path
4. `mapNestedToFlat: reads minZoneScore from top-level (legacy format)` — flat config path
5. `mapNestedToFlat: strategy.minZoneScore takes priority over top-level` — priority order
6. `zone score gate: zone scoring below minZoneScore is rejected` — rejection logic
7. `zone score gate: zone scoring at or above minZoneScore passes` — pass logic
8. `zone score gate: setting minZoneScore to 0 disables the gate` — disable behavior
9. `zone score gate: score exactly at threshold passes (not strict inequality)` — boundary
10. `zone score gate: custom threshold of 6 rejects scores 0-5.5` — custom threshold
11. `regression: adding minZoneScore does not affect other impulse zone defaults` — no side effects

## Tests run

```
ok | 1327 passed | 0 failed (17s)
```

## Regression check

- All 1327 existing tests pass unchanged
- The new gate only fires when `impulseZoneEnabled !== false && izGateMode === "hard"` AND price is already at zone — it cannot affect pairs that don't reach the zone gate
- The gate uses `<` (strict less-than), so a zone scoring exactly at threshold still passes
- Other impulse zone settings (penalty, bonus, gateMode, slCapMultiplier) verified unchanged in regression test #11

## Open questions

None — implementation is straightforward and self-contained.

## Suggested PR title and description

**Title:** feat(scanner): add configurable minimum zone score gate

**Description:**
Adds a new quality gate that rejects impulse zones scoring below a configurable threshold (default: 4/9). Previously, any zone that existed with price at it would pass the hard gate regardless of quality — a zone scoring 1.5/9 (OB at Fib 50%, no other confluence) was treated identically to a 9/9 zone.

**What it does:**
- Zones below `minZoneScore` get status `skipped_weak_zone` and are logged
- Gate fires AFTER price-at-zone check but BEFORE Tier 1 credit
- Configurable from UI via Strategy tab slider (0-9, step 0.5)
- Setting to 0 disables the gate entirely

**Files:** 5 modified, 1 new test file (11 tests), full suite 1327/1327 passing.
