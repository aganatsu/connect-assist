# Task: Configurable Tier 1 Minimum Core Factor Count
## Branch: manus/configurable-tier1-min
## Behavior changes
1. The Tier 1 gate minimum (Gate 19) is now configurable via `strategy.minTier1Factors` (range 1–5, default 3).
2. Users who lower this value (e.g., to 2) will see MORE trades pass the Tier 1 gate — setups that previously required 3 core factors will now pass with 2.
3. Users who raise this value (e.g., to 4–5) will see FEWER trades pass — only high-confluence setups will be accepted.
4. **Default behavior is unchanged** — existing users with no explicit setting continue to use 3 as the minimum.

## Files modified
- `supabase/functions/_shared/confluenceScoring.ts` — Replaced hardcoded `>= 3` with `>= _minTier1` where `_minTier1` reads from `config.minTier1Factors` (clamped 1–5, default 3). Also updated the failure message to show the configured minimum.
- `supabase/functions/_shared/configMapper.ts` — Added `minTier1Factors: 3` to RUNTIME_DEFAULTS and added mapping `strategy.minTier1Factors ?? raw.minTier1Factors ?? RUNTIME_DEFAULTS.minTier1Factors` in the resolution function.
- `supabase/functions/bot-scanner/index.ts` — Updated two impulse-zone credit recalculation blocks (lines ~4925 and ~4972) to use `pairConfig.minTier1Factors ?? 3` instead of hardcoded 3.
- `src/components/BotConfigModal.tsx` — Added "Min Tier 1 Core Factors" slider (1–5, step 1) in the Strategy section, with description and SEARCH_INDEX entry.
- `supabase/functions/_shared/minTier1FactorsConfig.test.ts` — New test file (5 tests).

## Tests added
1. `configMapper resolves minTier1Factors from strategy` — verifies default=3, strategy override, raw fallback, and priority
2. `RUNTIME_DEFAULTS.minTier1Factors is 3` — verifies the default constant
3. `confluenceScoring uses config.minTier1Factors for Tier 1 gate` — verifies clamping logic (1–5 range)
4. `Tier 1 gate pass/fail with configurable minimum` — verifies gate logic with min=2, 3, 4, 5
5. `Regression: default minTier1Factors=3 produces same gate behavior as hardcoded 3` — proves no change for default users

## Tests run
```
ok | 29 passed | 0 failed (442ms)
```
All 29 tests across 4 test files pass (minTier1FactorsConfig, scanMetaActiveStyle, notificationCategoryToggles, impulseZoneGateModeConfig).

## Regression check
- The clamping logic ensures `_minTier1` defaults to 3 when `config.minTier1Factors` is undefined, null, or not a number — identical to the previous hardcoded behavior.
- Test 5 explicitly verifies that for all tier1Count values 0–5, the configurable version with default=3 produces identical pass/fail results as the old hardcoded version.
- The impulse-zone credit recalculations use `pairConfig.minTier1Factors ?? 3` which also defaults to 3.

## Open questions
- None. User explicitly granted permission to modify confluenceScoring.ts and bot-scanner gate 19.

## Suggested PR title and description
**Title:** feat: make Tier 1 minimum core factor count configurable (strategy.minTier1Factors)

**Description:**
Replaces the hardcoded `>= 3` Tier 1 gate threshold with a user-configurable setting (`strategy.minTier1Factors`, range 1–5, default 3).

- Adds slider in Bot Configuration > Strategy section
- Wired through configMapper with proper fallback chain
- Updated confluenceScoring.ts and bot-scanner impulse-zone credit recalculations
- Default behavior unchanged for existing users
- 5 new regression tests, all passing
