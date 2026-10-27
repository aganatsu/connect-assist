-- Broker vs bot price log (Impulse-on-V3 step 4c; owner decision S3 = measure first, 2026-10-27).
--
-- Every paper position mirrored to MT5 (Impulse and V3 alike) records, per broker connection:
--   open                 the bot's fill price next to MT5's open price (slippage), plus the broker position id
--   open_skipped         the mirror was skipped (spread too wide): the paper position runs with no broker copy
--   open_failed          MT5 refused or did not answer the open
--   close_mirrored       the bot closed and MT5 still held the trade: the bot's exit next to MT5's price at that moment
--   broker_closed_first  the bot closed but MT5 no longer held the trade: MT5's own close (time, price, reason), e.g. a
--                        21:00 UTC rollover spike our feed does not have
-- Measurement only: written best-effort by bot-scanner after the existing mirror calls, never read by any trading path.
-- Append-only. Apply BY HAND before merging (docs/DEPLOYMENT.md).

create table if not exists public.broker_price_log (
  id                 bigint generated always as identity primary key,
  user_id            uuid        not null,
  bot_id             text        not null,
  position_id        text        not null,
  connection_id      uuid        not null,
  symbol             text        not null,
  direction          text        not null,
  entry_zone_type    text,
  event              text        not null,
  bot_price          numeric,
  broker_price       numeric,
  broker_open_price  numeric,
  slippage_pips      numeric,
  broker_position_id text,
  broker_time        timestamptz,
  broker_reason      text,
  bot_close_reason   text,
  rollover_window    boolean,
  detail             jsonb       not null default '{}'::jsonb,
  observed_at        timestamptz not null default now(),
  constraint broker_price_log_event check (event in ('open','open_skipped','open_failed','close_mirrored','broker_closed_first')),
  constraint broker_price_log_direction check (direction in ('long','short')),
  constraint broker_price_log_once unique (position_id, connection_id, event)
);

create index if not exists broker_price_log_by_user_time on public.broker_price_log (user_id, observed_at desc);

drop trigger if exists broker_price_log_append_only on public.broker_price_log;
create trigger broker_price_log_append_only before update or delete on public.broker_price_log for each row execute function public.structure_bars_append_only();
drop trigger if exists broker_price_log_no_truncate on public.broker_price_log;
create trigger broker_price_log_no_truncate before truncate on public.broker_price_log for each statement execute function public.structure_bars_append_only();

alter table public.broker_price_log enable row level security;
alter table public.broker_price_log force row level security;
revoke all on public.broker_price_log from anon, authenticated, service_role;
grant select, insert on public.broker_price_log to service_role;
grant select on public.broker_price_log to authenticated;
drop policy if exists broker_price_log_owner_read on public.broker_price_log;
create policy broker_price_log_owner_read on public.broker_price_log for select to authenticated using (user_id = auth.uid());
