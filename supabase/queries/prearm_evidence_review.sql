-- Step 5 evidence review — pre-arm / confirmation sequencing
--
-- For docs/PENDING_ORDER_PREARMING_PLAN.md. These decide whether steps 6 and 7
-- (enforcing confirmation sequencing, then frozen-entry location) are ready.
--
-- NOTE ON SHAPE: liquidity_confirmation_observation is a JSONB COLUMN on
-- staged_setups and pending_orders. There is no observations table. Migration
-- 20260812130000 adds the column; the payload shape is
-- LiquidityConfirmationObservation in _shared/liquidityConfirmationContract.ts.


-- ── 1. Reason distribution ───────────────────────────────────────────
-- CORRECTED. This is a distribution over ORDERS, not over evaluations.
-- liquidity_confirmation_observation is UPDATED in place each scan
-- (bot-scanner:7986) and only while status is pending/awaiting_confirmation.
-- So each row holds the LAST reason before the order went terminal — there is
-- no history, and a reason that occurred earlier in an order's life is gone.
--
-- Three groups mean different things and must not be read together:
--   rule working ....... no_qualifying_sweep, zone_touch_pending,
--                        confirmation_pending, sweep_before_zone_touch,
--                        confirmation_not_after_sweep
--   migration failing .. sweep_identity_unresolved
--   fail-closed ........ legacy_contract_requires_fresh_sequence,
--                        setup_activation_time_unavailable
--
-- A large sweep_identity_unresolved share means durable IDs are not resolving
-- and the v2 contract is not actually being tested. A large fail-closed share
-- means the population is mostly pre-v2 rows, so the sample is not
-- representative yet either.
SELECT
  liquidity_confirmation_observation->>'reasonCode' AS reason_code,
  count(*) AS n,
  count(*) FILTER (WHERE (liquidity_confirmation_observation->>'ready')::boolean) AS ready,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM pending_orders
WHERE liquidity_confirmation_observation IS NOT NULL
  AND created_at > now() - interval '7 days'
GROUP BY 1
ORDER BY 2 DESC;


-- ── 2. Would the new contract have changed the outcome? ──────────────
-- A pending order can produce SEVERAL paper_trade_history rows — partial
-- closes are separate rows. Joining directly multiplied n by the number of
-- exits and treated each partial as its own outcome, so a scaled-out winner
-- counted as several trades. History is aggregated per pending order first, and
-- the trade is won or lost on its TOTAL pnl.
--
-- Depends on #340 for source_pending_order_id. Until that lands, closed_trades
-- is 0 and this reports fill rate only.
WITH outcome AS (
  SELECT source_pending_order_id AS pending_id,
         sum(pnl) AS total_pnl,
         count(*) AS exit_legs
  FROM paper_trade_history
  WHERE source_pending_order_id IS NOT NULL
  GROUP BY 1
)
SELECT
  (p.liquidity_confirmation_observation->>'ready')::boolean AS sequence_ready,
  p.status,
  count(*) AS orders,
  count(o.pending_id) AS closed_trades,
  count(*) FILTER (WHERE o.total_pnl > 0) AS wins,
  count(*) FILTER (WHERE o.total_pnl <= 0) AS losses,
  round(avg(o.total_pnl)::numeric, 2) AS avg_pnl,
  round(avg(o.exit_legs)::numeric, 2) AS avg_exit_legs
FROM pending_orders p
LEFT JOIN outcome o ON o.pending_id = p.id
WHERE p.liquidity_confirmation_observation IS NOT NULL
  AND p.created_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC NULLS LAST, 3 DESC;


