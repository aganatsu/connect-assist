-- D.2 Step 1 verification — run in the Supabase SQL editor AFTER applying
-- 20260921120000_ipo_paper_ledger.sql and 20260921140000_ipo_paper_state.sql.
--
-- Returns one row per required property with a PASS/FAIL column. Read the FAILs;
-- there should be none. If any row FAILs, the live schema differs from the
-- migration and D.2 stops there.
--
-- This is deliberately catalog-driven rather than a set of hand-written
-- assertions about DDL text: what matters is what Postgres actually enforces,
-- not what the file says it asked for.

with expected(check_name, kind, detail) as (values
  -- existence
  ('table ipo_paper_positions exists',            'table',  'ipo_paper_positions'),
  ('table ipo_paper_trade_history exists',        'table',  'ipo_paper_trade_history'),
  ('table ipo_execution_events exists',           'table',  'ipo_execution_events'),
  ('table ipo_paper_ledger exists',               'table',  'ipo_paper_ledger')
),

tables(t) as (values
  ('ipo_paper_positions'), ('ipo_paper_trade_history'),
  ('ipo_execution_events'), ('ipo_paper_ledger')
),

-- ── existence ────────────────────────────────────────────────────────────────
existence as (
  select 'EXISTS  ' || t as check_name,
         case when to_regclass('public.' || t) is not null then 'PASS' else 'FAIL' end as status,
         coalesce(to_regclass('public.' || t)::text, '(missing)') as actual
  from tables
),

-- ── RLS: ENABLE and FORCE are different things ───────────────────────────────
rls as (
  select 'RLS ENABLED  ' || c.relname as check_name,
         case when c.relrowsecurity then 'PASS' else 'FAIL' end as status,
         'relrowsecurity=' || c.relrowsecurity as actual
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in (select t from tables)
  union all
  select 'RLS FORCED   ' || c.relname,
         case when c.relforcerowsecurity then 'PASS' else 'FAIL' end,
         'relforcerowsecurity=' || c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in (select t from tables)
),

-- ── grants: the browser roles must not be able to reach the table at all ─────
-- RLS governs rows; grants govern reachability. A table that is merely empty to
-- PostgREST is not the same as one PostgREST cannot query.
grants as (
  select 'NO GRANT ' || r.rolname || ' -> ' || t.t as check_name,
         case when bool_or(has_table_privilege(r.rolname, 'public.' || t.t, p.priv))
              then 'FAIL' else 'PASS' end as status,
         string_agg(p.priv || '=' || has_table_privilege(r.rolname, 'public.' || t.t, p.priv)::text, ' ') as actual
  from tables t
  cross join (values ('anon'), ('authenticated')) as r(rolname)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
  group by r.rolname, t.t
  union all
  select 'SERVICE_ROLE CAN WRITE ' || t.t,
         case when has_table_privilege('service_role', 'public.' || t.t, 'SELECT')
               and has_table_privilege('service_role', 'public.' || t.t, 'INSERT')
               and has_table_privilege('service_role', 'public.' || t.t, 'UPDATE')
               and has_table_privilege('service_role', 'public.' || t.t, 'DELETE')
              then 'PASS' else 'FAIL' end,
         'select/insert/update/delete'
  from tables t
),

-- ── strategy ownership must be NOT NULL, not merely present ──────────────────
ownership as (
  select 'NOT NULL ' || c.relname || '.' || a.attname as check_name,
         case when a.attnotnull then 'PASS' else 'FAIL' end as status,
         'attnotnull=' || a.attnotnull as actual
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  where n.nspname = 'public'
    and c.relname in ('ipo_paper_positions','ipo_paper_trade_history','ipo_execution_events')
    and a.attname in ('strategy_id','strategy_version','user_id')
    and a.attnum > 0 and not a.attisdropped
),

