-- Record how impulsive the leg was, on the trade that came from it.
--
-- impulseZoneEngine defines an impulse structurally (swing origin -> BOS) and
-- never measured displacement, so a three-week grind and a two-candle
-- expansion produced identical zones. PR #530 started measuring it and showed
-- it in the Zone Story, but nothing persisted it — the panel could display the
-- number and no query could ever group trades by it.
--
-- It goes here rather than into factors_json because that column is an ARRAY
-- and bot-weekly-advisor iterates it (index.ts:252). Nesting an object into it
-- would break the advisor silently.
--
-- trade_reasonings.position_id joins to paper_trade_history.position_id, so
-- this makes the question answerable:
--
--   select r.leg_displacement->>'strength' as strength,
--          count(*), round(avg(h.pnl), 2) as avg_pnl,
--          round(100.0 * count(*) filter (where h.pnl > 0) / count(*), 1) as win_rate
--   from paper_trade_history h
--   join trade_reasonings r on r.position_id = h.position_id
--   where r.leg_displacement is not null
--   group by 1 order by 1;

ALTER TABLE public.trade_reasonings
  ADD COLUMN IF NOT EXISTS leg_displacement jsonb;

COMMENT ON COLUMN public.trade_reasonings.leg_displacement IS
  'Observational measure of how forcefully the impulse leg moved: avgBodyRatio, maxRangeMultiple, displacementCandles, displacementRatio, rangePerBar, strength. Nothing gates on it. Added 2026-09-15 so low-displacement legs can be evaluated against outcomes instead of assumed to underperform.';
