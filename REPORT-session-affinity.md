# Task: Session-Pair Affinity Module + Factor 26 Integration
## Branch: manus/session-affinity
## Behavior changes
**YES — scoring behavior change:**

1. **Factor 26 "Session Affinity" now contributes to confluence score.** When `_currentSymbol` is available in config (which it is during live scanning), the factor adds or subtracts up to ±1.5 points based on how well the pair trades during the current session.
   - Prime pairs (e.g., EUR/USD in London): +1.0 to +1.5 points
   - Good pairs (e.g., USD/JPY in NY): +0.5 points
   - Marginal pairs: 0 points (neutral)
   - Avoid pairs (e.g., EUR/GBP in Asian): -1.0 points

2. **Net effect on trade selection:** Pairs scanned during their off-peak session will score slightly lower, making them less likely to pass the `minConfluence` threshold. Pairs in their primary session get a small boost. The weight is configurable via `factorWeights.sessionAffinity` (default: 1.5) and can be set to 0 to disable.

3. **No gate changes.** This is a soft scoring factor only — it does not block any trade outright.

## Files modified
- `supabase/functions/_shared/sessionAffinity.ts` — NEW. Session-pair affinity scoring module with affinity map for 36 instruments, overlap detection, day-of-week modifiers, ATR trend modifiers, tier classification, and utility functions.
- `supabase/functions/_shared/sessionAffinity.test.ts` — NEW. 18 unit tests covering all module functionality.
- `supabase/functions/_shared/confluenceScoring.ts` — MODIFIED. Added Factor 26 "Session Affinity" implementation, import of `getSessionAffinity` and `affinityToScoringPoints`, and `sessionAffinity: 1.5` to `DEFAULT_FACTOR_WEIGHTS`. Also added entry to `FACTOR_MAX_WEIGHT` map.
- `supabase/functions/_shared/confluenceScoring.test.ts` — MODIFIED. Updated factor count assertion (22 → 23), added 5 new tests for Factor 26 behavior and regression verification.
- `supabase/functions/_shared/__snapshots__/*.json` — REGENERATED. Snapshots updated to include the new Session Affinity factor in output.
- `supabase/functions/backtest-engine/liveBacktestParity.test.ts` — MODIFIED. Updated factor count assertion (22 → 23).
- `REPORT-session-affinity.md` — NEW. This report.

## Tests added
**sessionAffinity.test.ts (18 tests):**
1. `EUR/USD has high London affinity and low Asian affinity`
2. `Overlap bonus applied during London-NY overlap window`
3. `Wednesday gets 1.10x modifier, Monday gets 0.90x`
4. `Late Friday (after 12:00 ET) gets 0.70 modifier`
5. `Expanding ATR gives 1.10x, contracting + low affinity gives 0.70x`
6. `Contracting ATR with high affinity (>= 0.5) gets no penalty`
7. `Unknown instrument returns neutral score`
8. `Tier classification: prime >= 0.80, good >= 0.55, marginal >= 0.30, avoid < 0.30`
9. `rankPairsBySessionAffinity returns all pairs sorted descending`
10. `shouldScanPair returns false for avoid-tier pairs`
11. `shouldScanPair returns true for prime-tier pairs`
12. `affinityToScoringPoints: prime gives positive, avoid gives -1.0`
13. `isInLondonNYOverlap correctly detects overlap window`
14. `XAU/USD has highest affinity in New York, lowest in Asian`
15. `AUD/NZD has Asian as its primary session`
16. `BTC/USD has relatively even scores across sessions`
17. `All major SPECS instruments have affinity data`
18. `isPrimarySession is true only when session matches pair's primary`

**confluenceScoring.test.ts (5 new tests):**
19. `Factor 26: Session Affinity factor appears in factors list` — verifies factor exists with group "Timing"
20. `Factor 26: EUR/USD during London session scores as prime/good` — verifies positive weight when pair matches session
21. `Factor 26: No symbol in config produces neutral score` — verifies graceful degradation
22. `Factor 26: sessionAffinity weight=0 disables the factor` — verifies user can disable
23. `REGRESSION: existing factors unchanged when sessionAffinity added` — proves all other factors produce identical output

## Tests run
```
$ deno test --allow-all supabase/functions/_shared/sessionAffinity.test.ts
ok | 18 passed | 0 failed (20ms)

$ deno test --allow-all supabase/functions/_shared/confluenceScoring.test.ts
ok | 22 passed | 0 failed (90ms)

$ deno test --allow-all supabase/functions/
FAILED | 895 passed | 1 failed (14s)
```
The 1 failure (`bidirectionalScoring.test.ts:304 — "Regression: aligned factors still produce positive weight"`) is PRE-EXISTING on main — verified by stashing changes and running on clean main (same failure). Not caused by this change.

## Regression check
1. **REGRESSION test added**: Test "REGRESSION: existing factors unchanged when sessionAffinity added" explicitly proves that all 25 existing factors produce identical weights with and without the new factor (using `sessionAffinity: 0` to disable).
2. **Snapshot stability**: All 3 snapshot tests regenerated and verified stable on second run.
3. **Factor count parity**: Both `confluenceScoring.test.ts` and `liveBacktestParity.test.ts` updated from 22 → 23 and pass.
4. **TypeScript compilation**: Clean (`deno check` passes).
5. **Disabling path**: Setting `factorWeights: { sessionAffinity: 0 }` in config produces IDENTICAL output to pre-change behavior.

## Open questions
1. **Pre-existing test failure**: `bidirectionalScoring.test.ts` line 304 fails on main. This appears to be a regression from a previous change. Should I investigate on a separate branch?
2. **Weight tuning**: Default weight is 1.5 (same as Session Quality). After observing live behavior for a few days, you may want to adjust up (more aggressive session filtering) or down (softer influence).

## Suggested PR title and description
**Title:** `[session-affinity] Add Factor 26: Session-Pair Affinity scoring`

**Description:**
Adds session-pair affinity as Factor 26 in the confluence scoring engine. The factor scores how well each instrument trades during the current session based on empirical data.

**Behavior change:** Pairs scanned during their off-peak session score up to -1.0 points lower; pairs in their primary session score up to +1.5 points higher. Configurable via `factorWeights.sessionAffinity` (set to 0 to disable).

**Key features:**
- Affinity map for all 36 SPECS instruments across 4 sessions
- London-NY overlap detection with per-pair bonus
- Day-of-week quality modifiers (Wed best, Fri worst)
- ATR trend interaction (expanding volatility boosts, contracting penalizes)
- Tier classification: prime / good / marginal / avoid
- 23 new tests including regression proof

**Data sources:** BIS 2025 Triennial Survey, BabyPips per-pair session data, ICT methodology.
