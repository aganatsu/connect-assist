-- Migration: Flag and close paper positions opened with look-ahead bias
--
-- Before the market-order look-ahead fix (commit 9b4e024, 2026-05-22), the bot
-- used zone refinedEntry as the market order fill price instead of analysis.lastPrice.
-- This inflated paper P&L by recording fills at prices that hadn't been reached yet.
--
-- This migration identifies affected positions and closes them with a special
-- close_reason so they don't contaminate ongoing paper trading metrics.
--
-- Detection criteria for look-ahead positions:
--   1. position_status = 'open' (still active)
--   2. entry_price != current_price at open time (market orders should fill at current price)
--   3. signal_reason contains impulseZone data (indicating IZ-based entry was used)
--   4. Created before the fix date (2026-05-22)
--
-- Strategy: Flag with close_reason = 'lookahead_bias_cleanup' but do NOT auto-close.
-- The user can review and decide whether to close manually or let them ride.
-- This is safer than auto-closing positions that might be profitable.

-- Step 1: Flag open positions that were likely opened with look-ahead pricing.
-- We mark them with close_reason so the dashboard can surface them for review.
UPDATE paper_positions
SET close_reason = 'lookahead_bias_flagged'
WHERE position_status = 'open'
  AND close_reason IS NULL
  AND created_at < '2026-05-22T00:00:00Z'
  AND signal_reason::text LIKE '%impulseZone%'
  AND entry_price != current_price;

-- Step 2: Also flag pending orders that were placed with look-ahead entry prices.
-- These are limit orders placed before the fix that used refinedEntry directly.
-- They should be cancelled rather than filled at potentially wrong levels.
UPDATE pending_orders
SET status = 'cancelled',
    cancel_reason = 'lookahead_bias_cleanup'
WHERE status = 'pending'
  AND created_at < '2026-05-22T00:00:00Z'
  AND signal_reason::text LIKE '%impulseZone%';
