# Task: Fix NaN Entry Price on Market Orders
## Branch: manus/fix-nan-entry-price
## Behavior changes
1. Market orders placed via the impulse zone hard gate now correctly use `bestZone.high` and `bestZone.low` (the actual property names) instead of the non-existent `bestZone.zoneHigh` / `bestZone.zoneLow`. Previously, all market orders with izGateMode="hard" had `entry_price: "NaN"` in the DB because `undefined + undefined = NaN`.
2. Staged zone-watch setups now also use the correct property names for `entry_price` and `analysis_snapshot`.
3. A NaN guard ensures that even if future changes introduce invalid zone data, the entry price will fall back to `analysis.lastPrice` rather than storing NaN.

## Files modified
- `supabase/functions/bot-scanner/index.ts` — Fixed `.zoneHigh`/`.zoneLow` → `.high`/`.low` in 4 locations (market order entry, staging insert, staging update, analysis snapshot). Added NaN guard on `marketEntryPrice`.
- `supabase/functions/bot-scanner/nanEntryPrice.test.ts` — New test file (4 tests).

### Extra caution note: bot-scanner/index.ts

The change modifies the `marketEntryPrice` calculation at line 4298-4306 and the staging insert/update paths at lines 3701, 3714, 3718, 3725. The fix corrects property names that were always wrong (`.zoneHigh`/`.zoneLow` never existed on the bestZone object — they were always `undefined`). The NaN guard is a safety fallback that only activates for invalid values.

## Tests added
- `marketEntryPrice: uses .high/.low from bestZone (not .zoneHigh/.zoneLow)` — Confirms the midpoint calculation works with correct property names
- `marketEntryPrice: OLD bug with .zoneHigh/.zoneLow would produce NaN` — Proves the old code path produced NaN (regression guard)
- `marketEntryPrice: NaN guard falls back to lastPrice` — Confirms the safety fallback works when zone data is invalid
- `marketEntryPrice: uses refinedEntry when available` — Confirms refinedEntry takes priority when present

## Tests run
```
With our changes:    488 passed | 15 failed (all pre-existing)
Without our changes: 487 passed | 16 failed (all pre-existing)
Net: +1 passing test improvement
```

## Regression check
- The property name fix is a pure bug fix — `.zoneHigh`/`.zoneLow` never existed on the bestZone object, so the old code always produced NaN for the midpoint path. The new code produces the correct midpoint. No valid behavior is changed.
- The NaN guard is a safety net that only activates when the computed value is invalid — it cannot change behavior for valid inputs.
- Confirmed by running full test suite with and without changes.

## Open questions
- The 3 existing open positions in the DB still have `entry_price: "NaN"`. You may want to manually update them with the correct entry prices (zone midpoints at open time). I can provide the SQL if needed.

## Suggested PR title and description
**Title:** fix: NaN entry price on market orders (wrong bestZone property names)

**Description:**
Market orders placed via the impulse zone hard gate used `izData.bestZone.zoneHigh` / `.zoneLow` — properties that don't exist on the bestZone object (which has `.high` / `.low`). This caused `undefined + undefined = NaN`, storing "NaN" as the entry_price in paper_positions.

Fixed all 4 references to use the correct property names. Added a NaN guard as a safety net. Staging inserts/updates had the same bug and are also fixed.
