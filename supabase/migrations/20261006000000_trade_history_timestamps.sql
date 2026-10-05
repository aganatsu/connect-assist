-- paper_trade_history.closed_at and open_time become timestamptz.
--
-- Both were TEXT and held two formats, written by different paths:
--   2026-08-07T05:59:48.684Z           JS toISOString()      (477 + 479 rows)
--   2026-09-01 16:03:19.824734+00      Postgres ::TEXT cast  (5 + 3 rows)
-- Measured on the 2026-10-05 snapshot (482 rows). A text comparison orders
-- those wrongly: ' ' sorts before 'T', so `closed_at >= '2026-09-16T00:00'`
-- dropped every space-format row on that date — including the two trades
-- backfilled from close_audit_log on 2026-09-16. Date filters silently
-- excluded exactly the rows a reconciliation most needs to see.
--
-- The original text is preserved verbatim in closed_at_raw / open_time_raw.
-- Those columns are evidence only; nothing writes them after this migration.
--
-- The migration REFUSES to run if any value lacks an explicit UTC offset or
-- does not parse. A value without an offset would be read in the session time
-- zone, a silent guess; better to stop and look at it.

DO $$
DECLARE
  v_bad bigint;
  v_example text;
BEGIN
  SELECT count(*), min(v)
    INTO v_bad, v_example
    FROM (
      SELECT closed_at AS v FROM public.paper_trade_history
      UNION ALL
      SELECT open_time FROM public.paper_trade_history
    ) s
   WHERE v !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'paper_trade_history has % timestamp value(s) without a recognised UTC offset, e.g. %', v_bad, v_example;
  END IF;
END $$;

ALTER TABLE public.paper_trade_history
  ADD COLUMN IF NOT EXISTS closed_at_raw text,
  ADD COLUMN IF NOT EXISTS open_time_raw text;

COMMENT ON COLUMN public.paper_trade_history.closed_at_raw IS
  'Original TEXT closed_at before 20261006000000. Evidence only; null for rows written after.';
COMMENT ON COLUMN public.paper_trade_history.open_time_raw IS
  'Original TEXT open_time before 20261006000000. Evidence only; null for rows written after.';

-- The freeze trigger re-derives streamlined_decision_origin on UPDATE for rows
-- that have none, and can RAISE on an old signal_reason. This copy touches no
-- decision column, so it does not need the trigger.
ALTER TABLE public.paper_trade_history DISABLE TRIGGER trg_freeze_streamlined_decision;
UPDATE public.paper_trade_history
   SET closed_at_raw = closed_at,
       open_time_raw = open_time
 WHERE closed_at_raw IS NULL;
ALTER TABLE public.paper_trade_history ENABLE TRIGGER trg_freeze_streamlined_decision;

ALTER TABLE public.paper_trade_history
  ALTER COLUMN closed_at TYPE timestamptz USING closed_at::timestamptz,
  ALTER COLUMN open_time TYPE timestamptz USING open_time::timestamptz;

-- Proof the conversion lost nothing: every raw value re-parses to the stored
-- instant. Aborts the migration (and the type change with it) otherwise.
DO $$
DECLARE v_mismatch bigint;
BEGIN
  SELECT count(*) INTO v_mismatch
    FROM public.paper_trade_history
   WHERE closed_at_raw IS NOT NULL
     AND (closed_at IS DISTINCT FROM closed_at_raw::timestamptz
          OR open_time IS DISTINCT FROM open_time_raw::timestamptz);
  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'timestamp conversion mismatch on % row(s)', v_mismatch;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_paper_trade_history_closed_at
  ON public.paper_trade_history (user_id, bot_id, closed_at DESC);
