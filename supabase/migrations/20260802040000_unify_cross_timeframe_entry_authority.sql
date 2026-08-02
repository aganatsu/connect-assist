-- Phase 8: persist and audit the same frozen Cross-Timeframe Authority
-- decision across Watchlist, pending and position stages.
--
-- Runtime behavior remains capped by the evidence activation registry. This
-- migration never creates an activation or changes a requested mode.

ALTER TABLE public.staged_setups
  ADD COLUMN IF NOT EXISTS cross_tf_entry_authority JSONB
    GENERATED ALWAYS AS (
      frozen_strategy_context #> '{crossTimeframeContext,authority}'
    ) STORED,
  ADD COLUMN IF NOT EXISTS cross_tf_effective_mode TEXT
    GENERATED ALWAYS AS (
      frozen_strategy_context #>>
        '{crossTimeframeContext,authority,effectiveMode}'
    ) STORED,
  ADD COLUMN IF NOT EXISTS cross_tf_entry_allowed BOOLEAN
    GENERATED ALWAYS AS (
      CASE
        WHEN frozen_strategy_context #>
          '{crossTimeframeContext,authority,allowed}' IS NULL THEN NULL
        ELSE (
          frozen_strategy_context #>>
            '{crossTimeframeContext,authority,allowed}'
        )::BOOLEAN
      END
    ) STORED;

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS cross_tf_entry_authority JSONB
    GENERATED ALWAYS AS (
      frozen_strategy_context #> '{crossTimeframeContext,authority}'
    ) STORED,
  ADD COLUMN IF NOT EXISTS cross_tf_effective_mode TEXT
    GENERATED ALWAYS AS (
      frozen_strategy_context #>>
        '{crossTimeframeContext,authority,effectiveMode}'
    ) STORED,
  ADD COLUMN IF NOT EXISTS cross_tf_entry_allowed BOOLEAN
    GENERATED ALWAYS AS (
      CASE
        WHEN frozen_strategy_context #>
          '{crossTimeframeContext,authority,allowed}' IS NULL THEN NULL
        ELSE (
          frozen_strategy_context #>>
            '{crossTimeframeContext,authority,allowed}'
        )::BOOLEAN
      END
    ) STORED;

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS cross_tf_entry_authority JSONB
    GENERATED ALWAYS AS (
      frozen_strategy_context #> '{crossTimeframeContext,authority}'
    ) STORED,
  ADD COLUMN IF NOT EXISTS cross_tf_effective_mode TEXT
    GENERATED ALWAYS AS (
      frozen_strategy_context #>>
        '{crossTimeframeContext,authority,effectiveMode}'
    ) STORED,
  ADD COLUMN IF NOT EXISTS cross_tf_entry_allowed BOOLEAN
    GENERATED ALWAYS AS (
      CASE
        WHEN frozen_strategy_context #>
          '{crossTimeframeContext,authority,allowed}' IS NULL THEN NULL
        ELSE (
          frozen_strategy_context #>>
            '{crossTimeframeContext,authority,allowed}'
        )::BOOLEAN
      END
    ) STORED;

ALTER TABLE public.staged_setups
  DROP CONSTRAINT IF EXISTS staged_cross_tf_entry_authority_valid;
ALTER TABLE public.staged_setups
  ADD CONSTRAINT staged_cross_tf_entry_authority_valid CHECK (
    cross_tf_entry_authority IS NULL
    OR (
      cross_tf_entry_authority ->> 'contractVersion' =
        'cross-tf-entry-authority.v1'
      AND cross_tf_effective_mode IN ('observe', 'soft', 'hard')
      AND cross_tf_entry_allowed IS NOT NULL
    )
  );

ALTER TABLE public.pending_orders
  DROP CONSTRAINT IF EXISTS pending_cross_tf_entry_authority_valid;
ALTER TABLE public.pending_orders
  ADD CONSTRAINT pending_cross_tf_entry_authority_valid CHECK (
    cross_tf_entry_authority IS NULL
    OR (
      cross_tf_entry_authority ->> 'contractVersion' =
        'cross-tf-entry-authority.v1'
      AND cross_tf_effective_mode IN ('observe', 'soft', 'hard')
      AND cross_tf_entry_allowed IS NOT NULL
    )
  );

ALTER TABLE public.paper_positions
  DROP CONSTRAINT IF EXISTS position_cross_tf_entry_authority_valid;
ALTER TABLE public.paper_positions
  ADD CONSTRAINT position_cross_tf_entry_authority_valid CHECK (
    cross_tf_entry_authority IS NULL
    OR (
      cross_tf_entry_authority ->> 'contractVersion' =
        'cross-tf-entry-authority.v1'
      AND cross_tf_effective_mode IN ('observe', 'soft', 'hard')
      AND cross_tf_entry_allowed IS TRUE
      AND final_authorization #>>
        '{crossTimeframeAuthority,contractVersion}' =
        'cross-tf-entry-authority.v1'
      AND final_authorization #>>
        '{crossTimeframeAuthority,allowed}' = 'true'
    )
  );

CREATE INDEX IF NOT EXISTS idx_staged_cross_tf_authority
  ON public.staged_setups (
    user_id,
    bot_id,
    cross_tf_effective_mode,
    cross_tf_entry_allowed
  )
  WHERE cross_tf_entry_authority IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pending_cross_tf_authority
  ON public.pending_orders (
    user_id,
    bot_id,
    cross_tf_effective_mode,
    cross_tf_entry_allowed
  )
  WHERE cross_tf_entry_authority IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_positions_cross_tf_authority
  ON public.paper_positions (
    user_id,
    bot_id,
    cross_tf_effective_mode,
    cross_tf_entry_allowed
  )
  WHERE cross_tf_entry_authority IS NOT NULL;

CREATE OR REPLACE VIEW public.cross_timeframe_entry_authority_audit
WITH (security_invoker = true)
AS
SELECT
  'watchlist'::TEXT AS lifecycle_stage,
  staged.id AS row_id,
  staged.user_id,
  staged.bot_id,
  staged.symbol,
  staged.direction,
  staged.candidate_id,
  staged.cross_tf_effective_mode,
  staged.cross_tf_entry_allowed,
  staged.cross_tf_entry_authority,
  staged.staged_at AS observed_at
FROM public.staged_setups AS staged
WHERE staged.cross_tf_entry_authority IS NOT NULL
UNION ALL
SELECT
  'pending'::TEXT,
  pending.id,
  pending.user_id,
  pending.bot_id,
  pending.symbol,
  pending.direction,
  pending.candidate_id,
  pending.cross_tf_effective_mode,
  pending.cross_tf_entry_allowed,
  pending.cross_tf_entry_authority,
  pending.placed_at
FROM public.pending_orders AS pending
WHERE pending.cross_tf_entry_authority IS NOT NULL
UNION ALL
SELECT
  'position'::TEXT,
  position.id,
  position.user_id,
  position.bot_id,
  position.symbol,
  position.direction,
  position.candidate_id,
  position.cross_tf_effective_mode,
  position.cross_tf_entry_allowed,
  position.cross_tf_entry_authority,
  position.open_time
FROM public.paper_positions AS position
WHERE position.cross_tf_entry_authority IS NOT NULL;

REVOKE ALL ON public.cross_timeframe_entry_authority_audit FROM PUBLIC;
GRANT SELECT ON public.cross_timeframe_entry_authority_audit
  TO authenticated, service_role;

COMMENT ON VIEW public.cross_timeframe_entry_authority_audit IS
  'One read-only lifecycle audit of the frozen Cross-Timeframe Authority decision from Watchlist through fill.';
