-- Phase 5: expose the immutable cross-timeframe setup context without creating
-- a second source of truth. Values are generated from frozen_strategy_context,
-- whose existing trigger and hash constraint already prevent replacement.

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'staged_setups',
    'pending_orders',
    'paper_positions'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I
         ADD COLUMN IF NOT EXISTS cross_tf_context_version TEXT
           GENERATED ALWAYS AS (
             frozen_strategy_context #>> ''{crossTimeframeContext,contractVersion}''
           ) STORED,
         ADD COLUMN IF NOT EXISTS cross_tf_timeframe_evidence_id TEXT
           GENERATED ALWAYS AS (
             frozen_strategy_context #>> ''{crossTimeframeContext,timeframeEvidenceId}''
           ) STORED,
         ADD COLUMN IF NOT EXISTS cross_tf_relationship TEXT
           GENERATED ALWAYS AS (
             frozen_strategy_context #>> ''{crossTimeframeContext,relationship,classification}''
           ) STORED',
      table_name
    );

    EXECUTE format(
      'ALTER TABLE public.%I
         DROP CONSTRAINT IF EXISTS %I',
      table_name,
      table_name || '_cross_tf_context_contract'
    );
    EXECUTE format(
      'ALTER TABLE public.%I
         ADD CONSTRAINT %I CHECK (
           frozen_strategy_context #> ''{crossTimeframeContext}'' IS NULL
           OR cross_tf_context_version = ''frozen-cross-tf-context.v1''
         )',
      table_name,
      table_name || '_cross_tf_context_contract'
    );
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS idx_staged_setups_cross_tf_evidence
  ON public.staged_setups (cross_tf_timeframe_evidence_id)
  WHERE cross_tf_timeframe_evidence_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pending_orders_cross_tf_evidence
  ON public.pending_orders (cross_tf_timeframe_evidence_id)
  WHERE cross_tf_timeframe_evidence_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_paper_positions_cross_tf_evidence
  ON public.paper_positions (cross_tf_timeframe_evidence_id)
  WHERE cross_tf_timeframe_evidence_id IS NOT NULL;

COMMENT ON COLUMN public.staged_setups.cross_tf_context_version IS
  'Generated Phase-5 contract version from the immutable setup strategy package.';
COMMENT ON COLUMN public.pending_orders.cross_tf_context_version IS
  'Generated Phase-5 contract version propagated from the originating setup.';
COMMENT ON COLUMN public.paper_positions.cross_tf_context_version IS
  'Generated Phase-5 contract version propagated to the opened position.';
