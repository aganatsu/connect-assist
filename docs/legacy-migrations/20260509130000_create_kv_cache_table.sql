-- Key-value cache table for expensive computations (FOTSI, etc.)
-- Used to avoid redundant API calls within a TTL window.

CREATE TABLE IF NOT EXISTS kv_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_kv_cache_expires_at ON kv_cache(expires_at);

-- Cleanup expired entries (optional — can be run by a cron or left to accumulate)
-- The table will only have a handful of rows so cleanup is not urgent.
