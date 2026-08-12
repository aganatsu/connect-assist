-- Durable cursor for pending-zone touch detection.
-- Candles overlapping the cursor are rechecked because a still-forming candle
-- can extend its high or low after the previous scan.

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS last_touch_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN public.pending_orders.last_touch_checked_at IS
  'Last wall-clock observation used by pending-zone touch detection. Boundary candles are rechecked so later wicks in the same forming candle are not missed.';

