-- IPO EXACT ENTRY TIMESTAMP
--
-- `entry_time` has always held the STRATEGY BAR OPEN — bars[entryIndex].datetime,
-- via intent.barTime — not the moment price reached the entry. A 1h fill at
-- 15:37 was recorded and displayed as 15:00.
--
-- The causal resolver already locates the fill minute (ipoCausalOrdering
-- `firstEntryMinute`), but it only ran when the OUTCOME was ambiguous, and even
-- then the minute was dropped from the position row. 3 of 18 closed rows and 0
-- of 2 open positions carried it.
--
-- After this migration the two fields mean exactly one thing each:
--   entry_time        the best-known causal entry INSTANT
--   strategy_bar_time the HTF bar that contained it, bar-aligned, always
--
-- Precision is not a stored flag: entry_minute_time non-null means entry_time
-- is the proven minute, null means it is the bar and the minute is unknown.

-- ─── 1. the new column ───────────────────────────────────────────────────────

alter table public.ipo_paper_positions
  add column if not exists strategy_bar_time timestamptz;

alter table public.ipo_paper_trade_history
  add column if not exists strategy_bar_time timestamptz;

comment on column public.ipo_paper_positions.strategy_bar_time is
  'HTF bar that contained the fill (bar-aligned). entry_time is the causal entry instant.';
comment on column public.ipo_paper_trade_history.strategy_bar_time is
  'HTF bar that contained the fill (bar-aligned). entry_time is the causal entry instant.';

-- ─── 2. preserve the old meaning before repointing ───────────────────────────
-- Lossless: every existing entry_time IS the strategy bar, so this is a copy,
-- not a derivation. Doing it first makes step 3 reversible.

update public.ipo_paper_positions
   set strategy_bar_time = entry_time
 where strategy_bar_time is null;

update public.ipo_paper_trade_history
   set strategy_bar_time = entry_time
 where strategy_bar_time is null;

-- ─── 3. adopt the minute where it was ALREADY recorded ───────────────────────
-- Only rows that already hold a tape-proven entry_minute_time. No minute is
-- manufactured here: a legacy row with a null entry_minute_time keeps its bar
-- timestamp and is reported as strategy-bar precision, because the tape that
-- would have proven its minute no longer exists to be consulted.

update public.ipo_paper_positions
   set entry_time = entry_minute_time
 where entry_minute_time is not null
   and entry_minute_time <> entry_time;

update public.ipo_paper_trade_history
   set entry_time = entry_minute_time
 where entry_minute_time is not null
   and entry_minute_time <> entry_time;

-- ─── 4. the invariant ────────────────────────────────────────────────────────
-- An entry cannot precede the bar that contains it, and once a minute is proven
-- entry_time must equal it. Both tables are small and append-mostly, so this is
-- cheap and it stops the two fields drifting apart again.

do $$ begin
  alter table public.ipo_paper_positions
    add constraint ipo_paper_positions_entry_time_in_bar
    check (strategy_bar_time is null or entry_time >= strategy_bar_time);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.ipo_paper_positions
    add constraint ipo_paper_positions_entry_minute_is_entry_time
    check (entry_minute_time is null or entry_minute_time = entry_time);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.ipo_paper_trade_history
    add constraint ipo_paper_history_entry_time_in_bar
    check (strategy_bar_time is null or entry_time >= strategy_bar_time);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.ipo_paper_trade_history
    add constraint ipo_paper_history_entry_minute_is_entry_time
    check (entry_minute_time is null or entry_minute_time = entry_time);
exception when duplicate_object then null; end $$;
