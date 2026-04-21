ALTER TABLE public.broker_connections
ADD COLUMN IF NOT EXISTS commission_per_lot NUMERIC NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS detected_commission_per_lot NUMERIC;