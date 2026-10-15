-- V3.2c PR2: canonical append-only 1H structure-bar store + revision / rejection telemetry. ADDITIVE.
-- Nothing in trading reads these tables. Writers: the research import tool (local-runner, approved datasets only) and
-- the bot-scanner live writer (DEFAULT OFF; STRUCTURE_BARS_LIVE_WRITE). Apply by hand BEFORE merging dependent code.
--
-- Canonical rule (D9 amended 2026-10-15): the canonical 1H bar is the first valid observation made at least 15 minutes
-- after the bar's close; later differing observations are revision telemetry and never rewrite canonical history.
-- Spans (Q2 / D26): research_import owns 2025-04-16 21:00Z → 2026-10-09 21:00Z; scanner_live may only write bars at or
-- after 2026-10-23 21:00Z (the reserved V2.1.1 OOS window 2026-10-12 → 10-23 is never written live); smc_scan_bars_fill
-- (a later, separately approved path) covers 2026-10-09 21:00Z → the live release.

-- ── canonical bars ────────────────────────────────────────────────────────────
create table if not exists public.structure_bars_1h (
  symbol      text        not null,
  bar_time    timestamptz not null,               -- bar OPEN time (UTC), on the hour
  open        numeric     not null,               -- rounded to 5 decimal places (all six pairs, JPY included)
  high        numeric     not null,
  low         numeric     not null,
  close       numeric     not null,
  provider    text,
  source      text        not null,
  source_ref  text,                               -- dataset sha256 for research_import
  observed_at timestamptz not null,               -- when the canonical value was observed (conservative)
  frozen_at   timestamptz not null default now(),
  constraint structure_bars_1h_pkey primary key (symbol, bar_time),
  constraint structure_bars_1h_symbol check (symbol in ('EUR/USD','GBP/USD','USD/JPY','CHF/JPY','NZD/CAD','NZD/CHF')),
  constraint structure_bars_1h_on_hour check ((extract(epoch from bar_time)::bigint % 3600) = 0),
  constraint structure_bars_1h_epoch check (bar_time >= timestamptz '2025-04-16 21:00:00+00'),
  constraint structure_bars_1h_ohlc check (high >= greatest(open, close) and low <= least(open, close) and high >= low),
  constraint structure_bars_1h_settled check (observed_at >= bar_time + interval '75 minutes'),
  constraint structure_bars_1h_source check (source in ('research_import','scanner_live','smc_scan_bars_fill')),
  constraint structure_bars_1h_import_span check (source <> 'research_import' or bar_time < timestamptz '2026-10-09 21:00:00+00'),
  constraint structure_bars_1h_live_span check (source <> 'scanner_live' or bar_time >= timestamptz '2026-10-23 21:00:00+00'),
  constraint structure_bars_1h_fill_span check (source <> 'smc_scan_bars_fill' or bar_time >= timestamptz '2026-10-09 21:00:00+00')
);

-- ── revision telemetry: a later observation that differs from the canonical value ─────────────
create table if not exists public.structure_bar_revisions (
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
  constraint structure_bar_revisions_pkey primary key (symbol, bar_time, value_hash, source),
  constraint structure_bar_revisions_source check (source in ('research_import','scanner_live','smc_scan_bars_fill','smc_scan_bars_compare'))
);

-- ── rejection telemetry: observations that could not become canonical (data quality / not yet settled) ─────
create table if not exists public.structure_bar_rejections (
  symbol      text        not null,
  bar_time    timestamptz not null,
  reason      text        not null,
  value_hash  text        not null,
  open        numeric,
  high        numeric,
  low         numeric,
  close       numeric,
  provider    text,
  source      text        not null,
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint structure_bar_rejections_pkey primary key (symbol, bar_time, reason, value_hash, source),
  constraint structure_bar_rejections_reason check (reason in ('unknown_symbol','ohlc_inconsistent','off_grid','outside_fx_hours','not_settled')),
  constraint structure_bar_rejections_source check (source in ('research_import','scanner_live','smc_scan_bars_fill'))
);

create index if not exists structure_bars_1h_by_time on public.structure_bars_1h (bar_time);
create index if not exists structure_bar_revisions_by_time on public.structure_bar_revisions (symbol, bar_time);

-- ── append-only: canonical history and telemetry are never updated, deleted or truncated ──────────────────
create or replace function public.structure_bars_append_only()
returns trigger language plpgsql as $function$
begin
  raise exception '% is append-only (% refused)', tg_table_name, tg_op using errcode = 'check_violation';
end $function$;

do $$
declare t text;
begin
  foreach t in array array['structure_bars_1h','structure_bar_revisions','structure_bar_rejections'] loop
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

comment on table public.structure_bars_1h is
  'V3.2c canonical 1H bars (append-only). First valid observation >= 15 min after close wins permanently; research_import owns 2025-04-16 21:00Z..2026-10-09 21:00Z; scanner_live only >= 2026-10-23 21:00Z. Read by nothing in trading.';
