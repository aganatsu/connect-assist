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
-- Only mature cohorts backed by one immutable snapshot spanning the complete
-- outcome window are eligible for the headline. Any interval gap, including a
-- legitimate market closure, makes the row unusable rather than silently
-- assuming that neither stop nor target traded during the gap. Same-candle
-- ordering is inconclusive.
--
-- Scope limitation: this is a gross, price-only touch-entry replay. It does
-- not model confirmation timing, spread, commission, slippage, break-even,
-- trailing stops, partial exits, or fill-time authorization. pending_orders
-- can store a recalculated authorization stop after a real fill, so filled
-- rows are excluded from the headline and counted separately.
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
),
snapshot_candidates AS (
  SELECT
    s.id AS pending_id,
    ns.id AS snapshot_id,
    ns.observed_at,
    ns.candles,
    bounds.first_candle_at,
    bounds.coverage_end_at,
    row_number() OVER (
      PARTITION BY s.id
      ORDER BY ns.observed_at ASC, ns.id ASC
    ) AS snapshot_rank
  FROM analysis_setups s
  JOIN normalized_snapshots ns
    ON ns.symbol = s.symbol
   AND ns.normalized_timeframe = s.replay_timeframe
   AND ns.observed_at >= s.outcome_horizon_at
  CROSS JOIN LATERAL (
    SELECT
      min(NULLIF(c.value ->> 'datetime', '')::timestamptz)
        AS first_candle_at,
      max(
        NULLIF(c.value ->> 'datetime', '')::timestamptz
          + make_interval(mins => s.replay_interval_minutes)
      ) AS coverage_end_at
    FROM jsonb_array_elements(ns.candles) c(value)
  ) bounds
  WHERE s.cohort_mature
    AND bounds.first_candle_at <= s.zone_touch_time
    AND bounds.coverage_end_at >= s.outcome_horizon_at
),
chosen_snapshots AS (
  SELECT *
  FROM snapshot_candidates
  WHERE snapshot_rank = 1
),
candles AS (
  SELECT DISTINCT
    cs.pending_id,
    q.candle_at,
    q.open_price,
    q.high_price,
    q.low_price,
    q.close_price
  FROM chosen_snapshots cs
  JOIN analysis_setups s ON s.id = cs.pending_id
  CROSS JOIN LATERAL jsonb_array_elements(cs.candles) c(value)
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
    AND q.candle_at <= s.outcome_horizon_at
),
candles_with_gaps AS (
  SELECT
    c.*,
    extract(epoch FROM (
      c.candle_at - lag(c.candle_at) OVER (
        PARTITION BY c.pending_id
        ORDER BY c.candle_at
      )
    )) / 60.0 AS gap_minutes
  FROM candles c
),
measured AS (
  SELECT
    s.*,
    cs.snapshot_id,
    cs.observed_at AS snapshot_observed_at,
    m.available_bars,
    m.first_candle_at,
    m.coverage_end_at,
    m.largest_gap_minutes,
    m.interval_gap_count,
    m.touch_candle_count,
    m.target_on_touch_candle,
    m.stop_on_touch_candle,
    m.first_target_at,
    m.first_stop_at
  FROM analysis_setups s
  LEFT JOIN chosen_snapshots cs ON cs.pending_id = s.id
  CROSS JOIN LATERAL (
    SELECT
      count(*)::integer AS available_bars,
      min(b.candle_at) AS first_candle_at,
      max(b.candle_at + make_interval(mins => s.replay_interval_minutes))
        AS coverage_end_at,
      max(b.gap_minutes) AS largest_gap_minutes,
      count(*) FILTER (
        WHERE b.gap_minutes > s.replay_interval_minutes * 1.5
      )::integer AS interval_gap_count,
      count(*) FILTER (
        WHERE b.candle_at <= s.zone_touch_time
          AND b.candle_at + make_interval(mins => s.replay_interval_minutes)
              > s.zone_touch_time
      )::integer AS touch_candle_count,
      COALESCE(bool_or(
        (s.direction = 'long' AND b.high_price >= s.stored_target)
        OR (s.direction = 'short' AND b.low_price <= s.stored_target)
      ) FILTER (
        WHERE b.candle_at <= s.zone_touch_time
          AND b.candle_at + make_interval(mins => s.replay_interval_minutes)
              > s.zone_touch_time
      ), false) AS target_on_touch_candle,
      COALESCE(bool_or(
        (s.direction = 'long' AND b.low_price <= s.stored_stop)
        OR (s.direction = 'short' AND b.high_price >= s.stored_stop)
      ) FILTER (
        WHERE b.candle_at <= s.zone_touch_time
          AND b.candle_at + make_interval(mins => s.replay_interval_minutes)
              > s.zone_touch_time
      ), false) AS stop_on_touch_candle,
      min(b.candle_at) FILTER (
        WHERE b.candle_at > s.zone_touch_time
          AND (
            (s.direction = 'long' AND b.high_price >= s.stored_target)
            OR (s.direction = 'short' AND b.low_price <= s.stored_target)
          )
      ) AS first_target_at,
      min(b.candle_at) FILTER (
        WHERE b.candle_at > s.zone_touch_time
          AND (
            (s.direction = 'long' AND b.low_price <= s.stored_stop)
            OR (s.direction = 'short' AND b.high_price >= s.stored_stop)
          )
      ) AS first_stop_at
    FROM candles_with_gaps b
    WHERE b.pending_id = s.id
  ) m
),
classified AS (
  SELECT
    m.*,
    CASE
      WHEN NOT m.geometry_valid THEN 'invalid_stored_geometry'
      WHEN NOT m.cohort_mature THEN 'cohort_immature'
      WHEN m.status = 'filled' THEN 'filled_geometry_not_comparable'
      WHEN m.snapshot_id IS NULL OR m.available_bars = 0
        THEN 'full_window_snapshot_unavailable'
      WHEN m.touch_candle_count = 0 THEN 'touch_candle_unavailable'
      WHEN m.interval_gap_count > 0 THEN 'candle_interval_gap'
      WHEN m.target_on_touch_candle OR m.stop_on_touch_candle
        THEN 'ambiguous_entry_candle'
      WHEN m.first_target_at IS NOT NULL
       AND m.first_stop_at IS NOT NULL
       AND m.first_target_at = m.first_stop_at
        THEN 'ambiguous_same_candle'
      WHEN m.first_target_at IS NOT NULL
       AND (m.first_stop_at IS NULL OR m.first_target_at < m.first_stop_at)
        THEN 'would_have_won'
      WHEN m.first_stop_at IS NOT NULL
       AND (m.first_target_at IS NULL OR m.first_stop_at < m.first_target_at)
        THEN 'would_have_lost'
      ELSE 'open_at_horizon'
    END AS counterfactual_outcome
  FROM measured m
),
eligible AS (
  SELECT
    c.*,
    c.cohort_mature
      AND c.geometry_valid
      AND c.status <> 'filled'
      AND c.snapshot_id IS NOT NULL
      AND c.available_bars > 0
      AND c.touch_candle_count > 0
      AND c.interval_gap_count = 0 AS headline_eligible
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
        AND c.counterfactual_outcome = 'open_at_horizon'
    ) OVER () AS unresolved_count,
    count(*) FILTER (
      WHERE c.cohort_mature AND NOT c.headline_eligible
    ) OVER () AS unusable_count,
    count(*) FILTER (
      WHERE c.cohort_mature AND c.status = 'filled'
    ) OVER () AS filled_geometry_excluded_count,
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
  unresolved_count,
  unusable_count,
  filled_geometry_excluded_count,
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
  snapshot_id,
  snapshot_observed_at,
  available_bars,
  first_candle_at,
  coverage_end_at,
  largest_gap_minutes,
  interval_gap_count,
  outcome_horizon_at,
  'decision-outcome.v1; retained-touch cohort; gross stored geometry; no confirmation timing, spread, commission, slippage, trailing, partials, break-even, or fill-time authorization simulation'
    AS model_scope
FROM with_counts
ORDER BY zone_touch_time DESC, symbol;
