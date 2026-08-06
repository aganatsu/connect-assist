-- Phase 3: allow audited pre-lock trigger revisions. A revision only describes
-- evolving structure; only trigger_locked and confirmation_passed are terminal
-- confirmation authority events.

ALTER TABLE public.impulse_entry_lifecycle_transitions
  DROP CONSTRAINT IF EXISTS impulse_entry_lifecycle_transitions_event_type_check;
ALTER TABLE public.impulse_entry_lifecycle_transitions
  ADD CONSTRAINT impulse_entry_lifecycle_transitions_event_type_check CHECK (
    event_type IN (
      'created', 'zone_touched', 'candidate_failed', 'trigger_revised',
      'trigger_locked', 'confirmation_passed', 'impulse_invalidated', 'expired'
    )
  );

CREATE INDEX IF NOT EXISTS idx_impulse_confirmation_transition
  ON public.impulse_entry_lifecycle_transitions (
    lifecycle_id, event_type, created_at DESC
  ) WHERE event_type IN ('trigger_revised', 'trigger_locked', 'confirmation_passed');

COMMENT ON COLUMN public.impulse_entry_lifecycle_transitions.event_type IS
  'Immutable lifecycle event. trigger_revised is non-authoritative; trigger_locked freezes the candidate-specific break contract.';
