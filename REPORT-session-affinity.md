# Task: Session-Pair Affinity Module
## Branch: manus/session-affinity
## Behavior changes
none — pure addition. This module is informational only. It does not modify any gates, factor weights, scoring, or trade decisions. It exports pure functions that can be called by the scanner to annotate results.

## Files modified
- `supabase/functions/_shared/sessionAffinity.ts` — NEW. Session-pair affinity scoring module with affinity map for 36 instruments, overlap detection, day-of-week modifiers, ATR trend modifiers, tier classification, and utility functions.
- `supabase/functions/_shared/sessionAffinity.test.ts` — NEW. 18 unit tests covering all module functionality.
- `REPORT-session-affinity.md` — NEW. This report.

## Tests added
1. `EUR/USD has high London affinity and low Asian affinity` — verifies base scores and tier classification
2. `Overlap bonus applied during London-NY overlap window` — verifies 08:30-12:00 ET overlap detection and bonus
3. `Wednesday gets 1.10x modifier, Monday gets 0.90x` — verifies day-of-week modifiers
4. `Late Friday (after 12:00 ET) gets 0.70 modifier` — verifies late Friday penalty
5. `Expanding ATR gives 1.10x, contracting + low affinity gives 0.70x` — verifies ATR trend modifiers
6. `Contracting ATR with high affinity (>= 0.5) gets no penalty` — verifies no double-penalty for good pairs
7. `Unknown instrument returns neutral score` — verifies graceful fallback
8. `Tier classification: prime >= 0.80, good >= 0.55, marginal >= 0.30, avoid < 0.30` — verifies tier boundaries
9. `rankPairsBySessionAffinity returns all pairs sorted descending` — verifies ranking utility
10. `shouldScanPair returns false for avoid-tier pairs` — verifies scan gating utility
11. `shouldScanPair returns true for prime-tier pairs` — verifies scan pass-through
12. `affinityToScoringPoints: prime gives positive, avoid gives -1.0` — verifies scoring conversion
13. `isInLondonNYOverlap correctly detects overlap window` — verifies overlap window boundaries
14. `XAU/USD has highest affinity in New York, lowest in Asian` — verifies commodity session data
15. `AUD/NZD has Asian as its primary session` — verifies Oceanic pair exception
16. `BTC/USD has relatively even scores across sessions` — verifies 24/7 market handling
17. `All major SPECS instruments have affinity data` — verifies complete coverage
18. `isPrimarySession is true only when session matches pair's primary` — verifies primary flag

## Tests run
```
$ deno test supabase/functions/_shared/sessionAffinity.test.ts
ok | 18 passed | 0 failed (21ms)

$ deno test supabase/functions/ --allow-read --allow-env --allow-net
ok | 890 passed | 1 failed (12s)
```
The 1 failure (`bidirectionalScoring.test.ts:304`) is PRE-EXISTING on main — not caused by this change. Verified by running the same test on clean main (same failure).

## Regression check
- No existing files were modified — this is a pure addition of new files
- No imports were added to any existing module
- TypeScript compilation passes with no errors (`npx tsc --noEmit` clean)
- All 890 existing tests pass (the 1 failure is pre-existing on main)

## Open questions
1. **Integration path**: The module is ready to be consumed by the scanner. Three options:
   - **Option A (recommended)**: Add as Factor 26 in `confluenceScoring.ts` with weight key `sessionAffinity` — would require modifying `confluenceScoring.ts` and adding to `DEFAULT_FACTOR_WEIGHTS` (both protected files, need permission)
   - **Option B**: Use `shouldScanPair()` in the scanner loop to skip low-affinity pairs entirely — would require modifying `bot-scanner/index.ts` (protected file, need permission)
   - **Option C**: Use as info-only annotation in scan logs (no protected file changes needed)

2. **Pre-existing test failure**: `bidirectionalScoring.test.ts` line 304 fails on main. This appears to be a regression from a previous change to bidirectional scoring. Should I investigate on a separate branch?

## Suggested PR title and description
**Title:** `[session-affinity] Add session-pair affinity scoring module`

**Description:**
Adds `_shared/sessionAffinity.ts` — a new module that scores how well each instrument trades during the current session based on empirical pip-range data, ICT methodology, and institutional flow research.

**Key features:**
- Affinity map for all 36 SPECS instruments across 4 sessions
- London-NY overlap detection with per-pair bonus
- Day-of-week quality modifiers (Wed best, Fri worst)
- ATR trend interaction (expanding volatility boosts, contracting penalizes low-affinity)
- Tier classification: prime / good / marginal / avoid
- Utility functions: `rankPairsBySessionAffinity()`, `shouldScanPair()`, `affinityToScoringPoints()`

**No behavior changes.** Module is informational only until explicitly wired into the scanner.

**Data sources:**
- BIS 2025 Triennial Survey (global FX volume distribution)
- BabyPips 2025 per-pair per-session pip-range data
- ICT Kill Zone / Silver Bullet / Power of 3 methodology
- Institutional flow research (London-NY overlap concentration)
