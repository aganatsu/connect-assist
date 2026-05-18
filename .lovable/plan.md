# Full Mobile-Compatible Rework

Goal: every page works beautifully on a 360–414px phone while polishing desktop density. Frontend only — no bot/backend logic changes.

## Foundation (shared)

- **Responsive tokens in `index.css`**: clamp-based type scale, tighter mobile spacing, larger min tap targets (44px) on touch devices.
- **`AppShell`**: keep mobile bottom tab bar + desktop icon rail. Add a slim mobile top bar (page title + status dot + quick actions) so users always see context.
- **Reusable primitives**:
  - `ResponsiveTable` — auto-switches a `<table>` to a stacked card list under `md`.
  - `BottomSheet` — wraps existing Dialog; slides from bottom on mobile, centers on desktop.
  - `SwipeTabs` — horizontal-scroll tab strip for mobile tabbed pages.
  - `StatChip` / `KPIGrid` — 2-col on mobile, 4-col on desktop.
- **Mobile More menu**: expand to include Game Plan + Fundamentals + Prop Firm (already there), and add quick "Run Scan" shortcut.
- **Global**: replace remaining `min-w` rigid grids, fix horizontal overflow, ensure all modals are `max-h-[90vh]` scrollable on mobile.

## Per-page work

### Dashboard (`Index.tsx`)
- KPI cards 2×2 on mobile (already partly there) — tighten spacing.
- Live Prices: 2-col compact card grid on mobile.
- Equity Curve: reduced height (200px), simplified axis ticks, range pills wrap.
- Currency Strength: keep vertical bar chart, shrink height.
- Active Positions: render as `MobilePositionCard` list on mobile (already exists, reuse).
- Activity Log: full-width below.

### Chart (`Chart.tsx`)
- Compact TradingView container at ~55vh.
- Toolbar (symbol, timeframe, indicators) collapses into a bottom sheet trigger.
- Side panels (SMC overlays, watchlist) become bottom sheets.

### Bot (`BotView.tsx`) — biggest file
- Convert top KPIs to swipeable horizontal card row.
- Tabs (Status / Config / Recommendations / Logs / Trades) → `SwipeTabs`.
- Long forms in `BotConfigModal` → full-screen sheet on mobile, sectioned with sticky save bar.
- Trade tables → card list via `ResponsiveTable`.

### ICT Analysis, Fundamentals, Game Plan
- Stack panels vertically on mobile, collapse heavy sub-sections behind accordions.
- `GamePlanPanel`, `ImpulseZonePanel`, `FOTSIStrengthMeter`: full-width cards, simpler legends.

### Journal
- Filter bar collapses to a bottom-sheet filter; trade list as cards (symbol, P&L, date, tap → detail sheet).

### Backtest
- Setup form full-width single column; run button sticky-bottom.
- Results: KPIs 2×2, equity chart compact, trades list as cards.

### Brokers
- Connection cards stack; `BrokerTradesTab` table → `ResponsiveTable`.
- `BrokerLog` virtualized list with smaller rows.

### Trade Replay
- Compact chart (50vh), playback controls fixed at bottom, details in a collapsible sheet, sidebar list as a drawer.

### Prop Firm
- KPI grid 2-col, rules/limits as accordions, equity meter full-width.

### Settings
- Sectioned accordions on mobile; each section full-width form with sticky save.

### Auth (Login / Signup / Reset)
- Already simple; verify safe-area padding, larger inputs, and proper viewport height on iOS Safari.

## Desktop polish (light)
- Slightly tighter padding scale, consistent card shadows, unified table density, fix a few `min-w` overflows that affect 1280px screens.

## Out of scope
- No PWA / install / service worker.
- No changes to edge functions, scanner, or bot logic.
- No new features — purely layout, density, and interaction polish.

## Technical notes
- Use Tailwind responsive prefixes (`md:`, `lg:`) — mobile-first.
- Reuse existing `useIsMobile()` hook for conditional render where CSS alone isn't enough (tables → cards, dialogs → sheets).
- All colors via semantic tokens (no hardcoded hex in components).
- Shadcn `Sheet` component for bottom sheets; `Accordion` for collapsibles.
- Validate visually at 360, 390, 414, 768, 1280, 1536px.

## Rollout order
1. Foundation primitives + AppShell top bar.
2. Dashboard, Auth (quick wins).
3. Bot + BotConfigModal (highest complexity).
4. Chart + Trade Replay (chart-heavy).
5. Journal, Backtest, Brokers (table-heavy).
6. ICT, Fundamentals, Game Plan, Prop Firm, Settings.
7. Desktop density pass + cross-viewport QA.
