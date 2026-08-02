-- Phase 3: persist the observation-only zone candidate lifecycle and top-three
-- cross-factor rank alongside the existing legacy/local shadow evidence.

ALTER TABLE public.zone_candidate_shadow_observations
  ADD COLUMN IF NOT EXISTS candidate_model_version text,
  ADD COLUMN IF NOT EXISTS candidate_model_rank integer,
  ADD COLUMN IF NOT EXISTS candidate_model_winner boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS candidate_lifecycle_state text,
  ADD COLUMN IF NOT EXISTS candidate_lifecycle jsonb,
  ADD COLUMN IF NOT EXISTS candidate_model jsonb;

ALTER TABLE public.zone_candidate_shadow_observations
  DROP CONSTRAINT IF EXISTS zone_shadow_candidate_model_rank_valid,
  DROP CONSTRAINT IF EXISTS zone_shadow_candidate_lifecycle_valid;

ALTER TABLE public.zone_candidate_shadow_observations
  ADD CONSTRAINT zone_shadow_candidate_model_rank_valid CHECK (
    candidate_model_rank IS NULL OR candidate_model_rank > 0
  ),
  ADD CONSTRAINT zone_shadow_candidate_lifecycle_valid CHECK (
    candidate_lifecycle_state IS NULL
    OR candidate_lifecycle_state IN (
      'fresh',
      'tapped_and_held',
      'partially_mitigated',
      'violated'
    )
  );

CREATE INDEX IF NOT EXISTS idx_zone_shadow_candidate_model
  ON public.zone_candidate_shadow_observations (
    user_id,
    bot_id,
    trading_style,
    candidate_model_version,
    candidate_model_rank,
    observed_at DESC
  )
  WHERE candidate_model_version IS NOT NULL;

CREATE OR REPLACE FUNCTION public.protect_zone_candidate_model_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF ROW(
    NEW.candidate_model_version,
    NEW.candidate_model_rank,
    NEW.candidate_model_winner,
    NEW.candidate_lifecycle_state,
    NEW.candidate_lifecycle,
    NEW.candidate_model
  ) IS DISTINCT FROM ROW(
    OLD.candidate_model_version,
    OLD.candidate_model_rank,
    OLD.candidate_model_winner,
    OLD.candidate_lifecycle_state,
    OLD.candidate_lifecycle,
    OLD.candidate_model
  ) THEN
    RAISE EXCEPTION 'zone candidate model evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_zone_candidate_model_evidence
  ON public.zone_candidate_shadow_observations;
CREATE TRIGGER protect_zone_candidate_model_evidence
  BEFORE UPDATE
  ON public.zone_candidate_shadow_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_zone_candidate_model_evidence();

REVOKE ALL ON FUNCTION public.protect_zone_candidate_model_evidence()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_zone_candidate_model_evidence()
  TO service_role;

COMMENT ON COLUMN
  public.zone_candidate_shadow_observations.candidate_model_rank IS
  'Observation-only rank across local evidence, proximity, sweep, retest, displacement, and structural importance.';
