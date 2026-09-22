-- IPO-owned paper trading state. Phase D.
--
-- WHY SEPARATE TABLES AND NOT A strategy_id COLUMN ON THE SMC ONES.
-- bot-daily-review does not merely include an unlabelled row, it ATTRIBUTES it:
--
--     if (t.bot_id) return t.bot_id === botId;  ...  return botId === "smc";
--
-- An IPO row in paper_trade_history would therefore have been COUNTED AS AN SMC
-- TRADE and inflated SMC's measured performance. Sharing a table would make
-- correctness depend on a dozen readers each remembering to filter; separate
-- tables make it depend on nothing.
--
-- NOTHING HERE IS REACHABLE FROM A BROWSER. RLS is enabled and FORCED, the anon
-- and authenticated grants are revoked, and access is service_role only through
-- an edge function.

-- ─── open positions ──────────────────────────────────────────────────────────
create table if not exists public.ipo_paper_positions (
  id uuid primary key default gen_random_uuid(),

  -- Ownership is NOT NULL on purpose: a nullable owner is precisely the SMC
  -- failure mode this design exists to avoid.
  strategy_id      text not null,
  strategy_version text not null,
  setup_id         text not null,
  intent_id        text not null,
  user_id          uuid not null references auth.users(id) on delete cascade,

  symbol     text not null,
  timeframe  text not null,
  direction  text not null check (direction in ('long','short')),

  entry_time            timestamptz      not null,
  entry_price           double precision not null,
  target_price          double precision not null,
  s2_invalidation_level double precision not null,
  nominal_risk_distance double precision not null check (nominal_risk_distance > 0),
  cost_r                double precision not null,

  -- Paper-dollar sizing. R is canonical; these exist so a dollar view is
  -- possible without the strategy result ever depending on a risk policy.
  reference_balance_at_entry numeric          not null,
  nominal_risk_pct           numeric          not null,
  nominal_risk_usd           numeric          not null,

  ipo_candle_time   timestamptz not null,
  volatility_bucket text        not null,

  -- Phase D cannot hold a live position. The CHECK is the guarantee.
  execution_mode text not null default 'paper' check (execution_mode = 'paper'),

  status text not null default 'open'
    check (status in ('open','data_gap_suspended')),

  mae_r double precision not null default 0,
  mfe_r double precision not null default 0,

  -- Resume anchor for incremental management and gap detection.
  last_managed_bar_time timestamptz not null,
  gap_from_bar_time     timestamptz,
  gap_to_bar_time       timestamptz,
  gap_reason            text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ipo_paper_positions_intent_key unique (intent_id)
);

-- One open position per strategy per instrument, enforced by the DATABASE and
-- not only by application logic.
create unique index if not exists ipo_paper_positions_one_open
  on public.ipo_paper_positions (strategy_id, symbol)
  where status in ('open','data_gap_suspended');

create index if not exists ipo_paper_positions_user_symbol
  on public.ipo_paper_positions (user_id, symbol, entry_time desc);

