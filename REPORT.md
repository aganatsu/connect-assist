# Task: Add requireUnifiedZone toggle
## Branch: manus/require-unified-zone
## Behavior changes
1. When `requireUnifiedZone` is set to `true` in bot config (strategy section), the bot will **skip any pair** where the Unified Zone Engine did not reach "triggered" or "confirmed" state with `entryReady = true`. The standalone impulse zone fallback is completely bypassed — no trade is taken without the full story confirmation (impulse → zone → liquidity sweep → CHoCH).
2. Default value is `false`, so **existing behavior is unchanged** unless the user explicitly enables this toggle.
3. When enabled, scan details will show `status: "skipped_require_unified"` for pairs that were filtered out by this gate.

## Files modified
- `supabase/functions/_shared/configMapper.ts` — Added `requireUnifiedZone: false` to RUNTIME_DEFAULTS (line 146) and mapping in `mapNestedToFlat()` (line 382). Reads from `strategy.requireUnifiedZone ?? raw.requireUnifiedZone ?? false`.
- `supabase/functions/bot-scanner/index.ts` — Added `else if (pairConfig.requireUnifiedZone)` branch (lines 4568–4574) between the unified gate pass check and the standalone hard gate check. When true and unified gate did not pass, sets `detail.status = "skipped_require_unified"` and continues to next pair.
- `supabase/functions/_shared/configMapper.test.ts` — Added 5 new test cases for the `requireUnifiedZone` field.
- `src/components/BotConfigModal.tsx` — Added a ToggleField for "Require Unified Zone Confirmation" in the Strategy tab, positioned between Min Zone Score and the factor toggles grid (line 743).

## Tests added
1. `requireUnifiedZone defaults to false` — asserts null config returns `requireUnifiedZone: false`
2. `requireUnifiedZone from strategy section` — asserts `strategy.requireUnifiedZone: true` maps correctly
3. `requireUnifiedZone from top-level raw` — asserts flat `requireUnifiedZone: true` maps correctly
4. `requireUnifiedZone=false explicitly set` — asserts explicit false is preserved
5. `strategy.requireUnifiedZone takes priority over raw` — asserts strategy-level takes precedence over top-level

## Tests run
```
deno test --no-check --allow-all supabase/functions/_shared/
ok | 1153 passed | 0 failed (14s)
```

## Regression check
- The `requireUnifiedZone` field defaults to `false`, meaning **zero behavior change** for any existing bot config that does not explicitly set this field.
- Ran the full `unifiedGateWiring.test.ts` suite (15 tests) which validates the existing unified gate logic — all pass, confirming the new branch does not interfere with existing unified/standalone flow.
- The new `else if` branch is inserted BEFORE the existing standalone hard gate check, so when `requireUnifiedZone` is `false` (default), execution falls through to the existing code path unchanged.

## Open questions
1. Should the backtest engine (`backtest-engine/index.ts`) also respect `requireUnifiedZone`? Currently it does not call `findUnifiedZone()` at all — it only uses the standalone impulse zone engine. If you want backtests to match live behavior when this toggle is on, the backtest engine would need the unified zone engine wired in (larger change).
2. The `zoneLiquidity.test.ts` has a pre-existing flaky test (`old sweep beyond maxAge is ignored`) that sometimes fails on main. Not related to this change.

## Suggested PR title and description
**Title:** feat: add `requireUnifiedZone` config toggle to disable standalone impulse zone fallback

**Description:**
Adds a new boolean config field `requireUnifiedZone` (default: `false`) that, when enabled, requires the Unified Zone Engine to confirm entry before any trade is taken. The standalone impulse zone fallback is completely bypassed.

**Motivation:** Backtest analysis showed the unified zone engine produces 76.5% WR (profit factor 1.52) while the standalone fallback produces 39% WR (net negative). Disabling the fallback flips the bot from -$254 to +$215 over the test period.

**Changes:**
- `configMapper.ts`: new field in RUNTIME_DEFAULTS + mapping
- `bot-scanner/index.ts`: new `else if` branch skips pair when unified gate not passed and toggle is on
- `BotConfigModal.tsx`: UI toggle in Strategy tab
- 5 new tests in `configMapper.test.ts`

**Risk:** None for existing users — default is `false` (no behavior change). Only affects bots where the owner explicitly enables the toggle.
