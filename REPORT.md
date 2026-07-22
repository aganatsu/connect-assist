# Task: Expandable Trade Detail (Post-Mortem)
## Branch: manus/expandable-trade-detail
## Behavior changes
1. Trade history items in the paper-trading status API response now include a `postMortem` field (object or null) containing: outcome, holdDuration, whatWorked, whatFailed, lessonLearned, factorsPresent, factorsAbsent.
2. Expanded rows in both "Closed Today" and "History" tabs now display a Post-Mortem section (amber-bordered card) showing outcome badge, hold duration, what worked, what failed, and lesson learned.
3. Mobile trade cards now have a chevron indicator and expand on tap to show score, signal source badge, post-mortem, and metadata (size, order ID, SL, TP).

## Files modified
- `supabase/functions/paper-trading/index.ts` — Added fetch of `trade_post_mortems` table in status action; builds a lookup map by position_id and attaches postMortem object to each history item.
- `src/pages/BotView.tsx` — Added Post-Mortem display section to desktop expanded row (before Trade Metadata Grid); enhanced mobile cards with chevron, expandable detail including score/signal source/post-mortem/metadata.

## Tests added
None added (frontend-only display change + backend query addition; no logic to unit-test beyond what generatePostMortem already covers).

## Tests run
TypeScript check: `npx tsc --noEmit` → Exit code 0, zero errors.

## Regression check
- The `histArr` mapping is strictly additive — existing fields are unchanged, only `postMortem` is appended.
- If `trade_post_mortems` table is empty or the query fails, `pmByPosId` is empty and all trades get `postMortem: null` — no visual change from before.
- Desktop expanded row: Post-Mortem section is conditionally rendered only when `t.postMortem` is truthy, so existing rows without post-mortem data render identically to before.
- Mobile cards: the only structural change is wrapping the P&L + chevron in a flex div and adding the expandable section below — collapsed state looks the same.

## Open questions
- The paper-trading status endpoint now makes an additional Supabase query (`trade_post_mortems`). This adds ~50-100ms latency. If this is a concern, we could lazy-load post-mortems client-side instead.
- Older trades that were closed before `generatePostMortem` was added will show `postMortem: null` — no section displayed. This is expected behavior.

## Suggested PR title and description
**Title:** feat: add post-mortem data to expandable trade detail rows

**Description:**
Adds post-mortem analysis (what worked, what failed, lesson learned) to the expandable trade detail rows in both "Closed Today" and "History" tabs.

**Backend:** paper-trading status now fetches `trade_post_mortems` and attaches the data to each history item.

**Frontend:** Amber-bordered Post-Mortem card renders in expanded rows showing outcome badge, hold duration, and the three insight fields. Mobile cards also get full expandable detail with chevron indicator.

Both tabs use the same `TradeHistoryTable` component so the change applies uniformly.
