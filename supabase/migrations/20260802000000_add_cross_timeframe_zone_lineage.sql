-- Phase 4: immutable cross-timeframe parent/child lineage for zone candidates.
-- Observation only; no runtime gate reads these fields.

ALTER TABLE public.zone_candidate_shadow_observations
  ADD COLUMN IF NOT EXISTS timeframe_relationship text,
  ADD COLUMN IF NOT EXISTS parent_candidate_id text,
  ADD COLUMN IF NOT EXISTS candidate_lineage jsonb;

ALTER TABLE public.zone_candidate_shadow_observations
  DROP CONSTRAINT IF EXISTS zone_shadow_timeframe_relationship_valid;

ALTER TABLE public.zone_candidate_shadow_observations
  ADD CONSTRAINT zone_shadow_timeframe_relationship_valid CHECK (
    timeframe_relationship IS NULL
    OR timeframe_relationship IN (
      'qualified_nested',
      'context_only',
      'standalone_lower_tf',
      'timeframe_conflict',
      'no_parent_context'
    )
  );

CREATE INDEX IF NOT EXISTS idx_zone_shadow_timeframe_lineage
  ON public.zone_candidate_shadow_observations (
    user_id,
    bot_id,
    trading_style,
    timeframe_relationship,
    observed_at DESC
  )
  WHERE timeframe_relationship IS NOT NULL;

CREATE OR REPLACE FUNCTION public.protect_cross_timeframe_zone_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF ROW(
    NEW.timeframe_relationship,
    NEW.parent_candidate_id,
    NEW.candidate_lineage
  ) IS DISTINCT FROM ROW(
    OLD.timeframe_relationship,
    OLD.parent_candidate_id,
    OLD.candidate_lineage
  ) THEN
    RAISE EXCEPTION 'cross-timeframe zone lineage is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_cross_timeframe_zone_lineage
  ON public.zone_candidate_shadow_observations;
CREATE TRIGGER protect_cross_timeframe_zone_lineage
  BEFORE UPDATE
  ON public.zone_candidate_shadow_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_cross_timeframe_zone_lineage();

REVOKE ALL ON FUNCTION public.protect_cross_timeframe_zone_lineage()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_cross_timeframe_zone_lineage()
  TO service_role;

COMMENT ON COLUMN
  public.zone_candidate_shadow_observations.timeframe_relationship IS
  'Observation-only relationship between this zone and the nearest configured higher-timeframe parent.';
