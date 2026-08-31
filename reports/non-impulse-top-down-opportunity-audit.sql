-- Non-impulse top-down opportunity audit — bounded summary
--
-- Purpose:
--   Count scans where the existing unified/impulse engine produced no
--   executable zone, while independent top-down evidence had already been
--   computed (style, direction, structure, HTF POIs and liquidity sequence).
--
-- This query is READ ONLY. It does not create a setup, propose an entry, change
-- configuration, or infer a counterfactual win/loss.
--
-- Why this version is intentionally compact:
--   scan_logs.details_json is large. Carrying the full JSON through multiple
--   MATERIALIZED CTEs can force PostgreSQL to spill gigabytes into pgsql_tmp.
--   This query expands each scan once, projects only the fields needed for the
--   summary, and returns grouped rows instead of every raw scan.
--   Structure readiness mirrors evaluateCanonicalStructureDecision by selecting
--   only the latest direction-aligned liquidity sequence.
--
-- Interpretation:
--   * `no_structural_impulse` means no accepted structural leg was found.
--   * `*_no_accepted_zone` means an impulse trace existed, but it did not
--     produce an accepted entry POI. Seeing impulse dates with "No Zone" is
--     therefore expected and internally consistent.
--   * `at_aligned_htf_poi_*` is descriptive only. No candidate entry, stop,
--     target, confirmation, final authorization, or outcome was frozen on the
--     current hard no-zone path.
--
-- Edit only the params CTE. If Supabase still returns SQLSTATE 53100, change
-- lookback_days from 21 to 1. If even `select now();` fails, the database
-- instance itself is out of disk rather than this report exhausting temp space.

