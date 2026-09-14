-- CORRECTION to the first version of this migration.
--
-- The first version was written from the migrations folder, which is NOT the
-- schema. The 2026-09-01 revert deleted 1,247 commits including migration
-- files, but the database kept every change those migrations had applied. The
-- live constraint already permitted awaiting_confirmation:
--
--   CHECK (status = ANY (ARRAY['pending','awaiting_confirmation','filled',
--     'reconciliation_required','broker_rejected','invalidated','expired',
--     'cancelled']))
--
-- So the premise was wrong — zone touches were never blocked by this
-- constraint — and worse, rewriting it DROPPED 'reconciliation_required' and
-- 'broker_rejected', which the live schema had and the repo did not know
-- about.
--
-- This restores those two and keeps the union. 'triggered' is retained because
-- the zone engine and staged_setups use that vocabulary.
--
-- The lesson, which is the reason this file still exists rather than being
-- deleted: query pg_constraint before writing a constraint migration in this
-- project. The migrations folder is an incomplete record of the schema.

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
    'invalidated',
    'reconciliation_required',
    'broker_rejected'
  ));

COMMENT ON COLUMN public.pending_orders.status IS
  'pending -> awaiting_confirmation (zone touched) -> filled | cancelled | expired | invalidated. '
  'reconciliation_required and broker_rejected come from the broker sync path and exist in the '
  'live schema without a surviving migration file — do not drop them.';
