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
-- Note the direction, which is easy to state backwards. On the observed GBP/CHF
-- setup the structural boundary is 1.08597 against a zone floor of 1.08617
-- (~2 pips), while the position stop sits ~23 pips lower at the pair's 25-pip
-- MIN_SL_PIPS floor. Structural is TIGHTER. Switching to it makes pre-entry
-- invalidation fire EARLIER, not later — which is correct: a setup whose zone
-- has broken is dead regardless of how much room a hypothetical position would
-- have had.
--
-- Nothing in pending_orders has entered. Through BOTH 'pending' and
-- 'awaiting_confirmation' there is no position, so the boundary is structural
-- for the whole pending lifecycle — touch is not entry.
--
-- Pre-entry, the question is "is the setup still structurally valid?" — has the
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
  'Pre-entry boundary: the price at which the ZONE OR IMPULSE that produced this setup is broken. Not the position stop loss, which is sized for an entered trade. Governs the whole pending lifecycle, including awaiting_confirmation — touch is not entry.';
COMMENT ON COLUMN public.pending_orders.structural_invalidation_source IS
  'Which structure produced the level: zone_boundary, impulse_boundary, or proposed. From deriveWatchlistInvalidation().';
