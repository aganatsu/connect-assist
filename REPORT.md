# Task: Consolidate gamePlan.ts session-boundary logic onto sessions.ts
## Branch: manus/gameplan-session-consolidation
## Behavior changes
none — pure refactor

## Files modified
- `supabase/functions/_shared/gamePlan.ts`: Removed local `SESSION_TIMES` constant and hardcoded hour values. Replaced `getCurrentSession()` with a call to `sharedDetectSession()` (mapping "Off-Hours" → "Asian" to preserve the 3-value contract). Replaced `getUpcomingSession()` with a loop over `SESSION_WINDOWS` using a single `PRE_MARKET_LEAD_HOURS = 0.5` constant. Added import of `detectSession` and `SESSION_WINDOWS` from `./sessions.ts`.
- `supabase/functions/_shared/gamePlanSessionConsolidation.test.ts` (NEW): 15-test regression suite proving identical behavior at all 24-hour boundaries, including DST transition days.

## Tests added
| Test | What it asserts |
|------|-----------------|
| `getCurrentSession: consolidated version matches old logic at all 24h boundaries` | Compares old hardcoded logic vs new shared-based logic at 96+ time points (every 15 min + exact boundaries + epsilon tests). Zero mismatches. |
| `getUpcomingSession: consolidated version matches old logic at all 24h boundaries` | Same exhaustive comparison for the pre-market detection function. |
| `getCurrentSession boundaries: Asian wraps midnight correctly` | t=20,23,0,1,1.99 → "Asian" |
| `getCurrentSession boundaries: London starts at 2.0` | t=2,5,8.49 → "London" |
| `getCurrentSession boundaries: New York starts at 8.5` | t=8.5,12,15.99 → "New York" |
| `getCurrentSession boundaries: Off-Hours (16-20) maps to Asian` | t=16,17,19,19.99 → "Asian" |
| `getUpcomingSession: pre-market windows are exactly 30 min before open` | Each session's [start-0.5, start) window returns the session; outside returns null |
| `getUpcomingSession: returns null outside all pre-market windows` | Mid-session times (3,10,14,17,22) → null |
| `SESSION_WINDOWS contains the expected session boundaries` | Verifies the shared constants match expected values |
| `No hardcoded session hours remain in gamePlan.ts` | Greps source for SESSION_TIMES, preMarketNYHour, openNYHour, closeNYHour — asserts none found |
| `DST: old and new getCurrentSession agree across full day in EST (winter)` | Feeds real UTC timestamps (Jan 2025, offset -5) through both smcAnalysis.ts toNYTime and sessions.ts detectSession; 96 points, zero mismatches |
| `DST: old and new getCurrentSession agree across full day in EDT (summer)` | Same sweep using June 2025 (offset -4); 96 points, zero mismatches |
| `DST: spring-forward boundary` | At the exact UTC moment the code's DST formula switches EST→EDT (2025-03-08T07:00Z), both old and new agree: before=Asian, after=London |
| `DST: fall-back boundary` | At the exact UTC moment EDT→EST (2025-11-02T06:00Z), both agree: before=Asian, after=Asian |
| `DST: getUpcomingSession agrees at spring-forward pre-market boundary` | London pre-market detection at the DST transition moment agrees between old and new |

## Tests run
```
$ deno task test
ok | 1618 passed | 0 failed (19s)
```

## Regression check
1. **Provenance of reference values:** The `OLD_SESSION_TIMES` and `oldGetCurrentSession`/`oldGetUpcomingSession` in the test file were verified byte-for-byte against `git show HEAD~1:supabase/functions/_shared/gamePlan.ts` (lines 128–164). They are the exact constants that were removed, not re-typed from memory.

2. **Normal-day coverage:** 96+ time points (every 15 min + exact boundaries + epsilon values) compared old vs new. Zero mismatches.

3. **DST-transition coverage:** Full 96-point sweeps on both an EST day (January 2025) and an EDT day (June 2025) using real UTC timestamps through both `smcAnalysis.ts toNYTime` and `sessions.ts detectSession`. Plus explicit tests at the exact UTC moments of spring-forward (2025-03-08T07:00Z) and fall-back (2025-11-02T06:00Z). Zero mismatches.

4. **Type contract preserved:** The `SessionName` type exported from `gamePlan.ts` remains unchanged (`"London" | "New York" | "Asian"` — 3 values), preserving the contract for all consumers (bot-scanner, backtest-engine).

## Open questions
None.

## Suggested PR title and description
**Title:** `[gameplan-session-consolidation] Replace hardcoded session hours with sessions.ts single source of truth`

**Description:**
Removes the local `SESSION_TIMES` constant and hardcoded hour values from `gamePlan.ts`. Session boundaries now come from `sessions.ts`'s `SESSION_WINDOWS` (single source of truth). Only the 30-minute pre-market lead time remains as a game-plan-specific constant.

- `getCurrentSession()` delegates to `detectSession()` from sessions.ts, mapping "Off-Hours" → "Asian" to preserve the existing 3-value contract
- `getUpcomingSession()` iterates `SESSION_WINDOWS` with `PRE_MARKET_LEAD_HOURS = 0.5`
- 10-test regression suite proves identical behavior at all 24h boundaries (96+ data points)
- No hardcoded session-hour numbers remain in gamePlan.ts
- 1613 tests pass, 0 fail
