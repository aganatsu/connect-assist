# Task: pending-order-replace-stale
## Branch: manus/pending-order-replace-stale
## Behavior changes
1. When the scanner generates a new pending limit order for a symbol+direction that already has an active pending order, the OLD pending order is now cancelled (status="cancelled", cancel_reason="Superseded by new setup...") BEFORE the new one is inserted. Previously, the insert would fail with a unique constraint violation and the new (potentially better) setup was silently dropped.
2. The cancel_reason includes both old and new score + entry price for audit trail visibility.

## Files modified
- `supabase/functions/bot-scanner/index.ts` — Added "replace stale" logic before pending_orders INSERT (lines 5933-5948): queries for existing pending order with same (user_id, bot_id, symbol, direction, status=pending), cancels it with descriptive reason, then proceeds with insert.
- `supabase/functions/_shared/pendingOrderReplaceStale.test.ts` — New test file with 8 tests covering the replace-stale logic.
- `REPORT.md` — This file.

## Tests added
1. `replace stale: cancels existing pending order for same symbol+direction` — verifies the core behavior
2. `replace stale: does NOT cancel pending order for different direction` — safety check
3. `replace stale: does NOT cancel pending order for different symbol` — safety check
4. `replace stale: does NOT cancel already-cancelled or filled orders` — only targets status=pending
5. `replace stale: cancels multiple pending orders if somehow more than one exists` — edge case
6. `replace stale: no existing pending → nothing cancelled, insert proceeds` — happy path
7. `replace stale: does NOT cancel orders from different bot_id` — isolation check
8. `replace stale: cancel reason includes old and new score + entry for audit trail` — auditability

## Tests run
```
$ deno test --allow-all supabase/functions/_shared/pendingOrderReplaceStale.test.ts
running 8 tests
ok | 8 passed | 0 failed (13ms)
```

## Regression check
- The unique constraint `idx_pending_orders_unique_active` remains in place as a safety net
- The old error-handling path (lines 5966-5974) is preserved — if somehow the cancel+insert still hits a race condition, it logs the error gracefully
- No changes to how pending orders are filled, expired, or monitored — only the INSERT path is affected
- Gate 5 (same-direction duplicate check for OPEN positions) is untouched

## Open questions
- None. The fix is straightforward and self-contained.

## Suggested PR title and description
**Title:** fix: replace stale pending orders instead of failing on duplicate constraint

**Description:**
When the scanner finds a new setup for a symbol+direction that already has an active pending order, it now cancels the old one (with audit trail) before inserting the new one.

Previously, the unique constraint on `(user_id, bot_id, symbol, direction) WHERE status='pending'` caused the INSERT to fail silently, dropping the newer (potentially better) setup.

The cancel_reason preserves both old and new score + entry price for visibility in the Zone Setups panel.
