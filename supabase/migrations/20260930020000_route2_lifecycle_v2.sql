-- ROUTE 2 CONFIRMATION LIFECYCLE — V2 state
--
-- Two defects were proven on forward order b64d4d7b (NZD/CAD short,
-- 2026-09-29), both visible only because route2_poll_log existed:
--
--   1. STALE FORMING-BAR RE-ARM. The arm test read the FORMING entry-TF
--      bar's running high, which retains a touch for the whole bar. Armed
--      21:50:01, reset 21:50:04, re-armed 21:51:01 off the same 21:45 bar —
--      while the 1m tape shows the only crossing was 21:48 and the highs at
--      21:49/50/51 were 7.8 pips short of the entry. A touch must be an
--      event that is CONSUMED, which needs state.
--
--   2. RESET BEFORE THE CONFIRM TF CAN CLOSE. Hunts lasted 3.4 s and 60.0 s;
--      a close-based CHoCH needs one CLOSED confirm-TF bar, so 0 of 2 could
--      ever have confirmed. The hunt needs a deadline it is protected until.
--
-- Observational columns only. No strategy geometry is stored or changed.

alter table public.pending_orders
  -- touch identity: what has already been consumed, so it cannot re-arm
  add column if not exists last_touch_bar_time        timestamptz,
  add column if not exists last_touch_detection_time  timestamptz,
  add column if not exists last_consumed_touch_id     text,
  -- The directional extreme of the forming bar AT the moment the touch was
  -- consumed. A same-bar re-arm is permitted only if the bar later extends
  -- strictly beyond this, which is explicit evidence of a NEW crossing
  -- rather than the same spike being re-read.
  add column if not exists last_consumed_touch_extreme numeric,
  add column if not exists confirmation_arm_count     integer not null default 0,
  add column if not exists confirmation_armed_at      timestamptz,
  -- the protected window: one complete confirm-TF candle after the touch
  add column if not exists confirmation_min_observation_until timestamptz,
  add column if not exists confirmation_checks_count  integer not null default 0,
  add column if not exists rearm_reason               text,
  add column if not exists reset_reason               text,
  add column if not exists hard_invalidation          boolean,
  add column if not exists touch_consumed             boolean;

comment on column public.pending_orders.last_consumed_touch_extreme is
  'Forming-bar directional extreme when the touch was consumed. Same-bar '
  're-arm requires the bar to extend strictly beyond this.';
comment on column public.pending_orders.confirmation_min_observation_until is
  'ORDINARY zone-departure resets are deferred until this instant: the close '
  'of the first confirm-TF candle that opens at or after the touch.';
comment on column public.pending_orders.hard_invalidation is
  'True when the hunt ended on a thesis-invalidating reason rather than an '
  'ordinary zone departure. See route2Lifecycle.RESET_SEVERITY.';

-- ─── poll log: carry the same lifecycle facts per evaluation ────────────────
-- Still append-only; the trigger from 20260929120000 remains in force.

alter table public.route2_poll_log
  add column if not exists touch_id                  text,
  add column if not exists touch_verdict             text,
  add column if not exists min_observation_until     timestamptz,
  add column if not exists reset_deferred            boolean,
  add column if not exists reset_severity            text,
  add column if not exists lifecycle_version         text;

comment on column public.route2_poll_log.reset_deferred is
  'True when an ORDINARY reset was suppressed because the confirmation '
  'window had not yet elapsed. This is the V2 fix firing, and it must be '
  'observable or the fix cannot be audited.';

do $$ begin
  alter table public.route2_poll_log
    add constraint route2_poll_log_touch_verdict_valid
    check (touch_verdict is null or touch_verdict in
      ('NEW_TOUCH','ALREADY_CONSUMED_TOUCH','NEW_CROSS_AFTER_RESET'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.route2_poll_log
    add constraint route2_poll_log_reset_severity_valid
    check (reset_severity is null or reset_severity in ('HARD','ORDINARY'));
exception when duplicate_object then null; end $$;

create index if not exists pending_orders_strategy_version
  on public.pending_orders (bot_id, strategy_version, placed_at desc);

-- ─── NO BACKFILL ────────────────────────────────────────────────────────────
--
-- V1 orders keep NULL lifecycle state and their V1 strategy_version. They
-- are observational only and must not enter V2 metrics; leaving the columns
-- NULL is what makes that separation structural rather than a convention.
