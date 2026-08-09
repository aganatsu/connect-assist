-- The legacy optimizer auto-applied partial, legacy-scoring configurations.
-- Canonical Strategy Research is intentionally user-triggered and review-only.
DO $$
BEGIN
  PERFORM cron.unschedule('optimizer-weekly-run');
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'optimizer-weekly-run was not scheduled: %', SQLERRM;
END $$;
