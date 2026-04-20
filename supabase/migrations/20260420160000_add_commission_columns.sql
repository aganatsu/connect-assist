-- Add commission tracking columns to broker_connections
-- commission_per_lot: user-configured commission per standard lot (round-trip, in account currency)
-- detected_commission_per_lot: auto-learned from actual fill data (per-side, in account currency)
ALTER TABLE public.broker_connections
  ADD COLUMN commission_per_lot NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN detected_commission_per_lot NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.broker_connections.commission_per_lot IS 'User-configured round-trip commission per standard lot in account currency (e.g., 7.0 for $7/lot)';
COMMENT ON COLUMN public.broker_connections.detected_commission_per_lot IS 'Auto-detected per-side commission per lot from actual fill data (e.g., 3.5 for $3.50/side)';
