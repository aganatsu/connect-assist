-- APPLY PACK — the exact DDL for the two remaining pending migrations.
--
-- GENERATED from the migration files. Do not hand-edit: a test asserts the DDL
-- below is byte-identical to the files, because a stale copy here would record
-- a version as applied while the database received different SQL — which is the
-- same class of divergence the repair step just finished cleaning up.
--
-- WHY THIS EXISTS RATHER THAN `supabase db push`. The CLI needs a direct
-- Postgres connection and therefore SUPABASE_DB_PASSWORD, which this project
-- deliberately does not expose outside CI; and GitHub only dispatches a
-- workflow that exists on the default branch, which apply-migrations.yml does
-- not. This reaches the same end state through the SQL editor.
--
-- EACH MIGRATION IS ONE TRANSACTION, and its bookkeeping row is written INSIDE
-- that transaction. So a failure rolls back the DDL *and* the record together,
-- and the two can never disagree. That is the same guarantee db push gives.
--
-- Run them one at a time, in this order, checking the result of each before
-- moving on. Nothing here deploys a function or creates a schedule.
--
-- Post-apply verification: supabase/queries/ipo_phase_d_verify.sql

-- ═════════════════════════════════════════════════════════════════════════════
-- 20260920200000_ipo_corpus_tier_and_source_family
--
-- ADDITIVE ONLY. Two ADD COLUMN IF NOT EXISTS, two CHECK constraints wrapped
-- in DO blocks that swallow duplicate_object, comments, and three UPDATEs.
-- No destructive statement.
--
-- EXPECT: 4 rows set to TIER_1, 2 rows set to TIER_3, and USER_CONFIRMED rows
-- set to USER_INDEPENDENT. candle_datetime is TEXT and the UPDATEs match ISO
-- literals; the live format was confirmed to match, so these will not
-- silently update zero rows. Verify the counts after committing.
-- ═════════════════════════════════════════════════════════════════════════════

begin;

-- Confidence tier and source family for corpus rows. RESEARCH DATA ONLY.
--
-- WHY THIS EXISTS. Both facts were established by earlier audit work and then
-- written down nowhere. They lived in conversation history alone, and had to be
-- recovered by grepping a session transcript on 2026-09-20. Until now the table
-- could not answer the two questions that decide whether a row may be used:
--
--   "can anyone still go and look at the source?"   -> confidence_tier
--   "whose demonstration is this?"                  -> source_family
--
-- NEITHER IS DERIVABLE FROM evidence_source. That column says what KIND of
-- claim a row is. A VIDEO_DEMONSTRATION whose file no longer exists on disk is
-- still a video demonstration, but nothing can be checked against it. And both
-- an Ezzy row and the user's own independent judgment can carry the same
-- evidence_source, so folding teacher identity into it would let one teacher's
-- corpus be padded with the user's own trading calls — an error made once
-- already and explicitly corrected.
--
-- BOTH ARE NULLABLE, AND NULL MEANS NOT ESTABLISHED. A row whose tier or
-- teacher has never been determined must be storable as unknown. Null must
-- never be read as "probably Tier 1" or "probably Ezzy"; the CHECK constraints
-- reject wrong values precisely so a stored value can be trusted as a finding.
--
-- NOTHING READS THIS FOR TRADING. No production code path is affected.

ALTER TABLE public.ipo_corpus_examples
  ADD COLUMN IF NOT EXISTS confidence_tier text,
  ADD COLUMN IF NOT EXISTS source_family   text;

DO $$ BEGIN
  ALTER TABLE public.ipo_corpus_examples
    ADD CONSTRAINT ice_confidence_tier_check CHECK (confidence_tier IS NULL OR confidence_tier IN (
      'TIER_1_DIRECTLY_INSPECTABLE',
      'TIER_2_DERIVED_FROM_INSPECTABLE_SOURCE',
      'TIER_3_UNINSPECTABLE_LEGACY'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- TUBEPULL_UNKNOWN_SOURCE is its own family rather than "unattributed": the
-- material exists and is usable, but it has NOT been shown to come from the
-- same teacher, so it must never be pooled with EZZY when validating or
-- invalidating Ezzy's rules.
DO $$ BEGIN
  ALTER TABLE public.ipo_corpus_examples
    ADD CONSTRAINT ice_source_family_check CHECK (source_family IS NULL OR source_family IN (
      'EZZY',
      'TUBEPULL_UNKNOWN_SOURCE',
      'USER_INDEPENDENT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.ipo_corpus_examples.confidence_tier IS
  'Whether the demonstration can still be re-checked against its own source. '
  'NULL = not established. TIER_3 rows must not be used to propose a rule.';
COMMENT ON COLUMN public.ipo_corpus_examples.source_family IS
  'Which teacher/source the demonstration came from. NULL = not yet attributed, '
  'never "probably EZZY".';

-- ── Backfill of assignments already established by audit ────────────────────
-- Keyed on the natural key (symbol, timeframe, candle_datetime, direction).
-- Only rows whose tier was actually determined are touched; anything else is
-- deliberately left NULL rather than guessed.

-- Tier 1: source frame directly inspectable. 1d 2020-05-11 and 4h 2020-05-11
-- 16:00 were TIER_2 until independent pixel measurement raised them.
UPDATE public.ipo_corpus_examples SET confidence_tier = 'TIER_1_DIRECTLY_INSPECTABLE', source_family = 'EZZY'
 WHERE symbol = 'BTC/USD' AND (
   (timeframe = '1d' AND candle_datetime = '2020-04-20T00:00:00Z' AND direction = 'demand') OR
   (timeframe = '4h' AND candle_datetime = '2020-05-08T16:00:00Z' AND direction = 'supply') OR
   (timeframe = '1d' AND candle_datetime = '2020-05-11T00:00:00Z' AND direction = 'demand') OR
   (timeframe = '4h' AND candle_datetime = '2020-05-11T16:00:00Z' AND direction = 'demand'));

-- Tier 3: no source file matching the label exists on disk, so the marked
-- candle cannot be re-verified. 2020-04-08 additionally has no containing
-- structural leg, so no origin rule can score it at all.
UPDATE public.ipo_corpus_examples SET confidence_tier = 'TIER_3_UNINSPECTABLE_LEGACY', source_family = 'EZZY'
 WHERE symbol = 'BTC/USD' AND timeframe = '1d' AND (
   (candle_datetime = '2020-03-27T00:00:00Z' AND direction = 'demand') OR
   (candle_datetime = '2020-04-08T00:00:00Z' AND direction = 'supply'));

-- The user's own trading judgments are a separate family and must not be
-- reclassified as Ezzy demonstrations. Their tier is left NULL: tier describes
-- inspectability of a recorded source, which is not what these rows are.
UPDATE public.ipo_corpus_examples SET source_family = 'USER_INDEPENDENT'
 WHERE evidence_source = 'USER_CONFIRMED' AND source_family IS NULL;

insert into supabase_migrations.schema_migrations (version)
values ('20260920200000') on conflict (version) do nothing;

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- 20260921140000_ipo_paper_state
--
-- CREATES ONLY. Three tables, five indexes, three unique constraints, RLS
-- enabled and forced, anon/authenticated revoked, service_role granted.
-- No destructive statement, and it touches nothing pre-existing except
-- auth.users via foreign key. All three tables were confirmed absent.
-- ═════════════════════════════════════════════════════════════════════════════

begin;

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

insert into supabase_migrations.schema_migrations (version)
values ('20260921140000') on conflict (version) do nothing;

commit;

