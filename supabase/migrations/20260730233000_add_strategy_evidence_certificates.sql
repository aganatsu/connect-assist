-- Phase 8B — immutable, service-generated strategy evidence certificates.
--
-- Certificates summarize historical Shadow Evidence with chronological
-- out-of-sample and walk-forward checks. They may recommend Log-only as the
-- next stage, but this migration cannot change activation or runtime behavior.

CREATE TABLE IF NOT EXISTS public.strategy_evidence_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  feature_key TEXT NOT NULL,
  variant_key TEXT NOT NULL DEFAULT 'default',
  activation_scope JSONB NOT NULL DEFAULT '{}'::JSONB,
  activation_scope_hash TEXT NOT NULL,
  contract_version TEXT NOT NULL DEFAULT 'strategy-evidence.v1',
  generator_version TEXT NOT NULL,
  certificate JSONB NOT NULL,
  certificate_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('collecting', 'eligible_log_only', 'keep_shadow')
  ),
  total_candidates INTEGER NOT NULL CHECK (total_candidates >= 0),
  evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
  resolved_count INTEGER NOT NULL CHECK (resolved_count >= 0),
  changed_count INTEGER NOT NULL CHECK (changed_count >= 0),
  coverage_percent NUMERIC(7, 3) NOT NULL
    CHECK (coverage_percent BETWEEN 0 AND 100),
  beneficial_rate_percent NUMERIC(7, 3)
    CHECK (
      beneficial_rate_percent IS NULL
      OR beneficial_rate_percent BETWEEN 0 AND 100
    ),
  expectancy_delta_r NUMERIC(12, 6) NOT NULL,
  max_drawdown_delta_percent NUMERIC(12, 4) NOT NULL,
  good_trade_retention_percent NUMERIC(7, 3) NOT NULL
    CHECK (good_trade_retention_percent BETWEEN 0 AND 100),
  out_of_sample_passed BOOLEAN NOT NULL,
  walk_forward_consistent BOOLEAN NOT NULL,
  source_window_start TIMESTAMPTZ,
  source_window_end TIMESTAMPTZ,
  generated_at TIMESTAMPTZ NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT true,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(feature_key) BETWEEN 1 AND 100),
  CHECK (length(variant_key) BETWEEN 1 AND 100),
  CHECK (
    source_window_end IS NULL
    OR source_window_start IS NULL
    OR source_window_end >= source_window_start
  ),
  CHECK (
    contract_version = certificate->>'contractVersion'
    AND generator_version = certificate->>'generatorVersion'
    AND feature_key = certificate->>'featureKey'
    AND variant_key = certificate->>'variantKey'
    AND status = certificate#>>'{eligibility,status}'
  ),
  CHECK (
    activation_scope_hash =
      public.strategy_activation_json_hash(activation_scope)
  ),
  CHECK (
    certificate_hash =
      public.strategy_activation_json_hash(certificate)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_evidence_certificate_hash
  ON public.strategy_evidence_certificates (
    user_id,
    bot_id,
    feature_key,
    variant_key,
    activation_scope_hash,
    certificate_hash
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_evidence_one_current
  ON public.strategy_evidence_certificates (
    user_id,
    bot_id,
    feature_key,
    variant_key,
    activation_scope_hash
  )
  WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_strategy_evidence_history
  ON public.strategy_evidence_certificates (
    user_id,
    bot_id,
    feature_key,
    generated_at DESC
  );

ALTER TABLE public.strategy_evidence_certificates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own strategy evidence certificates"
  ON public.strategy_evidence_certificates;
CREATE POLICY "Users can view own strategy evidence certificates"
  ON public.strategy_evidence_certificates
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.protect_strategy_evidence_certificate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.bot_id IS DISTINCT FROM OLD.bot_id
     OR NEW.feature_key IS DISTINCT FROM OLD.feature_key
     OR NEW.variant_key IS DISTINCT FROM OLD.variant_key
     OR NEW.activation_scope IS DISTINCT FROM OLD.activation_scope
     OR NEW.activation_scope_hash IS DISTINCT FROM OLD.activation_scope_hash
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.generator_version IS DISTINCT FROM OLD.generator_version
     OR NEW.certificate IS DISTINCT FROM OLD.certificate
     OR NEW.certificate_hash IS DISTINCT FROM OLD.certificate_hash
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.total_candidates IS DISTINCT FROM OLD.total_candidates
     OR NEW.evidence_count IS DISTINCT FROM OLD.evidence_count
     OR NEW.resolved_count IS DISTINCT FROM OLD.resolved_count
     OR NEW.changed_count IS DISTINCT FROM OLD.changed_count
     OR NEW.coverage_percent IS DISTINCT FROM OLD.coverage_percent
     OR NEW.beneficial_rate_percent IS DISTINCT FROM OLD.beneficial_rate_percent
     OR NEW.expectancy_delta_r IS DISTINCT FROM OLD.expectancy_delta_r
     OR NEW.max_drawdown_delta_percent IS DISTINCT
        FROM OLD.max_drawdown_delta_percent
     OR NEW.good_trade_retention_percent IS DISTINCT
        FROM OLD.good_trade_retention_percent
     OR NEW.out_of_sample_passed IS DISTINCT FROM OLD.out_of_sample_passed
     OR NEW.walk_forward_consistent IS DISTINCT
        FROM OLD.walk_forward_consistent
     OR NEW.source_window_start IS DISTINCT FROM OLD.source_window_start
     OR NEW.source_window_end IS DISTINCT FROM OLD.source_window_end
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at THEN
    RAISE EXCEPTION 'Strategy evidence certificate payload is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_strategy_evidence_certificate
  ON public.strategy_evidence_certificates;
CREATE TRIGGER protect_strategy_evidence_certificate
  BEFORE UPDATE
  ON public.strategy_evidence_certificates
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_strategy_evidence_certificate();

CREATE OR REPLACE FUNCTION public.publish_strategy_evidence_certificate(
  p_user_id UUID,
  p_bot_id TEXT,
  p_feature_key TEXT,
  p_variant_key TEXT,
  p_activation_scope JSONB,
  p_certificate JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_scope JSONB := COALESCE(p_activation_scope, '{}'::JSONB);
  v_scope_hash TEXT;
  v_certificate_hash TEXT;
  v_current public.strategy_evidence_certificates%ROWTYPE;
  v_inserted public.strategy_evidence_certificates%ROWTYPE;
  v_status TEXT;
  v_contract_version TEXT;
  v_generator_version TEXT;
  v_variant_key TEXT := trim(COALESCE(p_variant_key, 'default'));
BEGIN
  IF p_user_id IS NULL
     OR NULLIF(trim(COALESCE(p_bot_id, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_feature_key, '')), '') IS NULL
     OR jsonb_typeof(p_certificate) <> 'object' THEN
    RAISE EXCEPTION
      'Certificate user, bot, feature and object payload are required';
  END IF;

  v_contract_version := p_certificate->>'contractVersion';
  v_generator_version := p_certificate->>'generatorVersion';
  v_status := p_certificate#>>'{eligibility,status}';
  IF v_contract_version <> 'strategy-evidence.v1' THEN
    RAISE EXCEPTION 'Unsupported evidence contract: %', v_contract_version;
  END IF;
  IF NULLIF(v_generator_version, '') IS NULL THEN
    RAISE EXCEPTION 'Evidence generator version is required';
  END IF;
  IF p_certificate->>'featureKey' <> trim(p_feature_key)
     OR p_certificate->>'variantKey' <> v_variant_key THEN
    RAISE EXCEPTION 'Certificate feature or variant does not match request';
  END IF;
  IF v_status NOT IN ('collecting', 'eligible_log_only', 'keep_shadow') THEN
    RAISE EXCEPTION 'Invalid evidence status: %', v_status;
  END IF;

  v_scope_hash := public.strategy_activation_json_hash(v_scope);
  v_certificate_hash :=
    public.strategy_activation_json_hash(p_certificate);

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_user_id::TEXT || '|' || trim(p_bot_id) || '|'
      || trim(p_feature_key) || '|' || v_variant_key || '|'
      || v_scope_hash,
      0
    )
  );

  SELECT *
    INTO v_current
    FROM public.strategy_evidence_certificates
   WHERE user_id = p_user_id
     AND bot_id = trim(p_bot_id)
     AND feature_key = trim(p_feature_key)
     AND variant_key = v_variant_key
     AND activation_scope_hash = v_scope_hash
     AND is_current
   FOR UPDATE;

  IF FOUND AND v_current.certificate_hash = v_certificate_hash THEN
    RETURN jsonb_build_object(
      'changed', false,
      'code', 'certificate_unchanged',
      'row', to_jsonb(v_current)
    );
  END IF;

  UPDATE public.strategy_evidence_certificates
     SET is_current = false,
         superseded_at = now()
   WHERE user_id = p_user_id
     AND bot_id = trim(p_bot_id)
     AND feature_key = trim(p_feature_key)
     AND variant_key = v_variant_key
     AND activation_scope_hash = v_scope_hash
     AND is_current;

  INSERT INTO public.strategy_evidence_certificates (
    user_id,
    bot_id,
    feature_key,
    variant_key,
    activation_scope,
    activation_scope_hash,
    contract_version,
    generator_version,
    certificate,
    certificate_hash,
    status,
    total_candidates,
    evidence_count,
    resolved_count,
    changed_count,
    coverage_percent,
    beneficial_rate_percent,
    expectancy_delta_r,
    max_drawdown_delta_percent,
    good_trade_retention_percent,
    out_of_sample_passed,
    walk_forward_consistent,
    source_window_start,
    source_window_end,
    generated_at
  ) VALUES (
    p_user_id,
    trim(p_bot_id),
    trim(p_feature_key),
    v_variant_key,
    v_scope,
    v_scope_hash,
    v_contract_version,
    v_generator_version,
    p_certificate,
    v_certificate_hash,
    v_status,
    COALESCE((p_certificate#>>'{sample,totalCandidates}')::INTEGER, 0),
    COALESCE((p_certificate#>>'{sample,evidence}')::INTEGER, 0),
    COALESCE((p_certificate#>>'{sample,resolved}')::INTEGER, 0),
    COALESCE((p_certificate#>>'{sample,changed}')::INTEGER, 0),
    COALESCE((p_certificate#>>'{sample,coveragePercent}')::NUMERIC, 0),
    NULLIF(
      p_certificate#>>'{effect,beneficialRatePercent}',
      ''
    )::NUMERIC,
    COALESCE((p_certificate#>>'{effect,expectancyDeltaR}')::NUMERIC, 0),
    COALESCE(
      (p_certificate#>>'{effect,maxDrawdownDeltaPercent}')::NUMERIC,
      0
    ),
    COALESCE(
      (p_certificate#>>'{effect,goodTradeRetentionPercent}')::NUMERIC,
      100
    ),
    COALESCE(
      (p_certificate#>>'{validation,outOfSample}')::BOOLEAN,
      false
    ),
    COALESCE(
      (p_certificate#>>'{validation,walkForwardConsistent}')::BOOLEAN,
      false
    ),
    NULLIF(p_certificate#>>'{sourceWindow,start}', '')::TIMESTAMPTZ,
    NULLIF(p_certificate#>>'{sourceWindow,end}', '')::TIMESTAMPTZ,
    COALESCE(
      NULLIF(p_certificate->>'generatedAt', '')::TIMESTAMPTZ,
      now()
    )
  )
  RETURNING * INTO v_inserted;

  RETURN jsonb_build_object(
    'changed', true,
    'code', 'certificate_published',
    'runtimeEnforced', false,
    'row', to_jsonb(v_inserted)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_strategy_evidence_certificate(
  UUID, TEXT, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC;

GRANT SELECT ON public.strategy_evidence_certificates TO authenticated;
GRANT ALL ON public.strategy_evidence_certificates TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_strategy_evidence_certificate(
  UUID, TEXT, TEXT, TEXT, JSONB, JSONB
) TO service_role;

COMMENT ON TABLE public.strategy_evidence_certificates IS
  'Immutable Phase 8 evidence certificates. Recommendations are observational and cannot change activation or runtime behavior.';
