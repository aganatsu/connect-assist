-- Repeated-zone exposure telemetry. OBSERVATION ONLY. Additive.
--
-- WHY. The frozen sequencing rule is `touchIndex > previousExitIndex`, so a
-- still-valid IPO may be entered again once the previous trade on it exits. A
-- fixture run showed FOUR consecutive fills on one zone at an identical entry,
-- target and stop. That behaviour is deliberate and is NOT changed here — no
-- cooldown, no one-trade-per-zone, no mitigation retirement. Changing it would
-- be a strategy change needing its own research and version.
--
-- What was missing was the ability to measure it afterwards. `setup_id` already
-- identifies the zone (symbol + timeframe + IPO candle + direction), so the
-- grouping key existed; what did not was the ordinal, the gap between attempts,
-- and — on the history table — the IPO candle and volatility bucket, which only
-- lived on the open position and vanished when it closed.
--
-- These columns answer, by query rather than by re-deriving from bars:
--   first entries vs re-entries          count(*) group by zone_entry_ordinal
--   expectancy by re-entry ordinal       avg(realized_r) group by ordinal
--   realized R per zone                  sum(realized_r) group by setup_id
--   worst cumulative loss on one IPO     min of that sum
--
-- NOTHING HERE FEEDS A DECISION. Every column is written after the execution
-- verdict is already fixed, and a test asserts the ordinal cannot reach it.

-- ─── open positions ──────────────────────────────────────────────────────────
alter table public.ipo_paper_positions
  add column if not exists zone_entry_ordinal      integer,
  add column if not exists zone_previous_exit_time timestamptz;

-- ─── closed results ──────────────────────────────────────────────────────────
-- ipo_candle_time and volatility_bucket are carried over from the position:
-- without them a closed row cannot be attributed to its zone or its regime
-- except by joining back through setup_id, and the regime would be lost outright.
alter table public.ipo_paper_trade_history
  add column if not exists zone_entry_ordinal      integer,
  add column if not exists zone_previous_exit_time timestamptz,
  add column if not exists ipo_candle_time         timestamptz,
  add column if not exists volatility_bucket       text;

-- An ordinal is 1-based when present. Nullable, because rows written before
-- this migration legitimately have none and backfilling one would be inventing
-- a measurement.
do $$ begin
  alter table public.ipo_paper_positions
    add constraint ipo_paper_positions_zone_ordinal_positive
    check (zone_entry_ordinal is null or zone_entry_ordinal >= 1);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.ipo_paper_trade_history
    add constraint ipo_paper_history_zone_ordinal_positive
    check (zone_entry_ordinal is null or zone_entry_ordinal >= 1);
exception when duplicate_object then null; end $$;

-- The analysis index: every question above groups by zone, then orders by time.
create index if not exists ipo_paper_history_zone
  on public.ipo_paper_trade_history (strategy_id, setup_id, entry_time);

create index if not exists ipo_paper_history_ordinal
  on public.ipo_paper_trade_history (strategy_id, zone_entry_ordinal)
  where excluded_from_stats = false;

comment on column public.ipo_paper_trade_history.zone_entry_ordinal is
  '1 for the first trade on this IPO candle, 2 for the next. Counted over the '
  'ENGINE trade list, which at activation already contains the bootstrapped '
  'history — so an ordinal of 3 on the first paper row means the engine had '
  'taken this zone twice before paper trading began. Observation only.';
comment on column public.ipo_paper_trade_history.zone_previous_exit_time is
  'Exit time of the previous trade on this same zone. Null on the first.';
