# Task: Config UI Zone/Confirmation Audit & Fix
## Branch: manus/config-ui-zone-clarity
## Behavior changes
none — pure UI/label changes. No gate logic, scoring, or trade behavior is altered. The `impulseZoneGateMode` selector writes to the same `strategy.impulseZoneGateMode` field that configMapper already reads — users just couldn't change it from the UI before (it was always "hard" by default).

## Files modified
- `src/components/BotConfigModal.tsx` — Fixed misleading descriptions, added impulseZoneGateMode selector, renamed "Enable Zone Setups" to "Pending Zone Orders", added entry flow diagram, updated search index
- `supabase/functions/_shared/impulseZoneGateModeConfig.test.ts` — New test file for config resolution logic

## Changes explained (BotConfigModal.tsx — requires extra caution note)
This file is the UI config modal, not live execution code. Changes are purely cosmetic/descriptive:
1. **requireUnifiedZone description**: Changed "CHoCH" to "confirmation" and listed all valid types (CHoCH, BOS, sweep+CHoCH, displacement MSS)
2. **impulseZoneGateMode selector**: New dropdown with hard/soft/off options + BLOCKING/SCORING badge. Writes to `strategy.impulseZoneGateMode` which configMapper already reads.
3. **"Enable Zone Setups" → "Pending Zone Orders"**: Renamed to avoid confusion (it doesn't enable/disable zones, it enables pending orders)
4. **Entry flow diagram**: Visual step-by-step showing how impulse zone gate → unified zone → entry method interact
5. **Market Fill description**: Changed "no CHoCH wait" to "without waiting for LTF confirmation" for accuracy
6. **Search index**: Updated label and added impulseZoneGateMode entry

## Tests added
- `impulseZoneGateModeConfig.test.ts`:
  - defaults to 'hard' when not set
  - reads from strategy when set
  - reads from raw when strategy not set
  - strategy takes priority over raw
  - accepts all valid values (hard/soft/off)
  - UI writes to strategy.impulseZoneGateMode which configMapper reads

## Tests run
```
running 6 tests from ./supabase/functions/_shared/impulseZoneGateModeConfig.test.ts
impulseZoneGateMode defaults to 'hard' when not set ... ok (33ms)
impulseZoneGateMode reads from strategy when set ... ok (0ms)
impulseZoneGateMode reads from raw when strategy not set ... ok (0ms)
impulseZoneGateMode strategy takes priority over raw ... ok (0ms)
impulseZoneGateMode accepts all valid values ... ok (0ms)
UI writes to strategy.impulseZoneGateMode which configMapper reads ... ok (0ms)
ok | 6 passed | 0 failed (42ms)
```

## Regression check
- No gate logic modified — configMapper already supported all three modes
- The UI selector writes to the exact same field the backend reads
- Default remains "hard" so existing users see zero behavior change

## Open questions
1. Should the `cascadeZoneMode` (prefer/only/off) also get a UI selector? Currently only swing traders use it and there's no way to change it from the UI.
2. Should `impulseZonePenalty` (the soft mode penalty amount, default 2.0) be exposed as a slider when soft mode is selected?

## Suggested PR title and description
**Title:** fix: clarify zone/confirmation config labels, add impulseZoneGateMode selector

**Description:**
- Fixed misleading "CHoCH" references in requireUnifiedZone description (accepts CHoCH, BOS, sweep+CHoCH, displacement MSS)
- Added impulseZoneGateMode dropdown (hard/soft/off) — previously hidden with no UI control
- Renamed "Enable Zone Setups" → "Pending Zone Orders" to clarify it enables pending orders, not zones
- Added visual entry decision flow diagram to the strategy section
- Updated Market Fill description for accuracy
- No behavior changes — pure UI/label fixes