WITH params AS (
  SELECT
    '57c79dee-db6b-4fae-b34a-4b64ce33ca34'::uuid AS user_id,
    'smc'::text AS bot_id,
    21::integer AS lookback_days,
    NULL::text AS style_filter,
    NULL::text AS symbol_filter
),
pair_rows AS (
  SELECT
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
    NULLIF(
      item.detail #>> '{unifiedZone,entryZoneQualification,state}',
      ''
    ) AS entry_zone_qualification_state,
    NULLIF(
      item.detail #>> '{unifiedZone,entryZoneQualification,stage}',
      ''
    ) AS entry_zone_qualification_stage,
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
),
measured AS (
  SELECT
    r.*,
    COALESCE(htf.aligned_count, 0) AS aligned_htf_poi_count,
    COALESCE(htf.inside_count, 0) AS inside_aligned_htf_poi_count,
    COALESCE(sequence.sequence_ready, false) AS structure_sequence_ready
  FROM filtered_rows r
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE p.direction_aligned)::integer AS aligned_count,
      count(*) FILTER (
        WHERE p.direction_aligned
          AND r.current_price IS NOT NULL
          AND p.low_price IS NOT NULL
          AND p.high_price IS NOT NULL
          AND r.current_price BETWEEN
            LEAST(p.low_price, p.high_price)
            AND GREATEST(p.low_price, p.high_price)
      )::integer AS inside_count
    FROM (
      SELECT
        CASE
          WHEN r.direction = 'long'
            THEN lower(COALESCE(poi.value ->> 'direction', ''))
              IN ('bullish', 'bullish_breaker', 'long')
          WHEN r.direction = 'short'
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
      FROM jsonb_array_elements(r.htf_pois) AS poi(value)
    ) p
  ) htf ON true
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN r.require_liquidity_sweep
          THEN COALESCE(seq.value ->> 'entryReady' = 'true', false)
        ELSE COALESCE(
          jsonb_typeof(seq.value -> 'shift') = 'object',
          false
        )
      END AS sequence_ready
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
),
classified AS (
  SELECT
    m.*,
    CASE
      WHEN m.unified_state = 'no_impulse'
        THEN 'no_structural_impulse'
      WHEN m.unified_state = 'no_zone'
        AND m.entry_zone_qualification_state = 'missing'
        THEN 'qualified_impulse_no_entry_zone_candidate'
      WHEN m.unified_state = 'no_zone'
        AND m.entry_zone_qualification_state = 'rejected'
        THEN 'entry_zone_rejected_' || COALESCE(
          m.entry_zone_qualification_stage,
          'unknown_stage'
        )
      WHEN m.unified_state = 'no_zone'
        AND m.impulse_qualification_state IN ('developing', 'forming')
        THEN 'forming_impulse_no_accepted_zone'
      WHEN m.unified_state = 'no_zone'
        AND m.impulse_qualification_state = 'completed_unqualified'
        THEN 'completed_impulse_no_accepted_zone'
      WHEN m.unified_state = 'no_zone'
        AND m.impulse_qualification_state = 'stale'
        THEN 'stale_impulse_no_accepted_zone'
      WHEN m.unified_state = 'no_zone'
        AND m.impulse_qualification_state = 'invalidated'
        THEN 'invalidated_impulse_no_accepted_zone'
      WHEN m.unified_state = 'no_zone'
        THEN 'impulse_trace_no_accepted_zone'
      WHEN m.unified_state = 'error'
        THEN 'zone_engine_error'
      ELSE 'no_executable_impulse_zone'
    END AS zone_failure_class,
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
        THEN 'no_direction_aligned_htf_poi_detected'
      WHEN m.current_price IS NULL
        THEN 'aligned_htf_poi_price_unavailable'
      WHEN m.inside_aligned_htf_poi_count = 0
        THEN 'aligned_htf_poi_exists_price_not_inside'
      WHEN m.structure_sequence_ready
        THEN 'at_aligned_htf_poi_sequence_ready_geometry_not_frozen'
      ELSE 'at_aligned_htf_poi_sequence_pending_geometry_not_frozen'
    END AS opportunity_stage
  FROM measured m
)
SELECT
  c.trading_style,
  c.bias_timeframe,
  c.structure_timeframe,
  c.setup_timeframe,
  c.confirmation_timeframe,
  c.session,
  c.runtime_status,
  c.zone_failure_class,
  c.impulse_qualification_state,
  c.entry_zone_qualification_state,
  c.entry_zone_qualification_stage,
  c.opportunity_stage,
  count(*) AS scan_observations,
  count(DISTINCT c.symbol) AS distinct_symbols,
  string_agg(DISTINCT c.symbol, ', ' ORDER BY c.symbol) AS symbols,
  min(c.scanned_at) AS first_seen_at,
  max(c.scanned_at) AS last_seen_at,
  round(avg(c.score), 1) AS average_legacy_score,
  count(*) FILTER (
    WHERE c.inside_aligned_htf_poi_count > 0
  ) AS scans_at_aligned_htf_poi,
  count(*) FILTER (
    WHERE c.structure_sequence_ready
  ) AS scans_with_ready_structure_sequence,
  count(*) FILTER (
    WHERE c.timeframe_evidence_id IS NULL
  ) AS missing_timeframe_evidence_id,
  'descriptive_only_no_entry_stop_target_confirmation_or_outcome'
    AS evidence_limit
FROM classified c
GROUP BY
  c.trading_style,
  c.bias_timeframe,
  c.structure_timeframe,
  c.setup_timeframe,
  c.confirmation_timeframe,
  c.session,
  c.runtime_status,
  c.zone_failure_class,
  c.impulse_qualification_state,
  c.entry_zone_qualification_state,
  c.entry_zone_qualification_stage,
  c.opportunity_stage
ORDER BY
  CASE
    WHEN c.opportunity_stage =
      'at_aligned_htf_poi_sequence_ready_geometry_not_frozen' THEN 0
    WHEN c.opportunity_stage =
      'at_aligned_htf_poi_sequence_pending_geometry_not_frozen' THEN 1
    ELSE 2
  END,
  scan_observations DESC,
  c.trading_style,
  c.session;
