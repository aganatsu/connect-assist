-- Non-impulse top-down opportunity audit
--
-- Purpose:
--   Describe scans where the existing unified/impulse engine produced no
--   executable zone, while preserving the independent top-down evidence that
--   had already been computed (style, direction, structure, HTF POIs and
--   liquidity sequence).
--
-- This query is READ ONLY. It does not propose an entry, change configuration,
-- create a setup, or infer a counterfactual win/loss.
--
-- Important interpretation:
--   * "at_aligned_htf_poi" means current price was literally inside an
--     already-detected, direction-aligned Daily/4H/1H OB/FVG/breaker range.
--   * It does NOT mean the scan was tradeable. The current no-impulse path did
--     not freeze a candidate entry, invalidation, stop, target, confirmation,
--     final authorization, or outcome.
--   * `no_zone` can retain a developing/invalid impulse trace. That is not a
--     contradiction: an impulse candidate existed, but no accepted entry zone
--     was produced.
--
-- Edit only the params CTE. `scan_logs` and `scan_candle_snapshots` currently
-- retain routine evidence for 30 days, so the default is intentionally 21.

WITH params AS (
  SELECT
    '57c79dee-db6b-4fae-b34a-4b64ce33ca34'::uuid AS user_id,
    'smc'::text AS bot_id,
    21::integer AS lookback_days,
    NULL::text AS style_filter,
    NULL::text AS symbol_filter
),
source_logs AS MATERIALIZED (
  SELECT
    sl.id AS scan_log_id,
    sl.user_id,
    sl.bot_id,
    sl.scanned_at,
    sl.details_json
  FROM public.scan_logs sl
  CROSS JOIN params p
  WHERE sl.user_id = p.user_id
    AND sl.bot_id = p.bot_id
    AND sl.scanned_at >= now() - make_interval(days => p.lookback_days)
),
expanded AS MATERIALIZED (
  SELECT
    sl.scan_log_id,
    sl.user_id,
    sl.bot_id,
    sl.scanned_at,
    item.ordinality,
    item.detail
  FROM source_logs sl
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE jsonb_typeof(COALESCE(sl.details_json, '[]'::jsonb))
      WHEN 'array' THEN sl.details_json
      WHEN 'object' THEN jsonb_build_array(sl.details_json)
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS item(detail, ordinality)
),
scan_meta AS MATERIALIZED (
  SELECT DISTINCT ON (e.scan_log_id)
    e.scan_log_id,
    e.detail AS meta
  FROM expanded e
  WHERE e.detail ->> '__meta' = 'true'
  ORDER BY e.scan_log_id, e.ordinality
),
pair_details AS MATERIALIZED (
  SELECT
    e.scan_log_id,
    e.user_id,
    e.bot_id,
    e.scanned_at,
    e.ordinality,
    e.detail,
    m.meta,
    NULLIF(e.detail ->> 'pair', '') AS symbol,
    COALESCE(
      NULLIF(e.detail #>> '{stylePolicy,style}', ''),
      NULLIF(e.detail ->> 'tradingStyle', ''),
      NULLIF(m.meta #>> '{stylePolicy,style}', ''),
      NULLIF(m.meta ->> 'activeStyle', ''),
      'unknown'
    ) AS raw_style,
    NULLIF(e.detail #>> '{stylePolicy,timeframes,roles,bias}', '')
      AS bias_timeframe,
    NULLIF(e.detail #>> '{stylePolicy,timeframes,roles,structure}', '')
      AS structure_timeframe,
    NULLIF(e.detail #>> '{stylePolicy,timeframes,roles,setup}', '')
      AS setup_timeframe,
    NULLIF(e.detail #>> '{stylePolicy,timeframes,roles,confirmation}', '')
      AS confirmation_timeframe,
    NULLIF(e.detail #>> '{stylePolicy,timeframes,roles,refinement}', '')
      AS refinement_timeframe,
    NULLIF(e.detail #>> '{stylePolicy,timeframes,runtimeEntry}', '')
      AS runtime_entry_timeframe,
    COALESCE(NULLIF(e.detail ->> 'session', ''), 'unknown') AS session,
    COALESCE(NULLIF(e.detail ->> 'status', ''), 'unknown') AS runtime_status,
    COALESCE(
      NULLIF(e.detail ->> 'skipReason', ''),
      NULLIF(e.detail ->> 'reason', ''),
      NULLIF(e.detail #>> '{impulseZone,reason}', ''),
      NULLIF(e.detail #>> '{unifiedZone,reason}', '')
    ) AS runtime_reason,
    COALESCE(
      NULLIF(e.detail ->> 'timeframeEvidenceScanCycleId', ''),
      NULLIF(m.meta ->> 'scanCycleId', '')
    ) AS scan_cycle_id,
    NULLIF(e.detail ->> 'timeframeEvidenceId', '') AS timeframe_evidence_id,
    COALESCE(
      NULLIF(e.detail #>> '{directionVerdict,verdict}', ''),
      NULLIF(e.detail ->> 'direction', '')
    ) AS raw_direction,
    e.detail #>> '{directionVerdict,shouldBlock}' AS direction_should_block_text,
    NULLIF(e.detail #>> '{canonicalStructureAuthority,trend,external}', '')
      AS external_trend,
    NULLIF(e.detail #>> '{canonicalStructureAuthority,trend,internal}', '')
      AS internal_trend,
    COALESCE(
      NULLIF(e.detail #>> '{unifiedZone,state}', ''),
      'unknown'
    ) AS unified_state,
    NULLIF(
      e.detail #>> '{unifiedZone,impulse,qualification,state}',
      ''
    ) AS impulse_qualification_state,
    e.detail #> '{unifiedZone,impulse,qualification,reasons}'
      AS impulse_qualification_reasons,
    NULLIF(e.detail #>> '{unifiedZone,impulse,direction}', '')
      AS impulse_direction,
    NULLIF(e.detail #>> '{unifiedZone,impulse,timeframe}', '')
      AS impulse_timeframe,
    NULLIF(e.detail #>> '{unifiedZone,impulse,startDate}', '')
      AS impulse_start_at,
    NULLIF(e.detail #>> '{unifiedZone,impulse,endDate}', '')
      AS impulse_end_at,
    NULLIF(e.detail #>> '{unifiedZone,impulse,high}', '')
      AS impulse_high_text,
    NULLIF(e.detail #>> '{unifiedZone,impulse,low}', '')
      AS impulse_low_text,
    NULLIF(e.detail #>> '{unifiedZone,impulse,spanBars}', '')
      AS impulse_span_bars_text,
    NULLIF(e.detail #>> '{unifiedZone,price,currentPrice}', '')
      AS current_price_text,
    NULLIF(e.detail ->> 'score', '') AS score_text,
    e.detail #>> '{unifiedZone,gatePolicy,requireLiquiditySweep}'
      AS require_liquidity_sweep_text,
    CASE
      WHEN jsonb_typeof(e.detail #> '{chartOverlays,htfPOIs}') = 'array'
        THEN e.detail #> '{chartOverlays,htfPOIs}'
      ELSE '[]'::jsonb
    END AS htf_pois,
    (
      CASE
        WHEN jsonb_typeof(e.detail #> '{chartOverlays,orderBlocks}') = 'array'
          THEN e.detail #> '{chartOverlays,orderBlocks}'
        ELSE '[]'::jsonb
      END
      ||
      CASE
        WHEN jsonb_typeof(e.detail #> '{chartOverlays,fvgs}') = 'array'
          THEN e.detail #> '{chartOverlays,fvgs}'
        ELSE '[]'::jsonb
      END
      ||
      CASE
        WHEN jsonb_typeof(e.detail #> '{chartOverlays,breakerBlocks}') = 'array'
          THEN e.detail #> '{chartOverlays,breakerBlocks}'
        ELSE '[]'::jsonb
      END
    ) AS entry_pois,
    CASE
      WHEN jsonb_typeof(
        e.detail #> '{canonicalStructureAuthority,levels}'
      ) = 'array'
        THEN e.detail #> '{canonicalStructureAuthority,levels}'
      ELSE '[]'::jsonb
    END AS structure_levels,
    CASE
      WHEN jsonb_typeof(
        e.detail #> '{canonicalLiquiditySequence,sequences}'
      ) = 'array'
        THEN e.detail #> '{canonicalLiquiditySequence,sequences}'
      ELSE '[]'::jsonb
    END AS liquidity_sequences
  FROM expanded e
  LEFT JOIN scan_meta m ON m.scan_log_id = e.scan_log_id
  WHERE COALESCE(e.detail ->> '__meta', 'false') <> 'true'
    AND NULLIF(e.detail ->> 'pair', '') IS NOT NULL
    AND e.detail ? 'impulseZone'
    AND COALESCE(e.detail #>> '{impulseZone,hasZone}', 'false') <> 'true'
),
typed AS MATERIALIZED (
  SELECT
    pd.*,
    CASE lower(replace(pd.raw_style, ' ', '_'))
      WHEN 'scalp' THEN 'scalper'
      WHEN 'scalper' THEN 'scalper'
      WHEN 'day' THEN 'day_trader'
      WHEN 'day_trader' THEN 'day_trader'
      WHEN 'swing' THEN 'swing_trader'
      WHEN 'swing_trader' THEN 'swing_trader'
      ELSE 'unknown'
    END AS trading_style,
    CASE lower(pd.raw_direction)
      WHEN 'long' THEN 'long'
      WHEN 'bullish' THEN 'long'
      WHEN 'short' THEN 'short'
      WHEN 'bearish' THEN 'short'
      ELSE NULL
    END AS direction,
    COALESCE(pd.direction_should_block_text = 'true', false)
      AS direction_should_block,
    CASE
      WHEN pd.current_price_text ~
        '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
        THEN pd.current_price_text::numeric
      ELSE NULL
    END AS current_price,
    CASE
      WHEN pd.score_text ~
        '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
        THEN pd.score_text::numeric
      ELSE NULL
    END AS score,
    COALESCE(pd.require_liquidity_sweep_text = 'true', false)
      AS require_liquidity_sweep,
    CASE
      WHEN pd.impulse_high_text ~
        '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
        THEN pd.impulse_high_text::numeric
      ELSE NULL
    END AS impulse_high,
    CASE
      WHEN pd.impulse_low_text ~
        '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
        THEN pd.impulse_low_text::numeric
      ELSE NULL
    END AS impulse_low,
    CASE
      WHEN pd.impulse_span_bars_text ~ '^[0-9]+$'
        THEN pd.impulse_span_bars_text::integer
      ELSE NULL
    END AS impulse_span_bars,
    jsonb_array_length(pd.structure_levels) > 0 AS structure_available,
    CASE
      WHEN pd.unified_state = 'no_impulse'
        THEN 'no_structural_impulse'
      WHEN pd.unified_state = 'no_zone'
        AND pd.impulse_qualification_state = 'developing'
        THEN 'developing_impulse_no_accepted_zone'
      WHEN pd.unified_state = 'no_zone'
        AND pd.impulse_qualification_state = 'invalidated'
        THEN 'invalidated_impulse_no_accepted_zone'
      WHEN pd.unified_state = 'no_zone'
        THEN 'impulse_trace_no_accepted_zone'
      WHEN pd.unified_state = 'error'
        THEN 'zone_engine_error'
      ELSE 'no_executable_impulse_zone'
    END AS zone_failure_class
  FROM pair_details pd
),
measured AS MATERIALIZED (
  SELECT
    t.*,
    COALESCE(htf.aligned_count, 0) AS aligned_htf_poi_count,
    COALESCE(htf.inside_count, 0) AS inside_aligned_htf_poi_count,
    COALESCE(entry_tf.aligned_count, 0) AS aligned_entry_poi_count,
    COALESCE(sequence.aligned_count, 0) AS aligned_sequence_count,
    COALESCE(sequence.ready_count, 0) AS ready_sequence_count,
    COALESCE(snapshot.snapshot_count, 0) > 0 AS has_scan_candle_snapshot,
    COALESCE(snapshot.timeframes, ARRAY[]::text[]) AS snapshot_timeframes,
    EXISTS (
      SELECT 1
      FROM public.zone_timeframe_evidence zte
      WHERE zte.user_id = t.user_id
        AND zte.bot_id = t.bot_id
        AND zte.scan_cycle_id = t.scan_cycle_id
        AND zte.symbol = t.symbol
        AND zte.id::text = t.timeframe_evidence_id
    ) AS has_timeframe_evidence_row,
    (
      NULLIF(t.detail #>> '{frozenExecutablePlan,candidateId}', '') IS NOT NULL
      AND NULLIF(t.detail #>> '{frozenExecutablePlan,entryPrice}', '') IS NOT NULL
      AND NULLIF(t.detail #>> '{frozenExecutablePlan,stopLoss}', '') IS NOT NULL
      AND NULLIF(t.detail #>> '{frozenExecutablePlan,takeProfit}', '') IS NOT NULL
    ) AS has_frozen_executable_geometry,
    (
      t.detail ? 'entryConfirmationCandidate'
      OR t.detail ? 'confirmationDecision'
    ) AS has_candidate_confirmation,
    (
      t.detail ? 'finalAuthorization'
      OR t.detail ? 'finalTradeAuthorization'
      OR t.detail ? 'pendingAuthorizationObservation'
    ) AS has_final_authorization
  FROM typed t
  LEFT JOIN LATERAL (
    SELECT
      count(*)::integer AS snapshot_count,
      array_agg(DISTINCT scs.timeframe ORDER BY scs.timeframe)
        AS timeframes
    FROM public.scan_candle_snapshots scs
    WHERE scs.user_id = t.user_id
      AND scs.bot_id = t.bot_id
      AND scs.scan_cycle_id = t.scan_cycle_id
      AND scs.symbol = t.symbol
  ) snapshot ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE p.direction_aligned)::integer AS aligned_count,
      count(*) FILTER (
        WHERE p.direction_aligned
          AND t.current_price IS NOT NULL
          AND p.low_price IS NOT NULL
          AND p.high_price IS NOT NULL
          AND t.current_price BETWEEN
            LEAST(p.low_price, p.high_price)
            AND GREATEST(p.low_price, p.high_price)
      )::integer AS inside_count
    FROM (
      SELECT
        CASE
          WHEN t.direction = 'long'
            THEN lower(COALESCE(poi.value ->> 'direction', ''))
              IN ('bullish', 'bullish_breaker', 'long')
          WHEN t.direction = 'short'
            THEN lower(COALESCE(poi.value ->> 'direction', ''))
              IN ('bearish', 'bearish_breaker', 'short')
          ELSE false
        END AS direction_aligned,
        CASE
          WHEN poi.value ->> 'low' ~
            '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
            THEN (poi.value ->> 'low')::numeric
          ELSE NULL
        END AS low_price,
        CASE
          WHEN poi.value ->> 'high' ~
            '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
            THEN (poi.value ->> 'high')::numeric
          ELSE NULL
        END AS high_price
      FROM jsonb_array_elements(t.htf_pois) AS poi(value)
    ) p
  ) htf ON true
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (
      WHERE COALESCE(lower(poi.value ->> 'state'), 'active')
              NOT IN ('broken', 'filled', 'mitigated')
        AND CASE
          WHEN t.direction = 'long'
            THEN lower(COALESCE(poi.value ->> 'direction', ''))
              IN ('bullish', 'bullish_breaker', 'long')
          WHEN t.direction = 'short'
            THEN lower(COALESCE(poi.value ->> 'direction', ''))
              IN ('bearish', 'bearish_breaker', 'short')
          ELSE false
        END
    )::integer AS aligned_count
    FROM jsonb_array_elements(t.entry_pois) AS poi(value)
  ) entry_tf ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE q.direction_aligned)::integer AS aligned_count,
      count(*) FILTER (
        WHERE q.direction_aligned
          AND CASE
            WHEN t.require_liquidity_sweep
              THEN q.entry_ready
            ELSE q.has_shift
          END
      )::integer AS ready_count
    FROM (
      SELECT
        CASE
          WHEN t.direction = 'long'
            THEN lower(COALESCE(seq.value ->> 'direction', '')) = 'bullish'
          WHEN t.direction = 'short'
            THEN lower(COALESCE(seq.value ->> 'direction', '')) = 'bearish'
          ELSE false
        END AS direction_aligned,
        seq.value ->> 'entryReady' = 'true' AS entry_ready,
        jsonb_typeof(seq.value -> 'shift') = 'object' AS has_shift
      FROM jsonb_array_elements(t.liquidity_sequences) AS seq(value)
    ) q
  ) sequence ON true
),
classified AS MATERIALIZED (
  SELECT
    m.*,
    CASE
      WHEN m.direction IS NULL
        THEN 'direction_unavailable'
      WHEN m.direction_should_block
        THEN 'direction_blocked'
      WHEN NOT m.structure_available
        THEN 'structure_evidence_unavailable'
      WHEN
        (m.direction = 'long' AND m.external_trend = 'bearish')
        OR (m.direction = 'short' AND m.external_trend = 'bullish')
        THEN 'external_structure_opposes_direction'
      WHEN m.aligned_htf_poi_count = 0
        AND m.aligned_entry_poi_count > 0
        THEN 'entry_tf_poi_only_no_aligned_htf_poi'
      WHEN m.aligned_htf_poi_count = 0
        THEN 'no_direction_aligned_htf_poi_detected'
      WHEN m.current_price IS NULL
        THEN 'aligned_htf_poi_price_unavailable'
      WHEN m.inside_aligned_htf_poi_count = 0
        THEN 'aligned_htf_poi_exists_price_not_inside'
      WHEN m.ready_sequence_count > 0
        THEN 'at_aligned_htf_poi_sequence_ready_geometry_not_frozen'
      ELSE 'at_aligned_htf_poi_sequence_pending_geometry_not_frozen'
    END AS opportunity_stage,
    (
      m.direction IS NOT NULL
      AND NOT m.direction_should_block
      AND m.structure_available
      AND NOT (
        (m.direction = 'long' AND m.external_trend = 'bearish')
        OR (m.direction = 'short' AND m.external_trend = 'bullish')
      )
      AND m.inside_aligned_htf_poi_count > 0
    ) AS descriptive_top_down_candidate
  FROM measured m
),
filtered AS MATERIALIZED (
  SELECT c.*
  FROM classified c
  CROSS JOIN params p
  WHERE (
      p.style_filter IS NULL
      OR c.trading_style = lower(replace(p.style_filter, ' ', '_'))
    )
    AND (
      p.symbol_filter IS NULL
      OR c.symbol = upper(p.symbol_filter)
    )
)
SELECT
  f.scanned_at,
  f.scan_log_id,
  f.scan_cycle_id,
  f.symbol,
  f.trading_style,
  f.bias_timeframe,
  f.structure_timeframe,
  f.setup_timeframe,
  f.confirmation_timeframe,
  f.refinement_timeframe,
  f.runtime_entry_timeframe,
  f.session,
  f.runtime_status,
  f.zone_failure_class,
  f.opportunity_stage,
  f.descriptive_top_down_candidate,
  count(*) OVER () AS cohort_scan_count,
  count(*) OVER (
    PARTITION BY f.trading_style, f.opportunity_stage
  ) AS style_stage_scan_count,
  round(
    100.0 * count(*) OVER (
      PARTITION BY f.trading_style, f.opportunity_stage
    ) / NULLIF(count(*) OVER (PARTITION BY f.trading_style), 0),
    1
  ) AS style_stage_percent,
  f.direction,
  f.direction_should_block,
  f.external_trend,
  f.internal_trend,
  f.current_price,
  f.score,
  f.aligned_htf_poi_count,
  f.inside_aligned_htf_poi_count,
  f.aligned_entry_poi_count,
  f.aligned_sequence_count,
  f.ready_sequence_count,
  f.require_liquidity_sweep,
  f.unified_state,
  f.impulse_qualification_state,
  f.impulse_qualification_reasons,
  f.impulse_direction,
  f.impulse_timeframe,
  f.impulse_start_at,
  f.impulse_end_at,
  f.impulse_high,
  f.impulse_low,
  f.impulse_span_bars,
  f.timeframe_evidence_id,
  f.has_timeframe_evidence_row,
  f.has_scan_candle_snapshot,
  f.snapshot_timeframes,
  f.has_frozen_executable_geometry,
  f.has_candidate_confirmation,
  f.has_final_authorization,
  ARRAY_REMOVE(ARRAY[
    CASE WHEN f.current_price IS NULL
      THEN 'current_price_missing' END,
    CASE WHEN f.direction IS NULL
      THEN 'direction_verdict_missing_or_neutral' END,
    CASE WHEN NOT f.structure_available
      THEN 'canonical_structure_missing' END,
    CASE WHEN jsonb_array_length(f.htf_pois) = 0
      THEN 'htf_poi_payload_empty' END,
    CASE WHEN f.timeframe_evidence_id IS NULL
      THEN 'timeframe_evidence_id_missing' END,
    CASE WHEN NOT f.has_timeframe_evidence_row
      THEN 'timeframe_evidence_row_missing' END,
    CASE WHEN NOT f.has_scan_candle_snapshot
      THEN 'closed_candle_snapshot_missing' END,
    CASE WHEN NOT f.has_frozen_executable_geometry
      THEN 'candidate_entry_stop_target_not_frozen' END,
    CASE WHEN NOT f.has_candidate_confirmation
      THEN 'candidate_specific_confirmation_not_evaluated' END,
    CASE WHEN NOT f.has_final_authorization
      THEN 'final_authorization_not_evaluated' END,
    'counterfactual_outcome_not_available'
  ], NULL) AS evidence_gaps,
  f.runtime_reason
FROM filtered f
ORDER BY
  f.descriptive_top_down_candidate DESC,
  f.scanned_at DESC,
  f.symbol;
