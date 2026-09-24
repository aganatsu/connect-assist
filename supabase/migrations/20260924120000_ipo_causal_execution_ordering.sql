-- IPO forward-evidence containment: causal event ordering. ADDITIVE ONLY.
--
-- WHY. The forward paper runner derived the entry from one extreme of an HTF
-- bar and then evaluated the brand-new position against the WHOLE of that same
-- bar. An OHLC bar carries no path ordering, so a target-side excursion that
-- occurred BEFORE the entry touch could book TARGET_2R on a position that did
-- not yet exist. Recorded instance: BTC/USD 1h 2026-09-23T14:00Z opened at
-- 85792.01, already above the 85159.525 target, on a trade that entered at
-- 84473.315 later in the same hour. The true 1-minute path was an S2 close.
--
-- WHAT CHANGES HERE. Nothing about the strategy. No column alters a price, a
-- level, a target or an invalidation rule. These columns record HOW an outcome
-- was ordered, WHICH feed supplied the tape, and WHICH forward-evidence model
-- produced the row — so contaminated legacy rows and corrected ones can never
-- be pooled by accident.
--
-- NOTHING IS REWRITTEN AND NOTHING IS DELETED. Every column is nullable with no
-- default backfill. A row with `causal_execution_version` NULL is legacy,
-- pre-fix forward evidence, and stays exactly as it was recorded.
--
-- IPO-OWNED ONLY. No SMC table is named anywhere in this file.

-- ─── open positions ──────────────────────────────────────────────────────────
alter table public.ipo_paper_positions
  -- The forward-evidence boundary. NULL = recorded before the ordering fix.
  add column if not exists causal_execution_version text,
  -- The minute the position actually came into existence, when 1m proved it.
  add column if not exists entry_minute_time        timestamptz,
  add column if not exists entry_resolution_method  text,
  -- Provider provenance. Previous research showed venue mismatches matter, and
  -- the fetch layer already returns the source; discarding it was the waste.
  add column if not exists htf_source               text,
  add column if not exists minute_source            text,
  -- Set when the tape refused an exit the frozen engine booked from whole-bar
  -- OHLC. The paper position then legitimately outlives the engine's trade.
  add column if not exists engine_exit_overridden   boolean not null default false,
  add column if not exists engine_exit_bar_time     timestamptz,
  -- OBSERVATIONAL CONTEXT TAG. NOT A GATE. Experiment 3 refuted the HTF-opposed
  -- hypothesis on unseen data, so no context filter is promoted; this exists so
  -- forward data can answer the question later without re-deriving bars.
  add column if not exists daily_structure           text,
  add column if not exists daily_structure_alignment text,
  add column if not exists daily_structure_as_of     timestamptz;

-- ─── closed results ──────────────────────────────────────────────────────────
alter table public.ipo_paper_trade_history
  add column if not exists causal_execution_version text,
  add column if not exists entry_minute_time        timestamptz,
  add column if not exists target_minute_time       timestamptz,
  add column if not exists s2_close_bar_time        timestamptz,
  add column if not exists exit_resolution_method   text,
  add column if not exists htf_source               text,
  add column if not exists minute_source            text,
  -- What whole-bar OHLC alone would have booked, recorded only where it differs
  -- from the causal answer. Diagnostic; nothing branches on it.
  add column if not exists htf_would_have_booked    text,
  add column if not exists daily_structure           text,
  add column if not exists daily_structure_alignment text,
  add column if not exists daily_structure_as_of     timestamptz;

-- ─── ORDERING_UNRESOLVED is a DATA verdict, not a strategy outcome ───────────
-- Emitted when competing events cannot be ordered against the fill — most often
-- entry and target inside the same minute with no tick feed to separate them.
-- It carries no realized R and is excluded from statistics for the same reason
-- DATA_GAP_ABORTED is: inventing a winner or a loser there would be exactly the
-- contamination this migration exists to end.
alter table public.ipo_paper_trade_history
  drop constraint if exists ipo_paper_trade_history_exit_reason_check;
alter table public.ipo_paper_trade_history
  add constraint ipo_paper_trade_history_exit_reason_check
  check (exit_reason in
    ('TARGET_2R','S2_CLOSE_INVALIDATION','DATA_GAP_ABORTED','ORDERING_UNRESOLVED'));

alter table public.ipo_paper_trade_history
  drop constraint if exists ipo_paper_history_outcome_coherent;
alter table public.ipo_paper_trade_history
  add constraint ipo_paper_history_outcome_coherent check (
    (exit_reason not in ('DATA_GAP_ABORTED','ORDERING_UNRESOLVED')
       and exit_price is not null and realized_r is not null
       and excluded_from_stats = false)
    or
    (exit_reason in ('DATA_GAP_ABORTED','ORDERING_UNRESOLVED')
       and realized_r is null and excluded_from_stats = true
       and exclusion_reason is not null)
  );

-- ─── the audit trail gains one event type ────────────────────────────────────
-- CAUSAL_OVERRIDE is written the moment the tape refuses an exit the frozen
-- engine booked. A disagreement between the two must never be silent.
alter table public.ipo_execution_events
  drop constraint if exists ipo_execution_events_event_type_check;
alter table public.ipo_execution_events
  add constraint ipo_execution_events_event_type_check
  check (event_type in
    ('SETUP_VALID','INTENT_CREATED','FILLED','REFUSED','MANAGED','CLOSED',
     'GAP_SUSPENDED','GAP_RECOVERED','GAP_ABORTED','CAUSAL_OVERRIDE'));

-- ─── indexes for the forward-evidence boundary ───────────────────────────────
-- The default analysis population: causally ordered, statistically usable.
create index if not exists ipo_paper_history_causal_clean
  on public.ipo_paper_trade_history (strategy_id, exit_time desc)
  where causal_execution_version is not null and excluded_from_stats = false;

create index if not exists ipo_paper_history_unresolved
  on public.ipo_paper_trade_history (strategy_id, exit_time desc)
  where exit_reason = 'ORDERING_UNRESOLVED';

-- ─── security posture, restated ──────────────────────────────────────────────
-- `supabase db push` applies every pending migration, and a table touched here
-- must carry the full posture in this file too — ENABLE alone lets the owner
-- bypass RLS, and leaving default grants lets PostgREST attempt the query before
-- RLS refuses it. All four statements are idempotent.
alter table public.ipo_paper_positions      enable row level security;
alter table public.ipo_paper_positions      force  row level security;
alter table public.ipo_paper_trade_history  enable row level security;
alter table public.ipo_paper_trade_history  force  row level security;
alter table public.ipo_execution_events     enable row level security;
alter table public.ipo_execution_events     force  row level security;

revoke all on public.ipo_paper_positions     from anon, authenticated;
revoke all on public.ipo_paper_trade_history from anon, authenticated;
revoke all on public.ipo_execution_events    from anon, authenticated;

grant all on public.ipo_paper_positions     to service_role;
grant all on public.ipo_paper_trade_history to service_role;
grant all on public.ipo_execution_events    to service_role;
