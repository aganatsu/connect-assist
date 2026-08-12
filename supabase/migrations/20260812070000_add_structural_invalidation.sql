-- Pre-touch invalidation is not the position stop loss.
--
-- Step 1 of the corrected sequence in docs/PREARM_GATE_AUDIT.md, and a blocker
-- for pre-arming.
--
-- bot-scanner:2588 cancels any row with status 'pending' when price breaches
-- stop_loss — touched or not:
--
--   const slLevel = parseFloat(pending.stop_loss);
--   if (pending.direction === "long" && currentPrice < slLevel) { ...invalidated... }
--
-- A stop loss is sized for a position that EXISTS: entry minus risk, floored by
-- MIN_SL_PIPS and spread. Using it as the boundary for a setup that has not been
-- entered is a category error, and it gets worse the longer a setup waits.
--
-- Observed 2026-08-12 on the GBP/CHF watchlist entry: invalidation 1.08597
-- against a zone floor of 1.08617 — about 2 pips, on a pair whose minimum stop
-- is 25 pips. A pre-armed order there dies on any overshoot before it can fill.
--
-- Pre-touch, the question is "is the setup still structurally valid?" — has the
-- zone or the impulse that produced it been broken. That level already exists:
-- deriveWatchlistInvalidation() in _shared/watchlistInvalidation.ts computes it
-- from the zone boundary (or impulse, as fallback) plus a buffer, and
-- staged_setups.sl_level already stores it.
--
-- A SEPARATE COLUMN, deliberately, rather than reusing stop_loss. The two
-- levels answer different questions at different phases, and one field would
-- collapse the distinction again the first time someone reads stop_loss and
-- assumes it means the only thing it can mean.

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS structural_invalidation NUMERIC(20,10),
  ADD COLUMN IF NOT EXISTS structural_invalidation_source TEXT;

COMMENT ON COLUMN public.pending_orders.structural_invalidation IS
  'Pre-touch boundary: the price at which the ZONE OR IMPULSE that produced this setup is broken. Not the position stop loss, which is sized for an entered trade. Used only before zone_touch_time is set.';
COMMENT ON COLUMN public.pending_orders.structural_invalidation_source IS
  'Which structure produced the level: zone_boundary, impulse_boundary, or proposed. From deriveWatchlistInvalidation().';
