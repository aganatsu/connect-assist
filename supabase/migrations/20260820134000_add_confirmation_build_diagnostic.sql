ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS confirmation_build_diagnostic JSONB;

COMMENT ON COLUMN public.pending_orders.confirmation_build_diagnostic IS
  'Latest closed-candle diagnostic from the shared impulse confirmation-lock owner.';
