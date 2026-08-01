-- Correct Phase 1 evidence lineage and retention without changing strategy,
-- ranking, gating, authorization or execution behavior.

ALTER TABLE public.zone_timeframe_evidence
  ADD COLUMN IF NOT EXISTS event_linked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS style_policy_snapshot jsonb;

ALTER TABLE public.zone_timeframe_evidence_summary
  ADD COLUMN IF NOT EXISTS parent_evidence_id uuid,
  ADD COLUMN IF NOT EXISTS evidence_source text,
  ADD COLUMN IF NOT EXISTS contract_version text,
  ADD COLUMN IF NOT EXISTS trading_style text,
  ADD COLUMN IF NOT EXISTS style_policy_version text,
  ADD COLUMN IF NOT EXISTS style_base_policy_hash text,
  ADD COLUMN IF NOT EXISTS style_policy_hash text,
  ADD COLUMN IF NOT EXISTS style_policy_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS pending_order_id uuid,
  ADD COLUMN IF NOT EXISTS confirmation_attempt integer,
  ADD COLUMN IF NOT EXISTS event_linked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_disagreement boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS golden_replay_linked boolean NOT NULL DEFAULT false;

-- An immutable child observation must retain the UUID of its original parent
-- even after the large parent payload is compacted. ON DELETE SET NULL would
-- silently erase that provenance and conflict with the immutability contract.
ALTER TABLE public.zone_timeframe_evidence
  DROP CONSTRAINT IF EXISTS zone_timeframe_evidence_parent_evidence_id_fkey;

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

-- Atomic, monotonic confirmation-attempt allocation. A new confirmation edge
-- invocation has a new scan UUID, so counting within scan_cycle_id always
-- returned 1. This counter is scoped to the pending order instead.
CREATE TABLE IF NOT EXISTS public.zone_confirmation_evidence_counters (
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  pending_order_id uuid NOT NULL,
  last_attempt integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bot_id, pending_order_id)
);

ALTER TABLE public.zone_confirmation_evidence_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages confirmation evidence counters"
  ON public.zone_confirmation_evidence_counters;
CREATE POLICY "Service role manages confirmation evidence counters"
ON public.zone_confirmation_evidence_counters
FOR ALL TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL ON public.zone_confirmation_evidence_counters
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zone_confirmation_evidence_counters TO service_role;

CREATE OR REPLACE FUNCTION public.allocate_zone_confirmation_evidence_attempt(
  p_user_id uuid,
  p_bot_id text,
  p_pending_order_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  allocated integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  SELECT COALESCE(MAX(confirmation_attempt), 0) + 1
  INTO allocated
  FROM public.zone_timeframe_evidence
  WHERE user_id = p_user_id
    AND bot_id = p_bot_id
    AND pending_order_id = p_pending_order_id
    AND evidence_source = 'confirmation';

  INSERT INTO public.zone_confirmation_evidence_counters (
    user_id,
    bot_id,
    pending_order_id,
    last_attempt,
    updated_at
  )
  VALUES (
    p_user_id,
    p_bot_id,
    p_pending_order_id,
    allocated,
    now()
  )
  ON CONFLICT (user_id, bot_id, pending_order_id)
  DO UPDATE SET
    last_attempt =
      public.zone_confirmation_evidence_counters.last_attempt + 1,
    updated_at = now()
  RETURNING last_attempt INTO allocated;

  RETURN allocated;
END;
$$;

REVOKE ALL ON FUNCTION
  public.allocate_zone_confirmation_evidence_attempt(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.allocate_zone_confirmation_evidence_attempt(uuid, text, uuid)
  TO service_role;

CREATE INDEX IF NOT EXISTS zone_tf_evidence_event_retention_idx
  ON public.zone_timeframe_evidence (event_linked, observed_at);

CREATE INDEX IF NOT EXISTS zone_tf_evidence_pending_attempt_idx
  ON public.zone_timeframe_evidence (
    user_id,
    bot_id,
    pending_order_id,
    confirmation_attempt
  )
  WHERE evidence_source = 'confirmation';
