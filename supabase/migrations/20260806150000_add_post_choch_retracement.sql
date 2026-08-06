ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS post_confirmation_entry JSONB,
  ADD COLUMN IF NOT EXISTS post_confirmation_observation JSONB;

ALTER TABLE public.pending_orders
  DROP CONSTRAINT IF EXISTS pending_post_confirmation_entry_valid;
ALTER TABLE public.pending_orders
  ADD CONSTRAINT pending_post_confirmation_entry_valid CHECK (
    post_confirmation_entry IS NULL OR (
      post_confirmation_entry ->> 'contractVersion' = 'post-choch-retracement.v1'
      AND post_confirmation_entry ->> 'state' IN (
        'awaiting_retracement', 'ready', 'invalidated', 'expired'
      )
      AND (post_confirmation_entry #>> '{zone,low}')::NUMERIC <
          (post_confirmation_entry #>> '{zone,high}')::NUMERIC
    )
  );

CREATE INDEX IF NOT EXISTS idx_pending_post_confirmation_wait
  ON public.pending_orders (user_id, bot_id, status)
  WHERE status = 'awaiting_confirmation'
    AND post_confirmation_entry ->> 'state' = 'awaiting_retracement';
