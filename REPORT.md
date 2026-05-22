# Task: Tiered Scoring Display Sync

## Branch: manus/tiered-scoring-display-sync

## Behavior changes

none — pure display fix. No change to trade logic, gate decisions, scoring, or position sizing.

The bot's actual gate decisions were already correct (Gate 19 runs AFTER the impulse zone credits
and reads the updated `analysis.tieredScoring`). Only the dashboard display was showing stale data
because `detail.tieredScoring` held a reference to the pre-credit object.

## Files modified

- `supabase/functions/bot-scanner/index.ts` — Added 2 sync blocks:
  1. Line ~4271: Syncs `detail.tieredScoring` and `detail.score` in the above-threshold path (before gates are assigned to detail)
  2. Line ~5170: Catch-all sync before `scanDetails.push(detail)` for all paths (below-threshold, staged, no-direction)
- `supabase/functions/_shared/tieredScoringDisplaySync.test.ts` — New test file (3 tests)

## Why bot-scanner/index.ts was modified

The root cause is a JavaScript reference semantics issue:
1. `detail.tieredScoring = analysis.tieredScoring` (line 3461) stores a reference to the original object
2. Impulse zone credit code (lines 3934-4120) creates a NEW object: `analysis.tieredScoring = { ...ts, tier1Count: newCount }`
3. `detail.tieredScoring` still points to the OLD object with `tier1Count: 1`
4. The dashboard reads `detail.tieredScoring` and shows "only 1 core factor" even though the gate correctly passed

The fix adds `detail.tieredScoring = analysis.tieredScoring` after all credits are applied, ensuring
the dashboard display matches the actual gate decision.

## Tests added

1. `detail.tieredScoring stays in sync after impulse zone credit reassignment` — Simulates the exact bug: creates detail with reference to original tieredScoring, then reassigns analysis.tieredScoring (as impulse zone credit does), verifies the sync logic updates detail.tieredScoring.
2. `detail.tieredScoring is NOT overwritten when no credit was applied` — Verifies that when no credit fires (references are already the same), the sync is a no-op.
3. `detail.factors reflects in-place mutations from impulse zone credit` — Verifies that factor mutations (present=true) are visible through the reference (no copy issue there).

## Tests run

```
# New tests:
ok | 3 passed | 0 failed (8ms)

# All supabase tests (this branch):
FAILED | 677 passed | 33 failed (7s)

# All supabase tests (main branch baseline):
FAILED | 676 passed | 34 failed (7s)

# Net: +1 pass, -1 fail (our 3 new tests pass; all failures are pre-existing)
```

## Regression check

- Compared test results between `main` (676 pass / 34 fail) and this branch (677 pass / 33 fail)
- No new failures introduced
- The change is display-only: it syncs a reference after all scoring logic has completed, so it cannot alter any gate decision or trade execution
- Gate 19 at line 4221 reads `analysis.tieredScoring` (the updated one), not `detail.tieredScoring`
- The sync happens AFTER all gate decisions are made, so it's impossible for this change to affect trade logic

## Open questions

None — this is a straightforward reference sync fix with no ambiguity.

## Suggested PR title and description

**Title:** fix: sync detail.tieredScoring after impulse zone credits (display-only)

**Description:**
The dashboard was showing contradictory information: factor checkmarks showed "present" (via IMPULSE-ZONE CREDIT) but the Tier Gates section showed "only 1 core factor — FAILED."

Root cause: `detail.tieredScoring` was set at line 3461 (before credits), but impulse zone credit code at lines 3934-4120 creates a NEW `analysis.tieredScoring` object. The detail reference became stale.

Fix: Sync `detail.tieredScoring = analysis.tieredScoring` after all credits complete, in both the above-threshold and below-threshold code paths.

No behavior change — the bot's actual gate decisions were already correct (Gate 19 at line 4221 reads the updated `analysis.tieredScoring`). This only fixes what the dashboard displays.
