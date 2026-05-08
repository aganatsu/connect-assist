# Task: Falling Knife / Rocket Protection (Fix 6)

## Branch: manus/falling-knife-guard

## Behavior changes

1. **P/D zone mean-reversion blocked in strong opposing regimes**: When the direction determination hierarchy falls through to the P/D zone fallback (Step 3 — fractals balanced, no daily BOS), the system now checks if the regime strongly opposes the P/D-implied direction. If regime confidence ≥ 75% in the opposing direction, direction is set to `null` (no trade) instead of generating a counter-trend entry.
   - **Before**: Ranging market + discount zone + 90% bearish regime → direction = "long" (catching a falling knife)
   - **After**: Ranging market + discount zone + 90% bearish regime → direction = null (no trade)
   - This applies symmetrically: premium zone + 90% bullish regime → no short trade (rocket protection)

2. **Threshold**: Only blocks when regime confidence ≥ 75%. Weaker regimes (e.g., 60%) still allow P/D zone mean-reversion trades.

3. **No change to trending markets**: This guard only applies within the ranging market P/D zone fallback path. Trending markets continue to use fractal balance as the primary direction source.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/confluenceScoring.ts` | Added falling knife guard at lines ~510-533 in the P/D zone fallback section of the ranging direction hierarchy |
| `supabase/functions/_shared/structureAuthority.test.ts` | Added 5 new regression tests for Fix 6 (tests 15-19) |

## Tests added

1. **Fix 6: P/D discount + strong bearish regime → direction null (falling knife protection)** — Verifies 90% bearish blocks long from discount
2. **Fix 6: P/D premium + strong bullish regime → direction null (rocket protection)** — Verifies 85% bullish blocks short from premium
3. **Fix 6: P/D discount + weak bearish regime → direction long (allowed)** — Verifies 60% bearish does NOT block
4. **Fix 6: P/D discount + bullish regime → direction long (regime agrees)** — Verifies agreeing regime doesn't interfere
5. **Fix 6: User's USD/JPY example — ranging, balanced fractals, discount, 90% bearish → null** — Full hierarchy walkthrough replicating the exact scan scenario

## Tests run

```
$ deno test --allow-read --allow-net --allow-env --no-check supabase/functions/_shared/
ok | 173 passed | 0 failed (6s)

$ deno test --allow-read --allow-net --allow-env --no-check supabase/functions/bot-scanner/
ok | 12 passed | 0 failed (155ms)

TOTAL: 185 passed | 0 failed
```

## Regression check

- All 173 _shared tests pass (including 19 structureAuthority tests, 13 rangingDirectionFixes tests, 13 htfNestedEntry tests, and all confluenceScoring snapshot tests)
- All 12 bot-scanner tests pass
- The confluenceScoring snapshot tests confirm that bullish trending, bearish trending, and ranging fixtures produce identical output to before (the guard only activates in the specific P/D fallback path with strong opposing regime)
- The guard is narrowly scoped: it only fires when ALL of these are true simultaneously:
  1. Market is ranging (not trending)
  2. Fractal delta < 15% (balanced)
  3. No clear daily BOS/CHoCH direction
  4. P/D zone would suggest a direction
  5. Regime confidence ≥ 75% in the opposing direction

## confluenceScoring.ts change explanation

**What changed:** The P/D zone fallback (Step 3 of the ranging direction hierarchy) now includes a "falling knife guard" before assigning direction from the P/D zone.

The guard reads `regimeInfo.bias` and `regimeInfo.confidence`. If the P/D zone would suggest "long" (discount) but regime is bearish with ≥75% confidence, OR if P/D would suggest "short" (premium) but regime is bullish with ≥75% confidence, direction is set to `null` instead.

**Why:** The user's USD/JPY scan showed the bot generating a "long" direction because price was in the discount zone (51.9%), despite a 90% bearish regime. While Gate 1 caught it downstream, the root cause was the P/D zone fallback generating a counter-trend direction. This fix prevents it at the source — "trend is your friend."

**Scope:** This guard is extremely narrow. It only applies when:
- Entry-TF is ranging (trending markets unaffected)
- Fractal delta < 15% (if fractals lean, they take priority)
- No daily BOS direction (if HTF structure has a lean, it takes priority)
- P/D zone is the LAST resort for direction
- AND regime is ≥75% confident in the opposite direction

## Open questions

1. **Gate 1 message clarity**: The scan output shows "Daily ranging but regime is bearish" which could confuse users since the Regime panel shows "Daily: strong trend (90%) ↓". The message refers to daily *structure* (BOS/CHoCH) being ranging while daily *regime* (EMA/ADX) is bearish. Consider updating the gate message for clarity in a follow-up task.

2. **OB direction mismatch penalty**: Currently only -0.3 penalty when OB direction doesn't match trade direction. User noted this seems lenient. Could be strengthened in a separate task.

3. **directionSource transparency**: Adding an explicit `directionSource` field to the analysis output (e.g., "fractalBalance", "dailyBOS", "pdZone", "null:fallingKnifeGuard") would make scan logs more transparent about WHY a direction was chosen.

## Suggested PR title and description

**Title**: fix(direction): falling knife/rocket protection — P/D zone fallback disabled when regime ≥75% opposes

**Description**:
Prevents the bot from generating counter-trend entries via mean-reversion logic in strong trends.

When the ranging direction hierarchy falls through to the P/D zone fallback (fractals balanced, no daily BOS), the system now checks if the regime strongly opposes (≥75% confidence). If so, direction = null (no trade).

**Example**: USD/JPY scan showed price in discount zone → bot generated "long" direction despite 90% bearish regime. Gate 1 caught it downstream, but the root cause was the P/D zone fallback generating a counter-trend direction in the first place. This fix prevents it at the source.

**Changes**:
- `confluenceScoring.ts`: 24-line guard in P/D zone fallback section
- `structureAuthority.test.ts`: 5 new regression tests

**Risk**: Low — narrowly scoped guard that only activates when all 5 conditions are met simultaneously. All 185 existing tests pass unchanged.
