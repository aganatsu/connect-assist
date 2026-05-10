# Task: Fix impulse zone engine — replace 50% pullback kill switch with origin-not-broken validation
## Branch: manus/impulse-origin-validation
## Behavior changes
1. **Impulse legs with deep internal pullbacks (>50%) are no longer rejected.** Previously, any impulse where an internal candle retraced >50% of the running leg was discarded entirely. Now, impulses are valid as long as the swing origin has not been broken by subsequent price action. This means more pairs will have valid impulse zones detected (e.g., ETH/USD bearish impulse with wave 2/4 corrections).
2. **Error message updated.** The reason string when no impulse is found changed from "no BOS or all pullbacks >50%" to "no BOS or origin broken".
3. **Impulse Zone panel moved to top of detail breakdown** (separate commit on main). The ImpulseZonePanel now appears first in both ScanSignalDetail and ScanDetailInline views.
4. **Direction engine reason surfaced in Impulse Zone panel** (separate commit on main). When no zone is found and direction detail is available, the panel shows bias/4H/1H status badges and the full reason text.
5. **Reason text no longer truncated** (separate commit on main). Removed CSS `truncate` class so full reason text wraps instead of being cut off.

## Files modified
- `supabase/functions/_shared/impulseZoneEngine.ts` — Removed `checkNoPullbackExceeds50()` function (50 lines). Replaced validation in `validateImpulseFromBOS()` with origin-not-broken check: for bullish impulses, checks no candle after BOS closed below the swing low; for bearish, checks no candle closed above the swing high. Updated `ImpulseLeg.isValid` comment and error message string.
- `supabase/functions/_shared/impulseZoneEngine.test.ts` — Added 3 new regression tests.
- `src/pages/BotView.tsx` — Moved ImpulseZonePanel from bottom to top in both ScanSignalDetail and ScanDetailInline components (committed directly to main).
- `src/components/ImpulseZonePanel.tsx` — Added direction detail badges (bias/4H/1H) when no zone and direction detail available. Removed `truncate` class from reason text (committed directly to main).
- `supabase/functions/bot-scanner/index.ts` — Added `directionDetail` and `directionReason` fields to impulse zone fallback data when direction is null (committed directly to main).

## bot-scanner/index.ts changes (caution file — detailed explanation)
**What changed:** One addition to the impulse zone fallback path (line ~3547). When `analysis.direction` is null and the impulse zone engine is skipped, the fallback data now includes `directionReason` (the text reason from the direction engine) and `directionDetail` (an object with `bias`, `biasSource`, `h4Retrace`, `h4ChochAgainst`, `h1Confirmed` fields extracted from `analysis.simpleDirection`). These are display-only fields consumed by the frontend ImpulseZonePanel — they do not affect any gate logic, scoring, or trade decisions.

## Tests added
1. `findImpulseLeg — accepts impulse with deep internal pullbacks (wave structure)` — Creates a bearish impulse with 70% wave-2 retrace. Asserts the impulse IS found (would have failed before the fix).
2. `findImpulseLeg — rejects impulse when origin is broken` — Creates a bullish impulse where price later crashes below the origin. Asserts the impulse is NOT found (or found as a smaller sub-leg).
3. `findImpulseLeg — ETH-like bearish impulse with wave structure is found` — Simulates the exact ETH/USD scenario (2337→2299 with 59% internal pullback to 2330). Asserts the impulse IS found.

## Tests run
```
ok | 37 passed | 0 failed (33ms)
```
All 34 existing tests + 3 new tests pass.

## Regression check
- All 34 pre-existing tests pass unchanged, confirming no regression in: valid impulse detection, POI mapping, Fib overlay scoring, S/R confirmation, LTF refinement, zone ranking, and full pipeline integration.
- The old test "rejects impulse with >50% pullback" still passes because it was written defensively (accepts null OR valid sub-leg).
- The new origin-not-broken validation is strictly more permissive than the old 50% rule — it accepts everything the old rule accepted, plus impulses with deep internal pullbacks that have intact origins.

## Open questions
- The impulse zone engine changes need a **bot-scanner redeploy** to take effect. The frontend changes (panel position, direction badges, truncation fix) are already on main and will be picked up by Lovable automatically.

## Suggested PR title and description
**Title:** fix: replace 50% internal pullback kill switch with origin-not-broken validation in impulse zone engine

**Description:**
The `checkNoPullbackExceeds50()` function incorrectly rejected valid impulsive waves that have normal wave 2/4 corrections. For example, ETH/USD's bearish impulse from 2337→2299 had an internal pullback to 2330 (59% of the first leg), causing the engine to report "No valid bearish impulse leg found" despite a clear OB at the origin.

**Fix:** Replaced the 50% internal pullback rule with origin-not-broken validation. An impulse is now valid as long as price hasn't closed past the swing origin that started the move. This aligns with ICT/SMC impulsive wave theory where internal corrections (waves 2 and 4) are expected and do not invalidate the impulse.

Also includes (on main):
- Impulse Zone panel moved to top of detail breakdown
- Direction engine reason surfaced in panel when no zone
- Full reason text no longer truncated

Tests: 37/37 pass (3 new regression tests added).
