-- Non-impulse top-down opportunity audit — bounded candidate details
--
-- Run the summary query first:
--   reports/non-impulse-top-down-opportunity-audit.sql
--
-- Use this only when the summary contains an `at_aligned_htf_poi_*` stage.
-- It returns at most 250 descriptive rows and does not join candle snapshots or
-- timeframe-evidence tables. It is READ ONLY and does not establish that a
-- setup was executable or would have won.
-- Structure readiness mirrors evaluateCanonicalStructureDecision by selecting
-- only the latest direction-aligned liquidity sequence.
--
-- Start with three days. Increase lookback_days only after this succeeds.

WITH params AS (
  SELECT
    '57c79dee-db6b-4fae-b34a-4b64ce33ca34'::uuid AS user_id,
    'smc'::text AS bot_id,
    3::integer AS lookback_days,
    250::integer AS row_limit,
    NULL::text AS style_filter,
    NULL::text AS symbol_filter
),
pair_rows AS (
  SELECT
    sl.id AS scan_log_id,
    sl.scanned_at,
    NULLIF(item.detail ->> 'pair', '') AS symbol,
    CASE lower(replace(COALESCE(
      NULLIF(item.detail #>> '{stylePolicy,style}', ''),
      NULLIF(item.detail ->> 'tradingStyle', ''),
      NULLIF(sl.details_json #>> '{0,stylePolicy,style}', ''),
      NULLIF(sl.details_json #>> '{0,activeStyle}', ''),
      'unknown'
    ), ' ', '_'))
      WHEN 'scalp' THEN 'scalper'
      WHEN 'scalper' THEN 'scalper'
      WHEN 'day' THEN 'day_trader'
      WHEN 'day_trader' THEN 'day_trader'
      WHEN 'swing' THEN 'swing_trader'
      WHEN 'swing_trader' THEN 'swing_trader'
      ELSE 'unknown'
    END AS trading_style,
    COALESCE(NULLIF(item.detail ->> 'session', ''), 'unknown') AS session,
    COALESCE(NULLIF(item.detail ->> 'status', ''), 'unknown')
      AS runtime_status,
    COALESCE(
      NULLIF(item.detail ->> 'skipReason', ''),
      NULLIF(item.detail ->> 'reason', ''),
      NULLIF(item.detail #>> '{impulseZone,reason}', ''),
      NULLIF(item.detail #>> '{unifiedZone,reason}', '')
    ) AS runtime_reason,
    CASE lower(COALESCE(
      NULLIF(item.detail #>> '{directionVerdict,verdict}', ''),
      NULLIF(item.detail ->> 'direction', '')
    ))
      WHEN 'long' THEN 'long'
      WHEN 'bullish' THEN 'long'
      WHEN 'short' THEN 'short'
      WHEN 'bearish' THEN 'short'
      ELSE NULL
    END AS direction,
    COALESCE(
      item.detail #>> '{directionVerdict,shouldBlock}' = 'true',
      false
    ) AS direction_should_block,
    NULLIF(
      item.detail #>> '{canonicalStructureAuthority,trend,external}',
      ''
    ) AS external_trend,
    NULLIF(
      item.detail #>> '{canonicalStructureAuthority,trend,internal}',
      ''
    ) AS internal_trend,
    CASE
      WHEN jsonb_typeof(
        item.detail #> '{canonicalStructureAuthority,levels}'
      ) = 'array'
        THEN jsonb_array_length(
          item.detail #> '{canonicalStructureAuthority,levels}'
        ) > 0
      ELSE false
    END AS structure_available,
    COALESCE(
      NULLIF(item.detail #>> '{unifiedZone,state}', ''),
      'unknown'
    ) AS unified_state,
    NULLIF(
      item.detail #>> '{unifiedZone,impulse,qualification,state}',
      ''
    ) AS impulse_qualification_state,
    item.detail #> '{unifiedZone,impulse,qualification,reasons}'
      AS impulse_qualification_reasons,
    NULLIF(
      item.detail #>> '{unifiedZone,entryZoneQualification,state}',
      ''
    ) AS entry_zone_qualification_state,
    NULLIF(
      item.detail #>> '{unifiedZone,entryZoneQualification,stage}',
      ''
    ) AS entry_zone_qualification_stage,
    item.detail #> '{unifiedZone,entryZoneQualification,reasons}'
      AS entry_zone_qualification_reasons,
    NULLIF(item.detail #>> '{unifiedZone,impulse,direction}', '')
      AS impulse_direction,
    NULLIF(item.detail #>> '{unifiedZone,impulse,timeframe}', '')
      AS impulse_timeframe,
    NULLIF(item.detail #>> '{unifiedZone,impulse,startDate}', '')
      AS impulse_start_at,
    NULLIF(item.detail #>> '{unifiedZone,impulse,endDate}', '')
      AS impulse_end_at,
    CASE
      WHEN NULLIF(item.detail #>> '{unifiedZone,price,currentPrice}', '') ~
        '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
        THEN (item.detail #>> '{unifiedZone,price,currentPrice}')::numeric
      ELSE NULL
    END AS current_price,
    CASE
      WHEN NULLIF(item.detail ->> 'score', '') ~
        '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
        THEN (item.detail ->> 'score')::numeric
      ELSE NULL
    END AS score,
    COALESCE(
      item.detail #>> '{unifiedZone,gatePolicy,requireLiquiditySweep}' = 'true',
      false
    ) AS require_liquidity_sweep,
    CASE
      WHEN jsonb_typeof(item.detail #> '{chartOverlays,htfPOIs}') = 'array'
        THEN item.detail #> '{chartOverlays,htfPOIs}'
      ELSE '[]'::jsonb
    END AS htf_pois,
    CASE
      WHEN jsonb_typeof(
        item.detail #> '{canonicalLiquiditySequence,sequences}'
      ) = 'array'
        THEN item.detail #> '{canonicalLiquiditySequence,sequences}'
      ELSE '[]'::jsonb
    END AS liquidity_sequences,
    NULLIF(item.detail ->> 'timeframeEvidenceId', '')
      AS timeframe_evidence_id,
    NULLIF(item.detail #>> '{stylePolicy,timeframes,roles,bias}', '')
      AS bias_timeframe,
    NULLIF(item.detail #>> '{stylePolicy,timeframes,roles,structure}', '')
      AS structure_timeframe,
    NULLIF(item.detail #>> '{stylePolicy,timeframes,roles,setup}', '')
      AS setup_timeframe,
    NULLIF(item.detail #>> '{stylePolicy,timeframes,roles,confirmation}', '')
      AS confirmation_timeframe
  FROM public.scan_logs sl
  CROSS JOIN params p
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE jsonb_typeof(COALESCE(sl.details_json, '[]'::jsonb))
      WHEN 'array' THEN sl.details_json
      WHEN 'object' THEN jsonb_build_array(sl.details_json)
      ELSE '[]'::jsonb
    END
  ) AS item(detail)
  WHERE sl.user_id = p.user_id
    AND sl.bot_id = p.bot_id
    AND sl.scanned_at >= now() - make_interval(days => p.lookback_days)
    AND COALESCE(item.detail ->> '__meta', 'false') <> 'true'
    AND NULLIF(item.detail ->> 'pair', '') IS NOT NULL
    AND item.detail ? 'impulseZone'
    AND COALESCE(
      item.detail #>> '{impulseZone,hasZone}',
      'false'
    ) <> 'true'
),
filtered_rows AS (
  SELECT r.*
  FROM pair_rows r
  CROSS JOIN params p
  WHERE (
      p.style_filter IS NULL
      OR r.trading_style = lower(replace(p.style_filter, ' ', '_'))
    )
    AND (
      p.symbol_filter IS NULL
      OR r.symbol = upper(p.symbol_filter)
    )
    AND r.direction IS NOT NULL
    AND NOT r.direction_should_block
    AND r.structure_available
    AND NOT (
      (r.direction = 'long' AND r.external_trend = 'bearish')
      OR (r.direction = 'short' AND r.external_trend = 'bullish')
    )
),
candidate_pois AS (
  SELECT
    r.*,
    poi.timeframe AS poi_timeframe,
    poi.poi_type,
    poi.poi_direction,
    poi.low_price AS poi_low,
    poi.high_price AS poi_high,
    sequence.sequence_id,
    sequence.sequence_status,
    sequence.sequence_entry_ready,
    sequence.sequence_has_shift,
    COALESCE(sequence.structure_sequence_ready, false)
      AS structure_sequence_ready
  FROM filtered_rows r
  CROSS JOIN LATERAL (
    SELECT
      NULLIF(value ->> 'timeframe', '') AS timeframe,
      NULLIF(value ->> 'type', '') AS poi_type,
      NULLIF(value ->> 'direction', '') AS poi_direction,
      CASE
        WHEN value ->> 'low' ~
          '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
          THEN (value ->> 'low')::numeric
        ELSE NULL
      END AS low_price,
      CASE
        WHEN value ->> 'high' ~
          '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
          THEN (value ->> 'high')::numeric
        ELSE NULL
      END AS high_price
    FROM jsonb_array_elements(r.htf_pois)
  ) poi
  LEFT JOIN LATERAL (
    SELECT
      NULLIF(seq.value ->> 'id', '') AS sequence_id,
      NULLIF(seq.value ->> 'status', '') AS sequence_status,
      COALESCE(seq.value ->> 'entryReady' = 'true', false)
        AS sequence_entry_ready,
      COALESCE(
        jsonb_typeof(seq.value -> 'shift') = 'object',
        false
      ) AS sequence_has_shift,
      CASE
        WHEN r.require_liquidity_sweep
          THEN COALESCE(seq.value ->> 'entryReady' = 'true', false)
        ELSE COALESCE(
          jsonb_typeof(seq.value -> 'shift') = 'object',
          false
        )
      END AS structure_sequence_ready
    FROM jsonb_array_elements(r.liquidity_sequences)
      WITH ORDINALITY AS seq(value, ordinality)
    WHERE
      CASE
        WHEN r.direction = 'long'
          THEN lower(COALESCE(seq.value ->> 'direction', '')) = 'bullish'
        WHEN r.direction = 'short'
          THEN lower(COALESCE(seq.value ->> 'direction', '')) = 'bearish'
        ELSE false
      END
    ORDER BY seq.ordinality DESC
    LIMIT 1
  ) sequence ON true
  WHERE
    CASE
      WHEN r.direction = 'long'
        THEN lower(COALESCE(poi.poi_direction, ''))
          IN ('bullish', 'bullish_breaker', 'long')
      WHEN r.direction = 'short'
        THEN lower(COALESCE(poi.poi_direction, ''))
          IN ('bearish', 'bearish_breaker', 'short')
      ELSE false
    END
    AND r.current_price IS NOT NULL
    AND poi.low_price IS NOT NULL
    AND poi.high_price IS NOT NULL
    AND r.current_price BETWEEN
      LEAST(poi.low_price, poi.high_price)
      AND GREATEST(poi.low_price, poi.high_price)
)
SELECT
  c.scanned_at,
  c.scan_log_id,
  c.symbol,
  c.trading_style,
  c.session,
  c.runtime_status,
  c.direction,
  c.external_trend,
  c.internal_trend,
  c.current_price,
  c.poi_timeframe,
  c.poi_type,
  c.poi_direction,
  c.poi_low,
  c.poi_high,
  c.structure_sequence_ready,
  c.sequence_id,
  c.sequence_status,
  c.sequence_entry_ready,
  c.sequence_has_shift,
  c.require_liquidity_sweep,
  c.unified_state,
  c.impulse_qualification_state,
  c.impulse_qualification_reasons,
  c.entry_zone_qualification_state,
  c.entry_zone_qualification_stage,
  c.entry_zone_qualification_reasons,
  c.impulse_direction,
  c.impulse_timeframe,
  c.impulse_start_at,
  c.impulse_end_at,
  c.score,
  c.bias_timeframe,
  c.structure_timeframe,
  c.setup_timeframe,
  c.confirmation_timeframe,
  c.timeframe_evidence_id,
  c.runtime_reason,
  'descriptive_only_geometry_and_outcome_not_frozen' AS evidence_limit
FROM candidate_pois c
ORDER BY c.scanned_at DESC, c.symbol, c.poi_timeframe, c.poi_type
LIMIT (SELECT row_limit FROM params);
