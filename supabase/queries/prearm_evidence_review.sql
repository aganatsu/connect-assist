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
-- The headline. Three groups mean different things and must not be read
-- together:
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
-- Cross the observe-only verdict against what actually happened. This is the
-- question step 6 turns on: does sequence-ready predict a better outcome than
-- the legacy path allowed?
--
-- Reading it: if ready=true rows fill and win at a similar rate to everything
-- else, the contract adds cost without discrimination. If ready=false rows are
-- disproportionately the losers and the expiries, enforcement is justified.
SELECT
  (liquidity_confirmation_observation->>'ready')::boolean AS sequence_ready,
  status,
  count(*) AS n
FROM pending_orders
WHERE liquidity_confirmation_observation IS NOT NULL
  AND created_at > now() - interval '7 days'
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
  AND created_at > now() - interval '7 days'
ORDER BY created_at DESC
LIMIT 50;


-- ── 4. Does frozen-entry location block independently? ───────────────
-- Step 7 is enforced separately from step 6 precisely so low fills stay
-- attributable. This shows the overlap: setups the sequence contract would
-- allow but frozen-entry P/D would still reject, and vice versa.
--
-- If one rule blocks nearly everything the other blocks, enforcing both changes
-- little and they can ship together. If they block disjoint sets, enforcing
-- both at once would compound and the separate rollout matters.
SELECT
  (liquidity_confirmation_observation->>'ready')::boolean AS sequence_ready,
  coalesce(
    (signal_reason->'frozenExecutablePlan'->'location'->>'allowed')::boolean,
    NULL) AS frozen_entry_allowed,
  count(*) AS n
FROM pending_orders
WHERE liquidity_confirmation_observation IS NOT NULL
  AND created_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 3 DESC;


-- ── 5. Distance vs reachability ──────────────────────────────────────
-- The open policy question from the first pre-armed order: USD/CHF armed
-- 166.9 pips away with an inherited 4-hour TTL, and expired untouched.
--
-- If most armed orders are multiple daily ranges from entry, expiry policy —
-- not confirmation sequencing — is what caps fills, and steps 6/7 would be
-- tuning a stage almost nothing reaches.
SELECT
  status,
  count(*) AS n,
  round(avg(abs(entry_price - current_price))::numeric, 5) AS avg_distance,
  round(max(abs(entry_price - current_price))::numeric, 5) AS max_distance,
  avg(expires_at - placed_at) AS avg_ttl,
  count(*) FILTER (WHERE zone_touch_time IS NOT NULL) AS ever_touched
FROM pending_orders
WHERE created_at > now() - interval '7 days'
GROUP BY 1
ORDER BY 2 DESC;


-- ── 6. Funnel ────────────────────────────────────────────────────────
-- Context for all of the above. Baseline before the Active Scan Slots change:
-- ~28 candidates/day across 15 symbols (2026-08-10 and -11), falling to 7
-- across 4 on 2026-08-12 when slots were at 4 against 33 instruments.
--
-- If staged is not recovering toward the baseline, nothing below it is
-- measurable and the other five queries have no sample worth reading.
SELECT
  date_trunc('day', s.created_at) AS day,
  count(*) AS staged,
  count(DISTINCT s.symbol) AS symbols,
  count(p.id) AS pre_armed,
  count(*) FILTER (WHERE p.zone_touch_time IS NOT NULL) AS touched,
  count(*) FILTER (WHERE p.status = 'filled') AS filled
FROM staged_setups s
LEFT JOIN pending_orders p ON p.candidate_id = s.candidate_id
WHERE s.created_at > now() - interval '14 days'
GROUP BY 1
ORDER BY 1 DESC;
