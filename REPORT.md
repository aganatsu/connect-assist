# Task: Fix cascade zone engine runtime error (htfConfluenceData scope bug)

## Branch: manus/cascade-htf-scope-fix

## Behavior changes

none — pure bug fix. The cascade zone engine was throwing a ReferenceError at runtime because `htfConfluenceData` was out of scope. This fix makes it accessible. No change to what trades get taken, what positions get sized, or what gates pass — the cascade was already erroring out for ALL pairs, so no trades were being affected by it.

## Files modified

- `supabase/functions/bot-scanner/index.ts` — Moved `htfConfluenceData` construction from inside the impulse zone engine's `try` block to the outer scope (before both the impulse zone and cascade zone sections). Both call sites now use `?? undefined` to handle the null case when `analysis.direction` is falsy.

## Tests added

No new tests added — this is a scoping fix. The existing 23 cascade engine tests and 17 cascade gate tests all pass. The error was a runtime ReferenceError that only manifests in the deployed edge function (Deno runtime), not in unit tests which mock the data flow.

## Tests run

```
$ deno test supabase/functions/_shared/ --allow-read --no-check
ok | 1098 passed | 2 failed (10s)
```

The 2 failures are pre-existing in `candleSource.test.ts` (API key issue, unrelated to this change).

## Regression check

The fix only changes WHERE `htfConfluenceData` is constructed, not HOW. The object literal is identical:
```ts
{
  h4OBs: h4OBs ?? [],
  h4FVGs: h4FVGs ?? [],
  h4Breakers: h4Breakers ?? [],
  htfFibLevels: htfFibLevels4H ?? null,
  dailyFibLevels: htfFibLevelsD ?? null,
  htfPD: htfPD4H ?? null,
  direction: (analysis.direction === "long" ? "bullish" : "bearish"),
}
```

The impulse zone engine receives the exact same data as before. The cascade zone engine now receives it instead of throwing a ReferenceError.

## Open questions

1. Should this be merged directly to main (fast-forward) or go through a PR? Given it's a one-line scoping fix that unblocks the entire cascade feature, I'd recommend merging directly.
2. After merging + redeploying, you'll need to run a new scan to see the cascade panel populate correctly for pairs with a Daily story (e.g., EUR/GBP).

## Suggested PR title and description

**Title:** Fix cascade zone engine error — htfConfluenceData out of scope

**Description:**
The `htfConfluenceData` variable was defined inside the impulse zone engine's `try` block, making it inaccessible to the cascade zone engine section below. This caused a ReferenceError at runtime, resulting in the cascade panel showing "Error" state for all pairs.

Fix: Extract `htfConfluenceData` construction to the outer scope before both engine sections, so both impulse zone and cascade zone can reference it. Both call sites use `?? undefined` to handle the null case.

All 1098 tests pass (2 pre-existing failures unrelated).
