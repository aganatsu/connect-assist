# Task: Fix Misleading UI Status Indicators
## Branch: manus/fix-ui-status-indicators

## Behavior changes

1. **ImpulseZonePanel "⏳ Hunting 5m CHoCH" badge** — Previously showed on ANY view (including closed trade history) whenever the scan-time snapshot had `priceInsideZone` or `priceAtZoneStrict` set. Now only shows when the parent component passes `isLiveContext={true}`, which is only set for live scan results (ScanSignalDetail, ScanDetailInline). Trade history detail views no longer show this misleading badge.

2. **ChartContextPanel "⚡ PRICE AT ZONE" badge** — Previously showed whenever the scan data had `priceAtZone=true`, regardless of how old the scan was. Now gated behind a 2-minute freshness check. If the scan is older than 2 minutes, it shows "Was at zone (scan stale)" instead of the active-looking "⚡ PRICE AT ZONE" badge.

## Files modified

| File | Change |
|------|--------|
| `src/components/ImpulseZonePanel.tsx` | Added `isLiveContext?: boolean` prop (default `false`). "⏳ Hunting 5m CHoCH" badge now gated behind `isLiveContext && (priceInsideZone \|\| priceAtZoneStrict)`. |
| `src/pages/BotView.tsx` | Added `isLiveContext` prop to the two live-context usages of ImpulseZonePanel (ScanSignalDetail line 1671, ScanDetailInline line 1837). Trade history usage (line 1392) intentionally left without the prop. |
| `src/components/ChartContextPanel.tsx` | Added `isScanFresh` computed value (true if `scannedAt` < 2 min old). "⚡ PRICE AT ZONE" badge now only shows when fresh; shows "Was at zone (scan stale)" when stale. |
| `src/components/ImpulseZonePanel.test.tsx` | New test file — 5 tests verifying isLiveContext gating behavior. |
| `src/components/ChartContextPanel.test.tsx` | New test file — 3 tests verifying staleness gating behavior. |

## Tests added

| Test file | Test | Assertion |
|-----------|------|-----------|
| `ImpulseZonePanel.test.tsx` | does NOT show badge when isLiveContext omitted | `queryByText(/Hunting 5m CHoCH/)` returns null |
| `ImpulseZonePanel.test.tsx` | does NOT show badge when isLiveContext=false | Same assertion |
| `ImpulseZonePanel.test.tsx` | DOES show badge when isLiveContext=true AND at zone | `getByText(/Hunting 5m CHoCH/)` exists |
| `ImpulseZonePanel.test.tsx` | does NOT show badge when isLiveContext=true but NOT at zone | Returns null |
| `ImpulseZonePanel.test.tsx` | shows zone info regardless of isLiveContext | OB badge and Score always visible |
| `ChartContextPanel.test.tsx` | shows PRICE AT ZONE when scan fresh | Badge visible, no stale text |
| `ChartContextPanel.test.tsx` | shows stale text when scan > 2 min old | "scan stale" visible, no ⚡ badge |
| `ChartContextPanel.test.tsx` | no badge when price not at zone | Neither badge nor stale text shown |

## Tests run

```
# Vitest (frontend)
✓ src/components/ImpulseZonePanel.test.tsx (5 tests) 63ms
✓ src/components/ChartContextPanel.test.tsx (3 tests) 95ms
Test Files  2 passed (2)
Tests  8 passed (8)

# Deno (backend — full suite)
ok | 873 passed | 0 failed (13s)

# TypeScript compilation
0 errors
```

## Regression check

- The `isLiveContext` prop defaults to `false`, meaning all existing usages that don't pass it (trade history) get the safe/conservative behavior (no badge). Only explicitly opted-in live contexts show the badge.
- The ChartContextPanel staleness check is additive — it only gates the badge text, not any zone data display. Zone bounds, type, fib depth, and distance are always shown.
- All 873 deno tests pass unchanged. All 8 new vitest tests pass.
- No backend code was modified — this is a pure frontend display fix.

## Open questions

1. **WatchlistPanel "near gate" badge** — This was audited and found to be CORRECT (only shows for actively-watching setups fetched live with status filter). No fix needed.
2. **PendingOrdersPanel "HUNTING" badge** — Also CORRECT (gated behind `status === "awaiting_confirmation"`). No fix needed.
3. **Edge function redeployment** — The refined zone entry changes from `manus/refined-zone-entry` are merged to main but edge functions haven't been redeployed yet (refined_zone_low/high are NULL on recent orders). User needs to trigger redeploy via Lovable or push a commit to trigger auto-deploy.

## Suggested PR title and description

**Title:** fix(ui): prevent stale "Hunting 5m CHoCH" and "PRICE AT ZONE" badges on historical data

**Description:**
Fixes misleading UI status indicators that showed active-looking badges on closed/historical trades.

**Problem:** The "⏳ Hunting 5m CHoCH" badge in ImpulseZonePanel and "⚡ PRICE AT ZONE" in ChartContextPanel were based purely on price proximity data captured at scan time. When viewing a closed trade's detail, these badges gave the false impression that an active hunt was in progress.

**Fix:**
- Added `isLiveContext` prop to ImpulseZonePanel — badge only shows in live scan contexts
- Added 2-minute staleness check to ChartContextPanel — stale scans show muted "Was at zone (scan stale)" instead of the active ⚡ badge
- Trade history views intentionally excluded from live indicators

**Testing:** 8 new vitest tests + all 873 deno tests passing.
