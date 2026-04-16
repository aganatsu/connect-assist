

# Fix Two Issues: MT5 Mirroring + Position Table Stability

## Issue 1: MT5 mirror trades fail silently
The `mirrorToMT5` function in `paper-trading/index.ts` (line 84-85) uses `conn.account_id` and `conn.api_key` directly without the swapped-fields auto-detection that was added to `broker-connections`. Since your credentials are stored with the JWT in `account_id` and UUID in `api_key`, the mirror function sends the JWT as the MetaApi account ID in the URL — which fails.

**Fix**: Add the same swap-detection logic from `broker-connections/index.ts` into the `mirrorToMT5` helper:
- If `conn.account_id` starts with `eyJ` and `conn.api_key` matches a UUID pattern, swap them before making the API call.
- Also wrap the fetch in a try/catch for SSL certificate errors (same issue seen during testing).

**File**: `supabase/functions/paper-trading/index.ts` (lines 82-85)

## Issue 2: Open positions table keeps reordering on every price update
The `status` action fetches positions from the database without a sort order (line 230, 235). Each time prices update and positions are re-fetched, the database returns them in arbitrary order, causing the table rows to jump around.

**Fix**: Add `.order("open_time", { ascending: true })` to both position queries (lines 230 and 235) so rows stay in a consistent order.

**File**: `supabase/functions/paper-trading/index.ts` (lines 230, 235)

## Summary of Changes
1. **paper-trading/index.ts** — Add swapped-field detection in `mirrorToMT5` + SSL error handling
2. **paper-trading/index.ts** — Add `.order("open_time")` to position queries for stable table order
3. Redeploy the `paper-trading` edge function

