-- Freeze the observation-only Canonical Dealing-Range Authority inside the
-- existing immutable setup strategy package. This migration does not gate or
-- authorize trades.

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
         ADD COLUMN IF NOT EXISTS canonical_dealing_range JSONB
           GENERATED ALWAYS AS (
             frozen_strategy_context #> ''{crossTimeframeContext,canonicalDealingRange}''
           ) STORED,
         ADD COLUMN IF NOT EXISTS canonical_dealing_range_version TEXT
           GENERATED ALWAYS AS (
             frozen_strategy_context #>> ''{crossTimeframeContext,canonicalDealingRange,range,contractVersion}''
           ) STORED,
         ADD COLUMN IF NOT EXISTS canonical_dealing_range_impulse_id TEXT
           GENERATED ALWAYS AS (
             frozen_strategy_context #>> ''{crossTimeframeContext,canonicalDealingRange,range,impulseId}''
           ) STORED,
         ADD COLUMN IF NOT EXISTS canonical_dealing_range_timeframe TEXT
           GENERATED ALWAYS AS (
             frozen_strategy_context #>> ''{crossTimeframeContext,canonicalDealingRange,range,timeframe}''
           ) STORED',
      table_name
    );

    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
      table_name,
      table_name || '_cross_tf_context_contract'
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
         frozen_strategy_context #> ''{crossTimeframeContext}'' IS NULL
         OR cross_tf_context_version IN (
           ''frozen-cross-tf-context.v1'',
           ''frozen-cross-tf-context.v2''
         )
       )',
      table_name,
      table_name || '_cross_tf_context_contract'
    );

    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
      table_name,
      table_name || '_canonical_dealing_range_valid'
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
         canonical_dealing_range IS NULL
         OR canonical_dealing_range ->> ''available'' = ''false''
         OR (
           canonical_dealing_range_version = ''canonical-dealing-range.v1''
           AND canonical_dealing_range_impulse_id IS NOT NULL
           AND canonical_dealing_range_timeframe IS NOT NULL
           AND (canonical_dealing_range #>> ''{range,high}'')::NUMERIC >
             (canonical_dealing_range #>> ''{range,low}'')::NUMERIC
           AND (canonical_dealing_range #>> ''{range,midpoint}'')::NUMERIC =
             (
               (canonical_dealing_range #>> ''{range,high}'')::NUMERIC +
               (canonical_dealing_range #>> ''{range,low}'')::NUMERIC
             ) / 2
         )
       )',
      table_name,
      table_name || '_canonical_dealing_range_valid'
    );
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS idx_staged_canonical_dealing_range
  ON public.staged_setups (
    user_id,
    bot_id,
    canonical_dealing_range_timeframe,
    canonical_dealing_range_impulse_id
  )
  WHERE canonical_dealing_range_impulse_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pending_canonical_dealing_range
  ON public.pending_orders (
    user_id,
    bot_id,
    canonical_dealing_range_timeframe,
    canonical_dealing_range_impulse_id
  )
  WHERE canonical_dealing_range_impulse_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_positions_canonical_dealing_range
  ON public.paper_positions (
    user_id,
    bot_id,
    canonical_dealing_range_timeframe,
    canonical_dealing_range_impulse_id
  )
  WHERE canonical_dealing_range_impulse_id IS NOT NULL;

COMMENT ON COLUMN public.staged_setups.canonical_dealing_range IS
  'Observation-only canonical impulse range frozen with the Watchlist setup.';
COMMENT ON COLUMN public.pending_orders.canonical_dealing_range IS
  'The unchanged canonical impulse range propagated from the originating setup.';
COMMENT ON COLUMN public.paper_positions.canonical_dealing_range IS
  'The unchanged canonical impulse range retained by the opened position.';
