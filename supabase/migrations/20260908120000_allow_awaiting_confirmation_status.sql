-- pending_orders.status has been missing 'awaiting_confirmation' since the
-- table was created (20260424100000). The zone-confirmation feature landed a
-- month later (20260522150000_add_confirmation_columns_to_pending_orders) and
-- added zone_touch_time and confirmation_attempts, but never widened the
-- CHECK constraint that gates the state it needs.
--
-- So every zone touch has been rejected by the database:
--
--   bot-scanner:3169
--     update pending_orders set
--       status = 'awaiting_confirmation',   -- violates pending_orders_status_check
--       zone_touch_time = now(),
--       confirmation_attempts = 0
--
-- The whole statement fails, so the order stays 'pending' AND zone_touch_time
-- never persists. zone-confirmation-scanner selects
-- `status = 'awaiting_confirmation'` and therefore always finds nothing.
--
-- Measured 2026-09-07: 31 pending orders over 48 hours, 0 filled, and
-- confirmation_attempts = 0 on every single one. Price reaches the zones —
-- 110 evaluations had price inside a zone that day — but the transition that
-- starts the confirmation hunt cannot be written.
--
-- 'triggered' is included as well: staged_setups and the zone engine both use
-- that vocabulary, and leaving one legal state out of a CHECK is the mistake
-- being fixed here.

ALTER TABLE public.pending_orders
  DROP CONSTRAINT IF EXISTS pending_orders_status_check;

ALTER TABLE public.pending_orders
  ADD CONSTRAINT pending_orders_status_check
  CHECK (status IN (
    'pending',
    'awaiting_confirmation',
    'triggered',
    'filled',
    'expired',
    'cancelled',
    'invalidated'
  ));

COMMENT ON COLUMN public.pending_orders.status IS
  'pending -> awaiting_confirmation (zone touched) -> filled | cancelled | expired | invalidated. '
  'awaiting_confirmation was absent from the CHECK constraint from table creation until 2026-09-08, '
  'which silently blocked every zone touch.';
