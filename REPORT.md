# Task: Impulse Zone Dashboard Widget
## Branch: manus/impulse-zone-widget
## Behavior changes
none — pure frontend addition (renders data already present in scan detail)

## Files modified
| File | Description |
|------|-------------|
| `src/components/ImpulseZonePanel.tsx` | NEW — Self-contained widget component that renders impulse zone data from scan detail |
| `src/pages/BotView.tsx` | Added import for ImpulseZonePanel; inserted widget in both `ScanSignalDetail` (collapsed list view) and `ScanDetailInline` (expanded detail panel), positioned after Fib Levels and before Summary |
| `REPORT.md` | This file |

## Widget features
- **Zone status badge:** "AT ZONE" (green), "ZONE FOUND" (violet), "NO ZONE" (gray)
- **Timeframe indicators:** 1H ✓ / 4H ✓ badges showing which timeframes have zones
- **Zone details:** Type (OB/FVG), Fib level, total score (out of 6)
- **Price range:** Zone high/low + impulse leg range with directional arrow
- **Confirmation badges:** S/R ✓/✗, LTF ✓/✗ with type, refined entry/SL prices
- **Distance indicator:** Shows distance to zone when price is not yet at zone
- **Scoring impact:** Shows "+bonus", "−penalty", or "neutral" when scoring is enabled
- **No-zone reason:** Shows truncated reason text when no zone is found

## Design decisions
- Matches existing panel styling (8px uppercase headers, mono fonts, rounded borders with colored accents)
- Uses violet as the primary accent color (distinct from existing amber/cyan/emerald panels)
- Conditionally renders — only shows when `d.impulseZone` is present in the scan detail
- Component is fully self-contained with no external dependencies beyond React

## Tests added
No frontend tests added — this is a pure presentational component that conditionally renders based on data presence. The backend logic producing the data is covered by 32 tests in the impulse-zone-engine/4h branches.

## Tests run
```
$ deno test supabase/functions/_shared/ --allow-all --no-check
ok | 284 passed | 0 failed (7s)
```

## Regression check
- Widget only renders when `d.impulseZone` is truthy — existing scan details without this field are completely unaffected
- No changes to any backend logic or data flow
- Import is a named export, tree-shaken if unused

## Open questions
1. Should the widget also appear in the scan log left panel (the pair list), or only in the detail panel?
2. Want a toggle in bot config to show/hide this panel in the UI?

## Suggested PR title and description
**Title:** `feat(ui): Impulse zone visualization widget in scan detail panel`

**Description:**
Adds a new `ImpulseZonePanel` component to the scan detail view that displays:
- Zone detection status with timeframe badges (1H/4H)
- Zone type, Fib alignment, and confidence score
- S/R confirmation and LTF refinement indicators
- Scoring impact (penalty/bonus/neutral)

Renders in both the collapsed signal list and expanded detail panel. Only shows when `detail.impulseZone` data is present (requires backend branches `impulse-zone-4h` and `impulse-zone-gate` to be merged first).

**Merge order:** Merge `manus/impulse-zone-4h` → `manus/impulse-zone-gate` → then this branch.
