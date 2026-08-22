-- Counterfactual question:
-- For every distinct setup that still retains its planned-entry touch time,
-- if it had been filled at its stored entry, would the stored target or stored
-- stop have been reached first?
--
-- Edit only the params CTE, then run the whole file in the Supabase SQL editor.
-- The default user_id is the active account used for the August 2026 analysis.
-- Set style_filter to 'scalper', 'day_trader', or 'swing_trader' to isolate a
-- style; leave it NULL for all styles.
--
-- Outcome windows follow decision-outcome.v1:
--   scalper: 1m candles / 8h
--   day_trader: 5m candles / 24h
--   swing_trader: 1h candles / 72h
--   unknown: 15m candles / 24h
--
-- Immutable snapshots are stitched by completed-candle timestamp. Only mature
-- cohorts with continuous, conflict-free evidence through their decision point
-- are eligible. Cadence gaps, including market closures, are rejected rather
-- than treated as proof that neither stop nor target traded. Same-candle and
-- horizon-boundary ordering are inconclusive.
--
-- Stored provider metadata is advisory because the current capture path uses
-- global map keys. Actual OHLC disagreement is checked independently.
--
-- Scope limitation: this is a gross, price-only touch-entry replay. It does
-- not model confirmation timing, spread, commission, slippage, break-even,
-- trailing stops, partial exits, or fill-time authorization. pending_orders
-- can persist recalculated authorization geometry before the atomic fill RPC.
-- Filled/broker-resolution rows and any row with an approved final-
-- authorization observation are therefore excluded from the headline.
--
-- pending_orders is not a durable touch-event ledger. The scanner clears
-- zone_touch_time when a hunt resets or a lifecycle retargets. This report
-- exposes known cleared-touch rows as a lower bound. Original touch time and
-- geometry cannot be reconstructed from this table. The result is the
-- recoverable retained-touch cohort, not literally every historical touch.

