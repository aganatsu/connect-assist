-- Key bars by OBSERVATION, not by the assumption that a closed bar is final.
--
-- WHAT WENT WRONG, TWICE. `smc_scan_bars` was keyed (symbol, timeframe,
-- bar_time) and written first-write-wins, on the premise that a bar is
-- immutable once observed. Two separate facts falsify that premise:
--
--   1. The FORMING bar changes until its interval ends. Fixed in
--      20260925110000 by keeping it on the manifest instead.
--
--   2. A bar that is closed BY THE CLOCK is not yet final FROM THE PROVIDER.
--      Observed directly: at 11:05:14 the 5m bar opening 11:00 had closed at
--      11:05:00, so it was stored — but Twelve Data was still serving it
--      unfinalized fourteen seconds later. By 11:25 the provider had settled
--      it, so that scan's manifest digest covered different values than the
--      frozen row. Replay: content_hash 41aeea01625e9463 != e5707a0885473a2d.
--
-- Provider revision of already-closed bars is a known FX aggregate behaviour,
-- so no clock rule can fix this. The store has to stop pretending a bar has one
-- true value and record what was actually seen, when.
--
-- THE FIX. One row per DISTINCT observed value: the key gains `bar_hash`, a
-- digest of the OHLC. A re-observation with identical values still collapses to
-- one row — which is the overwhelmingly common case, so the storage argument
-- for normalizing survives intact. A revision adds a second row instead of
-- being silently dropped.
--
-- Reconstruction then means "the value known at scan time": for each bar_time,
-- the latest observation whose first_seen_at does not exceed the manifest's
-- scanned_at. That is reproducible for every scan, past and future, including
-- the ones that saw provisional data.
--
-- The table is rebuilt rather than migrated. It holds ~3,000 rows written in
-- the last hour under the broken premise, none of which can be trusted to be
-- the value any particular scan saw — and it is a new observability table with
-- no history worth preserving. Nothing outside these three tables is touched.

drop table if exists public.smc_scan_bars;

create table public.smc_scan_bars (
  symbol     text        not null,
  timeframe  text        not null,
  bar_time   timestamptz not null,

  -- Digest of this observation's OHLC. Part of the key, so a revised bar is a
  -- new row rather than a lost one.
  bar_hash text not null,

  open  double precision not null,
  high  double precision not null,
  low   double precision not null,
  close double precision not null,
  volume double precision,

  provider text,

  -- When this particular VALUE was first seen. The ordering key for "what did
  -- the scanner know at the moment it scored".
  first_seen_at timestamptz not null default now(),

  constraint smc_scan_bars_pkey primary key (symbol, timeframe, bar_time, bar_hash)
);

-- Reconstruction always filters by symbol+timeframe over a bar_time range and
-- then orders by first_seen_at, so the index carries all four.
create index smc_scan_bars_lookup
  on public.smc_scan_bars (symbol, timeframe, bar_time, first_seen_at desc);

alter table public.smc_scan_bars enable row level security;
alter table public.smc_scan_bars force  row level security;
revoke all on public.smc_scan_bars from anon, authenticated;
grant all on public.smc_scan_bars to service_role;
