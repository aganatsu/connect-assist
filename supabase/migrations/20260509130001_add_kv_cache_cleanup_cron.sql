-- Periodic cleanup of expired kv_cache rows.
-- Runs once per hour. Deletes rows where expires_at < now().
-- The table is tiny (1-2 rows typically), so this is lightweight.
SELECT cron.schedule(
  'kv-cache-cleanup-hourly',
  '15 * * * *',
  $$
  DELETE FROM kv_cache WHERE expires_at < now();
  $$
);
