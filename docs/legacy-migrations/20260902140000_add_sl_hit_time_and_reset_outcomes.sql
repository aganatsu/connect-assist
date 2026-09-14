-- Record when the stop was hit, and re-open every outcome scored by the old logic.
--
-- simulateOutcome v1 classified a setup that hit BOTH take profit and stop loss
-- as a win, on the sole basis that tp_hit_time_minutes was non-null:
--
--   result.outcome_status = result.tp_hit_time_minutes !== null
--     ? "would_have_won" : "would_have_lost";
--
-- The comment above it said "check which was hit first by time". Nothing
-- checked. It also kept accumulating MFE and MAE after the stop was breached,
-- and guessed on MFE > MAE when neither level was reached inside the window.
--
-- Measured 2026-09-02 over rejections since the revert:
--
--   would_have_won   161 setups   130 of them (81%) hit both TP and SL
--   would_have_lost  114 setups     0 ambiguous
--
-- So 31 wins were real and 130 were unknown. Read as 59% these rejected setups
-- looked like missed winners; read honestly they are about 21%, close to the
-- live win rate. Every gate judged against that column was judged against noise.
--
-- v2 breaks on the first level touched, marks same-candle both-hit as
-- inconclusive rather than guessing, and stops assuming an outcome when neither
-- level is reached.

ALTER TABLE public.rejected_setups
  ADD COLUMN IF NOT EXISTS sl_hit_time_minutes INT;

COMMENT ON COLUMN public.rejected_setups.sl_hit_time_minutes IS
  'Minutes from entry to stop-loss touch. Set alongside tp_hit_time_minutes so a '
  'both-hit setup is distinguishable from a clean win. NULL when the stop was never hit.';

-- Re-open outcomes produced by v1 so the tracker recomputes them.
--
-- Scoped to rows the old classifier could have got wrong: anything it called a
-- win while both levels were hit, and anything it resolved by the MFE > MAE
-- guess. Clean wins (TP only) and clean losses (SL only) were already correct
-- under v1 and are deliberately left alone — re-running them would burn
-- TwelveData credits to reach the same answer.
--
-- outcome-tracker picks up outcome_status = 'pending' on its next cron run.
UPDATE public.rejected_setups
   SET outcome_status     = 'pending',
       outcome_checked_at = NULL,
       mfe_pips           = NULL,
       mae_pips           = NULL
 WHERE outcome_status <> 'pending'
   AND (
     (tp_hit IS TRUE AND sl_hit IS TRUE)          -- both hit: v1 always said "won"
     OR (tp_hit IS NOT TRUE AND sl_hit IS NOT TRUE) -- neither hit: v1 guessed on MFE>MAE
   );