-- ─── closed results ──────────────────────────────────────────────────────────
create table if not exists public.ipo_paper_trade_history (
  id uuid primary key default gen_random_uuid(),

  strategy_id      text not null,
  strategy_version text not null,
  setup_id         text not null,
  intent_id        text not null,
  user_id          uuid not null references auth.users(id) on delete cascade,

  symbol     text not null,
  timeframe  text not null,
  direction  text not null check (direction in ('long','short')),

  entry_time            timestamptz      not null,
  entry_price           double precision not null,
  target_price          double precision not null,
  s2_invalidation_level double precision not null,
  nominal_risk_distance double precision not null,
  cost_r                double precision not null,

  reference_balance_at_entry numeric not null,
  nominal_risk_pct           numeric not null,
  nominal_risk_usd           numeric not null,

  exit_time  timestamptz not null,
  -- NULL only for a data-gap abort, which has no strategy exit price.
  exit_price double precision,
  exit_reason text not null
    check (exit_reason in ('TARGET_2R','S2_CLOSE_INVALIDATION','DATA_GAP_ABORTED')),

  -- realized_r is the CANONICAL strategy result. realized_pnl_usd is a view of
  -- it under the sizing recorded above, never the other way round.
  realized_r        double precision,
  gross_r           double precision,
  realized_pnl_usd  numeric,

  mae_r double precision not null default 0,
  mfe_r double precision not null default 0,
  bars_held integer not null default 0,

  -- Target and S2 on one bar. Resolved stop-first, flag kept so the optimistic
  -- reading stays recoverable without changing the recorded result.
  same_bar_ambiguous boolean not null default false,

  -- A data-gap abort is a DATA-QUALITY failure, not a strategy outcome. It must
  -- never enter clean strategy statistics, so the exclusion is a stored column
  -- rather than a convention every reader has to remember.
  excluded_from_stats boolean not null default false,
  exclusion_reason    text,
  gap_from_bar_time   timestamptz,
  gap_to_bar_time     timestamptz,

  created_at timestamptz not null default now(),

  constraint ipo_paper_history_intent_key unique (intent_id),

  -- A real strategy exit must carry a price and an R; an abort must carry
  -- neither and must be excluded.
  constraint ipo_paper_history_outcome_coherent check (
    (exit_reason <> 'DATA_GAP_ABORTED'
       and exit_price is not null and realized_r is not null
       and excluded_from_stats = false)
    or
    (exit_reason = 'DATA_GAP_ABORTED'
       and realized_r is null and excluded_from_stats = true
       and exclusion_reason is not null)
  )
);

create index if not exists ipo_paper_history_user_time
  on public.ipo_paper_trade_history (user_id, exit_time desc);
create index if not exists ipo_paper_history_clean
  on public.ipo_paper_trade_history (strategy_id, exit_time desc)
  where excluded_from_stats = false;

-- ─── append-only audit ───────────────────────────────────────────────────────
create table if not exists public.ipo_execution_events (
  id bigserial primary key,
  event_id text not null,

  strategy_id      text not null,
  strategy_version text not null,
  setup_id text,
  intent_id text,
  user_id  uuid not null references auth.users(id) on delete cascade,

  symbol    text not null,
  bar_time  timestamptz not null,
  event_type text not null check (event_type in
    ('SETUP_VALID','INTENT_CREATED','FILLED','REFUSED','MANAGED','CLOSED',
     'GAP_SUSPENDED','GAP_RECOVERED','GAP_ABORTED')),

  -- Recorded SEPARATELY and never collapsed: the strategy result must survive
  -- whatever account safety would have done to it.
  strategy_decision text not null,
  account_decision  text not null default 'UNAVAILABLE',
  reason_codes jsonb not null default '[]'::jsonb,
  payload      jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  constraint ipo_execution_events_event_key unique (event_id)
);

create index if not exists ipo_execution_events_lookup
  on public.ipo_execution_events (strategy_id, symbol, bar_time desc);

-- ─── security: identical posture on all three ────────────────────────────────
-- FORCE matters and ENABLE alone is not enough: without it the table OWNER
-- bypasses RLS. REVOKE matters too — RLS governs rows, grants govern
-- reachability, and leaving default grants in place lets PostgREST attempt the
-- query before RLS refuses it.
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
grant usage, select on sequence public.ipo_execution_events_id_seq to service_role;

comment on table public.ipo_paper_positions is
  'IPO-owned PAPER positions. Never read or written by SMC. execution_mode is '
  'CHECK-constrained to paper. Service role only; browser access is via edge '
  'function. See docs/IPO_PHASE_D_DESIGN.md.';
comment on table public.ipo_paper_trade_history is
  'IPO-owned PAPER results. realized_r is the canonical strategy result; '
  'realized_pnl_usd is a view of it under the recorded nominal sizing. '
  'DATA_GAP_ABORTED rows carry no strategy exit and are excluded_from_stats.';
comment on table public.ipo_execution_events is
  'Append-only IPO audit. One row per decision INCLUDING refusals, so a forward '
  'test can answer why nothing traded. strategy_decision and account_decision '
  'are recorded separately and never collapsed.';
