

# Scan Master-Detail: 60/40 Layout

## What changes

Replace the bottom "Live Log" strip (lines 360-372) and the right-sidebar "Latest Scan" card (lines 346-356) with a new 60/40 split panel at the bottom of the page.

## Layout

```text
┌──────────────────────────────────────────────────────────────┐
│  Control Bar + Order Form (unchanged)                        │
├────────────────────────────────────┬─────────────────────────┤
│  Positions / History Tabs          │ Account / Exposure /    │
│  (unchanged)                       │ Performance / Engine    │
│                                    │ (unchanged, minus the   │
│                                    │  "Latest Scan" card)    │
├─────────────────────────┬──────────┴─────────────────────────┤
│  LATEST SCAN (60%)      │  DETAIL BREAKDOWN (40%)            │
│                         │                                    │
│  EUR/USD  ▲ long  7.2  PLACED  ← │  Factors (6/9)          │
│  GBP/USD  ▼ short 4.1  SKIP      │  ✓ Market Structure     │
│  USD/JPY  — 2.0  REJECTED        │  ✗ Volume Confirm       │
│  AUD/USD  ▲ long  5.5  SKIP      │  Risk Gates             │
│                                   │  ✓ Max DD ok            │
│  (click a row to see detail →)    │  Rejection Reasons      │
│                                   │  ⚠ Spread too wide      │
└─────────────────────────┴─────────────────────────────────────┘
```

## Implementation (single file: `src/pages/BotView.tsx`)

1. **Add state**: `selectedPairIdx` (number, default `0`) to track which pair row is selected in the scan list.

2. **Remove "Latest Scan" card** from the right sidebar (lines 346-356).

3. **Replace bottom "Live Log" div** (lines 360-372) with the 60/40 master-detail panel:
   - **Left panel (60%)**: List all pairs from `logs[0].details_json`. Each row shows: direction icon, pair name, confluence score, status badge (PLACED/SKIP/REJECTED). Clicking a row sets `selectedPairIdx`. Selected row highlighted with `bg-primary/10 border-l-2 border-primary`.
   - **Right panel (40%)**: Shows the full `ScanSignalDetail` content (factors, gates, rejection reasons, summary) for the selected pair — rendered inline (always expanded), not as a collapsible.

4. **Add scan timestamp header** above the left panel showing when the latest scan occurred (e.g., "Latest Scan — 07:00:15 PM") and how many pairs were scanned.

5. **Empty state**: If no scan data exists, show a centered message: "No scans yet — click Scan Now".

