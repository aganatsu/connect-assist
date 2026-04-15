

# Fix Four System Gaps

## 1. Auto-import bot trades into Journal

**Problem:** Paper trades closed by the bot (stored in `paper_trade_history`) never appear in the `trades` journal table.

**Solution:** Add an "Import Bot Trades" button on the Journal page that fetches `paper_trade_history` records and inserts them into the `trades` table, skipping duplicates. We'll match on `position_id` to avoid double-imports.

- Add a new action in the `trades` edge function: `import_from_paper` — queries `paper_trade_history` for the user, checks which `position_id`s already exist in `trades`, and inserts the missing ones with mapped fields (symbol, direction, entry/exit price, pnl, etc.)
- Add an "Import Bot Trades" button next to "Add Trade" in the Journal UI that calls this new action
- Show a toast with count of imported trades

## 2. P&L Reporting / CSV Export

**Problem:** No way to export journal data or performance stats.

**Solution:** Add a "Download CSV" button on the Journal page (Performance tab) that exports filtered trades as a CSV file client-side. No edge function needed — we already have the trades data in memory.

- Generate CSV from `filteredTrades` array with columns: Date, Symbol, Direction, Setup, Entry, Exit, P&L, R:R, Risk%, Notes
- Trigger browser download via `Blob` + `URL.createObjectURL`
- Place button in the Journal header area next to filters

## 3. Theme-aware Recharts colors

**Problem:** Charts in Journal use hardcoded dark-mode HSL values for grid lines, axes, and tooltip backgrounds. They break in light mode.

**Solution:** Replace hardcoded HSL strings with CSS variable references using `useTheme()`.

- Create a small helper object `chartTheme(resolvedTheme)` that returns grid stroke, axis stroke, and tooltip background colors based on the current theme
- Apply to all four Recharts instances in Journal (equity curve, daily P&L) and any charts on other pages
- Light mode: lighter grids, dark text, white tooltip bg. Dark mode: current colors.

## 4. Dynamic StatusBar mode

**Problem:** StatusBar hardcodes "PAPER MODE" text.

**Solution:** Query the `paper_accounts` table via the existing `paperApi.status()` to read the actual `execution_mode` field.

- Import `useQuery` and `paperApi` in StatusBar
- Fetch `paper-status` (already cached by BotView with 5s refetch)
- Display `execution_mode === "live"` as "LIVE MODE" (red/destructive) or "PAPER MODE" (yellow/warning)
- Show open position count from the status data as well

## Files to modify
- `supabase/functions/trades/index.ts` — add `import_from_paper` action
- `src/pages/Journal.tsx` — import button, CSV export button, theme-aware chart colors
- `src/components/StatusBar.tsx` — dynamic mode from database

