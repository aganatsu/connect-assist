# Task: Fix UI Label Inconsistencies
## Branch: manus/fix-ui-label-inconsistencies
## Behavior changes
none — pure frontend display fix. No changes to trade logic, scoring, gates, or execution paths.

## Files modified
- `src/components/ZoneStoryPanel.tsx` — Fixed "Hunting CHoCH" badge showing on already-placed trades; added `waiting_for_sweep` state; changed hardcoded "CHoCH" text to generic "confirmation"
- `src/components/UnifiedZonePanel.tsx` — Added `waiting_for_sweep` to STATE_LABELS and STATE_COLORS
- `src/components/PendingOrdersPanel.tsx` — Changed hardcoded "CHoCH on 5m" text to generic "confirmation (CHoCH, displacement, or reversal)"
- `src/pages/BotView.tsx` — Added `waiting_for_sweep`, `paused`, `no_direction`, `zone_setup_rejected_orientation` to scan list badges; fixed `trade_placed_at_zone` missing from both mobile detail view components (ScanSignalDetail + ScanDetailInline)

## Tests added
- TypeScript compilation check (`tsc --noEmit --skipLibCheck`) — passes with zero errors
- No runtime tests added (frontend-only display changes; no logic to unit test)

## Tests run
```
$ ./node_modules/.bin/tsc --noEmit --skipLibCheck
(exit code 0, no output = no errors)
```

## Regression check
- All changes are additive (new entries in lookup maps, additional conditions on badge display)
- No existing status strings were removed or renamed
- The "Hunting CHoCH" badge now has additional guards (`!unifiedData.confirmation?.entryReady && unifiedData.state !== "triggered" && unifiedData.state !== "confirmed"`) — it will still show for legitimate hunting scenarios (price at zone, no confirmation yet, no trade placed)

## Deferred items
- **Issue #7** (backend scanDetails stale after pending order fill): Requires modifying `bot-scanner/index.ts` (live execution). Deferred to avoid risk for a cosmetic issue.
- **Issue #8** (confirmed_fill badge distinction): Requires new status string in backend. Deferred to a backend release.

## Open questions
- None — all frontend fixes are safe to merge independently.

## Suggested PR title and description
**Title:** fix: resolve stale/missing UI status labels across scanner views

**Description:**
Fixes 6 UI label inconsistencies in the scanner dashboard:
1. "Hunting CHoCH" badge no longer shows when a trade is already placed or confirmation has fired
2. `waiting_for_sweep` status now has proper labels instead of showing raw status string
3. `trade_placed_at_zone` now shows correctly in mobile detail views
4. Missing statuses (`paused`, `no_direction`, `zone_setup_rejected_orientation`) no longer show as raw uppercase strings
5. Hardcoded "CHoCH on 5m" text replaced with generic "confirmation" to reflect all available confirmation methods
6. All changes are frontend-only — zero risk to live trading logic
