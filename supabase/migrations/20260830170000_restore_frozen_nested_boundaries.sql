-- Restore active Watchlist boundaries that were incorrectly re-derived from
-- an exact nested trigger instead of preserving the parent-zone boundary.
--
-- The scanner recorded both values in the structural_boundary_repaired audit
-- event. Use that immutable evidence rather than attempting to reproduce old
-- runtime configuration or instrument pip-size rules in SQL.

WITH first_incorrect_repair AS (
  SELECT DISTINCT ON (event.staged_setup_id)
    event.staged_setup_id,
    (
      event.evidence #>>
        '{lifecycleEvidence,detail,previousBoundary}'
    )::numeric AS previous_boundary,
    (
      event.evidence #>>
        '{lifecycleEvidence,detail,repairedBoundary}'
    )::numeric AS repaired_boundary
  FROM public.setup_lifecycle_events AS event
  WHERE event.reason_code = 'structural_boundary_repaired'
    AND jsonb_typeof(
      event.evidence #>
        '{lifecycleEvidence,detail,previousBoundary}'
    ) = 'number'
    AND jsonb_typeof(
      event.evidence #>
        '{lifecycleEvidence,detail,repairedBoundary}'
    ) = 'number'
  ORDER BY event.staged_setup_id, event.created_at ASC
), restored AS (
  UPDATE public.staged_setups AS s
     SET sl_level = repair.previous_boundary,
         lifecycle_reason =
           'Restored original frozen parent-zone structural boundary',
         lifecycle_reason_code = 'structural_boundary_restored',
         lifecycle_evidence = COALESCE(s.lifecycle_evidence, '{}'::jsonb) ||
           jsonb_build_object(
             'reasonCode', 'structural_boundary_restored',
             'observedAt', now(),
             'boundary', jsonb_build_object(
               'level', repair.previous_boundary,
               'source', 'audit_history_restore',
               'bufferPrice', 0
             ),
             'detail', COALESCE(
               s.lifecycle_evidence -> 'detail',
               '{}'::jsonb
             ) || jsonb_build_object(
               'incorrectBoundary', repair.repaired_boundary,
               'restoredBoundary', repair.previous_boundary
             )
           ),
         last_eval_at = now()
    FROM first_incorrect_repair AS repair
   WHERE s.id = repair.staged_setup_id
     AND s.status IN ('watching', 'qualified')
     AND s.sl_level = repair.repaired_boundary
  RETURNING s.*
)
INSERT INTO public.setup_lifecycle_events (
  staged_setup_id,
  candidate_id,
  user_id,
  bot_id,
  symbol,
  direction,
  from_status,
  to_status,
  reason,
  reason_code,
  evidence
)
SELECT
  restored.id,
  restored.candidate_id,
  restored.user_id,
  restored.bot_id,
  restored.symbol,
  restored.direction,
  restored.status,
  restored.status,
  restored.lifecycle_reason,
  restored.lifecycle_reason_code,
  jsonb_build_object(
    'lifecycleVersion', restored.lifecycle_version,
    'originatingZone', restored.originating_zone,
    'lifecycleEvidence', restored.lifecycle_evidence
  )
FROM restored;
