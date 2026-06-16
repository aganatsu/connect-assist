# Task: Zone Story Style Fix + Telegram Confirmation + FVG Label

## Branch: manus/zone-story-style-fix

## Behavior changes

1. **New field in scan_logs details_json**: The `__meta` object now includes an `activeStyle` field (one of `"scalper"`, `"day_trader"`, `"swing_trader"`) recording which trading style was active during that scan cycle. Purely additive — no existing fields modified.

2. **Style badge on BotView toolbar now reflects the LAST SCAN's style** (not just the current config). Shows a ⟳ indicator when the config has changed since the last scan.

3. **Style badge in scan panel header**: A small style badge now appears next to the scan timestamp.

4. **Telegram "LIVE Trade Opened" notification** now includes an "Entry Confirmation" section showing the confirmation type (e.g., "ltf choch ✓"), detail (e.g., "LTF CHoCH (bearish) @ index 290"), and score bonus. Previously this was only visible in the dashboard Zone Story panel.

5. **Telegram "Zone Setup ACTIVE" notification** now shows the actual confirmation state from the unified zone engine instead of the generic "Waiting for 5m CHoCH at zone" when confirmation data is available at scan time.

6. **Tier 1 factor display** now shows "Fair Value Gap (Entry TF)" instead of "Fair Value Gap" to clarify it checks the entry timeframe specifically (distinguishing from the Zone Story's LTF FVG refinement badge).

Note: All changes are display/notification-only. No gate logic, scoring, trade sizing, or entry/exit behavior is altered.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added `activeStyle` to `__meta` (line 6735). Added entry confirmation details to "Trade Opened" and "Zone Setup ACTIVE" telegram notifications. |
| `src/pages/BotView.tsx` | Updated toolbar style badge to prefer `latestMeta.activeStyle` over config, with mismatch detection. Added style badge in scan panel header. |
| `src/components/TierFactorBreakdown.tsx` | Added `displayName()` mapping to rename "Fair Value Gap" → "Fair Value Gap (Entry TF)" in UI display only. |
| `supabase/functions/_shared/scanMetaActiveStyle.test.ts` | New test file (9 tests) verifying __meta structure and frontend style resolution logic. |

## Extra caution note (bot-scanner/index.ts)

**What changed:** Two telegram notification message strings were modified:
1. "Trade Opened" (line ~6072): Appended an optional `Entry Confirmation` section that renders when `unifiedZoneData?.confirmation` is non-null. Falls through to empty string when null.
2. "Zone Setup ACTIVE" (line ~5964): The `<b>Confirmation:</b>` line now shows the actual confirmation state when available, with fallback to the original "Waiting for 5m CHoCH at zone" text.

**Why this is safe:** Both changes are string concatenation in telegram message construction. They use optional chaining (`?.`) with fallback to empty string or the original text. No control flow, no trade logic, no gate evaluation is affected. The data source (`unifiedZoneData.confirmation`) is already computed and stored in `detail` earlier in the same loop iteration.

## Tests added

| Test | Assertion |
|------|-----------|
| `__meta includes activeStyle field for day_trader` | Meta object contains `activeStyle: "day_trader"` |
| `__meta includes activeStyle field for scalper` | Meta object contains `activeStyle: "scalper"` |
| `__meta includes activeStyle field for swing_trader` | Meta object contains `activeStyle: "swing_trader"` |
| `frontend resolves style from scan when available` | When scan says "scalper" but config says "day_trader", display shows "scalper" with mismatch=true |
| `frontend falls back to config when scan has no activeStyle` | Legacy scans (no activeStyle) fall back to config style |
| `frontend shows no mismatch when scan and config agree` | Same style in both → mismatch=false |
| `frontend shows mismatch when config changed after scan` | Config changed to swing_trader but scan was day_trader → mismatch=true |
| `frontend handles null activeStyle gracefully` | null activeStyle → falls back to config, no mismatch |
| `resolvedStyle defaults to day_trader when config.tradingStyle.mode is undefined` | Mirrors bot-scanner fallback logic |

## Tests run

```
$ deno test --no-check supabase/functions/_shared/scanMetaActiveStyle.test.ts
running 9 tests from ./supabase/functions/_shared/scanMetaActiveStyle.test.ts
ok | 9 passed | 0 failed (48ms)

$ deno test --no-check supabase/functions/_shared/
FAILED | 1165 passed | 21 failed (11s)
# Note: 21 failures are PRE-EXISTING on main (verified by running tests on main branch).
# No regressions introduced by this change.
```

## Regression check

- Verified that the 21 test failures exist identically on `main` branch.
- The `activeStyle` field is purely additive to the `__meta` object — no existing fields are modified.
- The telegram notification changes are purely additive — existing message content is unchanged, new sections are appended.
- The `displayName()` mapping only affects UI rendering; the underlying factor key `"Fair Value Gap"` is unchanged for all logic lookups.
- `deno check` reports 60 type errors — all pre-existing, none from our changes (verified by grepping for our line numbers in the error output).

## Open questions

1. **Per-connection scanning**: The scanner runs ONE scan per user per cycle using the global config. If the user has two broker connections with different styles, only the global style is used. This fix makes the behavior transparent but doesn't add per-connection scanning.

2. **Rescan prompt**: When a mismatch is detected, the badge shows ⟳. Should we add an automatic rescan trigger when style changes?

## Suggested PR title and description

**Title:** fix: add entry confirmation to telegram notifications + clarify FVG label + style badge

**Description:**
Three UX improvements to the scan/notification system:

1. **Telegram notifications now show entry confirmation details** — "LIVE Trade Opened" and "Zone Setup ACTIVE" messages include the specific confirmation type (e.g., "ltf choch ✓ — LTF CHoCH (bearish) @ index 290") instead of generic text.

2. **Tier 1 FVG label clarified** — Renamed to "Fair Value Gap (Entry TF)" in the UI to distinguish from the Zone Story's LTF FVG refinement badge (which checks a different timeframe/context).

3. **Style badge shows actual scan style** — Badge reads from scan results rather than current config, with mismatch indicator when config changed since last scan.

No gate logic, scoring, or trade behavior changes. Pure display/notification improvements.
