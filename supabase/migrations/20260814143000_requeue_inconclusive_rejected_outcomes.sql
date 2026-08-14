-- Re-evaluate legacy inconclusive rows with the corrected full-window,
-- style-aware outcome tracker. The tracker requests each row's historical
-- observation range, so this does not depend on current/latest candles.
UPDATE public.rejected_setups
SET
  outcome_status = 'pending',
  outcome_checked_at = NULL,
  outcome_reason = 'requeued_for_outcome_v2'
WHERE outcome_status = 'inconclusive'
  AND rejected_at >= now() - interval '30 days';

COMMENT ON COLUMN public.rejected_setups.outcome_reason IS
  'Machine-readable tracking state or terminal counterfactual result reason. '
  'Pending rows use awaiting_entry/position_open; inconclusive rows use '
  'entry_not_reached/open_at_horizon/ambiguous candle reasons.';
