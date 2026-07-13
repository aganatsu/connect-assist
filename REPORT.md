# Task: Mobile UX V2 — Scan Panel Visibility, Trade Details, Scroll Fix

## Branch: manus/mobile-ux-v2

## Behavior changes

1. **Scan panel now defaults to expanded on mobile** — previously it defaulted to collapsed on mobile (only expanded on desktop). Users will now see scan results immediately without needing to tap the toggle.
2. **Scan panel header is fully tappable on mobile** — the entire header row acts as a toggle button (not just the small eye icon). This makes it much easier to expand/collapse on touch devices.
3. **Scan panel no longer hides when scrolling** — the outer BotView container now has `overflow-y-auto` on mobile, allowing the user to scroll down to the scan panel. Previously the positions panel had `min-h-[300px]` which pushed the scan panel below the viewport with no way to scroll to it.
4. **Expanded trade cards now show a "View Full Details" button** — tapping it opens a bottom Sheet with the full signal breakdown (entry confirmation story, signal source badge, zone info, factor breakdown via SignalReasoningCard, trade metrics, and management status).

## Files modified

| File | Description |
|------|-------------|
| `src/pages/BotView.tsx` | Added `overflow-y-auto` on mobile to outer container; removed `min-h-[300px]` on mobile; defaulted scan panel to expanded; made scan header row fully tappable on mobile with larger icons; fixed missing `</button>` closing tag |
| `src/components/MobilePositionCard.tsx` | Complete rewrite: added "View Full Details" button that opens a bottom Sheet with entry confirmation story, signal source badges (UNIFIED/CASCADE/STANDALONE), zone info, SignalReasoningCard factor breakdown, trade metrics grid, and management status indicators |

## Tests added

No new deno tests added — these are purely frontend/UI changes that don't affect any Supabase edge function logic. The changes are CSS class modifications and React component rendering only.

## Tests run

```
Before (main, no changes): 1490 passed | 48 failed (11s)
After (our changes):       1491 passed | 47 failed (13s)
```

The 47-49 failures are pre-existing and unrelated to our changes (they come from `styleTuningPort.test.ts`, `gate6Heat.test.ts`, `livePriceStatus.test.ts`, `reset.test.ts`, and `propFirmStatusBrokerEquity.test.ts` — all backend test files with uncaught errors or environment-dependent assertions).

ESBuild compilation verification:
- `src/pages/BotView.tsx` — compiles cleanly (167.2kb bundle, 0 errors)
- `src/components/MobilePositionCard.tsx` — compiles cleanly (27.3kb bundle, 0 errors)

## Regression check

1. **No backend code modified** — all changes are in `src/pages/` and `src/components/` (React frontend only)
2. **No scoring, gate, or trade logic touched** — changes are purely visual/layout
3. **Desktop behavior preserved** — all mobile-specific changes use `isMobile` guards or responsive classes (`md:` prefixes). Desktop layout is unchanged.
4. **ESBuild confirms no syntax errors** in both modified files

## Open questions

1. The scan panel `max-h-64` constraint on mobile (line 1135) limits the scan list to ~256px. Should this be increased now that the panel is more accessible?
2. Should the "View Full Details" sheet also include the SL/TP editor (EditSLTPInline) that exists on desktop's ExpandedPositionCard?

## Suggested PR title and description

**Title:** fix(mobile): scan panel visibility + trade detail sheet + scroll behavior

**Description:**
Fixes three reported mobile UX issues:

1. **Scan panel disappearing on scroll** — The positions panel had `min-h-[300px]` which pushed the scan panel below the viewport. Removed the mobile min-height and made the outer container scrollable (`overflow-y-auto`) so users can always reach the scan panel.

2. **Scan arrows/toggle not visible/tappable** — Made the entire scan header row tappable on mobile (not just the tiny eye icon). Increased icon sizes for touch targets. Defaulted the panel to expanded so scan results are immediately visible.

3. **Expanded trades missing details** — Added a "View Full Details" button to MobilePositionCard that opens a bottom Sheet with the full signal breakdown: entry confirmation story, signal source badges, zone info, SignalReasoningCard factor breakdown, trade metrics, and management status.

No backend changes. No behavior changes to scoring, gates, or trade execution.
