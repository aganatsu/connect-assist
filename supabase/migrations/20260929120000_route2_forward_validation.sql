-- ROUTE 2 FORWARD VALIDATION
--
-- Route 2 cannot be causally BACKtested: poll instants, per-cycle candle
-- availability and which of the two pollers handled a transition were never
-- persisted. Measured on the live table, every lifecycle column that could
-- have carried that record (`entry_confirmation`, `confirmation_method`,
-- `last_touch_checked_at`, `last_confirmation_checked_at`,
-- `thesis_validation`, `confirmation_build_diagnostic`) is NULL on 35 of 35
-- rows, and `confirmationHunt` appears in 0 of the last 400 scan_logs.
--
-- This migration adds the record that makes a FORWARD validation causal.
-- It changes no strategy behaviour: every column is written after a decision
-- and read only by analysis.
--
-- PAPER / RESEARCH ONLY. Nothing here touches broker execution, which is
-- gated on paper_accounts.execution_mode = 'live' elsewhere.

-- ─── 1. order-level creation record ─────────────────────────────────────────

alter table public.pending_orders
  add column if not exists zone_id                    text,
  add column if not exists zone_created_at            timestamptz,
  add column if not exists zone_age_minutes           numeric,
  add column if not exists entry_source               text,
  add column if not exists current_price_at_creation  numeric,
  add column if not exists h1_atr_at_creation         numeric,
  add column if not exists pending_distance_atr       numeric,
  add column if not exists initial_stop_loss          numeric,
  add column if not exists initial_take_profit        numeric,
  add column if not exists config_hash                text,
  add column if not exists strategy_version           text,
  add column if not exists expiry_policy              text,
  -- Route 1 is disabled for this experiment, so setups that WOULD have been
  -- taken as a direct market-fill-at-zone now flow into Route 2 instead.
  -- Measured over 180 days they are ~45% of the forward-eligible population
  -- and sit at ~0 ATR, so they arrive almost immediately and would otherwise
  -- silently inflate the fill rate the TTL research predicts. Recorded at
  -- creation so the two strata can be separated exactly rather than inferred
  -- from distance.
  add column if not exists would_have_been_route1     boolean,
  add column if not exists terminal_reason            text,
  -- touch telemetry: the market event and the system's detection of it are
  -- different instants. `zone_touch_time` is a wall clock at the noticing
  -- cycle and was the only thing recorded, so detection latency was invisible.
  add column if not exists market_touch_time          timestamptz,
  add column if not exists market_touch_bar_time      timestamptz,
  add column if not exists system_detection_time      timestamptz,
  -- confirmation telemetry
  add column if not exists confirmation_checked_at    timestamptz,
  add column if not exists confirmation_timeframe     text,
  add column if not exists confirmation_type          text,
  add column if not exists confirmation_tier          integer,
  add column if not exists confirmation_accepted      boolean,
  add column if not exists confirmation_reject_reason text,
  add column if not exists confirmation_accepted_at   timestamptz,
  add column if not exists trigger_timestamp          timestamptz,
  add column if not exists fill_timestamp             timestamptz,
  add column if not exists fill_price                 numeric,
  -- Zone Story: OBSERVATIONAL ONLY in this experiment. Persisted at four
  -- lifecycle points so its correlation with outcome can be measured later.
  -- It must not accept or reject an order.
  add column if not exists zone_story_at_creation     jsonb,
  add column if not exists zone_story_at_touch        jsonb,
  add column if not exists zone_story_at_confirmation jsonb,
  add column if not exists zone_story_at_fill         jsonb;

comment on column public.pending_orders.pending_distance_atr is
  'abs(current_price - entry_price) / H1 ATR(14) at creation. Route 2 rejects > 1.5.';
comment on column public.pending_orders.expiry_policy is
  'fixed_from_creation: refresh-in-place must NOT extend expires_at.';
comment on column public.pending_orders.terminal_reason is
  'Typed terminal state. cancel_reason stays free text for humans.';
comment on column public.pending_orders.zone_story_at_creation is
  'OBSERVATIONAL ONLY. Zone Story never gates Route 2 in this experiment.';

