-- PRE-MIGRATION PREFLIGHT — paste into the Supabase SQL editor and run.
--
-- Read-only. Every statement is a SELECT. Nothing is applied.
--
-- WHY THIS EXISTS RATHER THAN A CI DRY RUN. `supabase db push --dry-run` needs
-- a direct Postgres connection and therefore SUPABASE_DB_PASSWORD, which this
-- repo does not have; and GitHub only dispatches a workflow_dispatch workflow
-- that exists on the DEFAULT branch, which apply-migrations.yml does not. This
-- answers the same questions with no credential and no merge.
--
-- Returns (section, item, value). Read `4. ADD CONSTRAINT COLLISION` first: it
-- is the one that decides whether 20260920100000 can succeed at all.

with
-- ── 1. what the database thinks is already applied ───────────────────────────
applied as (
  select '1. MIGRATION HISTORY' as section,
         v as item,
         case when exists (select 1 from supabase_migrations.schema_migrations m
                           where m.version = v)
              then 'ALREADY APPLIED' else 'pending' end as value
  from (values ('20260920100000'),('20260920200000'),('20260921140000')) t(v)
),

-- ── 2. the live shape of the table 20260920100000 rewrites ───────────────────
cols as (
  select '2. ipo_corpus_examples COLUMNS' as section,
         column_name as item,
         data_type || case when is_nullable='YES' then ' null' else ' not null' end as value
  from information_schema.columns
  where table_schema='public' and table_name='ipo_corpus_examples'
),
expected_cols as (
  select '2b. COLUMN EXPECTATIONS' as section, c as item,
         case when exists (select 1 from information_schema.columns
                           where table_schema='public' and table_name='ipo_corpus_examples'
                             and column_name = c)
              then 'present' else 'ABSENT' end as value
  from (values ('user_id'),('confidence_tier'),('source_family')) x(c)
),

-- ── 3. corpus size and ownership, because user_id is about to be dropped ─────
corpus as (
  select '3. CORPUS' as section, 'rows' as item, count(*)::text as value
  from public.ipo_corpus_examples
  union all
  select '3. CORPUS', 'distinct user_id',
         (select count(distinct user_id)::text from public.ipo_corpus_examples)
  where exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='ipo_corpus_examples'
                  and column_name='user_id')
),

-- ── 4. THE DECISIVE CHECK ────────────────────────────────────────────────────
-- 20260920100000 drops user_id and then re-adds ice_unique_example WITHOUT it:
--     UNIQUE NULLS NOT DISTINCT (symbol, timeframe, candle_datetime, direction)
-- The old key included user_id. If two rows differ ONLY by user_id they become
-- duplicates and the ADD CONSTRAINT fails — after the DROP COLUMN has already
-- run. GROUP BY treats NULLs as equal, which is exactly NULLS NOT DISTINCT, so
-- this is the same test Postgres will apply.
collisions as (
  select '4. ADD CONSTRAINT COLLISION' as section,
         'colliding groups (0 = safe to apply)' as item,
         count(*)::text as value
  from (select symbol, timeframe, candle_datetime, direction
        from public.ipo_corpus_examples
        group by 1,2,3,4 having count(*) > 1) d
),
collision_detail as (
  select '4b. COLLIDING ROWS' as section,
         symbol||' '||timeframe||' '||coalesce(candle_datetime,'(null)')||' '||direction as item,
         count(*)::text || ' rows' as value
  from public.ipo_corpus_examples
  group by symbol, timeframe, candle_datetime, direction
  having count(*) > 1
),

-- ── 5. does anything the Phase D migration creates already exist? ────────────
phase_d as (
  select '5. PHASE D TABLES' as section, t as item,
         case when to_regclass('public.'||t) is not null
              then 'ALREADY EXISTS' else 'absent (will be created)' end as value
  from (values ('ipo_paper_positions'),('ipo_paper_trade_history'),
               ('ipo_execution_events')) x(t)
),
retired as (
  select '5b. RETIRED OBJECT' as section, 'ipo_paper_ledger' as item,
         case when to_regclass('public.ipo_paper_ledger') is not null
              then 'EXISTS — investigate, it was never supposed to be applied'
              else 'absent (correct)' end as value
),

-- ── 6. SMC baselines, so Step 5 has a before ─────────────────────────────────
smc as (
  select '6. SMC BASELINE' as section, 'paper_positions' as item, count(*)::text as value
  from public.paper_positions
  union all select '6. SMC BASELINE', 'pending_orders', count(*)::text from public.pending_orders
  union all select '6. SMC BASELINE', 'paper_trade_history', count(*)::text from public.paper_trade_history
),

-- ── 7. current posture, for the before/after on RLS ──────────────────────────
posture as (
  select '7. RLS NOW' as section, c.relname as item,
         'enabled=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity ||
         ' policies=' || (select count(*) from pg_policies p
                          where p.schemaname='public' and p.tablename=c.relname) as value
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname='ipo_corpus_examples'
)

select * from (
  select * from applied
  union all select * from expected_cols
  union all select * from cols
  union all select * from corpus
  union all select * from collisions
  union all select * from collision_detail
  union all select * from phase_d
  union all select * from retired
  union all select * from smc
  union all select * from posture
) r
order by section, item;
