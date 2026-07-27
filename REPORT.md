# Task: Consolidate Pre-Gates Fast-Path
## Branch: manus/consolidate-pre-gates
## Behavior changes
**One latent bug fix (inert in practice):**

The old pre-gates fast-path for daily loss limit had no `if (config.maxDailyLoss > 0)` guard. When `maxDailyLoss = 0` (meaning "disabled"), the old code would compute `dailyLossPct = 0` and check `0 >= 0` → `true` → block ALL trades. The main gate array has this guard and correctly skips the check when disabled.

This was a pre-existing inconsistency between the pre-gate and main gate. In practice it's inert because:
- Default `maxDailyLoss` is 5 (from `configMapper.ts` RUNTIME_DEFAULTS)
- Optimizer parameter space has `min: 1` for this parameter
- No real config ever sets `maxDailyLoss = 0`

The fix adds the `if (config.maxDailyLoss > 0)` guard to match the main gate array, making both paths structurally identical.

## Files modified
- `supabase/functions/backtest-engine/index.ts` — Replaced 6 inline gate checks in the pre-gates IIFE (lines 1935-1981) with calls to shared functions: `checkMaxPositions`, `checkMaxPerSymbol`, `checkMaxDrawdown`, `checkDailyLossLimit`, `checkCooldown`, `checkConsecutiveLosses`. Category strings and `skippedByPreGate` counting preserved exactly.
- `supabase/functions/_shared/preGateConsistency.test.ts` — NEW cross-consistency test proving pre-gate fast-path and main gate array agree on all 6 conditions.

## Tests added
1. `pre-gate vs main-gate: both paths agree on pass/fail for all 6 conditions` — 12 synthetic portfolio states, asserts pre-gate's first-fail category matches main gate's first-fail gate
2. `pre-gate vs main-gate: individual gate pass/fail matches for non-short-circuit cases` — filters to single-fail cases, verifies exact gate match
3. `pre-gate vs main-gate: disabled gates (config=0) are skipped by both paths` — proves maxDailyLoss=0, cooldown=0, maxConsecutiveLosses=0 don't block
4. `pre-gate: skippedByPreGate counter increments on any failure` — proves counter behavior is unchanged

## Tests run
```
deno task test
ok | 1728 passed | 0 failed (18s)
```

## Regression check
The cross-consistency test is the primary regression check. It:
- Runs 12 synthetic portfolio states through both the pre-gate fast-path pattern and the main gate array pattern
- Asserts they agree on which gate fails first (short-circuit order preserved)
- Asserts disabled gates (config=0) are skipped by both paths
- Asserts the `skippedByPreGate` counter increments on exactly the same cases as the main gate would block

This test would fail if:
- A shared function were called with different inputs in the two paths
- A guard condition existed in one path but not the other
- The short-circuit order differed between paths

## Open questions
None. The pre-gates fast-path now uses the same shared functions as the main gate array. The only remaining inline logic is the data-preparation code (filtering trades, computing elapsed time) which is necessarily different between the pre-gate context (has `allTrades`, `candleMs`) and the main gate context (has `recentTrades`, `currentCandleMs`).

## Suggested PR title and description
**Title:** `[consolidate-pre-gates] Replace inline pre-gate checks with shared function calls`

**Description:**
The backtest-engine's "Portfolio Pre-Gates" fast-path had a third copy of 6 gate checks (max positions, max per symbol, max drawdown, daily loss, cooldown, consecutive losses) that was never consolidated when the shared functions were extracted. This PR replaces all 6 inline checks with calls to the same shared functions used by the main gate array.

**Changes:**
- Pre-gates IIFE now calls `checkMaxPositions`, `checkMaxPerSymbol`, `checkMaxDrawdown`, `checkDailyLossLimit`, `checkCooldown`, `checkConsecutiveLosses`
- Category strings and `skippedByPreGate` counting preserved exactly
- Added `if (config.maxDailyLoss > 0)` guard to fix a latent bug (inert in practice — no real config uses maxDailyLoss=0)
- New cross-consistency test (4 test cases, 12 synthetic inputs) proving both paths agree

**Behavior:** No change for any real config. Fixes a latent bug for the impossible case of `maxDailyLoss=0`.
