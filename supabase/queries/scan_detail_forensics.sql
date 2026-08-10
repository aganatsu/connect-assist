-- ════════════════════════════════════════════════════════════════════════════
-- Scan detail forensics — the Trade Decision card, in bulk
-- ════════════════════════════════════════════════════════════════════════════
--
-- `scan_logs.details_json` holds the full per-pair `detail` object for every
-- scan (bot-scanner/index.ts:11199). That object is what renders the Trade
-- Decision card: impulse trace, zone bounds, entry/SL/TP, the workflow stage
-- grid, the candidate-model verdict. It is persisted for every pair on every
-- cycle, so the card can be read for many trades at once instead of one
-- screenshot at a time.
--
-- SHAPE
--   details_json is an ARRAY:
--     [ { "__meta": true, ... scan-level summary ... },
--       { "pair": "GBP/CHF", "status": "...", "unifiedZone": {...}, ... },
--       ... one object per scanned pair ... ]
--   The meta element is filtered out by `d->>'__meta' is null`.
--
-- CASTS (learned the hard way — this codebase stores a lot as text)
--   - details_json is cast ::jsonb so the query works whether the column is
--     json or jsonb.
--   - timestamps are cast (col::text)::timestamptz so it works whether the
--     column is text or a real timestamp.
--   - if `created_at` does not exist, swap it for `scanned_at` (both appear in
--     the code; whichever your table has will work).

-- ────────────────────────────────────────────────────────────────────────────
-- QUERY 0 — PROBE. Run this first; it costs nothing and removes the guesswork.
--
-- details_json is not uniformly shaped: the main scan (bot-scanner:11199)
-- writes an ARRAY of per-pair details, while the game-plan path
-- (bot-scanner:3940) writes an OBJECT into the same column. Feeding an object
-- to jsonb_array_elements raises "22023: cannot extract elements from an
-- object", so every query below guards on jsonb_typeof.
--
-- This also confirms which timestamp column exists.
-- ────────────────────────────────────────────────────────────────────────────

select
  jsonb_typeof(details_json::jsonb) as shape,
  count(*)                          as rows
from scan_logs
group by 1
order by 2 desc;

-- If `created_at` errors below, this tells you what the table actually has:
--   select column_name, data_type from information_schema.columns
--   where table_name = 'scan_logs' order by ordinal_position;


-- ────────────────────────────────────────────────────────────────────────────
-- QUERY A — full card detail for the last 15 placed trades.
--
-- Returns the raw detail object. Verbose, but nothing is assumed about nested
-- field names, so it cannot silently return blanks the way a guessed path can.
-- Export this one first.
-- ────────────────────────────────────────────────────────────────────────────

select
  to_char((s.created_at::text)::timestamptz, 'MM-DD HH24:MI') as scanned,
  d->>'pair'                                                  as pair,
  d->>'direction'                                             as direction,
  d->>'status'                                                as status,
  d                                                           as full_detail
from scan_logs s
cross join lateral jsonb_array_elements(
    case when jsonb_typeof(s.details_json::jsonb) = 'array'
         then s.details_json::jsonb else '[]'::jsonb end
  ) as d
where d->>'__meta' is null
  and coalesce(d->>'status', '') like 'trade_placed%'
order by (s.created_at::text)::timestamptz desc
limit 15;


-- ────────────────────────────────────────────────────────────────────────────
-- QUERY B — compact extract across the last 60 placed trades.
--
-- Pulls the fields the GBP/CHF post-mortem actually turned on: how big the
-- impulse was, which timeframe it came from, the zone bounds, the entry stop,
-- and the resulting R:R. A NULL here means the path differs from what the card
-- showed — worth knowing, not a failure.
-- ────────────────────────────────────────────────────────────────────────────

with placed as (
  select
    (s.created_at::text)::timestamptz as scanned_at,
    d
  from scan_logs s
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(s.details_json::jsonb) = 'array'
         then s.details_json::jsonb else '[]'::jsonb end
  ) as d
  where d->>'__meta' is null
    and coalesce(d->>'status', '') like 'trade_placed%'
)
select
  to_char(scanned_at, 'MM-DD HH24:MI')                       as scanned,
  d->>'pair'                                                 as pair,
  d->>'direction'                                            as direction,
  round((d->>'score')::numeric, 1)                           as score,
  d->>'signalSource'                                         as source,
  d->'unifiedZone'->>'selectedTF'                            as zone_tf,
  d->'unifiedZone'->>'state'                                 as zone_state,
  round((d->'unifiedZone'->'impulse'->>'pips')::numeric, 1)   as impulse_pips,
  d->'unifiedZone'->'impulse'->>'timeframe'                  as impulse_tf,
  (d->'unifiedZone'->'impulse'->>'spanBars')::int            as impulse_bars,
  d->'unifiedZone'->'zone'->>'type'                          as zone_type,
  d->'unifiedZone'->'zone'->>'fibLabel'                      as fib,
  d->'unifiedZone'->'entry'                                  as entry_story,
  d->'unifiedZone'->'confirmation'->>'type'                  as confirmation,
  d->'impulseZone'->'bestZone'->'candidateModel'             as candidate_model,
  d->'canonicalScannerState'                                 as workflow_state
from placed
order by scanned_at desc
limit 60;


-- ────────────────────────────────────────────────────────────────────────────
-- QUERY C — how small are the impulses the bot is trading?
--
-- The GBP/CHF loss traded a 27-pip impulse on 5m — noise, and a retracement
-- inside a multi-day uptrend. This shows whether that is typical.
-- ────────────────────────────────────────────────────────────────────────────

with placed as (
  select
    d->>'pair'                                               as pair,
    d->'unifiedZone'->'impulse'->>'timeframe'                as impulse_tf,
    (d->'unifiedZone'->'impulse'->>'pips')::numeric          as impulse_pips
  from scan_logs s
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(s.details_json::jsonb) = 'array'
         then s.details_json::jsonb else '[]'::jsonb end
  ) as d
  where d->>'__meta' is null
    and coalesce(d->>'status', '') like 'trade_placed%'
    and (d->'unifiedZone'->'impulse'->>'pips') is not null
)
select
  coalesce(impulse_tf, '(none)')            as impulse_timeframe,
  count(*)                                  as trades,
  round(min(impulse_pips), 1)               as smallest_pips,
  round(avg(impulse_pips), 1)               as avg_pips,
  round(max(impulse_pips), 1)               as largest_pips,
  count(*) filter (where impulse_pips < 40) as under_40_pips
from placed
group by 1
order by trades desc;
