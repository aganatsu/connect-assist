-- Column documentation, recovered from the archived migrations.
--
-- The baseline extraction read pg_constraint, pg_indexes, pg_policies and
-- the rest, but never pg_description, so every COMMENT was silently dropped
-- and the new project has none. That matters most for pending_orders.status,
-- whose comment is the warning left behind after a missing status value
-- rejected every zone touch for a month.
--
-- The originals were written as adjacent string literals across several
-- lines. SQL only concatenates those when a NEWLINE separates them, so they
-- are merged into one literal here rather than reflowed.
--
-- Recovered from docs/legacy-migrations/, so this restores what the repo can
-- prove. Comments applied only through Lovable's console are still missing;
-- pg_description on the old project is where the rest live.

COMMENT ON COLUMN public.broker_connections.commission_per_lot IS
  'User-configured round-trip commission per standard lot in account currency (e.g., 7.0 for $7/lot)';

COMMENT ON COLUMN public.broker_connections.detected_commission_per_lot IS
  'Auto-detected per-side commission per lot from actual fill data (e.g., 3.5 for $3.50/side)';

COMMENT ON COLUMN public.pending_orders.refined_zone_high IS
  'LTF-refined zone upper bound (15m OB/FVG). NULL = no refinement, use entry_zone_high.';

COMMENT ON COLUMN public.pending_orders.refined_zone_low IS
  'LTF-refined zone lower bound (15m OB/FVG). NULL = no refinement, use entry_zone_low.';

COMMENT ON COLUMN public.pending_orders.status IS
  'pending -> awaiting_confirmation (zone touched) -> filled | cancelled | expired | invalidated. reconciliation_required and broker_rejected come from the broker sync path and exist in the live schema without a surviving migration file — do not drop them.';

COMMENT ON COLUMN public.rejected_setups.sl_hit_time_minutes IS
  'Minutes from entry to stop-loss touch. Set alongside tp_hit_time_minutes so a both-hit setup is distinguishable from a clean win. NULL when the stop was never hit.';
