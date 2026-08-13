CREATE OR REPLACE VIEW public.impulse_entry_lifecycle_replay_summary
WITH (security_invoker = true) AS
SELECT
  user_id, bot_id, evidence_source,
  COUNT(*) AS replay_count,
  COUNT(*) FILTER (WHERE entered) AS entries,
  COUNT(*) FILTER (WHERE rescued_deeper_entry) AS deeper_entries,
  COUNT(*) FILTER (WHERE rescued_deeper_entry AND outcome = 'won') AS rescued_winners,
  COUNT(*) FILTER (WHERE retained_winner) AS winners_retained,
  COUNT(*) FILTER (WHERE rescued_deeper_entry AND outcome = 'lost') AS added_losses,
  COUNT(*) FILTER (WHERE outcome = 'won') AS winners,
  COUNT(*) FILTER (WHERE outcome = 'lost') AS losers,
  ROUND(AVG(mfe), 6) AS avg_mfe,
  ROUND(AVG(mae), 6) AS avg_mae,
  COUNT(*) FILTER (WHERE outcome IN ('won', 'lost')) >= 30 AS minimum_sample_ready,
  -- Existing view columns above must retain their positions. PostgreSQL only
  -- permits CREATE OR REPLACE VIEW to append new columns.
  COUNT(*) FILTER (WHERE NOT entered OR outcome = 'no_entry') AS no_entries,
  COUNT(*) FILTER (
    WHERE NOT entered AND NOT jsonb_path_exists(
      result, '$.transitions[*] ? (@.event == "zone_touched")'
    )
  ) AS never_touched,
  COUNT(*) FILTER (
    WHERE NOT entered
      AND jsonb_path_exists(result, '$.transitions[*] ? (@.event == "zone_touched")')
      AND NOT jsonb_path_exists(result, '$.transitions[*] ? (@.event == "trigger_locked")')
  ) AS touched_trigger_not_locked,
  COUNT(*) FILTER (
    WHERE NOT entered
      AND jsonb_path_exists(result, '$.transitions[*] ? (@.event == "trigger_locked")')
      AND NOT jsonb_path_exists(result, '$.transitions[*] ? (@.event == "confirmation_passed")')
  ) AS trigger_locked_not_confirmed,
  COUNT(*) FILTER (WHERE outcome = 'inconclusive') AS inconclusive,
  COUNT(*) FILTER (WHERE outcome IN ('won', 'lost')) AS resolved_outcomes,
  COUNT(*) FILTER (WHERE result ->> 'finalStatus' = 'invalidated') AS invalidated,
  COUNT(*) FILTER (WHERE result ->> 'finalStatus' = 'expired') AS expired,
  COUNT(*) FILTER (WHERE result ->> 'finalStatus' = 'exhausted') AS exhausted
FROM public.impulse_entry_lifecycle_replays
GROUP BY user_id, bot_id, evidence_source;

GRANT SELECT ON public.impulse_entry_lifecycle_replay_summary TO authenticated, service_role;
