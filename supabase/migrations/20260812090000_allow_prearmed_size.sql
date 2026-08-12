-- Pre-armed zone setups do not own a position size. Size is calculated from
-- current equity/exposure only during final authorization.
ALTER TABLE public.pending_orders ALTER COLUMN size DROP NOT NULL;
COMMENT ON COLUMN public.pending_orders.size IS
  'Null while a setup is pre-armed. Calculated from current account state during final authorization.';
