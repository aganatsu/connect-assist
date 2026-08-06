CREATE TABLE IF NOT EXISTS public.impulse_lifecycle_enforcement_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  evidence_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'eligible', 'rejected')),
  replay_count INTEGER NOT NULL,
  resolved_count INTEGER NOT NULL,
  rescued_winners INTEGER NOT NULL,
  added_losses INTEGER NOT NULL,
  minimum_sample_ready BOOLEAN NOT NULL,
  reviewed BOOLEAN NOT NULL DEFAULT false,
  reviewed_at TIMESTAMPTZ,
  is_current BOOLEAN NOT NULL DEFAULT true,
  evidence JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, bot_id, evidence_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_impulse_lifecycle_current_certificate
  ON public.impulse_lifecycle_enforcement_certificates (user_id, bot_id)
  WHERE is_current;
ALTER TABLE public.impulse_lifecycle_enforcement_certificates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own impulse lifecycle certificates" ON public.impulse_lifecycle_enforcement_certificates;
CREATE POLICY "Users read own impulse lifecycle certificates"
  ON public.impulse_lifecycle_enforcement_certificates FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service manages impulse lifecycle certificates" ON public.impulse_lifecycle_enforcement_certificates;
CREATE POLICY "Service manages impulse lifecycle certificates"
  ON public.impulse_lifecycle_enforcement_certificates FOR ALL TO service_role
  USING (true) WITH CHECK (true);
GRANT SELECT ON public.impulse_lifecycle_enforcement_certificates TO authenticated, service_role;
GRANT ALL ON public.impulse_lifecycle_enforcement_certificates TO service_role;

CREATE OR REPLACE FUNCTION public.review_impulse_lifecycle_certificate(
  p_evidence_hash TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.impulse_lifecycle_enforcement_certificates%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.impulse_lifecycle_enforcement_certificates
   WHERE user_id = auth.uid() AND bot_id = 'smc' AND evidence_hash = p_evidence_hash
     AND is_current FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current certificate not found'; END IF;
  IF v_row.status <> 'eligible' OR NOT v_row.minimum_sample_ready THEN
    RAISE EXCEPTION 'Certificate is not eligible for enforcement';
  END IF;
  UPDATE public.impulse_lifecycle_enforcement_certificates
     SET reviewed = true, reviewed_at = now()
   WHERE id = v_row.id;
  RETURN jsonb_build_object('reviewed', true, 'evidence_hash', p_evidence_hash);
END; $$;
REVOKE ALL ON FUNCTION public.review_impulse_lifecycle_certificate(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_impulse_lifecycle_certificate(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.retarget_pending_to_impulse_candidate(
  p_pending_id UUID,
  p_user_id UUID,
  p_bot_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pending public.pending_orders%ROWTYPE;
  v_authority public.impulse_entry_lifecycles%ROWTYPE;
  v_certificate public.impulse_lifecycle_enforcement_certificates%ROWTYPE;
  v_candidate JSONB;
  v_entry NUMERIC;
  v_stop NUMERIC;
BEGIN
  SELECT * INTO v_pending FROM public.pending_orders
   WHERE id = p_pending_id AND user_id = p_user_id AND bot_id = p_bot_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('retargeted', false, 'code', 'order_missing'); END IF;
  SELECT * INTO v_authority FROM public.impulse_entry_lifecycles
   WHERE id = v_pending.impulse_entry_lifecycle_id FOR UPDATE;
  IF NOT FOUND OR v_authority.mode <> 'enforce' OR v_authority.status <> 'active' THEN
    RETURN jsonb_build_object('retargeted', false, 'code', 'authority_not_enforcing');
  END IF;
  SELECT * INTO v_certificate FROM public.impulse_lifecycle_enforcement_certificates
   WHERE user_id = p_user_id AND bot_id = p_bot_id AND is_current
     AND status = 'eligible' AND reviewed AND minimum_sample_ready FOR UPDATE;
  IF NOT FOUND OR v_certificate.rescued_winners < v_certificate.added_losses THEN
    RETURN jsonb_build_object('retargeted', false, 'code', 'certificate_unavailable');
  END IF;
  SELECT candidate INTO v_candidate
    FROM jsonb_array_elements(v_authority.lifecycle -> 'candidates') candidate
   WHERE candidate ->> 'id' = v_authority.active_candidate_id;
  IF v_candidate IS NULL THEN
    RETURN jsonb_build_object('retargeted', false, 'code', 'candidate_missing');
  END IF;
  v_entry := CASE WHEN v_pending.direction = 'long'
    THEN (v_candidate ->> 'high')::NUMERIC ELSE (v_candidate ->> 'low')::NUMERIC END;
  v_stop := (v_authority.lifecycle #>> '{impulse,protectedLevel}')::NUMERIC;
  IF (v_pending.direction = 'long' AND v_stop >= v_entry)
    OR (v_pending.direction = 'short' AND v_stop <= v_entry) THEN
    RETURN jsonb_build_object('retargeted', false, 'code', 'invalid_stop_orientation');
  END IF;
  UPDATE public.pending_orders SET
    entry_zone_type = v_candidate ->> 'type',
    entry_zone_low = (v_candidate ->> 'low')::NUMERIC,
    entry_zone_high = (v_candidate ->> 'high')::NUMERIC,
    refined_zone_low = NULL,
    refined_zone_high = NULL,
    entry_price = v_entry,
    stop_loss = v_stop,
    status = 'pending',
    zone_touch_time = NULL,
    confirmation_attempts = 0,
    cancel_reason = NULL,
    resolved_at = NULL,
    signal_reason = COALESCE(v_pending.signal_reason, '{}'::JSONB) || jsonb_build_object(
      'impulseLifecycleRetarget', jsonb_build_object(
        'candidateId', v_authority.active_candidate_id,
        'generation', v_authority.lifecycle #>> '{confirmation,generation}',
        'evidenceHash', v_certificate.evidence_hash,
        'retargetedAt', now()
      )
    )
  WHERE id = v_pending.id;
  RETURN jsonb_build_object(
    'retargeted', true, 'candidate_id', v_authority.active_candidate_id,
    'entry_price', v_entry, 'stop_loss', v_stop
  );
END; $$;
REVOKE ALL ON FUNCTION public.retarget_pending_to_impulse_candidate(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retarget_pending_to_impulse_candidate(UUID, UUID, TEXT)
  TO service_role;
