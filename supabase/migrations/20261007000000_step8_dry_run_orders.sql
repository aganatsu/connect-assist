-- Step 8: dry-run Route 2 orders + a database-level entries-lock safety net.
--
-- While the account is entries-locked (post-reset, steps 8–18) the scanner can
-- run its full pipeline in DRY RUN (config simplification.dryRunWhenLocked):
-- Route 2 orders are inserted with dry_run = true and go through the real
-- dedupe / supersede / expiry / cancel / confirmation path, but the hunt only
-- records a hypothetical fill. That measures the real funnel
-- (decisions → unique orders → touches → confirmations → fills) without trading.
--
-- Because dry run lets the decision path run past the pause, the database now
-- refuses, independently of any code path:
--   * any paper position while the account's entries are locked;
--   * any non-dry-run pending order while locked;
--   * any position created from a dry-run order — ever, locked or not;
--   * turning a dry-run order into a real one (dry_run is immutable).

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS dry_run boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dry_run_context jsonb;

CREATE INDEX IF NOT EXISTS idx_pending_orders_dry_run
  ON public.pending_orders (user_id, placed_at DESC) WHERE dry_run;

COMMENT ON COLUMN public.pending_orders.dry_run IS
  'Step 8 funnel measurement while entries are locked. Never filled into a position; exclude from trading statistics.';

CREATE OR REPLACE FUNCTION public.entries_lock_insert_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_locked boolean;
BEGIN
  SELECT bool_or(a.entries_locked) INTO v_locked
    FROM public.paper_accounts a
   WHERE a.user_id = NEW.user_id
     AND COALESCE(a.bot_id, 'smc') = COALESCE(NEW.bot_id, 'smc');

  IF TG_TABLE_NAME = 'paper_positions' THEN
    IF COALESCE(v_locked, false) THEN
      RAISE EXCEPTION 'entries locked: no new positions until the new configuration is approved';
    END IF;
    IF NEW.source_pending_order_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.pending_orders p WHERE p.id = NEW.source_pending_order_id AND p.dry_run
    ) THEN
      RAISE EXCEPTION 'a dry-run order can never become a position';
    END IF;
  ELSIF TG_TABLE_NAME = 'pending_orders' THEN
    IF COALESCE(v_locked, false) AND NOT COALESCE(NEW.dry_run, false) THEN
      RAISE EXCEPTION 'entries locked: only dry-run orders may be placed until the new configuration is approved';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_paper_positions_entries_lock ON public.paper_positions;
CREATE TRIGGER trg_paper_positions_entries_lock
  BEFORE INSERT ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.entries_lock_insert_guard();

DROP TRIGGER IF EXISTS trg_pending_orders_entries_lock ON public.pending_orders;
CREATE TRIGGER trg_pending_orders_entries_lock
  BEFORE INSERT ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.entries_lock_insert_guard();

CREATE OR REPLACE FUNCTION public.pending_orders_dry_run_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.dry_run IS DISTINCT FROM OLD.dry_run THEN
    RAISE EXCEPTION 'pending_orders.dry_run is immutable';
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_pending_orders_dry_run_immutable ON public.pending_orders;
CREATE TRIGGER trg_pending_orders_dry_run_immutable
  BEFORE UPDATE ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.pending_orders_dry_run_immutable();
