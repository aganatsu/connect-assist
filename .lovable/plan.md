## What's wrong

Two related issues on the Bot page at 390px:

1. **Bleeding to the side** — three rows are wider than the viewport and force horizontal scroll:
   - **Tabs strip** (`Open / Closed Today / All History / Close Audit / Broker Log / AI Advisor / MT4-MT5 Live / Watchlist / Pending Orders / Game Plan`) — 10 tabs in one row with `overflow-x-auto`.
   - **Scan panel header** (bottom band) — "Latest Scan · 01:35:16 PM · ‹older / newer› · Scanning · New York · 10/10 pairs · Gate: ≥55% · TWELVE" all on one nowrap flex row with no shrink/wrap.
   - **Account KPI strip** (Balance / Unrealized / WR / Trades / DD) — already has `overflow-x-auto` which advertises itself as scrollable even when it shouldn't.

2. **"Whole workspace moves weirdly"** — because the inner content above is wider than the viewport, `<main>` in `AppShell` (which is `overflow-auto`) ends up scrolling horizontally too. The sticky top bar stays put while the entire content area pans left/right, which feels like the whole app is sliding.

## Fix

**Frontend / layout only. No bot logic touched.**

### 1. Lock the mobile shell to vertical scroll only
`src/components/AppShell.tsx` — change the mobile `<main>` to `overflow-y-auto overflow-x-hidden` so nothing can ever pan the page sideways. Desktop stays as-is.

### 2. Bot tabs strip (`src/pages/BotView.tsx`)
On mobile, replace the 10-tab horizontal `TabsList` with a compact picker:
- Show the active tab as a full-width `Select` (or button that opens a bottom sheet) listing all 10 tabs.
- Keep the existing `TabsList` for `md:` and up.

This eliminates the horizontal tab strip entirely on phones.

### 3. Scan panel header (`src/pages/BotView.tsx` ~line 1047)
On mobile, restructure the header so nothing exceeds viewport width:
- Stack into two rows: row 1 = eye toggle + "Latest Scan · time"; row 2 = older / newer / latest buttons + `SessionStatusPill` + `Gate` badge + pair counts.
- Add `flex-wrap` + `min-w-0` on both groups and `truncate` on long text (e.g. `Scanning · New York · 10/10 pairs` shortens to a smaller pill on mobile).
- Hide the verbose `pairs · signals · trades` summary on mobile (keep just `N pairs`).

### 4. Account KPI strip (`src/pages/BotView.tsx` ~line 617)
Remove `overflow-x-auto`; the 5 chips already fit at 360px with `flex-1`. This stops the strip from feeling draggable.

### 5. Sweep for other `min-w-[Npx]` offenders inside mobile branches
Quick audit of `BotView.tsx`:
- `min-w-[800px]` open-positions table — already gated behind `!isMobile`, fine.
- `min-w-[700px]` table at line 1341 — wrap its parent in `overflow-x-auto` (already there) but also confirm the parent has `max-w-full`. If on mobile we render this table, swap for a card list; if it's desktop-only, leave it.

I'll verify each remaining overflow path with `rg "min-w-\["` and patch any that render on mobile.

## Files to edit

- `src/components/AppShell.tsx` — mobile `<main>` overflow rules.
- `src/pages/BotView.tsx` — mobile tabs picker, scan header restructure, KPI strip overflow removal, any leftover min-w fixes.

## Out of scope

- No bot/scanner/edge-function changes.
- No desktop layout changes beyond what's needed to keep desktop working.
- No new pages or features.

## Verify

Open `/bot` at 360 / 390 / 414px and confirm:
- No horizontal scroll anywhere.
- Tabs reachable via the compact picker.
- Scan footer wraps cleanly.
- Swiping left/right does nothing at the page level (only the tabbed content area scrolls vertically).