-- ── 3. Ordering-rule timings ─────────────────────────────────────────
-- Sanity on the two agreed rules:
--   sweepTime >= zoneTouchTime    (same candle allowed)
--   confirmationTime > sweepTime  (strictly LATER closed candle, because OHLC
--                                  cannot prove intrabar ordering)
--
-- Reading sweep_to_confirm_secs correctly:
--   = 0                      same candle — the case the strict rule exists to
--                            reject. OHLC cannot say which came first.
--   = one bar interval       the valid next candle. This is the NORMAL pass,
--                            not a near-miss.
--   > one bar interval       confirmation came later still; also valid.
--
-- An earlier version of this comment claimed "at or below one interval means
-- same candle". That is wrong and inverted the reading: exactly one interval
-- later is precisely what the rule wants.
--
-- The interval itself is per-setup, so the frozen confirmation timeframe is
-- selected alongside rather than assumed.
SELECT
  symbol,
  frozen_strategy_context->'stylePolicy'->'timeframes'->'roles'->>'confirmation'
    AS confirmation_tf,
  liquidity_confirmation_observation->>'reasonCode' AS reason_code,
  (liquidity_confirmation_observation->>'zoneTouchTime')::timestamptz AS touched,
  (liquidity_confirmation_observation->>'sweepTime')::timestamptz AS swept,
  (liquidity_confirmation_observation->>'confirmationTime')::timestamptz AS confirmed,
  extract(epoch FROM
    (liquidity_confirmation_observation->>'sweepTime')::timestamptz
    - (liquidity_confirmation_observation->>'zoneTouchTime')::timestamptz) AS touch_to_sweep_secs,
  extract(epoch FROM
    (liquidity_confirmation_observation->>'confirmationTime')::timestamptz
    - (liquidity_confirmation_observation->>'sweepTime')::timestamptz) AS sweep_to_confirm_secs
FROM pending_orders
WHERE liquidity_confirmation_observation->>'sweepTime' IS NOT NULL
  AND liquidity_confirmation_observation->>'zoneTouchTime' IS NOT NULL
  AND created_at > now() - interval '7 days'
ORDER BY created_at DESC
LIMIT 50;
-- As with query 1, each row is one order's LAST observation, not a timeline.


-- ── 4. Does frozen-entry location block independently? ───────────────
-- frozenExecutablePlan never reaches pending_orders; it is set on the scan
-- detail (bot-scanner:10817) and lands in scan_logs.details_json. The pre-arm
-- insert writes signal_reason = {preArmed, candidateId} and nothing else.
--
-- ONE ROW PER CANDIDATE. A setup is re-observed on every scan while it lives,
-- so counting raw scan details weights long-lived setups by however many cycles
-- they survived — a candidate watched for four hours would outvote twelve
-- short-lived ones. DISTINCT ON takes each candidate's LATEST observation.
--
-- details_json is an array from the main scan path and an object from the
-- game-plan path, and a set-returning function cannot sit inside CASE.
WITH obs AS (
  SELECT DISTINCT ON (
    scan_logs.user_id,
    scan_logs.bot_id,
    d->'frozenExecutablePlan'->>'candidateId'
  )
    scan_logs.user_id,
    scan_logs.bot_id,
    d->'frozenExecutablePlan'->>'candidateId' AS candidate_id,
    (d->'liquidityConfirmationObservation'->>'ready')::boolean AS sequence_ready,
    (d->'frozenExecutablePlan'->'location'->>'allowed')::boolean AS frozen_entry_allowed
  FROM scan_logs,
       LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(details_json) = 'array'
              THEN details_json ELSE jsonb_build_array(details_json) END
       ) AS x(d)
  WHERE created_at > now() - interval '7 days'
    AND d ? 'frozenExecutablePlan'
    AND d->'frozenExecutablePlan'->>'candidateId' IS NOT NULL
  ORDER BY
    scan_logs.user_id,
    scan_logs.bot_id,
    d->'frozenExecutablePlan'->>'candidateId',
    created_at DESC
)
SELECT sequence_ready, frozen_entry_allowed, count(*) AS candidates
FROM obs GROUP BY 1, 2 ORDER BY 3 DESC;


