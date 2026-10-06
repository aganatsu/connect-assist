-- Switch the paper balance guard from OBSERVE to ENFORCE.
--
-- From here on, any change to paper_accounts.balance / peak_balance / the
-- ledger epoch that does not come through settle_paper_position,
-- settle_paper_partial or reset_paper_account RAISES instead of being recorded.
--
-- Evidence it is safe (24h observation window, 2026-10-05 17:20:36 →
-- 2026-10-06 17:25:04 UTC, settlement-monitor final verdict PASS):
--   7 periodic runs + final, 0 failed, max unwatched gap 4h;
--   paper_balance_unledgered_writes = 0 rows;
--   5 closes settled through the ledger (all scanner_breach_check), drift 0.
-- No legitimate writer bypasses the ledger, so nothing legitimate is refused.
--
-- Rollback: update public.paper_ledger_guard set mode = 'observe' where id = 1;

UPDATE public.paper_ledger_guard
   SET mode = 'enforce', updated_at = now()
 WHERE id = 1 AND mode = 'observe';

DO $$
BEGIN
  IF (SELECT mode FROM public.paper_ledger_guard WHERE id = 1) IS DISTINCT FROM 'enforce' THEN
    RAISE EXCEPTION 'paper_ledger_guard did not switch to enforce';
  END IF;
  IF EXISTS (SELECT 1 FROM public.paper_balance_unledgered_writes) THEN
    RAISE EXCEPTION 'unledgered balance writes exist — investigate before enforcing';
  END IF;
END $$;
