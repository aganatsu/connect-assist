# Task: Session 4 — Journal Auto-Tagging + Dashboard Pipeline + Fundamentals Interpretation
## Branch: manus/journal-dashboard-fundamentals
## Behavior changes
1. **Journal page** now auto-extracts tags from `reasoning_json` (setup type, session, regime, key factors, confirmation method) and displays them as colored chips. Users can filter trades by clicking tags.
2. **Dashboard** now shows a "Scanner Pipeline" card aggregating 24h scan funnel: pairs scanned → signals found → gate rejected → below threshold → staged → zone setups → trades placed, with signal rate, conversion rate, and net conversion percentage.
3. **Fundamentals page** now fetches the `news_impact` action from the fundamentals edge function and displays: (a) a Currency Bias Summary card showing net bullish/bearish direction per currency, (b) directional impact badges inline on each event, (c) expandable interpretation with reasoning, category, confidence, and a plain-English trading implication.
4. **api.ts** — added `fundamentalsApi.newsImpact(pair?)` method.

## Files modified
- `src/pages/Journal.tsx` — Full rewrite: auto-tagging from reasoning_json, tag-based filtering, enhanced detail panel with factor breakdown
- `src/pages/Index.tsx` — Added pipelineMetrics useMemo and Scanner Pipeline card
- `src/pages/Fundamentals.tsx` — Full rewrite: newsImpact query, currency bias summary, expandable event interpretation
- `src/lib/api.ts` — Added `newsImpact` to `fundamentalsApi`

## Tests added
None — these are frontend-only UI changes consuming existing API endpoints. No backend logic was modified.

## Tests run
```
npx tsc --noEmit → 0 errors
```

## Regression check
- No backend code was modified (no edge functions changed).
- The `fundamentals` edge function's `news_impact` action already existed and is simply being consumed by the frontend for the first time.
- Dashboard pipeline metrics are derived purely from existing `scan_logs` data — no new writes or mutations.
- Journal auto-tagging reads from `reasoning_json` which is already stored on every trade — no schema changes.

## Open questions
- The `news_impact` endpoint requires the `fundamentals` edge function to be deployed. If it hasn't been deployed recently, the interpretation section will show empty (gracefully handled).
- Should the Journal tags be persisted to a separate column for faster DB-level filtering, or is client-side filtering from reasoning_json sufficient for the current trade volume?

## Suggested PR title and description
**Title:** feat: Journal auto-tagging, Dashboard pipeline funnel, Fundamentals interpretation

**Description:**
Adds three major UI features:
- **Journal**: Auto-extracts tags (setup type, session, regime, factors, confirmation) from trade reasoning_json. Click any tag to filter. Enhanced detail panel.
- **Dashboard**: Scanner Pipeline card showing 24h funnel metrics with signal/conversion rates.
- **Fundamentals**: News impact interpretation with per-currency bias summary, inline directional badges, and expandable event analysis with trading implications.

No backend changes — all features consume existing API endpoints.