-- ── 5. Distance vs reachability ──────────────────────────────────────
-- Arm-time distance is NOT recoverable from pending_orders: current_price is
-- refreshed on every scan, so for a terminal row it is the last observed price.
-- scan_logs records it as staging.zoneDistance.
--
-- FIRST observation per candidate, not every scan. A setup that waits four
-- hours emits ~48 staging observations; counting them all would report
-- "armed_observations" as if it were armed setups, and would bias the average
-- toward whichever setups lingered longest. DISTINCT ON ... ORDER BY created_at
-- ASC takes the arm-time reading, which is the one the question is about.
--
-- Raw price deltas are not comparable across asset classes. This query is
-- intentionally limited to supported fiat-FX crosses, where the unit is
-- unambiguously pips. Crypto, indices and commodities use points or
-- instrument-specific display units and must be analysed separately.
WITH armed AS (
  SELECT DISTINCT ON (
    scan_logs.user_id,
    scan_logs.bot_id,
    d->'frozenExecutablePlan'->>'candidateId'
  )
    scan_logs.user_id,
    scan_logs.bot_id,
    d->>'pair' AS symbol,
    d->'frozenExecutablePlan'->>'candidateId' AS candidate_id,
    (d->'staging'->>'zoneDistance')::numeric AS zone_distance
  FROM scan_logs,
       LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(details_json) = 'array'
              THEN details_json ELSE jsonb_build_array(details_json) END
       ) AS x(d)
  WHERE created_at > now() - interval '7 days'
    AND (d->'staging'->>'zoneDistance') IS NOT NULL
    AND d->'frozenExecutablePlan'->>'candidateId' IS NOT NULL
    AND split_part(d->>'pair', '/', 1)
      IN ('USD','EUR','GBP','JPY','AUD','NZD','CAD','CHF')
    AND split_part(d->>'pair', '/', 2)
      IN ('USD','EUR','GBP','JPY','AUD','NZD','CAD','CHF')
  ORDER BY
    scan_logs.user_id,
    scan_logs.bot_id,
    d->'frozenExecutablePlan'->>'candidateId',
    created_at ASC
)
SELECT
  symbol,
  count(*) AS armed_setups,
  round(avg(zone_distance / CASE
    WHEN symbol LIKE '%JPY%' THEN 0.01
    ELSE 0.0001 END), 1) AS avg_distance_pips,
  round(max(zone_distance / CASE
    WHEN symbol LIKE '%JPY%' THEN 0.01
    ELSE 0.0001 END), 1) AS max_distance_pips
FROM armed GROUP BY 1 ORDER BY 2 DESC;

-- Companion: did anything actually touch? Status only, no distance arithmetic.
SELECT status, count(*) AS n,
       count(*) FILTER (WHERE zone_touch_time IS NOT NULL) AS ever_touched,
       avg(expires_at - placed_at) AS avg_ttl
FROM pending_orders
WHERE created_at > now() - interval '7 days'
GROUP BY 1 ORDER BY 2 DESC;


-- ── 6. Funnel ────────────────────────────────────────────────────────
-- Context for all of the above. Baseline before the Active Scan Slots change:
-- ~28 candidates/day across 15 symbols (2026-08-10 and -11), falling to 7
-- across 4 on 2026-08-12 when slots were at 4 against 33 instruments.
--
-- If staged is not recovering toward the baseline, nothing below it is
-- measurable and the other five queries have no sample worth reading.
-- CORRECTED: count(*) after a LEFT JOIN counts JOINED rows, not staged rows.
-- idx_pending_orders_candidate_active is unique only for active statuses, so a
-- candidate may own several terminal pending rows and the original inflated
-- `staged` by the fan-out. DISTINCT on the ids fixes it.
SELECT
  date_trunc('day', s.created_at) AS day,
  count(DISTINCT s.id) AS staged,
  count(DISTINCT s.symbol) AS symbols,
  count(DISTINCT p.id) AS pre_armed,
  count(DISTINCT p.id) FILTER (WHERE p.zone_touch_time IS NOT NULL) AS touched,
  count(DISTINCT p.id) FILTER (WHERE p.status = 'filled') AS filled
FROM staged_setups s
LEFT JOIN pending_orders p
  ON  p.user_id      = s.user_id
  AND p.bot_id       = s.bot_id
  AND p.candidate_id = s.candidate_id
  -- Scoped, because candidate_id alone is not unique: both uniqueness indexes
  -- are on (user_id, bot_id, candidate_id). Joining on the id alone can attach
  -- another account's pending order to this account's staged setup.
WHERE s.created_at > now() - interval '14 days'
GROUP BY 1
ORDER BY 1 DESC;
