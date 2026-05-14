# Task: Bot Config Audit
## Branch: manus/bot-config-audit
## Behavior changes

1. **DOL TP Extension toggle** — Users can now disable DOL-based TP extension via `dolTPExtensionEnabled: false` in config. When disabled, DOL targets from the game plan are NOT passed to `calculateSLTP`, so TP will never be extended beyond the base R:R calculation. **Default: ON** (no change for existing users).

2. **IPDA Ranges toggle** — Users can now disable IPDA Data Range computation via `ipdaRangesEnabled: false` in config. When disabled, the 20/40/60-day institutional reference levels are not calculated and not merged into game plan key levels. **Default: ON** (no change for existing users).

3. **Factor 25 (GP Key Level) weight** — Now adjustable in the UI via the Factor Weights tab. Previously this factor existed in the scoring engine but had no UI slider. Users can now tune it from 0 to 5 (default: 1.0, Tier 2).

4. **Dead defaults removed from BASE_CONFIG** — `notifications` section, `pyramidingEnabled`, `maxPyramidAdds`, `endOfSessionClose`, and unused protection keys (`dailyProfitTarget`, `cumulativeProfitTarget`, `cumulativeLossLimit`, `haltOnDailyTarget`) removed from the UI's BASE_CONFIG. These were never consumed by bot-scanner and had no UI controls. Protection defaults now reflect the actual consumed keys (`maxDailyLoss`, `maxConsecutiveLosses`, `circuitBreakerPct`).

5. **Clarified overlapping control descriptions** — Risk tab and Protection tab controls that overlap in concept now have explicit descriptions explaining their distinct purposes (% vs $, gate vs circuit-breaker, etc.).

## Files modified

| File | Description |
|------|-------------|
| `src/components/BotConfigModal.tsx` | Added Factor 25 to FACTOR_WEIGHT_DEFS, added DOL TP Extension + IPDA Ranges toggles to Game Plan tab, clarified overlapping control descriptions, removed dead defaults from BASE_CONFIG, updated search index |
| `supabase/functions/_shared/confluenceScoring.ts` | Added `dolTPExtensionEnabled` gate around DOL target extraction (2 lines) |
| `supabase/functions/_shared/gamePlan.ts` | Added `options?: { ipdaRangesEnabled?: boolean }` parameter to `generateInstrumentGamePlan`, gated IPDA computation and key-level merge |
| `supabase/functions/bot-scanner/index.ts` | Added config reads for `ipdaRangesEnabled` and `dolTPExtensionEnabled`, passed `ipdaRangesEnabled` to game plan generation, passed `dolTPExtensionEnabled` into pairConfig |
| `supabase/functions/_shared/botConfigAudit.test.ts` | **NEW** — 5 tests covering Factor 25 existence, DOL toggle, IPDA toggle, backward compat |

## Changes to protected/cautioned files

### bot-scanner/index.ts (live execution)

Three small changes were made:

1. **Config reads (line ~2913-2914)**: Two new lines reading `ipdaRangesEnabled` and `dolTPExtensionEnabled` from config, alongside the existing `gamePlanEnabled` reads. Both use the `!== false` pattern (default ON).

2. **Game plan generation call (line ~2995)**: Added `{ ipdaRangesEnabled }` options object as the 7th argument to `generateInstrumentGamePlan()`. This passes the user's toggle preference into game plan generation.

3. **pairConfig injection (line ~3362)**: Added `(pairConfig as any).dolTPExtensionEnabled = (config as any).dolTPExtensionEnabled !== false;` before `runConfluenceAnalysis()`. This makes the toggle available to the confluence scoring engine's DOL target extraction.

### confluenceScoring.ts (scoring engine)

One change was made:

1. **DOL target gate (lines ~2723-2728)**: Added `const dolTPEnabled = (config as any).dolTPExtensionEnabled !== false;` and gated the `dolTargetsForTP` extraction with `dolTPEnabled &&`. When the toggle is false, `dolTargetsForTP` is `undefined`, so `calculateSLTP` never receives DOL targets and TP is never extended.

## Tests added

| Test | What it asserts |
|------|-----------------|
| `Factor 25: gamePlanKeyLevel exists in DEFAULT_FACTOR_WEIGHTS with weight 1.0` | Factor key exists and has correct default weight |
| `dolTPExtensionEnabled: when false, DOL targets are NOT passed to calculateSLTP` | Runs confluence analysis with toggle disabled, verifies valid output |
| `dolTPExtensionEnabled: defaults to true (backward compat)` | Omitting the toggle produces valid results |
| `ipdaRangesEnabled: when false, IPDA ranges are null and no IPDA key levels are merged` | Game plan with toggle disabled has no IPDA ranges or IPDA key levels |
| `ipdaRangesEnabled: defaults to true (backward compat)` | Game plan without options has IPDA ranges present |

## Tests run

```
$ deno test supabase/functions/_shared/ --allow-all --no-check
ok | 453 passed | 0 failed (9s)
```

## Regression check

- All 453 existing tests pass unchanged — no behavioral regression
- Both new toggles default to `true` (via `!== false` pattern), meaning existing configs that don't set these keys get identical behavior to before
- The DOL TP extension gate only suppresses target passing; it does not alter `calculateSLTP` internals (protected file)
- The IPDA gate only skips the `calculateIPDARanges` call; all other game plan logic (bias, DOL, scenarios) is unaffected
- Factor 25 was already scored in the engine; the UI change only adds a slider — no scoring logic changed
- Dead default removal only affects the UI's initial preset state; existing saved configs in the database are unaffected

## Open questions

1. **Protection tab defaults**: I set `maxDailyLoss: 500, maxConsecutiveLosses: 3, circuitBreakerPct: 20` as the new BASE_CONFIG protection defaults. These match what the UI renders. Confirm these are reasonable defaults for new users.
2. **bot-config/index.ts defaults**: The edge function `bot-config/index.ts` still has the old dead keys in its defaults (for backward compat with existing DB records). Should those be cleaned up in a separate task?
3. **Pyramiding**: The `pyramidingEnabled` / `maxPyramidAdds` keys are dead code everywhere. Should they be removed from `bot-config/index.ts` too, or is there a future plan to implement pyramiding?

## Suggested PR title and description

**Title:** `[bot-config-audit] Add game plan toggles, Factor 25 slider, clarify overlapping controls, remove dead defaults`

**Description:**
Audit of the Bot Configuration modal addressing growth/complexity concerns:

- **New toggles**: `dolTPExtensionEnabled` and `ipdaRangesEnabled` in Game Plan tab — let users disable DOL-based TP extension and IPDA institutional ranges independently
- **Factor 25 slider**: `gamePlanKeyLevel` now adjustable in Factor Weights tab (was missing from UI)
- **Clarified descriptions**: Risk tab vs Protection tab overlapping controls now have explicit descriptions explaining their distinct purposes
- **Dead code cleanup**: Removed `notifications` section, `pyramidingEnabled`, `endOfSessionClose`, and unused protection keys from UI defaults
- **Backward compatible**: Both toggles default ON, no behavior change for existing configs
- **Tests**: 5 new tests, 453 total passing
