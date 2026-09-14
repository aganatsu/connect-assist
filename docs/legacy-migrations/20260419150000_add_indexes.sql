-- M18: Add missing database indexes for performance
-- These indexes improve query performance on frequently-accessed tables

-- scan_logs: queried by user_id + scanned_at for recent scan history
CREATE INDEX IF NOT EXISTS idx_scan_logs_user_date ON scan_logs(user_id, scanned_at DESC);

-- broker_connections: queried by user_id + is_active for active connections
CREATE INDEX IF NOT EXISTS idx_broker_conn_user_active ON broker_connections(user_id, is_active);

-- paper_trade_history: queried by user_id + symbol for trade history filtering
CREATE INDEX IF NOT EXISTS idx_trade_history_user_symbol ON paper_trade_history(user_id, symbol);

-- paper_positions: queried by user_id + status for open position lookups
CREATE INDEX IF NOT EXISTS idx_positions_user_status ON paper_positions(user_id, position_status);

-- paper_positions: queried by user_id + bot_id for bot-specific position lookups
CREATE INDEX IF NOT EXISTS idx_positions_user_bot ON paper_positions(user_id, bot_id);

-- config_presets: queried by user_id for preset listing
CREATE INDEX IF NOT EXISTS idx_config_presets_user ON config_presets(user_id);

-- bot_configs: queried by user_id + connection_id for config lookups
CREATE INDEX IF NOT EXISTS idx_bot_configs_user_conn ON bot_configs(user_id, connection_id);
