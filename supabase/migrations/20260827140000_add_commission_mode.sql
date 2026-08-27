-- Make broker commission intent explicit. Previously commission_per_lot=0 meant
-- both "this account has no commission" and "use the last detected charge".
ALTER TABLE public.broker_connections
  ADD COLUMN IF NOT EXISTS commission_mode TEXT;

UPDATE public.broker_connections
SET commission_mode = CASE
  WHEN COALESCE(commission_per_lot, 0) > 0 THEN 'manual'
  ELSE 'auto'
END
WHERE commission_mode IS NULL;

ALTER TABLE public.broker_connections
  ALTER COLUMN commission_mode SET DEFAULT 'auto',
  ALTER COLUMN commission_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'broker_connections_commission_mode_check'
      AND conrelid = 'public.broker_connections'::regclass
  ) THEN
    ALTER TABLE public.broker_connections
      ADD CONSTRAINT broker_connections_commission_mode_check
      CHECK (commission_mode IN ('auto', 'manual', 'none'));
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'broker_connections_manual_commission_check'
      AND conrelid = 'public.broker_connections'::regclass
  ) THEN
    ALTER TABLE public.broker_connections
      ADD CONSTRAINT broker_connections_manual_commission_check
      CHECK (commission_mode <> 'manual' OR commission_per_lot > 0);
  END IF;
END $$;

COMMENT ON COLUMN public.broker_connections.commission_mode IS
  'Commission source: auto doubles detected_commission_per_lot (stored per side), manual uses commission_per_lot (stored round trip), none forces zero.';
