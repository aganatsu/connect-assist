# Task: Direction Engine — Eliminate Split-Brain
## Branch: manus/direction-engine-fix
## Behavior changes
1. Pairs where only 1 out of 4+ direction sources agree (agreement < 0.50) are now **BLOCKED** — previously could produce a directional signal and trade.
2. Pairs with confidence 40–54% are now **BLOCKED** — previously the threshold was 40%, now raised to 55%.
3. When the Direction Verdict is "neutral" (below thresholds), the pair is **blocked entirely** — previously it would fall back to the 15m confluenceScoring direction and potentially trade against the HTF verdict.
4. When the Direction Verdict has a clear direction but the 15m scoring disagrees, the verdict wins unconditionally (was already the case, now explicit with conflict logging).

## Files modified
- `supabase/functions/_shared/directionVerdict.ts` — Added `agreementFloor: 0.50` to DEFAULT_VERDICT_CONFIG. Raised `minConfidence` from 40 to 55. Added agreement floor check that blocks when agreement < floor (checked after confidence threshold). Updated blockReason messages.
- `supabase/functions/bot-scanner/index.ts` — Replaced the effectiveDirection logic: verdict is now the single authority. Neutral/blocked verdict = no trade (no 15m fallback). Added `directionConflict` flag for informational logging when verdict and 15m disagree.
- `supabase/functions/_shared/directionVerdict.test.ts` — Added 7 regression tests covering the GBP/CAD scenario, agreement floor edge cases, minConfidence threshold, full-alignment pass-through, and split-brain prevention.

## Tests added
1. `REGRESSION: GBP/CAD scenario — weak spine + opposing context → blocked (not LONG)` — Proves the exact bug scenario (confirmedTrend=bullish, regime/weekly/gamePlan=bearish) is now blocked.
2. `REGRESSION: agreement exactly 0.50 (2/4 agree) → NOT blocked by agreement floor` — Proves the floor is exclusive (< 0.50 blocks, = 0.50 passes).
3. `REGRESSION: agreement below 0.50 (1/4) with strong spine → still blocked` — Proves even confirmedTrend (strong spine) can't override the agreement floor.
4. `REGRESSION: minConfidence=55 — simpleDirection alone at ~50% confidence → blocked` — Proves weak signals below 55% are now blocked.
5. `REGRESSION: full alignment still passes (no false positives from new thresholds)` — Proves high-conviction setups are unaffected.
6. `REGRESSION: confirmedTrend alone still passes (strong spine = high confidence + 100% agreement)` — Proves single strong source with no opposition still works.
7. `REGRESSION: split-brain scenario never produces contradicting signal` — Proves blocked verdicts never produce an actionable direction.

## Tests run
```
$ deno test directionVerdict.test.ts directionEngine.test.ts --allow-all --no-check
ok | 76 passed | 0 failed (193ms)
```

## Regression check
- The GBP/CAD scenario (the original bug) now correctly blocks instead of producing "LONG 50% confidence 25% agreement"
- Full-alignment scenarios (all sources agree) produce identical outputs to before — confidence >= 85%, agreement = 1.0, shouldBlock = false
- confirmedTrend alone still passes (confidence >= 70%, agreement = 1.0) — no false positives
- The old "regime veto" test still passes (trade is blocked, just by a different mechanism now — minConfidence catches it before regime veto fires)
- TypeScript: 0 errors (npx tsc --noEmit)

## Open questions
1. **Deploy timing**: This change will reduce the number of trades taken (more pairs blocked). You may want to monitor the first few scan cycles after deploy to see how many pairs are now blocked vs before. Consider deploying during a quiet market period.
2. **Tuning**: The `agreementFloor: 0.50` and `minConfidence: 55` are configurable via `bot_configs`. If the bot becomes too conservative, you can lower them without code changes.
3. **15m fallback removal**: The only case where 15m scoring still drives direction is when `computeDirectionVerdict()` itself throws an error (the `else` branch). This should be extremely rare in production.

## Suggested PR title and description
**Title:** fix: eliminate Direction Engine split-brain (agreement floor + minConfidence=55)

**Description:**
Fixes the bug where the Direction Verdict could output "LONG 50% confidence, 25% agreement" while the trend was bearish and the signal was SELL — a contradicting split-brain state.

**Root cause:** The minConfidence threshold (40%) was too low, and there was no agreement floor. A single spine source could produce a directional verdict even when 3/4 of all sources disagreed.

**Fix:**
- Raise minConfidence from 40 to 55 (coin-flip confidence no longer passes)
- Add agreement floor at 0.50 (less than half of sources agreeing = blocked)
- Make verdict the single authority — neutral/blocked = no trade, no 15m fallback

**Impact:** More conservative — fewer trades, but every trade that fires has genuine multi-timeframe alignment. Configurable via `bot_configs` if too strict.
