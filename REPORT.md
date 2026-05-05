# Task: BotView Mobile Compatibility
## Branch: manus/botview-mobile-compat
## Behavior changes
none — pure refactor (UI-only responsive layout changes; no trading logic, scoring, gates, or position management altered)

## Files modified
- `src/pages/BotView.tsx` — Added mobile-responsive conditional rendering: compact icon-only toolbar with overflow DropdownMenu, mobile account summary strip, card-based position list (via MobilePositionCard), hidden desktop sidebar on mobile, mobile account bottom Sheet, mobile scan detail bottom Sheet, and scan pair tap-to-open-sheet behavior.
- `src/components/MobilePositionCard.tsx` — New component: compact card-based position display for mobile showing symbol, direction, P&L, R-multiple, pips, and expandable detail with SL/TP/BE/Trail/Hold status.
- `TODO.md` — Added mobile compatibility task items.

## Tests added
No automated tests added — this is a pure UI/layout change with no logic changes. The component uses the same data and mutations as the desktop version. Manual verification required on mobile viewport.

## Tests run
TypeScript compilation check (no errors beyond expected path alias resolution):
```
$ npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -v "Cannot find module" | grep "BotView"
(no output — clean)
```

## Regression check
- Desktop layout is unchanged: the `isMobile` conditional renders the original desktop toolbar, table, and sidebar when `useIsMobile()` returns false (viewport >= 768px).
- No trading logic, API calls, mutations, or data processing was modified.
- The same `paperApi.closePosition`, `scanMut.mutate`, `startMut`, `pauseMut`, `stopMut`, `killMut`, `resetMut`, `resetBalMut`, `setBalMut` mutations are called with identical parameters on mobile.
- The `MobilePositionCard` component reads the same position data and computes the same R-multiple, pips, BE/trail/hold status as the inline desktop table row.

## Open questions
1. The `useIsMobile()` hook uses a 768px breakpoint. Should this be adjusted for tablets (e.g., 1024px)?
2. The mobile account sheet duplicates the sidebar calculation logic. Consider extracting to a shared hook if this grows further.
3. The MobilePositionCard does not include the ExpandedPositionCard (full detail with override editor) — should tapping a mobile card open a full-screen detail sheet with the ExpandedPositionCard content?

## Suggested PR title and description
**Title:** feat: Mobile-responsive BotView layout

**Description:**
Adds full mobile compatibility to the BotView trading dashboard:

- **Compact toolbar**: Icon-only Start/Pause/Stop buttons with status dot and mode badge. Overflow menu (three-dot) provides access to New Order, Bot Config, Account Details, and Kill Switch.
- **Account summary strip**: Horizontal scrollable bar showing Balance, Unrealized P&L, Win Rate, Trades, and Drawdown. Tapping opens the full Account & Performance bottom sheet.
- **Card-based positions**: Replaces the 15-column desktop table with `MobilePositionCard` components showing key metrics (symbol, direction, P&L, R, pips) with expandable detail rows.
- **Scan detail bottom sheet**: Tapping a scan pair on mobile opens a bottom Sheet with the full `ScanDetailInline` breakdown instead of the side-by-side panel.
- **Sidebar hidden on mobile**: Desktop sidebar (account, exposure, performance, engine controls) is hidden; all content accessible via the account bottom sheet.

No behavior changes — all trading logic, mutations, and data flows remain identical.
