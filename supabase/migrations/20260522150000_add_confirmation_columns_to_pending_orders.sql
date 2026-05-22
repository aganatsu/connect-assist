-- Migration: Add zone confirmation entry columns to pending_orders
-- Branch: manus/zone-confirmation-entry
-- Purpose: Support the two-stage entry state machine:
--   "pending" → "awaiting_confirmation" → "filled"/"cancelled"
--
-- New columns:
--   zone_touch_time: timestamp when price first touched the zone (triggers confirmation hunt)
--   confirmation_attempts: how many times price entered/left zone without confirming

-- Add new columns
ALTER TABLE pending_orders ADD COLUMN IF NOT EXISTS zone_touch_time TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE pending_orders ADD COLUMN IF NOT EXISTS confirmation_attempts INTEGER DEFAULT 0;

-- Allow "awaiting_confirmation" as a valid status
-- (Supabase uses text columns for status, so no enum change needed — just documenting)
-- Valid statuses: "pending", "awaiting_confirmation", "filled", "expired", "cancelled"

-- Index for efficient querying of orders in confirmation state
CREATE INDEX IF NOT EXISTS idx_pending_orders_confirmation_status
  ON pending_orders (user_id, bot_id, status)
  WHERE status IN ('pending', 'awaiting_confirmation');
