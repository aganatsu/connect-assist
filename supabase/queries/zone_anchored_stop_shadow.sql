-- How often does the stop sit inside the zone, and what would turning
-- `zoneAnchoredStop` on actually cost?
--
-- Run against scan_logs once bot-scanner has been running with the shadow
-- measurement deployed. The flag can stay OFF — the numbers are recorded
-- either way, and the flag-off branch changes no trade.
--
-- Read it as: `stop_inside_zone` is the prevalence of the defect (the BTC/USD
-- 2026-09-04 failure mode — stop at 79487.76 inside a 79000-80354.65 zone,
-- -$532.50, zone never invalidated). `would_skip` is the price of the fix:
-- those setups stop being traded entirely once the flag goes on.
--
-- Schema note: scan_logs.details_json is a jsonb ARRAY. Element 0 is a meta
-- object with no `pair`; the rest are per-pair scan details. There is no
-- 'scanDetails' key to index into.

with z as (
  select
    l.created_at,
    d ->> 'pair'                                             as pair,
    d ->> 'status'                                           as status,
    (d -> 'zoneAnchoredStop' ->> 'enabled')::boolean         as flag_on,
    (d -> 'zoneAnchoredStop' ->> 'wouldSkip')::boolean       as would_skip,
    (d -> 'zoneAnchoredStop' ->> 'stopInsideZone')::boolean  as stop_inside_zone,
    (d -> 'zoneAnchoredStop' ->> 'currentSlPips')::numeric   as current_sl_pips,
    (d -> 'zoneAnchoredStop' ->> 'anchoredPips')::numeric    as anchored_pips,
    (d -> 'zoneAnchoredStop' ->> 'maxAnchoredPips')::numeric as cap_pips,
    (d -> 'zoneAnchoredStop' ->> 'zoneWidthPips')::numeric   as zone_width_pips
  from scan_logs l
  cross join lateral jsonb_array_elements(l.details_json) as d
  where l.created_at > now() - interval '7 days'
    and jsonb_typeof(l.details_json) = 'array'
    and d ? 'zoneAnchoredStop'
)
select
  pair,
  count(*)                                     as evaluations,
  count(*) filter (where stop_inside_zone)     as stop_inside_zone,
  round(100.0 * count(*) filter (where stop_inside_zone) / count(*), 1) as pct_inside,
  count(*) filter (where would_skip)           as would_skip,
  round(100.0 * count(*) filter (where would_skip) / count(*), 1)       as pct_skipped,
  round(avg(current_sl_pips), 1)               as avg_stop_now,
  round(avg(anchored_pips), 1)                 as avg_stop_anchored,
  round(avg(zone_width_pips), 1)               as avg_zone_width,
  round(max(cap_pips), 1)                      as cap
from z
group by pair
order by pct_inside desc nulls last;

-- The single number that decides it — across every pair, what share of
-- setups that reach the SL stage would stop being taken?
--
--   with z as ( ...same CTE as above... )
--   select
--     count(*) filter (where would_skip) as lost,
--     count(*)                           as total,
--     round(100.0 * count(*) filter (where would_skip) / count(*), 1) as pct
--   from z;
--
-- Small pct with large pct_inside → the flag is close to free; turn it on.
-- Large pct → the wide zones need the resting-limit route rather than a skip,
-- and turning the flag on now would mostly just stop trading those pairs.
