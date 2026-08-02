-- Phase 2: queryable canonical impulse detector provenance.
-- Observation only: these columns do not participate in ranking, gating,
-- authorization, sizing, or execution.

ALTER TABLE public.zone_timeframe_evidence
  ADD COLUMN IF NOT EXISTS canonical_detector_version text,
  ADD COLUMN IF NOT EXISTS canonical_parity boolean;

ALTER TABLE public.zone_timeframe_evidence_summary
  ADD COLUMN IF NOT EXISTS canonical_detector_version text,
  ADD COLUMN IF NOT EXISTS canonical_parity boolean;

CREATE INDEX IF NOT EXISTS zone_tf_evidence_canonical_parity_idx
  ON public.zone_timeframe_evidence (
    user_id,
    canonical_detector_version,
    canonical_parity,
    observed_at DESC
  )
  WHERE canonical_detector_version IS NOT NULL;

CREATE OR REPLACE FUNCTION public.protect_zone_timeframe_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.bot_id IS DISTINCT FROM OLD.bot_id
     OR NEW.scan_cycle_id IS DISTINCT FROM OLD.scan_cycle_id
     OR NEW.symbol IS DISTINCT FROM OLD.symbol
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.evaluated_at IS DISTINCT FROM OLD.evaluated_at
     OR NEW.trading_style IS DISTINCT FROM OLD.trading_style
     OR NEW.style_policy_version IS DISTINCT FROM OLD.style_policy_version
     OR NEW.style_base_policy_hash IS DISTINCT FROM OLD.style_base_policy_hash
     OR NEW.style_policy_hash IS DISTINCT FROM OLD.style_policy_hash
     OR NEW.style_policy_snapshot::text IS DISTINCT FROM OLD.style_policy_snapshot::text
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.selected_timeframe IS DISTINCT FROM OLD.selected_timeframe
     OR NEW.final_reason IS DISTINCT FROM OLD.final_reason
     OR NEW.evidence_source IS DISTINCT FROM OLD.evidence_source
     OR NEW.replay_run_id IS DISTINCT FROM OLD.replay_run_id
     OR NEW.replay_provenance IS DISTINCT FROM OLD.replay_provenance
     OR NEW.parent_evidence_id IS DISTINCT FROM OLD.parent_evidence_id
     OR NEW.pending_order_id IS DISTINCT FROM OLD.pending_order_id
     OR NEW.confirmation_attempt IS DISTINCT FROM OLD.confirmation_attempt
     OR NEW.canonical_detector_version IS DISTINCT FROM OLD.canonical_detector_version
     OR NEW.canonical_parity IS DISTINCT FROM OLD.canonical_parity
     OR NEW.slots::text IS DISTINCT FROM OLD.slots::text
     OR NEW.engine_options::text IS DISTINCT FROM OLD.engine_options::text
     OR NEW.payload_truncated IS DISTINCT FROM OLD.payload_truncated
     OR NEW.truncation_detail::text IS DISTINCT FROM OLD.truncation_detail::text
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'zone_timeframe_evidence rows are immutable; only retention/link annotations may change';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN public.zone_timeframe_evidence.canonical_detector_version IS
  'Observation-only canonical impulse detector version used for this evidence row.';
COMMENT ON COLUMN public.zone_timeframe_evidence.canonical_parity IS
  'True only when every evaluated timeframe selected the same impulse as the legacy detector.';
