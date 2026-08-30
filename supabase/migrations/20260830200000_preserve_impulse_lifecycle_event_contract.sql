-- Repair databases that applied the terminal lifecycle migration before its
-- event contract was corrected. The lifecycle state machine still emits the
-- nested-trigger and pre-lock revision events introduced by earlier migrations;
-- terminal synchronization adds setup_resolved without replacing those events.

ALTER TABLE public.impulse_entry_lifecycle_transitions
  DROP CONSTRAINT IF EXISTS impulse_entry_lifecycle_transitions_event_type_check;

ALTER TABLE public.impulse_entry_lifecycle_transitions
  ADD CONSTRAINT impulse_entry_lifecycle_transitions_event_type_check CHECK (
    event_type IN (
      'created', 'zone_touched', 'entry_trigger_touched', 'candidate_failed',
      'trigger_revised', 'trigger_locked', 'confirmation_passed',
      'impulse_invalidated', 'expired', 'setup_resolved'
    )
  );
