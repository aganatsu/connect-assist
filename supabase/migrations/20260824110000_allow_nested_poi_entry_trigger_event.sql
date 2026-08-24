-- Nested POI market entry adds one audited transition to the existing impulse
-- lifecycle. Keep the database event contract aligned with the shared state
-- machine so an exact trigger touch can be persisted atomically.

ALTER TABLE public.impulse_entry_lifecycle_transitions
  DROP CONSTRAINT IF EXISTS impulse_entry_lifecycle_transitions_event_type_check;

ALTER TABLE public.impulse_entry_lifecycle_transitions
  ADD CONSTRAINT impulse_entry_lifecycle_transitions_event_type_check CHECK (
    event_type IN (
      'created', 'zone_touched', 'entry_trigger_touched', 'candidate_failed',
      'trigger_revised', 'trigger_locked', 'confirmation_passed',
      'impulse_invalidated', 'expired'
    )
  );
