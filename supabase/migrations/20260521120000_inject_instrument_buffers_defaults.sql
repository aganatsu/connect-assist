-- Migration: Inject recommended instrumentBuffers defaults into existing bot_configs
-- that do not already have the field set.
--
-- This ensures existing users get the safer per-instrument SL buffer values
-- (gold $1.50, silver $0.20, BTC $100, ETH $2.00, oil $1.00) without needing
-- to manually reset-to-defaults.
--
-- Safe: only updates rows where instrumentBuffers is missing or empty.
-- Idempotent: running twice has no effect (WHERE clause prevents overwrite).

UPDATE bot_configs
SET config_json = jsonb_set(
  config_json::jsonb,
  '{instrumentBuffers}',
  '{
    "XAU/USD": {"slBufferPips": 150},
    "XAG/USD": {"slBufferPips": 200},
    "BTC/USD": {"slBufferPips": 100},
    "ETH/USD": {"slBufferPips": 200},
    "US Oil":  {"slBufferPips": 100}
  }'::jsonb
)
WHERE (
  config_json::jsonb -> 'instrumentBuffers' IS NULL
  OR config_json::jsonb -> 'instrumentBuffers' = '{}'::jsonb
);
