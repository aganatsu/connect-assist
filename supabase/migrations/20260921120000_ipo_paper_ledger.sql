-- IPO forward/paper-trading ledger.
--
-- One row per CANDIDATE, not per fill. A ledger that records only fills cannot
-- answer "why did nothing trade on Tuesday", which is the question a forward
-- test exists to answer — so refusals are rows too, with a reason.
--
-- Append-only by intent. The natural key exists so a re-run of the stateless
-- replay is idempotent rather than duplicating history.

create table if not exists public.ipo_paper_ledger (
  id uuid primary key default gen_random_uuid(),

  -- natural key: one row per (instrument, signal bar, originating IPO candle)
  instrument        text        not null,
  timeframe         text        not null,
  bar_time          timestamptz not null,
  ipo_candle_time   timestamptz not null,

  direction         text        not null check (direction in ('long','short')),
  ipo_zone_low      double precision not null,
  ipo_zone_high     double precision not null,
  entry_level       double precision not null,
  invalidation_level double precision not null,
  target_price      double precision,

  fvg_present       boolean     not null,
  fvg_time          timestamptz,
  volatility_bucket text        not null,
  contraction_state text        not null,
  lifecycle_state   text        not null,

  filled            boolean     not null,
  no_fill_reason    text,
  fill_price        double precision,
  exit_time         timestamptz,
  exit_price        double precision,
  exit_reason       text        not null,

  realized_r        double precision,
  mae               double precision,
  mfe               double precision,

  created_at        timestamptz not null default now(),

  -- A filled row must carry a price; an unfilled row must carry a reason and
  -- must not carry a result. The same invariants auditLedger() enforces in TS,
  -- enforced again where the data actually lives.
  constraint ipo_paper_ledger_fill_coherent check (
    (filled and fill_price is not null and no_fill_reason is null)
    or
    (not filled and fill_price is null and no_fill_reason is not null and realized_r is null)
  ),
  constraint ipo_paper_ledger_natural_key
    unique (instrument, bar_time, ipo_candle_time)
);

create index if not exists ipo_paper_ledger_instrument_bar_idx
  on public.ipo_paper_ledger (instrument, bar_time desc);
create index if not exists ipo_paper_ledger_filled_idx
  on public.ipo_paper_ledger (filled, bar_time desc) where filled;

-- Project-owned research data, matching the posture already established for
-- ipo_corpus_examples (migration 20260920100000) exactly.
--
-- FORCE matters and ENABLE alone is not enough: without it the table OWNER
-- bypasses RLS, so a query run as the owning role would still read the table.
-- REVOKE matters too — RLS governs rows, grants govern reachability, and
-- leaving the default grants in place means PostgREST will happily attempt the
-- query before RLS refuses it. Both, or the guarantee is partial.
--
-- HARDENED 2026-09-21 at the D.2 checkpoint, before anything was applied.
-- `supabase db push` applies every pending migration, so this file would have
-- gone to the database alongside the Phase D one — un-hardened. The three lines
-- below are not optional extras for later; they are the difference between this
-- table being unreachable and being merely empty.
alter table public.ipo_paper_ledger enable row level security;
alter table public.ipo_paper_ledger force  row level security;

revoke all on public.ipo_paper_ledger from anon, authenticated;
grant all on public.ipo_paper_ledger to service_role;

comment on table public.ipo_paper_ledger is
  'IPO forward/paper-trading ledger. PAPER ONLY — no broker execution is derived '
  'from this table. One row per candidate including refusals. See '
  'docs/IPO_FORWARD_TRADING_SPEC.md section 10.';