do $$ begin
  alter table public.pending_orders
    add constraint pending_orders_terminal_reason_valid
    check (terminal_reason is null or terminal_reason in (
      'EXPIRED_NEVER_TOUCHED','EXPIRED_AFTER_TOUCH_NO_CONFIRMATION',
      'CANCELLED_SL_INVALIDATION','CANCELLED_IMPULSE_BROKEN','CANCELLED_ZONE_EXIT',
      'CANCELLED_DIRECTION_FLIP','CANCELLED_THESIS_FOTSI','CANCELLED_REFINED_ZONE_FAILURE',
      'CANCELLED_POSITION_CAP','CANCELLED_SUPERSEDED','FILLED'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.pending_orders
    add constraint pending_orders_entry_source_valid
    check (entry_source is null or entry_source in ('unified','refinedEntry','zoneMid','legacy'));
exception when duplicate_object then null; end $$;

-- A recorded distance is a non-negative number or it is absent. A negative
-- value would mean the guard was fed a sign-flipped input.
do $$ begin
  alter table public.pending_orders
    add constraint pending_orders_distance_atr_nonneg
    check (pending_distance_atr is null or pending_distance_atr >= 0);
exception when duplicate_object then null; end $$;

-- ─── 2. poll log — append only ──────────────────────────────────────────────
--
-- One row per lifecycle evaluation, per order, per poller. Two functions poll
-- the same rows on different cadences and apply different check-sets
-- (zone-confirmation-scanner runs no expiry, SL or thesis check), so which
-- one acted is part of the causal record, not an implementation detail.

create table if not exists public.route2_poll_log (
  id                      bigserial primary key,
  pending_id              text        not null,
  poll_timestamp          timestamptz not null,
  poller_name             text        not null,
  candles_available       integer     not null,
  current_price           numeric,
  status_before           text        not null,
  zone_touch_detected     boolean     not null default false,
  zone_touch_bar_time     timestamptz,
  confirmation_checked    boolean     not null default false,
  confirmation_result     text,
  confirmation_tier       integer,
  direction_state         text,
  impulse_broken          boolean,
  zone_exit               text,
  structural_invalidation text,
  branch_taken            text        not null,
  status_after            text        not null,
  created_at              timestamptz not null default now()
);

comment on table public.route2_poll_log is
  'APPEND ONLY. One row per Route 2 lifecycle evaluation. candles_available=0 '
  'records a poll skipped by a refused fetch — the event whose absence made '
  'the historical pending lifecycle unreplayable.';

create index if not exists route2_poll_log_pending on public.route2_poll_log (pending_id, poll_timestamp);
create index if not exists route2_poll_log_time on public.route2_poll_log (poll_timestamp desc);

alter table public.route2_poll_log enable row level security;
do $$ begin
  create policy route2_poll_log_service_all on public.route2_poll_log
    for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;

-- Append-only in the literal sense: no UPDATE, no DELETE, even by mistake.
create or replace function public.route2_poll_log_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'route2_poll_log is append-only';
end $$;

drop trigger if exists route2_poll_log_no_mutate on public.route2_poll_log;
create trigger route2_poll_log_no_mutate
  before update or delete on public.route2_poll_log
  for each row execute function public.route2_poll_log_append_only();

-- ─── 3. config history — append only ────────────────────────────────────────
--
-- bot_configs is a single mutable row carrying only `updated_at`. In the
-- universe audit, 11 of 35 live orders could not be attributed to a config
-- because no history existed. A hash per order is useless without the body
-- it hashes.

create table if not exists public.bot_config_history (
  id            bigserial primary key,
  user_id       uuid,
  bot_id        text        not null,
  config_hash   text        not null,
  config_json   jsonb       not null,
  first_seen_at timestamptz not null default now(),
  unique (bot_id, config_hash)
);

comment on table public.bot_config_history is
  'APPEND ONLY. One row the first time a config body is seen, keyed by hash. '
  'pending_orders.config_hash resolves here.';

alter table public.bot_config_history enable row level security;
do $$ begin
  create policy bot_config_history_service_all on public.bot_config_history
    for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;

-- ─── 4. read path ───────────────────────────────────────────────────────────

create index if not exists pending_orders_terminal
  on public.pending_orders (bot_id, terminal_reason, placed_at desc);
create index if not exists pending_orders_zone
  on public.pending_orders (zone_id, placed_at desc);

-- ─── 5. NO BACKFILL ─────────────────────────────────────────────────────────
--
-- Deliberately no UPDATE. The 35 pre-existing rows have no recorded distance,
-- no zone formation time and no poll history, and none can be recovered.
-- They keep NULL and are read as pre-forward-validation. Fabricating them is
-- the defect this migration exists to stop.
