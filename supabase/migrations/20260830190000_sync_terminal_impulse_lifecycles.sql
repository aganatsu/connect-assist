-- Keep the shared impulse lifecycle truthful when its linked staged setup,
-- pending order, or position reaches a terminal state outside candle replay.

ALTER TABLE public.impulse_entry_lifecycles
  DROP CONSTRAINT IF EXISTS impulse_entry_lifecycles_status_check;
ALTER TABLE public.impulse_entry_lifecycles
  ADD CONSTRAINT impulse_entry_lifecycles_status_check CHECK (
    status IN ('active', 'entered', 'invalidated', 'expired', 'exhausted', 'cancelled')
  );

ALTER TABLE public.impulse_entry_lifecycle_transitions
  DROP CONSTRAINT IF EXISTS impulse_entry_lifecycle_transitions_event_type_check;
ALTER TABLE public.impulse_entry_lifecycle_transitions
  ADD CONSTRAINT impulse_entry_lifecycle_transitions_event_type_check CHECK (
    event_type IN (
      'created', 'zone_touched', 'candidate_failed', 'trigger_locked',
      'confirmation_passed', 'impulse_invalidated', 'expired',
      'setup_resolved'
    )
  );
