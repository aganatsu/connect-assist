-- Grade the setups the DIRECTION engine refused.
--
-- Measured 2026-09-15: 148 trend-gate blocks in the sample, 82 of them
-- retracements. Whether letting those through is a good idea is unanswerable,
-- because a direction block never reached this table: recordRejectedSetup
-- opens with
--
--   if (!analysis?.direction || typeof analysis.lastPrice !== "number") return;
--
-- and a blocked pair has direction === null by construction. So the 1,527
-- graded rejections behind "refused setups win 18.4% vs 33.3% break-even"
-- exclude this entire gate — not by sampling, structurally.
--
-- A third rejection_type keeps the new rows separable. Existing analyses filter
-- on the two old values and are unaffected; anything reading the table WITHOUT
-- a rejection_type filter now mixes two populations whose stop and target are
-- constructed differently. See the note on synthetic levels in bot-scanner.

ALTER TABLE public.rejected_setups
  DROP CONSTRAINT IF EXISTS rejected_setups_rejection_type_check;

ALTER TABLE public.rejected_setups
  ADD CONSTRAINT rejected_setups_rejection_type_check
  CHECK (rejection_type = ANY (ARRAY[
    'gate_blocked'::text,
    'below_threshold_strong_t1'::text,
    'direction_blocked'::text
  ]));

COMMENT ON COLUMN public.rejected_setups.rejection_type IS
  'gate_blocked / below_threshold_strong_t1 come from the confluence gates and '
  'carry the stop and target scoring actually produced. direction_blocked comes '
  'from the direction engine, where no setup was ever scored, so its levels are '
  'SYNTHETIC (1.5x ATR stop, 2R target) and are not comparable with the other '
  'two. Always filter by rejection_type before drawing a win rate.';
