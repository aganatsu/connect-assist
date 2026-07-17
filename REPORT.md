# Task: Fix Equity Curve Chart
## Branch: manus/fix-equity-curve-chart
## Behavior changes
1. **Y-axis scaling**: Equity curve chart now auto-scales to the actual data range (±0.5% padding) instead of starting from $0. For an account at ~$110k, the Y-axis now shows $99k–$111k instead of $0–$120k.
2. **Y-axis labels**: Show 0 decimal places ($99k, $110k) instead of 1 decimal ($99.0k, $110.0k).
3. **Starting balance**: Dashboard header now shows profit/loss relative to the actual starting balance (derived from balance minus total closed PnL) instead of hardcoded $10,000.
4. **ReferenceLine**: The horizontal reference line on the equity chart now marks the actual starting balance instead of hardcoded $10,000.
5. **Tooltip formatting**: Shows $110,751 (toLocaleString, 0 decimals) instead of raw float with many decimals.
6. **formatMoney utility**: Values >= $1,000 now display with 0 decimal places ($110,751 instead of $110,751.10). Values < $1,000 still show 2 decimals.

## Files modified
- `src/pages/Index.tsx` — Added startingBalance useMemo, fixed YAxis domain/tickFormatter, fixed Tooltip formatter, fixed ReferenceLine y value
- `src/pages/Journal.tsx` — Fixed equity curve YAxis domain/tickFormatter and Tooltip formatter; fixed daily P&L YAxis tickFormatter and Tooltip
- `src/pages/Backtest.tsx` — Fixed backtest equity YAxis domain/tickFormatter and Tooltip formatter
- `src/lib/marketData.ts` — formatMoney now uses 0 decimals for values >= $1,000

## Tests added
No new test files added (the existing 8 tests in the repo all pass). The changes are purely frontend formatting — the equity curve data shape from the backend is unchanged.

## Tests run
```
pnpm exec vitest run
✓ src/components/ImpulseZonePanel.test.tsx (5 tests) 81ms
✓ src/components/ChartContextPanel.test.tsx (3 tests) 139ms
Test Files  2 passed (2)
Tests  8 passed (8)
```

TypeScript compilation: `tsc --noEmit` — 0 errors.

## Regression check
- The equity curve data from the backend (`paper-trading` status endpoint) is NOT modified — same shape, same values.
- The only changes are frontend rendering: Y-axis domain, tick formatting, tooltip formatting, and the starting balance derivation (which is a pure calculation from existing data: `balance - sum(tradeHistory.pnl)`).
- The `formatMoney` change only affects display — no logic depends on its output.

## Open questions
1. The `paper_accounts` table has no `initial_balance` column. The starting balance is derived client-side as `balance - totalClosedPnl`. If the user ever manually adjusted their balance via `set_balance`, this derivation would be off. Consider adding an `initial_balance` column to the DB if accuracy matters long-term.
2. The time range filter works correctly but relies on the full `equityCurve` array being returned from the backend (all trades, not paginated). With 50 trades this is fine, but at 1000+ trades it may need server-side filtering.

## Suggested PR title and description
**Title:** Fix equity curve chart: Y-axis scaling, decimals, starting balance

**Description:**
Fixes the equity curve chart being unreadable when account balance is large (~$110k):
- Y-axis now auto-scales to the data range instead of starting from $0
- Removed excessive decimals from Y-axis labels and tooltips
- Starting balance derived from actual trade history instead of hardcoded $10,000
- Applied same fixes to Journal and Backtest equity charts
- `formatMoney` utility updated to show 0 decimals for values >= $1,000
