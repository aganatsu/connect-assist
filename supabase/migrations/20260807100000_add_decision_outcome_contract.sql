ALTER TABLE public.rejected_setups
  ADD COLUMN IF NOT EXISTS decision_outcome_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS outcome_contract_version TEXT,
  ADD COLUMN IF NOT EXISTS outcome_window_hours INTEGER,
  ADD COLUMN IF NOT EXISTS outcome_reason TEXT,
  ADD COLUMN IF NOT EXISTS sl_hit_time_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS mfe_r NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS mae_r NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS outcome_r NUMERIC(10,3);
COMMENT ON COLUMN public.rejected_setups.decision_outcome_snapshot IS 'Point-in-time analytics snapshot separating authority, supporting evidence, operational safety, and legacy diagnostics.';
COMMENT ON COLUMN public.rejected_setups.outcome_reason IS 'Machine-readable reason for resolved or inconclusive counterfactual outcome classification.';
COMMENT ON COLUMN public.rejected_setups.outcome_r IS 'Counterfactual result normalized by initial risk. Analytics only; never trading authority.';
