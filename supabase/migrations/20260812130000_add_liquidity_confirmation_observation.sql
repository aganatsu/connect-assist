ALTER TABLE public.staged_setups
  ADD COLUMN IF NOT EXISTS liquidity_confirmation_observation JSONB;

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS liquidity_confirmation_observation JSONB;

COMMENT ON COLUMN public.staged_setups.liquidity_confirmation_observation IS
  'Observe-only v2 sweep-to-confirmation contract. Does not authorize execution.';

COMMENT ON COLUMN public.pending_orders.liquidity_confirmation_observation IS
  'Observe-only v2 sweep-to-confirmation contract frozen to this lifecycle candidate.';