-- ── the constraints that carry the design decisions ──────────────────────────
cons as (
  select c.conname, t.relname, pg_get_constraintdef(c.oid) as def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and t.relname in (select t from tables)
),
named_checks as (
  select 'CHECK paper-only execution_mode (positions)' as check_name,
         case when exists (select 1 from cons
                where relname='ipo_paper_positions'
                  and def ilike '%execution_mode%' and def ilike '%''paper''%')
              then 'PASS' else 'FAIL' end as status,
         coalesce((select def from cons where relname='ipo_paper_positions'
                   and def ilike '%execution_mode%' limit 1),'(absent)') as actual
  union all
  select 'CHECK gap-abort shape (history)',
         case when exists (select 1 from cons
                where conname = 'ipo_paper_history_outcome_coherent'
                  and def ilike '%DATA_GAP_ABORTED%'
                  and def ilike '%realized_r IS NULL%'
                  and def ilike '%excluded_from_stats%'
                  and def ilike '%exclusion_reason IS NOT NULL%')
              then 'PASS' else 'FAIL' end,
         coalesce((select def from cons where conname='ipo_paper_history_outcome_coherent'),'(absent)')
  union all
  select 'CHECK exit_reason domain (history)',
         case when exists (select 1 from cons where relname='ipo_paper_trade_history'
                  and def ilike '%TARGET_2R%' and def ilike '%S2_CLOSE_INVALIDATION%'
                  and def ilike '%DATA_GAP_ABORTED%')
              then 'PASS' else 'FAIL' end,
         coalesce((select def from cons where relname='ipo_paper_trade_history'
                   and def ilike '%TARGET_2R%' limit 1),'(absent)')
  union all
  select 'CHECK event_type domain (events)',
         case when exists (select 1 from cons where relname='ipo_execution_events'
                  and def ilike '%GAP_ABORTED%' and def ilike '%REFUSED%' and def ilike '%FILLED%')
              then 'PASS' else 'FAIL' end,
         coalesce((select def from cons where relname='ipo_execution_events'
                   and def ilike '%event_type%' limit 1),'(absent)')
  union all
  select 'CHECK status domain (positions)',
         case when exists (select 1 from cons where relname='ipo_paper_positions'
                  and def ilike '%data_gap_suspended%')
              then 'PASS' else 'FAIL' end,
         coalesce((select def from cons where relname='ipo_paper_positions'
                   and def ilike '%data_gap_suspended%' limit 1),'(absent)')
  union all
  select 'CHECK risk distance > 0 (positions)',
         case when exists (select 1 from cons where relname='ipo_paper_positions'
                  and def ilike '%nominal_risk_distance%')
              then 'PASS' else 'FAIL' end,
         coalesce((select def from cons where relname='ipo_paper_positions'
                   and def ilike '%nominal_risk_distance%' limit 1),'(absent)')
),

-- ── one open position per strategy per instrument, enforced by the DATABASE ──
one_open as (
  select 'PARTIAL UNIQUE one open position per strategy/symbol' as check_name,
         case when exists (
           select 1 from pg_indexes
           where schemaname='public' and tablename='ipo_paper_positions'
             and indexdef ilike '%unique%'
             and indexdef ilike '%(strategy_id, symbol)%'
             and indexdef ilike '%where%open%data_gap_suspended%')
              then 'PASS' else 'FAIL' end as status,
         coalesce((select indexdef from pg_indexes
                   where schemaname='public' and tablename='ipo_paper_positions'
                     and indexname='ipo_paper_positions_one_open'),'(absent)') as actual
),

-- ── idempotency keys and the read indexes ────────────────────────────────────
idx as (
  select 'INDEX ' || x.name as check_name,
         case when exists (select 1 from pg_indexes
                where schemaname='public' and indexname = x.name) then 'PASS' else 'FAIL' end as status,
         coalesce((select indexdef from pg_indexes where schemaname='public' and indexname = x.name),'(absent)') as actual
  from (values
    ('ipo_paper_positions_one_open'),
    ('ipo_paper_positions_user_symbol'),
    ('ipo_paper_history_user_time'),
    ('ipo_paper_history_clean'),
    ('ipo_execution_events_lookup')
  ) as x(name)
  union all
  select 'UNIQUE ' || x.name,
         case when exists (select 1 from cons where conname = x.name and def ilike 'UNIQUE%')
              then 'PASS' else 'FAIL' end,
         coalesce((select def from cons where conname = x.name),'(absent)')
  from (values
    ('ipo_paper_positions_intent_key'),
    ('ipo_paper_history_intent_key'),
    ('ipo_execution_events_event_key')
  ) as x(name)
),

-- ── nothing may exist before the first intentional test ──────────────────────
emptiness as (
  select 'ZERO ROWS ipo_paper_positions' as check_name,
         case when (select count(*) from public.ipo_paper_positions) = 0 then 'PASS' else 'FAIL' end as status,
         (select count(*)::text from public.ipo_paper_positions) as actual
  union all
  select 'ZERO ROWS ipo_paper_trade_history',
         case when (select count(*) from public.ipo_paper_trade_history) = 0 then 'PASS' else 'FAIL' end,
         (select count(*)::text from public.ipo_paper_trade_history)
  union all
  select 'ZERO ROWS ipo_execution_events',
         case when (select count(*) from public.ipo_execution_events) = 0 then 'PASS' else 'FAIL' end,
         (select count(*)::text from public.ipo_execution_events)
),

-- ── the SMC tables IPO must never touch, for the before/after record ─────────
smc_baseline as (
  select 'BASELINE paper_positions' as check_name, 'INFO' as status,
         (select count(*)::text from public.paper_positions) as actual
  union all
  select 'BASELINE pending_orders', 'INFO', (select count(*)::text from public.pending_orders)
  union all
  select 'BASELINE paper_trade_history', 'INFO', (select count(*)::text from public.paper_trade_history)
)

select * from (
  select * from existence
  union all select * from rls
  union all select * from grants
  union all select * from ownership
  union all select * from named_checks
  union all select * from one_open
  union all select * from idx
  union all select * from emptiness
  union all select * from smc_baseline
) all_checks
order by (status = 'FAIL') desc, check_name;
