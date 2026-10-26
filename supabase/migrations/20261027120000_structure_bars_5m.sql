-- Canonical append-only 5m bars for the Impulse-on-V3 shadow (owner decision 2026-10-26, option A).
--
-- WHY. The shadow needs every 5m bar soon after it closes (zone touch, confirmation candle, fill, stop / target). smc_scan_bars
-- records 5m bars only when a pair reaches the zone stage, so a third of bars are first recorded more than an hour late
-- (measured 2026-10-26). This store is written by bot-scanner from the 5m entry candles it already fetches every scan
-- (structureBarsWriter5m.ts, DEFAULT OFF via STRUCTURE_BARS_5M_LIVE_WRITE): zero provider calls, observational only.
-- RULES (canonicalBars5m.ts, = the 1H store's D9 rule on the 5m grid): first valid observation ≥ 15 minutes after close wins;
-- later differing values go to structure_bar_5m_revisions; nothing is ever updated or deleted.
-- Apply BY HAND before merging (docs/DEPLOYMENT.md). Reuses public.structure_bars_append_only() from 20261015000000.

create table if not exists public.structure_bars_5m (
  symbol      text        not null,
  bar_time    timestamptz not null,               -- bar OPEN time (UTC), on the 5-minute grid
  open        numeric     not null,               -- rounded to 5 decimal places (all six pairs)
  high        numeric     not null,
  low         numeric     not null,
  close       numeric     not null,
  provider    text,
  source      text        not null,
  source_ref  text,
  observed_at timestamptz not null,               -- when the canonical value was observed (fetch start − 2 min slack)
  frozen_at   timestamptz not null default now(),
  constraint structure_bars_5m_pkey primary key (symbol, bar_time),
  constraint structure_bars_5m_symbol check (symbol in ('EUR/USD','GBP/USD','USD/JPY','CHF/JPY','NZD/CAD','NZD/CHF')),
  constraint structure_bars_5m_grid check ((extract(epoch from bar_time)::bigint % 300) = 0),
  constraint structure_bars_5m_ohlc check (high >= greatest(open, close) and low <= least(open, close) and high >= low),
  constraint structure_bars_5m_settled check (observed_at >= bar_time + interval '20 minutes'),
  constraint structure_bars_5m_source check (source in ('scanner_live'))
);

create table if not exists public.structure_bar_5m_revisions (
  symbol               text        not null,
  bar_time             timestamptz not null,
  value_hash           text        not null,
  open                 numeric     not null,
  high                 numeric     not null,
  low                  numeric     not null,
  close                numeric     not null,
  provider             text,
  source               text        not null,
  source_ref           text,
  observed_at          timestamptz not null,
  canonical_value_hash text        not null,
  max_abs_diff         numeric     not null,
  recorded_at          timestamptz not null default now(),
  constraint structure_bar_5m_revisions_pkey primary key (symbol, bar_time, value_hash, source),
  constraint structure_bar_5m_revisions_source check (source in ('scanner_live'))
);

create index if not exists structure_bars_5m_by_time on public.structure_bars_5m (bar_time);

do $$
declare t text;
begin
  foreach t in array array['structure_bars_5m','structure_bar_5m_revisions'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.structure_bars_append_only()', t || '_append_only', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.structure_bars_append_only()', t || '_no_truncate', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from service_role', t);
    execute format('grant select, insert on public.%I to service_role', t);
  end loop;
end $$;
