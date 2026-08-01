CREATE TABLE public.zone_timeframe_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  scan_cycle_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  trading_style text,
  style_policy_version text,
  style_base_policy_hash text,
  style_policy_hash text,
  contract_version text NOT NULL DEFAULT 'zone-tf-evidence.v1',
  selected_timeframe text,
  final_reason text,
  evidence_source text NOT NULL DEFAULT 'live_scan',
  replay_run_id uuid,
  replay_provenance text,
  parent_evidence_id uuid REFERENCES public.zone_timeframe_evidence(id) ON DELETE SET NULL,
  pending_order_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  confirmation_attempt integer NOT NULL DEFAULT 0,
  slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  engine_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_truncated boolean NOT NULL DEFAULT false,
  truncation_detail jsonb,
  linked_setup_id uuid,
  linked_trade_id uuid,
  has_disagreement boolean NOT NULL DEFAULT false,
  golden_replay_linked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT zone_tf_evidence_source_chk CHECK (evidence_source IN ('live_scan','confirmation','replay','backtest')),
  CONSTRAINT zone_tf_evidence_provenance_chk CHECK (replay_provenance IS NULL OR replay_provenance IN ('exact_input','historically_refetched','approximate_config','unreplayable')),
  CONSTRAINT zone_tf_evidence_direction_chk CHECK (direction IN ('bullish','bearish','long','short'))
);

GRANT SELECT ON public.zone_timeframe_evidence TO authenticated;
GRANT ALL ON public.zone_timeframe_evidence TO service_role;

ALTER TABLE public.zone_timeframe_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own timeframe evidence"
ON public.zone_timeframe_evidence
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Service role manages timeframe evidence"
ON public.zone_timeframe_evidence
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE UNIQUE INDEX zone_tf_evidence_identity_uidx
  ON public.zone_timeframe_evidence (
    user_id, bot_id, scan_cycle_id, symbol, direction,
    contract_version, evidence_source, pending_order_id, confirmation_attempt
  );

CREATE INDEX zone_tf_evidence_symbol_idx ON public.zone_timeframe_evidence (user_id, symbol, observed_at DESC);
CREATE INDEX zone_tf_evidence_cycle_idx ON public.zone_timeframe_evidence (scan_cycle_id);
CREATE INDEX zone_tf_evidence_replay_idx ON public.zone_timeframe_evidence (replay_run_id);
CREATE INDEX zone_tf_evidence_retention_idx ON public.zone_timeframe_evidence (observed_at);

CREATE OR REPLACE FUNCTION public.protect_zone_timeframe_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.bot_id IS DISTINCT FROM OLD.bot_id
     OR NEW.scan_cycle_id IS DISTINCT FROM OLD.scan_cycle_id
     OR NEW.symbol IS DISTINCT FROM OLD.symbol
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.evaluated_at IS DISTINCT FROM OLD.evaluated_at
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.evidence_source IS DISTINCT FROM OLD.evidence_source
     OR NEW.pending_order_id IS DISTINCT FROM OLD.pending_order_id
     OR NEW.confirmation_attempt IS DISTINCT FROM OLD.confirmation_attempt
     OR NEW.slots::text IS DISTINCT FROM OLD.slots::text
     OR NEW.engine_options::text IS DISTINCT FROM OLD.engine_options::text
     OR NEW.selected_timeframe IS DISTINCT FROM OLD.selected_timeframe
     OR NEW.final_reason IS DISTINCT FROM OLD.final_reason
     OR NEW.replay_provenance IS DISTINCT FROM OLD.replay_provenance
  THEN
    RAISE EXCEPTION 'zone_timeframe_evidence rows are immutable; only annotation columns may change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_zone_timeframe_evidence_trg
BEFORE UPDATE ON public.zone_timeframe_evidence
FOR EACH ROW EXECUTE FUNCTION public.protect_zone_timeframe_evidence();

REVOKE EXECUTE ON FUNCTION public.protect_zone_timeframe_evidence() FROM anon, authenticated;

CREATE TABLE public.zone_timeframe_evidence_summary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL,
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  scan_cycle_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  selected_timeframe text,
  winner_candidate_id text,
  rejection_code_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  final_reason text,
  evidence_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evidence_id)
);

GRANT SELECT ON public.zone_timeframe_evidence_summary TO authenticated;
GRANT ALL ON public.zone_timeframe_evidence_summary TO service_role;

ALTER TABLE public.zone_timeframe_evidence_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own evidence summaries"
ON public.zone_timeframe_evidence_summary
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Service role manages evidence summaries"
ON public.zone_timeframe_evidence_summary
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE INDEX zone_tf_evidence_summary_symbol_idx
  ON public.zone_timeframe_evidence_summary (user_id, symbol, observed_at DESC);