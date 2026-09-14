-- M12: Create trade_archive table for data retention
-- Old paper_trade_history records (>90 days) are moved here by the data-cleanup function

CREATE TABLE IF NOT EXISTS trade_archive (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price TEXT,
  exit_price TEXT,
  size TEXT,
  pnl TEXT,
  pnl_pips TEXT,
  open_time TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  close_reason TEXT,
  signal_reason TEXT,
  signal_score TEXT,
  order_id TEXT,
  bot_id TEXT DEFAULT 'smc',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  archived_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying archived trades by user
CREATE INDEX IF NOT EXISTS idx_trade_archive_user ON trade_archive(user_id, closed_at DESC);
