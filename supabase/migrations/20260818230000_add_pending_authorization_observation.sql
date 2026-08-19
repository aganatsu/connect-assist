ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS pending_authorization_observation JSONB;

COMMENT ON COLUMN public.pending_orders.pending_authorization_observation IS
  'Observation-only confirmation agreement and final-authorization geometry. Never authorizes, blocks, sizes or fills a trade.';