WITH params AS (
  SELECT
    '57c79dee-db6b-4fae-b34a-4b64ce33ca34'::uuid AS user_id,
    'smc'::text AS bot_id,
    30::integer AS lookback_days,
    NULL::text AS style_filter
),
keyed_touches AS (
  SELECT
    p.*,
    COALESCE(
      p.impulse_entry_lifecycle_id::text,
      p.candidate_id::text,
      NULLIF(p.order_id, ''),
      p.id::text
    ) AS setup_key,
    COALESCE(
      NULLIF(p.frozen_strategy_context #>> '{stylePolicy,style}', ''),
      NULLIF(p.style_policy #>> '{style}', ''),
      'unknown'
    ) AS raw_style
  FROM public.pending_orders p
  CROSS JOIN params x
  WHERE p.user_id = x.user_id
    AND p.bot_id = x.bot_id
    AND p.zone_touch_time IS NOT NULL
),
known_cleared_touches AS (
  SELECT
    count(DISTINCT COALESCE(
      p.impulse_entry_lifecycle_id::text,
      p.candidate_id::text,
      NULLIF(p.order_id, ''),
      p.id::text
    ))::integer AS known_all_style_cleared_touch_setups_created_in_window
  FROM public.pending_orders p
  CROSS JOIN params x
  WHERE p.user_id = x.user_id
    AND p.bot_id = x.bot_id
    AND p.zone_touch_time IS NULL
    AND (
      COALESCE(p.confirmation_attempts, 0) > 0
      OR COALESCE(p.signal_reason, '{}'::jsonb) ? 'impulseLifecycleRetarget'
    )
    AND p.created_at >= now() - make_interval(days => x.lookback_days)
    AND NOT EXISTS (
      SELECT 1
      FROM keyed_touches k
      WHERE k.setup_key = COALESCE(
        p.impulse_entry_lifecycle_id::text,
        p.candidate_id::text,
        NULLIF(p.order_id, ''),
        p.id::text
      )
    )
),
ranked_touches AS (
  SELECT
    k.*,
    row_number() OVER (
      PARTITION BY k.setup_key
      ORDER BY k.zone_touch_time ASC, k.created_at ASC, k.id ASC
    ) AS setup_rank,
    count(*) OVER (PARTITION BY k.setup_key) AS rows_for_setup
  FROM keyed_touches k
),
styled_touches AS (
  SELECT
    r.*,
    CASE lower(replace(r.raw_style, ' ', '_'))
      WHEN 'scalper' THEN 'scalper'
      WHEN 'scalp' THEN 'scalper'
      WHEN 'day_trader' THEN 'day_trader'
      WHEN 'day' THEN 'day_trader'
      WHEN 'swing_trader' THEN 'swing_trader'
      WHEN 'swing' THEN 'swing_trader'
      ELSE 'unknown'
    END AS frozen_style
  FROM ranked_touches r
  WHERE r.setup_rank = 1
),
setups AS (
  SELECT
    s.id,
    s.setup_key,
    s.rows_for_setup,
    s.symbol,
    lower(s.direction) AS direction,
    s.status,
    s.cancel_reason,
    COALESCE((
      s.pending_authorization_observation->>'contractVersion'
        = 'pending-authorization-observation.v1'
      AND NULLIF(
        s.pending_authorization_observation
          #>> '{finalAuthorization,evaluatedAt}',
        ''
      ) IS NOT NULL
      AND s.pending_authorization_observation
        #> '{finalAuthorization,authorized}' = 'true'::jsonb
      AND s.pending_authorization_observation
        #>> '{finalAuthorization,code}' = 'authorized'
    ), false) AS final_authorization_approved,
    s.zone_touch_time,
    s.entry_price::numeric AS stored_entry,
    s.stop_loss::numeric AS stored_stop,
    s.take_profit::numeric AS stored_target,
    s.frozen_style,
    CASE s.frozen_style
      WHEN 'scalper' THEN '1m'
      WHEN 'day_trader' THEN '5m'
      WHEN 'swing_trader' THEN '1h'
      ELSE '15m'
    END AS replay_timeframe,
    CASE s.frozen_style
      WHEN 'scalper' THEN 1
      WHEN 'day_trader' THEN 5
      WHEN 'swing_trader' THEN 60
      ELSE 15
    END AS replay_interval_minutes,
    CASE s.frozen_style
      WHEN 'scalper' THEN 8
      WHEN 'swing_trader' THEN 72
      ELSE 24
    END AS outcome_window_hours,
    CASE
      WHEN lower(s.direction) = 'long'
        THEN s.stop_loss < s.entry_price
         AND s.entry_price < s.take_profit
      WHEN lower(s.direction) = 'short'
        THEN s.take_profit < s.entry_price
         AND s.entry_price < s.stop_loss
      ELSE false
    END AS geometry_valid
  FROM styled_touches s
  CROSS JOIN params x
  WHERE s.zone_touch_time >= now() - make_interval(days => x.lookback_days)
    AND (x.style_filter IS NULL OR s.frozen_style = x.style_filter)
),
analysis_setups AS (
  SELECT
    s.*,
    s.zone_touch_time + make_interval(hours => s.outcome_window_hours)
      AS outcome_horizon_at,
    s.zone_touch_time + make_interval(hours => s.outcome_window_hours) <= now()
      AS cohort_mature
  FROM setups s
),
normalized_snapshots AS (
  SELECT
    scs.*,
    CASE lower(replace(scs.timeframe, ' ', ''))
      WHEN '1min' THEN '1m'
      WHEN '1minute' THEN '1m'
      WHEN '5min' THEN '5m'
      WHEN '5minute' THEN '5m'
      WHEN '15min' THEN '15m'
      WHEN '15minute' THEN '15m'
      WHEN '60min' THEN '1h'
      WHEN '1hour' THEN '1h'
      ELSE lower(replace(scs.timeframe, ' ', ''))
    END AS normalized_timeframe
  FROM public.scan_candle_snapshots scs
  CROSS JOIN params x
  WHERE scs.user_id = x.user_id
    AND scs.bot_id = x.bot_id
    AND EXISTS (
      SELECT 1
      FROM analysis_setups s
      WHERE s.symbol = scs.symbol
        AND s.zone_touch_time <= scs.observed_at
        AND s.replay_timeframe = CASE lower(replace(scs.timeframe, ' ', ''))
          WHEN '1min' THEN '1m'
          WHEN '1minute' THEN '1m'
          WHEN '5min' THEN '5m'
          WHEN '5minute' THEN '5m'
          WHEN '15min' THEN '15m'
          WHEN '15minute' THEN '15m'
          WHEN '60min' THEN '1h'
          WHEN '1hour' THEN '1h'
          ELSE lower(replace(scs.timeframe, ' ', ''))
        END
    )
),
snapshot_catalog AS MATERIALIZED (
  SELECT
    ns.*,
    bounds.first_candle_at AS snapshot_first_candle_at,
    bounds.last_candle_at AS snapshot_last_candle_at
  FROM normalized_snapshots ns
  CROSS JOIN LATERAL (
    SELECT
      min(NULLIF(c.value ->> 'datetime', '')::timestamptz)
        AS first_candle_at,
      max(NULLIF(c.value ->> 'datetime', '')::timestamptz)
        AS last_candle_at
    FROM jsonb_array_elements(ns.candles) c(value)
  ) bounds
  WHERE bounds.first_candle_at IS NOT NULL
    AND bounds.last_candle_at IS NOT NULL
),
candidate_snapshots AS (
  SELECT
    s.id AS pending_id,
    sc.*
  FROM analysis_setups s
  JOIN snapshot_catalog sc
    ON sc.symbol = s.symbol
   AND sc.normalized_timeframe = s.replay_timeframe
   AND sc.snapshot_first_candle_at < s.outcome_horizon_at
   AND sc.snapshot_last_candle_at
         + make_interval(mins => s.replay_interval_minutes)
       > s.zone_touch_time
),
raw_candles AS MATERIALIZED (
  SELECT
    cs.pending_id,
    cs.id AS snapshot_id,
    cs.scan_cycle_id,
    cs.observed_at,
    cs.provider,
    cs.contract_version,
    c.ordinality AS candle_ordinal,
    q.candle_at,
    q.open_price,
    q.high_price,
    q.low_price,
    q.close_price
  FROM candidate_snapshots cs
  JOIN analysis_setups s ON s.id = cs.pending_id
  CROSS JOIN LATERAL
    jsonb_array_elements(cs.candles) WITH ORDINALITY c(value, ordinality)
  CROSS JOIN LATERAL (
    SELECT
      NULLIF(c.value ->> 'datetime', '')::timestamptz AS candle_at,
      NULLIF(c.value ->> 'open', '')::numeric AS open_price,
      NULLIF(c.value ->> 'high', '')::numeric AS high_price,
      NULLIF(c.value ->> 'low', '')::numeric AS low_price,
      NULLIF(c.value ->> 'close', '')::numeric AS close_price
  ) q
  WHERE q.candle_at IS NOT NULL
    AND q.open_price IS NOT NULL
    AND q.high_price IS NOT NULL
    AND q.low_price IS NOT NULL
    AND q.close_price IS NOT NULL
    AND q.candle_at + make_interval(mins => s.replay_interval_minutes)
        > s.zone_touch_time
    AND q.candle_at < s.outcome_horizon_at
),
timestamp_versions AS (
  SELECT
    pending_id,
    candle_at,
    count(*)::integer AS source_row_count,
    count(DISTINCT snapshot_id)::integer AS snapshot_version_count,
    count(DISTINCT provider)::integer AS stored_provider_count,
    count(DISTINCT ROW(
      open_price,
      high_price,
      low_price,
      close_price
    ))::integer AS ohlc_version_count
  FROM raw_candles
  GROUP BY pending_id, candle_at
),
ranked_versions AS (
  SELECT
    r.*,
    row_number() OVER (
      PARTITION BY r.pending_id, r.candle_at
      ORDER BY
        r.observed_at ASC,
        r.snapshot_id ASC,
        r.provider ASC,
        r.candle_ordinal ASC
    ) AS version_rank
  FROM raw_candles r
),
canonical_candles AS (
  SELECT
    r.*,
    v.source_row_count,
    v.snapshot_version_count,
    v.stored_provider_count,
    v.ohlc_version_count
  FROM ranked_versions r
  JOIN timestamp_versions v USING (pending_id, candle_at)
  WHERE r.version_rank = 1
),
series_provenance AS (
  SELECT
    pending_id,
    count(DISTINCT snapshot_id)::integer AS source_snapshot_count,
    array_agg(DISTINCT snapshot_id ORDER BY snapshot_id)
      AS source_snapshot_ids,
    min(observed_at) AS first_snapshot_observed_at,
    max(observed_at) AS last_snapshot_observed_at,
    count(DISTINCT provider)::integer AS stored_provider_count,
    array_agg(DISTINCT provider ORDER BY provider) AS stored_providers
  FROM raw_candles
  GROUP BY pending_id
),
version_audit AS (
  SELECT
    pending_id,
    count(*) FILTER (
      WHERE source_row_count > 1
    )::integer AS overlapping_timestamp_count,
    COALESCE(sum(source_row_count - 1), 0)::integer
      AS duplicate_source_row_count,
    count(*) FILTER (
      WHERE ohlc_version_count > 1
    )::integer AS ohlc_conflict_timestamp_count,
    count(*) FILTER (
      WHERE stored_provider_count > 1
    )::integer AS multi_provider_timestamp_count
  FROM timestamp_versions
  GROUP BY pending_id
),
canonical_with_previous AS (
  SELECT
    c.*,
    lag(c.candle_at) OVER (
      PARTITION BY c.pending_id
      ORDER BY c.candle_at
    ) AS previous_candle_at
  FROM canonical_candles c
),
cadenced_candles AS (
  SELECT
    c.*,
    extract(epoch FROM (c.candle_at - c.previous_candle_at))
      AS cadence_delta_seconds
  FROM canonical_with_previous c
),
raw_events AS (
  SELECT
    s.*,
    count(c.candle_at)::integer AS total_stitched_bars,
    count(c.candle_at) FILTER (
      WHERE c.candle_at <= s.zone_touch_time
        AND c.candle_at + make_interval(mins => s.replay_interval_minutes)
            > s.zone_touch_time
    )::integer AS touch_candle_count,
    min(c.candle_at) FILTER (
      WHERE c.candle_at <= s.zone_touch_time
        AND c.candle_at + make_interval(mins => s.replay_interval_minutes)
            > s.zone_touch_time
    ) AS touch_candle_at,
    COALESCE(bool_or(
      (s.direction = 'long' AND c.high_price >= s.stored_target)
      OR (s.direction = 'short' AND c.low_price <= s.stored_target)
    ) FILTER (
      WHERE c.candle_at <= s.zone_touch_time
        AND c.candle_at + make_interval(mins => s.replay_interval_minutes)
            > s.zone_touch_time
    ), false) AS target_on_touch_candle,
    COALESCE(bool_or(
      (s.direction = 'long' AND c.low_price <= s.stored_stop)
      OR (s.direction = 'short' AND c.high_price >= s.stored_stop)
    ) FILTER (
      WHERE c.candle_at <= s.zone_touch_time
        AND c.candle_at + make_interval(mins => s.replay_interval_minutes)
            > s.zone_touch_time
    ), false) AS stop_on_touch_candle,
    min(c.candle_at) FILTER (
      WHERE c.candle_at > s.zone_touch_time
        AND c.candle_at + make_interval(mins => s.replay_interval_minutes)
            <= s.outcome_horizon_at
        AND (
          (s.direction = 'long' AND c.high_price >= s.stored_target)
          OR (s.direction = 'short' AND c.low_price <= s.stored_target)
        )
    ) AS first_target_at,
    min(c.candle_at) FILTER (
      WHERE c.candle_at > s.zone_touch_time
        AND c.candle_at + make_interval(mins => s.replay_interval_minutes)
            <= s.outcome_horizon_at
        AND (
          (s.direction = 'long' AND c.low_price <= s.stored_stop)
          OR (s.direction = 'short' AND c.high_price >= s.stored_stop)
        )
    ) AS first_stop_at,
    COALESCE(bool_or(
      (s.direction = 'long' AND c.high_price >= s.stored_target)
      OR (s.direction = 'short' AND c.low_price <= s.stored_target)
    ) FILTER (
      WHERE c.candle_at < s.outcome_horizon_at
        AND c.candle_at + make_interval(mins => s.replay_interval_minutes)
            > s.outcome_horizon_at
    ), false) AS target_on_horizon_straddler,
    COALESCE(bool_or(
      (s.direction = 'long' AND c.low_price <= s.stored_stop)
      OR (s.direction = 'short' AND c.high_price >= s.stored_stop)
    ) FILTER (
      WHERE c.candle_at < s.outcome_horizon_at
        AND c.candle_at + make_interval(mins => s.replay_interval_minutes)
            > s.outcome_horizon_at
    ), false) AS stop_on_horizon_straddler
  FROM analysis_setups s
  LEFT JOIN canonical_candles c ON c.pending_id = s.id
  GROUP BY
    s.id,
    s.setup_key,
    s.rows_for_setup,
    s.symbol,
    s.direction,
    s.status,
    s.cancel_reason,
    s.final_authorization_approved,
    s.zone_touch_time,
    s.stored_entry,
    s.stored_stop,
    s.stored_target,
    s.frozen_style,
    s.replay_timeframe,
    s.replay_interval_minutes,
    s.outcome_window_hours,
    s.geometry_valid,
    s.outcome_horizon_at,
    s.cohort_mature
),
provisional_outcomes AS (
  SELECT
    e.*,
    CASE
      WHEN e.target_on_touch_candle OR e.stop_on_touch_candle
        THEN 'ambiguous_entry_candle'
      WHEN e.first_target_at IS NOT NULL
       AND e.first_stop_at IS NOT NULL
       AND e.first_target_at = e.first_stop_at
        THEN 'ambiguous_same_candle'
      WHEN e.first_target_at IS NOT NULL
       AND (e.first_stop_at IS NULL OR e.first_target_at < e.first_stop_at)
        THEN 'would_have_won'
      WHEN e.first_stop_at IS NOT NULL
       AND (e.first_target_at IS NULL OR e.first_stop_at < e.first_target_at)
        THEN 'would_have_lost'
      WHEN e.target_on_horizon_straddler OR e.stop_on_horizon_straddler
        THEN 'ambiguous_horizon_candle'
      ELSE 'open_at_horizon'
    END AS provisional_outcome,
    CASE
      WHEN e.target_on_touch_candle OR e.stop_on_touch_candle
        THEN e.touch_candle_at
      WHEN e.first_target_at IS NOT NULL AND e.first_stop_at IS NOT NULL
        THEN least(e.first_target_at, e.first_stop_at)
      ELSE COALESCE(e.first_target_at, e.first_stop_at)
    END AS decision_candle_at
  FROM raw_events e
),
required_windows AS (
  SELECT
    p.*,
    CASE
      WHEN p.provisional_outcome IN (
        'open_at_horizon',
        'ambiguous_horizon_candle'
      ) THEN p.outcome_horizon_at
      ELSE p.decision_candle_at
        + make_interval(mins => p.replay_interval_minutes)
    END AS required_coverage_end_at
  FROM provisional_outcomes p
),
series_quality AS (
  SELECT
    w.id AS pending_id,
    count(c.candle_at)::integer AS available_bars,
    min(c.candle_at) AS first_candle_at,
    max(c.candle_at + make_interval(mins => w.replay_interval_minutes))
      AS coverage_end_at,
    max(c.cadence_delta_seconds / 60.0) AS largest_gap_minutes,
    count(*) FILTER (
      WHERE c.candle_at < w.required_coverage_end_at
        AND c.ohlc_version_count > 1
    )::integer AS relevant_ohlc_conflict_count,
    count(*) FILTER (
      WHERE c.candle_at < w.required_coverage_end_at
        AND c.previous_candle_at IS NOT NULL
        AND c.cadence_delta_seconds
            > w.replay_interval_minutes * 60 + 1
    )::integer AS relevant_cadence_gap_count,
    count(*) FILTER (
      WHERE c.candle_at < w.required_coverage_end_at
        AND c.previous_candle_at IS NOT NULL
        AND c.cadence_delta_seconds
            < w.replay_interval_minutes * 60 - 1
    )::integer AS relevant_cadence_overlap_count,
    count(*) FILTER (
      WHERE c.candle_at < w.required_coverage_end_at
        AND c.stored_provider_count > 1
    )::integer AS relevant_multi_provider_overlap_count,
    count(DISTINCT c.provider) FILTER (
      WHERE c.candle_at < w.required_coverage_end_at
    )::integer AS relevant_selected_provider_count
  FROM required_windows w
  LEFT JOIN cadenced_candles c ON c.pending_id = w.id
  GROUP BY w.id
),
measured AS (
  SELECT
    w.*,
    COALESCE(p.source_snapshot_count, 0) AS source_snapshot_count,
    p.source_snapshot_ids,
    p.first_snapshot_observed_at,
    p.last_snapshot_observed_at,
    COALESCE(p.stored_provider_count, 0) AS stored_provider_count,
    p.stored_providers,
    COALESCE(v.overlapping_timestamp_count, 0)
      AS overlapping_timestamp_count,
    COALESCE(v.duplicate_source_row_count, 0)
      AS duplicate_source_row_count,
    COALESCE(v.ohlc_conflict_timestamp_count, 0)
      AS ohlc_conflict_timestamp_count,
    COALESCE(v.multi_provider_timestamp_count, 0)
      AS multi_provider_timestamp_count,
    COALESCE(q.available_bars, 0) AS available_bars,
    q.first_candle_at,
    q.coverage_end_at,
    q.largest_gap_minutes,
    COALESCE(q.relevant_ohlc_conflict_count, 0)
      AS relevant_ohlc_conflict_count,
    COALESCE(q.relevant_cadence_gap_count, 0)
      AS relevant_cadence_gap_count,
    COALESCE(q.relevant_cadence_overlap_count, 0)
      AS relevant_cadence_overlap_count,
    COALESCE(q.relevant_multi_provider_overlap_count, 0)
      AS relevant_multi_provider_overlap_count,
    COALESCE(q.relevant_selected_provider_count, 0)
      AS relevant_selected_provider_count
  FROM required_windows w
  LEFT JOIN series_provenance p ON p.pending_id = w.id
  LEFT JOIN version_audit v ON v.pending_id = w.id
  LEFT JOIN series_quality q ON q.pending_id = w.id
),
classified AS (
  SELECT
    m.*,
    CASE
      WHEN NOT m.geometry_valid THEN 'invalid_stored_geometry'
      WHEN NOT m.cohort_mature THEN 'cohort_immature'
      WHEN lower(m.status) IN (
        'filled',
        'broker_rejected',
        'reconciliation_required'
      ) OR m.final_authorization_approved
        THEN 'authorization_geometry_not_comparable'
      WHEN m.available_bars = 0 THEN 'candle_data_unavailable'
      WHEN m.touch_candle_count <> 1 THEN 'touch_candle_unavailable'
      WHEN m.relevant_ohlc_conflict_count > 0
        THEN 'conflicting_ohlc_versions'
      WHEN m.relevant_cadence_gap_count > 0 THEN 'candle_cadence_gap'
      WHEN m.relevant_cadence_overlap_count > 0 THEN 'candle_cadence_overlap'
      WHEN m.coverage_end_at IS NULL
        OR m.coverage_end_at < m.required_coverage_end_at
        THEN 'required_window_not_covered'
      ELSE m.provisional_outcome
    END AS counterfactual_outcome
  FROM measured m
),
eligible AS (
  SELECT
    c.*,
    c.counterfactual_outcome IN (
      'would_have_won',
      'would_have_lost',
      'ambiguous_entry_candle',
      'ambiguous_same_candle',
      'ambiguous_horizon_candle',
      'open_at_horizon'
    ) AS headline_eligible
  FROM classified c
),
with_counts AS (
  SELECT
    c.*,
    k.known_all_style_cleared_touch_setups_created_in_window,
    count(*) OVER () AS retained_distinct_touched,
    count(*) FILTER (WHERE c.cohort_mature) OVER () AS mature_retained_touched,
    count(*) FILTER (WHERE c.headline_eligible) OVER ()
      AS headline_eligible_touched,
    count(*) FILTER (
      WHERE c.headline_eligible
        AND c.counterfactual_outcome = 'would_have_won'
    ) OVER () AS resolved_wins,
    count(*) FILTER (
      WHERE c.headline_eligible
        AND c.counterfactual_outcome = 'would_have_lost'
    ) OVER () AS resolved_losses,
    count(*) FILTER (
      WHERE c.headline_eligible
        AND c.counterfactual_outcome LIKE 'ambiguous_%'
    ) OVER () AS ambiguous_count,
    count(*) FILTER (
      WHERE c.headline_eligible
        AND c.counterfactual_outcome = 'ambiguous_horizon_candle'
    ) OVER () AS horizon_ambiguity_count,
    count(*) FILTER (
      WHERE c.headline_eligible
        AND c.counterfactual_outcome = 'open_at_horizon'
    ) OVER () AS unresolved_count,
    count(*) FILTER (
      WHERE c.cohort_mature AND NOT c.headline_eligible
    ) OVER () AS unusable_count,
    count(*) FILTER (
      WHERE c.cohort_mature
        AND c.counterfactual_outcome =
          'authorization_geometry_not_comparable'
    ) OVER () AS authorization_geometry_excluded_count,
    count(*) FILTER (
      WHERE c.cohort_mature AND lower(c.status) = 'filled'
    ) OVER () AS filled_status_excluded_count,
    count(*) FILTER (
      WHERE c.cohort_mature AND c.source_snapshot_count > 1
    ) OVER () AS stitched_setup_count,
    count(*) FILTER (
      WHERE c.cohort_mature AND c.ohlc_conflict_timestamp_count > 0
    ) OVER () AS ohlc_conflict_setup_count,
    count(*) FILTER (
      WHERE c.cohort_mature AND c.stored_provider_count > 1
    ) OVER () AS mixed_stored_provider_setup_count,
    count(*) FILTER (
      WHERE c.cohort_mature AND c.relevant_cadence_gap_count > 0
    ) OVER () AS cadence_gap_setup_count,
    count(*) FILTER (
      WHERE c.cohort_mature
        AND c.counterfactual_outcome = 'required_window_not_covered'
    ) OVER () AS incomplete_required_window_count,
    count(*) FILTER (WHERE c.headline_eligible)
      OVER (PARTITION BY c.frozen_style) AS style_eligible_touched,
    count(*) FILTER (
      WHERE c.headline_eligible
        AND c.counterfactual_outcome = 'would_have_won'
    ) OVER (PARTITION BY c.frozen_style) AS style_wins,
    count(*) FILTER (
      WHERE c.headline_eligible
        AND c.counterfactual_outcome = 'would_have_lost'
    ) OVER (PARTITION BY c.frozen_style) AS style_losses
  FROM eligible c
  CROSS JOIN known_cleared_touches k
)
SELECT
  retained_distinct_touched,
  known_all_style_cleared_touch_setups_created_in_window,
  mature_retained_touched,
  headline_eligible_touched,
  resolved_wins,
  resolved_losses,
  resolved_wins + resolved_losses AS resolved_trades,
  round(
    100.0 * resolved_wins / nullif(resolved_wins + resolved_losses, 0),
    2
  ) AS resolved_win_rate_pct,
  round(
    100.0 * resolved_wins / nullif(headline_eligible_touched, 0),
    2
  ) AS winner_share_of_eligible_touches_pct,
  ambiguous_count,
  horizon_ambiguity_count,
  unresolved_count,
  unusable_count,
  authorization_geometry_excluded_count,
  filled_status_excluded_count,
  stitched_setup_count,
  ohlc_conflict_setup_count,
  mixed_stored_provider_setup_count,
  cadence_gap_setup_count,
  incomplete_required_window_count,
  frozen_style,
  style_eligible_touched,
  style_wins,
  style_losses,
  round(
    100.0 * style_wins / nullif(style_wins + style_losses, 0),
    2
  ) AS style_resolved_win_rate_pct,
  setup_key,
  rows_for_setup,
  symbol,
  direction,
  status,
  cancel_reason,
  final_authorization_approved,
  zone_touch_time,
  cohort_mature,
  headline_eligible,
  replay_timeframe,
  outcome_window_hours,
  stored_entry,
  stored_stop,
  stored_target,
  round(
    abs(stored_target - stored_entry)
      / nullif(abs(stored_entry - stored_stop), 0),
    3
  ) AS stored_rr,
  counterfactual_outcome,
  provisional_outcome,
  first_target_at,
  first_stop_at,
  CASE WHEN first_target_at IS NOT NULL THEN round(
    extract(epoch FROM (first_target_at - zone_touch_time)) / 3600,
    2
  ) END AS hours_to_target,
  CASE WHEN first_stop_at IS NOT NULL THEN round(
    extract(epoch FROM (first_stop_at - zone_touch_time)) / 3600,
    2
  ) END AS hours_to_stop,
  required_coverage_end_at,
  source_snapshot_count,
  source_snapshot_ids,
  first_snapshot_observed_at,
  last_snapshot_observed_at,
  stored_provider_count,
  stored_providers,
  available_bars,
  first_candle_at,
  coverage_end_at,
  largest_gap_minutes,
  relevant_cadence_gap_count,
  relevant_cadence_overlap_count,
  overlapping_timestamp_count,
  duplicate_source_row_count,
  relevant_ohlc_conflict_count,
  ohlc_conflict_timestamp_count,
  relevant_multi_provider_overlap_count,
  multi_provider_timestamp_count,
  relevant_selected_provider_count,
  outcome_horizon_at,
  'decision-outcome.v1; stitched immutable candles; retained-touch cohort; gross original geometry only; authorization-mutated geometry excluded; provider metadata advisory; no confirmation timing, spread, commission, slippage, trailing, partials, break-even, or fill-time authorization simulation'
    AS model_scope
FROM with_counts
ORDER BY zone_touch_time DESC, symbol;
