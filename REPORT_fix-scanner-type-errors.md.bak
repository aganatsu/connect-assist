# Task: Fix Scanner Type Errors
## Branch: manus/fix-scanner-type-errors
## Behavior changes

1. **`setup_confidence` values now accurate**: Previously, `setupClassification.confidence` (a numeric 0–1 value) was compared as a string (`=== "high"` etc.), which always fell to the else branch producing 0.5. Now the actual numeric confidence is stored directly. Signals will have accurate confidence values (e.g., 0.82) instead of always 0.5.

2. **`newsBias.strength` now populated**: Previously referenced `pairBias.strength` (non-existent field, always `undefined`). Now correctly uses `pairBias.netStrength`. Game plan data will have the actual net strength value populated.

Both changes are bug fixes — the old code was silently producing incorrect/undefined values due to type mismatches.

## Files modified
- `supabase/functions/_shared/gamePlan.ts` — Fixed OrderBlock type (isActive → state field check) and FVG type (filled boolean → state/mitigated check) to match actual smcAnalysis.ts interfaces
- `supabase/functions/_shared/weeklyProfile.ts` — Fixed candle.time (non-existent on Candle interface) → candle.datetime (correct field) in 3 locations
- `supabase/functions/_shared/weeklyProfile.test.ts` — Updated test fixture helpers to construct candles with `datetime: string` (ISO format) instead of `time: number` (deprecated/non-existent field)
- `supabase/functions/bot-scanner/index.ts` — Fixed pairBias.strength → pairBias.netStrength (correct return field from newsImpact API); Fixed setupClassification.confidence string comparison → direct numeric assignment

## Tests added
- No new test files; existing `weeklyProfile.test.ts` fixtures corrected to use proper `Candle` interface fields (datetime instead of time). This is effectively a test fix that would have failed before (and was failing — 9 tests broken).

## Tests run
```
$ deno test --no-check supabase/functions/_shared/ --allow-read --allow-write --allow-net --allow-env
ok | 468 passed | 0 failed (9s)

$ deno check supabase/functions/bot-scanner/index.ts
Check supabase/functions/bot-scanner/index.ts  (0 errors)
```

## Regression check
- `deno check` passes clean with zero errors (previously had 7 type errors preventing deployment)
- All 468 tests pass (previously 9 weeklyProfile tests were failing)
- gamePlan.ts: `ob.state === "fresh" || ob.state === "tested"` matches same OBs that had `isActive: true`
- gamePlan.ts: `f.state !== "filled" && !f.mitigated` is equivalent to old `!f.filled`
- weeklyProfile.ts: `new Date(candle.datetime).getTime()` produces identical timestamps to `candle.time * 1000`
- The two bot-scanner changes fix bugs (undefined/incorrect values → correct values)

## Open questions
1. **Bot scanner deployment**: After merging to main, please confirm the scanner runs successfully on the next scan cycle.
2. **setup_confidence change**: Signals will now store actual numeric confidence (e.g., 0.85) instead of always 0.5. Any downstream logic that assumed bucketed values (0.9/0.7/0.5) should be checked.
3. **newsBias.strength populated**: Game plans will now have actual `netStrength` values. Any UI or logic consuming this field should handle numeric values (was previously `undefined`).

## Suggested PR title and description
**Title:** fix: resolve 7 type errors preventing bot-scanner from running

**Description:**
The bot-scanner was failing to deploy due to 7 TypeScript type errors across `gamePlan.ts`, `weeklyProfile.ts`, and `bot-scanner/index.ts`. These errors arose from interface drift — the `Candle`, `OrderBlock`, `FairValueGap`, and `SetupClassification` types were updated in `smcAnalysis.ts` but consuming code still referenced old field names.

**Changes:**
- `gamePlan.ts`: OrderBlock `isActive` → `state` field check; FVG `filled` → `state`/`mitigated` check
- `weeklyProfile.ts`: `candle.time` → `candle.datetime` (3 locations)
- `weeklyProfile.test.ts`: Test fixtures updated to use `datetime` ISO strings
- `bot-scanner/index.ts`: `pairBias.strength` → `pairBias.netStrength`; `confidence` string comparison → numeric value

**Verification:** `deno check` passes clean. 468/468 tests pass, 0 failures.
