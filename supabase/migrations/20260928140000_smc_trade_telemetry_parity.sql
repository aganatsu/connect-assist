-- SMC TRADE TELEMETRY PARITY
--
-- Production SMC trades cannot currently be checked against causal research:
--
--   * `stop_loss` is the stop AT CLOSE, not at entry. Management moves it, and
--     an SL exit writes the same level as the exit price. Measured on the live
--     table: stop_loss = exit_price EXACTLY on 354 of 453 rows (78.1%). Any R
--     derived from it is a division artifact — it produced +270 avgR on
--     ETH/USD before the defect was caught.
--   * There is no realized-R column at all.
--   * Nothing records which execution route opened the trade, so Route 1
--     (market fill at zone) and Route 2 (pending + confirmation) are
--     indistinguishable in history.
--
-- This migration adds an IMMUTABLE entry block to the open-position table and
-- its archive, plus realized R on the archive. It changes no strategy
-- behaviour: every column here is written after the trade decision and read
-- only by analysis.
--
-- The existing mutable `stop_loss` / `take_profit` keep their current meaning
-- and current consumers, untouched.

-- ─── 1. open positions ───────────────────────────────────────────────────────

alter table public.paper_positions
  add column if not exists entry_route             text,
  add column if not exists entry_price_at_open     numeric,
  add column if not exists entry_stop_loss         numeric,
  add column if not exists entry_take_profit       numeric,
  add column if not exists initial_risk_price      numeric,
  add column if not exists initial_risk_pips       numeric,
  add column if not exists entry_time              timestamptz,
  add column if not exists strategy_bar_time       timestamptz,
  add column if not exists strategy_name           text,
  add column if not exists strategy_version        text,
  add column if not exists trading_style           text,
  add column if not exists entry_zone_timeframe    text,
  add column if not exists entry_config_snapshot   jsonb,
  add column if not exists entry_decision_snapshot jsonb;

-- ─── 2. closed history: the same block, plus realized R ──────────────────────

alter table public.paper_trade_history
  add column if not exists entry_route             text,
  add column if not exists entry_price_at_open     numeric,
  add column if not exists entry_stop_loss         numeric,
  add column if not exists entry_take_profit       numeric,
  add column if not exists initial_risk_price      numeric,
  add column if not exists initial_risk_pips       numeric,
  add column if not exists entry_time              timestamptz,
  add column if not exists strategy_bar_time       timestamptz,
  add column if not exists strategy_name           text,
  add column if not exists strategy_version        text,
  add column if not exists trading_style           text,
  add column if not exists entry_zone_timeframe    text,
  add column if not exists entry_config_snapshot   jsonb,
  add column if not exists entry_decision_snapshot jsonb,
  add column if not exists realized_r_gross        numeric,
  add column if not exists realized_r_net          numeric;

comment on column public.paper_positions.entry_stop_loss is
  'IMMUTABLE. The stop at the instant the position opened. stop_loss is the LIVE stop and moves.';
comment on column public.paper_trade_history.entry_stop_loss is
  'IMMUTABLE. The stop at entry. Use this for R, never stop_loss (which is the stop at close).';
comment on column public.paper_trade_history.realized_r_gross is
  '(exit-entry)/initial_risk_price, signed by direction. Null when entry telemetry is absent.';
comment on column public.paper_trade_history.realized_r_net is
  'realized_r_gross minus cost in R. NULL when cost is unknown — never fabricated.';
comment on column public.paper_positions.entry_route is
  'route1_market | route2_pending | legacy_unknown. Set at entry, never inferred from price action.';

-- ─── 3. value domain ─────────────────────────────────────────────────────────

do $$ begin
  alter table public.paper_positions
    add constraint paper_positions_entry_route_valid
    check (entry_route is null or entry_route in ('route1_market','route2_pending','legacy_unknown'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.paper_trade_history
    add constraint paper_history_entry_route_valid
    check (entry_route is null or entry_route in ('route1_market','route2_pending','legacy_unknown'));
exception when duplicate_object then null; end $$;

-- Risk is a positive distance or it is absent. A zero or negative value would
-- silently produce an infinite or sign-flipped R.
do $$ begin
  alter table public.paper_positions
    add constraint paper_positions_initial_risk_positive
    check (initial_risk_price is null or initial_risk_price > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.paper_trade_history
    add constraint paper_history_initial_risk_positive
    check (initial_risk_price is null or initial_risk_price > 0);
exception when duplicate_object then null; end $$;

-- R must be absent unless the risk that defines it is present.
do $$ begin
  alter table public.paper_trade_history
    add constraint paper_history_r_requires_risk
    check (realized_r_gross is null or initial_risk_price is not null);
exception when duplicate_object then null; end $$;

-- ─── 4. LEGACY ROWS ARE NOT BACKFILLED ───────────────────────────────────────
--
-- Deliberately no UPDATE. The only stop a historical row carries is the one
-- management already overwrote, so entry_stop_loss and realized_r cannot be
-- recovered from it. Every pre-existing row keeps NULL entry telemetry and is
-- read as legacy. Fabricating these values is precisely the defect this
-- migration exists to stop.

-- ─── 5. read path ────────────────────────────────────────────────────────────

create index if not exists paper_history_entry_route
  on public.paper_trade_history (bot_id, entry_route, closed_at desc);
