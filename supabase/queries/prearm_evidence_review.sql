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
-- CORRECTED. The original version grouped by pending_orders.status and its
-- comment claimed it showed whether ready=true setups "fill and win". It
-- cannot: pending_orders has no win/loss. Outcomes live in
-- paper_trade_history, reachable only via source_pending_order_id — the column
-- added by #340. Before that lands this query answers fill rate only, and
-- win/loss stays null.
SELECT
  (p.liquidity_confirmation_observation->>'ready')::boolean AS sequence_ready,
  p.status,
  count(*) AS n,
  count(h.id) AS closed_trades,
  count(*) FILTER (WHERE h.pnl > 0) AS wins,
  count(*) FILTER (WHERE h.pnl <= 0) AS losses,
  round(avg(h.pnl)::numeric, 2) AS avg_pnl
FROM pending_orders p
LEFT JOIN paper_trade_history h ON h.source_pending_order_id = p.id
WHERE p.liquidity_confirmation_observation IS NOT NULL
  AND p.created_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC NULLS LAST, 3 DESC;


-- ── 3. Ordering-rule timings ─────────────────────────────────────────
-- Sanity on the two rules agreed for the contract:
--   sweepTime >= zoneTouchTime   (same candle allowed)
--   confirmationTime > sweepTime (strictly later closed candle)
--
-- sweep_to_confirm_secs at or below one bar interval means confirmations are
-- landing on the same candle as their sweep, which OHLC cannot order. That
-- would mean the strict rule is doing real work rather than being a formality.
SELECT
  symbol,
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
-- CORRECTED: also requires zoneTouchTime, or touch_to_sweep_secs is NULL for
-- every row that never touched and the output is mostly blanks. And as with
-- query 1, each row is one order's LAST observation, not a timeline.


-- ── 4. Does frozen-entry location block independently? ───────────────
-- CORRECTED. The original read
--   signal_reason->'frozenExecutablePlan'->'location'->>'allowed'
-- from pending_orders. That path does not exist. frozenExecutablePlan is only
-- ever set on `detail` (bot-scanner:10817) and reaches scan_logs.details_json;
-- the pre-arm insert writes signal_reason = {preArmed, candidateId} and nothing
-- else. The original returned NULL for every row and would have read as "no
-- overlap" — the most misleading possible result for a query whose purpose is
-- deciding whether steps 6 and 7 can ship together.
--
-- details_json is an array from the main scan path and an object from the
-- game-plan path, and a set-returning function cannot sit inside CASE.
SELECT
  (d->'liquidityConfirmationObservation'->>'ready')::boolean AS sequence_ready,
  (d->'frozenExecutablePlan'->'location'->>'allowed')::boolean AS frozen_entry_allowed,
  count(*) AS n
FROM scan_logs,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(details_json) = 'array'
            THEN details_json ELSE jsonb_build_array(details_json) END
     ) AS x(d)
WHERE created_at > now() - interval '7 days'
  AND d ? 'frozenExecutablePlan'
GROUP BY 1, 2
ORDER BY 3 DESC;


-- ── 5. Distance vs reachability ──────────────────────────────────────
-- CORRECTED, twice over.
--
-- (a) The original used abs(entry_price - current_price) and called it
--     "distance at arm time". current_price is refreshed on every scan
--     (bot-scanner updates it in the pending loop), so for a terminal row it is
--     the last observed price, not the price when the order was armed. Arm-time
--     distance is not recoverable from pending_orders at all.
--
-- (b) It averaged raw price deltas across symbols. 0.0010 is 10 pips on
--     USD/CHF, 0.1 pips on USD/JPY and immaterial on XAU/USD. The average was
--     meaningless.
--
-- Arm-time distance IS recorded in scan_logs as staging.zoneDistance, so read
-- it there and normalise by the pair's pip size.
SELECT
  d->>'pair' AS symbol,
  count(*) AS armed_observations,
  round(avg((d->'staging'->>'zoneDistance')::numeric /
    CASE
      WHEN d->>'pair' LIKE '%JPY%' THEN 0.01
      WHEN d->>'pair' IN ('XAU/USD','XAG/USD','BTC/USD','ETH/USD','US Oil') THEN 0.01
      ELSE 0.0001
    END, 1) AS avg_distance_pips,
  round(max((d->'staging'->>'zoneDistance')::numeric /
    CASE
      WHEN d->>'pair' LIKE '%JPY%' THEN 0.01
      WHEN d->>'pair' IN ('XAU/USD','XAG/USD','BTC/USD','ETH/USD','US Oil') THEN 0.01
      ELSE 0.0001
    END, 1) AS max_distance_pips
FROM scan_logs,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(details_json) = 'array'
            THEN details_json ELSE jsonb_build_array(details_json) END
     ) AS x(d)
WHERE created_at > now() - interval '7 days'
  AND (d->'staging'->>'zoneDistance') IS NOT NULL
GROUP BY 1
ORDER BY 3 DESC;

-- Companion: did anything actually touch? Status-only, no distance arithmetic.
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
LEFT JOIN pending_orders p ON p.candidate_id = s.candidate_id
WHERE s.created_at > now() - interval '14 days'
GROUP BY 1
ORDER BY 1 DESC;
