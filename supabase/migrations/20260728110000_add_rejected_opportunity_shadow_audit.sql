-- Analytics-only metadata for Gameplan shadow evaluation.
-- These columns do not participate in scanner gating, sizing, or execution.

ALTER TABLE public.rejected_setups
  ADD COLUMN IF NOT EXISTS normalized_gates TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS opportunity_key TEXT,
  ADD COLUMN IF NOT EXISTS shadow_decision JSONB;

CREATE INDEX IF NOT EXISTS idx_rejected_setups_opportunity_recent
  ON public.rejected_setups (user_id, bot_id, opportunity_key, rejected_at DESC);

CREATE INDEX IF NOT EXISTS idx_rejected_setups_normalized_gates
  ON public.rejected_setups USING GIN (normalized_gates);

COMMENT ON COLUMN public.rejected_setups.opportunity_key IS
  'Stable grouping key used with a rolling time window to collapse repeated scan records into one market opportunity.';

COMMENT ON COLUMN public.rejected_setups.shadow_decision IS
  'Observational Gameplan hierarchy decision. Never used by trade execution.';
