# Task: Fix Zone Story Timeframe Labels
## Branch: manus/fix-zone-story-tf-labels
## Behavior changes
1. **Scalper style**: Zone Story now correctly shows "via 1H" / "via 15m" / "via 5m" instead of "via D" / "via 4H" / "via 1H". The trace line shows the correct timeframe unit (e.g., "12 1H bars" instead of "12 D bars").
2. **Swing trader style**: Zone Story now correctly shows "via W" / "via D" / "via 4H" instead of "via D" / "via 4H" / "via 1H".
3. **Day trader style**: No change — labels remain "D" / "4H" / "1H" (this is the default).
4. **TF Bonus scoring**: Now correctly awards +2.0 for the top slot, +1.0 for mid slot, regardless of style. Previously, a scalper's 1H zone (top slot) would get +0 because the engine checked `selectedTF === "D"` literally.
5. **A+/B+ setup labels**: Now derived from tfBonus value (>=2.0 = A+, >=1.0 = B+) instead of hardcoded TF string comparison.
6. **Story summary reason strings**: Now use the correct style-aware TF names in the reason text (e.g., "1H zone selected (A+ setup)" for scalper instead of "Daily zone selected (A+ setup)").

## Files modified
- `supabase/functions/_shared/impulseZoneEngine.ts` — Added TFSlotLabels interface, DEFAULT_TF_LABELS constant, optional tfLabels param to findBestEntryZoneMultiTF, all selectedTF assignments now use labels
- `supabase/functions/_shared/unifiedZoneEngine.ts` — Import TFSlotLabels, pass through to engine, fix tfBonus and candle selection to use labels instead of hardcoded strings
- `supabase/functions/bot-scanner/index.ts` — Import TFSlotLabels, define zoneTFLabels per trading style, pass to findUnifiedZone
- `src/components/ZoneStoryPanel.tsx` — Widen selectedTF type to string, fix summary to use tfBonus for A+/B+ label
- `src/components/UnifiedZonePanel.tsx` — Widen selectedTF type to string
- `src/components/ImpulseZonePanel.tsx` — Widen selectedTF type to string
- `src/components/SMCChart.tsx` — Widen selectedTF type to string

## Tests added
No new test files added (the existing 8 frontend tests all pass). The backend changes are backward-compatible (default labels = existing behavior), and the 63 pre-existing Deno type errors are unrelated to this change (same count before and after).

## Tests run
```
vitest run: 2 files, 8 tests passed (0 failed)
deno check impulseZoneEngine.ts: OK (0 errors)
deno check unifiedZoneEngine.ts: OK (0 errors)
deno check bot-scanner/index.ts: 63 pre-existing errors (none related to this change)
```

## Regression check
- Verified that without tfLabels param, findBestEntryZoneMultiTF defaults to `{ top: "D", mid: "4H", low: "1H" }` — identical to previous hardcoded behavior.
- Day trader style explicitly passes `{ top: "D", mid: "4H", low: "1H" }` — no change in output.
- The 63 deno check errors are identical before and after the change (stash/pop verified).
- Frontend vitest tests pass unchanged (fixture data uses "1H" which is still a valid string).

## Open questions
1. **Deployment**: The bot-scanner edge function needs to be redeployed for this fix to take effect in production. The frontend will auto-deploy via Lovable once merged to main.
2. **Cascade engine**: `cascadeZoneEngine.ts` (line 572) also interpolates `multiTFResult.selectedTF` in a reason string — this will automatically show the correct label since it reads from the same engine output. No code change needed there.

## Suggested PR title and description
**Title:** fix: use style-aware timeframe labels in zone story engine

**Description:**
The zone engine hardcoded "D"/"4H"/"1H" labels regardless of trading style. For scalper (which remaps slots to 1H/15m/5m), this caused:
- Zone Story showing "via D" when the actual timeframe was 1H
- "12 D bars" trace when it was actually 12 hourly bars
- TF bonus of +0 for what should be the top-slot zone (+2.0)
- "Daily zone selected (A+ setup)" when it was really a 1H zone

This PR adds a `TFSlotLabels` interface that maps engine slots to actual timeframe names per style, and passes it through the full pipeline (impulseZoneEngine -> unifiedZoneEngine -> bot-scanner -> frontend).

Backward compatible: day_trader behavior is unchanged. No new dependencies.
