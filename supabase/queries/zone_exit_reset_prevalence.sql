-- Did the direction-blind zone-exit reset actually cost trades?
--
-- `confirmation_attempts` counts how many times price entered the zone, left
-- it, and the confirmation hunt was reset. Every reset also cleared
-- `zone_touch_time`, which is what seeds the CHoCH search — so each one
-- abandoned a hunt in progress.
--
-- An order with attempts > 0 that never filled is a setup that reached its
-- zone, started hunting, was reset, and died. That is the population the
-- #468 flag is aimed at. It does NOT prove the resets were favourable exits
-- rather than genuine breaches — nothing recorded the side price left on —
-- so read this as an upper bound on the damage, not a measurement of it.

select
  status,
  count(*)                                                   as orders,
  count(*) filter (where coalesce(confirmation_attempts, 0) > 0) as with_resets,
  round(avg(nullif(confirmation_attempts, 0)), 2)            as avg_resets_when_reset,
  max(confirmation_attempts)                                 as max_resets
from pending_orders
where bot_id = 'smc'
  and placed_at > now() - interval '60 days'
group by status
order by orders desc;

-- The number that matters: reached the zone, hunted, reset, never filled.
select
  count(*)                                                   as reset_and_never_filled,
  round(avg(confirmation_attempts), 2)                       as avg_resets,
  min(placed_at)                                             as earliest,
  max(placed_at)                                             as latest
from pending_orders
where bot_id = 'smc'
  and coalesce(confirmation_attempts, 0) > 0
  and status in ('expired', 'cancelled')
  and placed_at > now() - interval '60 days';

-- Compare against the ones that did fill after a reset — if this is non-zero,
-- the reset is survivable and the fix matters less than the count above suggests.
select
  count(*) filter (where coalesce(confirmation_attempts, 0) = 0) as filled_first_touch,
  count(*) filter (where coalesce(confirmation_attempts, 0) > 0) as filled_after_reset
from pending_orders
where bot_id = 'smc'
  and status = 'filled'
  and placed_at > now() - interval '60 days';

-- Caveat worth keeping in view: per the project notes, pending-order fills
-- have been dead since 2026-05-15 (~1,400 orders, zero fills). If the third
-- query returns zeroes across the board, that is the reason, and the reset bug
-- is one cause among others rather than the cause.
