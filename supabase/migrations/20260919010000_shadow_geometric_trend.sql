-- trend_agrees was comparing two different definitions of "trend".
--
-- The live engine derives trend from SWING GEOMETRY: bullish only if the last
-- two highs AND the last two lows both rise, bearish only if both fall, else
-- ranging. It never reads BOS/CHoCH (smcAnalysis.ts:1108-1114).
--
-- The canonical engine's trend is the running direction of the last emitted
-- structure EVENT.
--
-- Comparing those directly is apples-to-oranges. On 2026-09-19 it produced four
-- BTC/USD rows flagged as trend disagreements where live said "ranging" and
-- canonical said "bearish" — both correct under their own definition. The field
-- was manufacturing findings rather than detecting them.
--
-- canonical_geometric_trend applies the LIVE rule to the CANONICAL swing set, so
-- trend_agrees now compares like with like. A disagreement from here means the
-- SWINGS differ, which is a real finding.
--
-- canonical_trend keeps its existing meaning — canonical's event-driven trend —
-- so rows already written stay internally consistent. It is now informational
-- and is NOT part of the agreement test.
--
-- ROWS WRITTEN BEFORE THIS MIGRATION have trend_agrees computed the old way and
-- canonical_geometric_trend NULL. Do not pool them with later rows when
-- measuring trend agreement; filter on canonical_geometric_trend IS NOT NULL.
-- They are left in place rather than deleted: they are still valid records of
-- the level/timing disagreements, which were never affected by this.

ALTER TABLE public.structure_shadow_telemetry
  ADD COLUMN IF NOT EXISTS canonical_geometric_trend text;

COMMENT ON COLUMN public.structure_shadow_telemetry.canonical_geometric_trend IS
  'Canonical swing points run through the LIVE engine''s trend rule, so '
  'trend_agrees compares like with like. NULL for rows written before '
  '2026-09-19 — exclude those when measuring trend agreement.';
COMMENT ON COLUMN public.structure_shadow_telemetry.canonical_trend IS
  'Canonical event-driven trend: direction of the last emitted BOS/CHoCH. A '
  'DIFFERENT CONCEPT from current_trend, which is swing geometry. Informational '
  'only — never compare the two directly.';
COMMENT ON COLUMN public.structure_shadow_telemetry.trend_agrees IS
  'current_trend vs canonical_geometric_trend (same definition both sides). For '
  'rows before 2026-09-19 this compared current_trend vs canonical_trend, which '
  'was not a valid comparison.';
