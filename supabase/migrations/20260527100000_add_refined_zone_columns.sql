-- Migration: Add refined zone bounds to pending_orders
-- Branch: manus/refined-zone-entry
-- Purpose: Store the LTF-refined zone bounds (15m OB/FVG) separately from the
--   broad HTF zone bounds. The zone-confirmation-scanner uses these narrower
--   bounds to determine when to start the 5m confirmation hunt.
--
-- When ltfRefined=true: refined_zone_low/high = 15m OB/FVG bounds (tight sniper zone)
-- When ltfRefined=false: refined_zone_low/high = NULL → scanner falls back to entry_zone_low/high

ALTER TABLE pending_orders ADD COLUMN IF NOT EXISTS refined_zone_low NUMERIC(20,10) DEFAULT NULL;
ALTER TABLE pending_orders ADD COLUMN IF NOT EXISTS refined_zone_high NUMERIC(20,10) DEFAULT NULL;

-- Comment for clarity
COMMENT ON COLUMN pending_orders.refined_zone_low IS 'LTF-refined zone lower bound (15m OB/FVG). NULL = no refinement, use entry_zone_low.';
COMMENT ON COLUMN pending_orders.refined_zone_high IS 'LTF-refined zone upper bound (15m OB/FVG). NULL = no refinement, use entry_zone_high.';
