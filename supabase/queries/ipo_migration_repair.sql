-- MIGRATION REPAIR — 20260920000000 and 20260920100000 only.
--
-- Run PART A first and read it. Only run PART B if Part A is all PASS.
--
-- WHAT REPAIR MEANS AND WHY THE CHECK COMES FIRST.
-- Marking a migration applied tells the tooling to skip it FOREVER. Any
-- statement in those files that did not in fact run will now never run, and
-- nothing will ever report it again. So "the resulting schema is already live"
-- has to mean every effect, not the headline ones.
--
-- Confirmed live already: the table exists with 14 rows, user_id is gone, the
-- four-column unique shape is in place, RLS is enabled and forced, and
-- candle_datetime is in the expected ISO format. Part A covers what that report
-- did NOT cover — six CHECK constraints, two foreign keys, the two rebuilt
-- indexes, and the grant posture, which is the security-relevant one.

-- ═════════════════════════════════════════════════════════════════════════════
-- PART A — read-only. Everything must say PASS.
-- ═════════════════════════════════════════════════════════════════════════════

with
-- ── from 20260920000000: the CHECK constraints ───────────────────────────────
checks as (
  select 'A1. CHECK constraints (20260920000000)' as section, c as item,
         case when exists (
           select 1 from pg_constraint k join pg_class t on t.oid = k.conrelid
           where t.relname = 'ipo_corpus_examples' and k.conname = c)
              then 'PASS' else 'MISSING — this statement never ran' end as value
  from (values ('ice_direction_check'),('ice_evidence_check'),
               ('ice_zone_bounds_paired'),('ice_zone_bounds_ordered'),
               ('ice_no_self_parent'),('ice_child_has_group'),
               ('ice_unique_example')) x(c)
),

-- ── from 20260920000000: the self-referencing parent FK ──────────────────────
-- (the auth.users FK went with user_id, so only this one should remain)
fks as (
  select 'A2. FOREIGN KEYS' as section,
         'parent_example_id -> ipo_corpus_examples' as item,
         case when exists (
           select 1 from pg_constraint k join pg_class t on t.oid = k.conrelid
           where t.relname='ipo_corpus_examples' and k.contype='f'
             and pg_get_constraintdef(k.oid) ilike '%parent_example_id%')
              then 'PASS' else 'MISSING — this statement never ran' end as value
  union all
  select 'A2. FOREIGN KEYS', 'no leftover auth.users FK (user_id is gone)',
         case when exists (
           select 1 from pg_constraint k join pg_class t on t.oid = k.conrelid
           where t.relname='ipo_corpus_examples' and k.contype='f'
             and pg_get_constraintdef(k.oid) ilike '%auth.users%')
              then 'UNEXPECTED — still present' else 'PASS' end
),

-- ── from 20260920100000: indexes REBUILT without user_id ─────────────────────
-- If these still carry user_id the second migration's index rebuild did not run
-- — which would also mean the column drop happened by some other route.
idx as (
  select 'A3. INDEXES rebuilt without user_id' as section,
         indexname as item,
         case when indexdef ilike '%user_id%'
              then 'STILL HAS user_id — rebuild never ran'
              else 'PASS  ' || substring(indexdef from '\(.*\)$') end as value
  from pg_indexes
  where schemaname='public' and tablename='ipo_corpus_examples'
),

-- ── from 20260920100000: THE SECURITY-RELEVANT ONE ───────────────────────────
-- RLS being enabled and forced was confirmed. The REVOKE was not. Without it
-- the browser roles keep their default grants, so PostgREST queries the table
-- and RLS answers with an empty array — reachable-but-empty rather than
-- unreachable. That is the exact distinction this project keeps insisting on,
-- and repair would bury it.
grants as (
  select 'A4. GRANT POSTURE (the one repair would bury)' as section,
         'anon/authenticated have NO privilege' as item,
         case when bool_or(has_table_privilege(r, 'public.ipo_corpus_examples', p))
              then 'FAIL — REVOKE never ran; the table is reachable, not merely empty'
              else 'PASS' end as value
  from (values ('anon'),('authenticated')) a(r),
       (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) b(p)
  union all
  select 'A4. GRANT POSTURE (the one repair would bury)',
         'service_role can read and write',
         case when has_table_privilege('service_role','public.ipo_corpus_examples','SELECT')
               and has_table_privilege('service_role','public.ipo_corpus_examples','INSERT')
              then 'PASS' else 'FAIL — GRANT never ran; the research path is broken' end
),

-- ── what must still be pending afterwards ────────────────────────────────────
pending as (
  select 'A5. MUST STAY PENDING' as section, v as item,
         case when exists (select 1 from supabase_migrations.schema_migrations m
                           where m.version = v)
              then 'ALREADY RECORDED — stop, do not repair'
              else 'PASS — still pending, will be applied by db push' end as value
  from (values ('20260920200000'),('20260921140000')) x(v)
)

select * from (
  select * from checks
  union all select * from fks
  union all select * from idx
  union all select * from grants
  union all select * from pending
) r order by section, item;


-- ═════════════════════════════════════════════════════════════════════════════
-- PART B — the repair. ONLY if every Part A row says PASS.
--
-- This is the only write. It inserts two rows into the CLI's bookkeeping table
-- and runs no DDL: nothing about the corpus table changes.
--
-- Equivalent to `supabase migration repair --status applied 20260920000000`
-- and the same for 20260920100000, but without needing the database password
-- the CLI would require.
--
-- If Part A shows A4 FAIL, do NOT run this. Run the two missing statements
-- first — they are idempotent and safe on their own:
--     revoke all on public.ipo_corpus_examples from anon, authenticated;
--     grant all on public.ipo_corpus_examples to service_role;
-- then re-run Part A, then come back.
-- ═════════════════════════════════════════════════════════════════════════════

-- Check the bookkeeping table's shape first; newer CLI versions add columns.
-- select column_name, is_nullable from information_schema.columns
--  where table_schema='supabase_migrations' and table_name='schema_migrations'
--  order by ordinal_position;

-- insert into supabase_migrations.schema_migrations (version)
-- values ('20260920000000'), ('20260920100000')
-- on conflict (version) do nothing;


-- ═════════════════════════════════════════════════════════════════════════════
-- PART C — confirm the post-repair state. Read-only.
-- Expect: 15 recorded, and exactly two pending.
-- ═════════════════════════════════════════════════════════════════════════════

-- select 'recorded' as kind, count(*)::text as value
--   from supabase_migrations.schema_migrations
-- union all
-- select 'pending', string_agg(v, ', ' order by v) from (
--   select v from (values
--     ('20260914000000'),('20260914010000'),('20260915060000'),('20260915120000'),
--     ('20260915130000'),('20260916000000'),('20260916010000'),('20260917000000'),
--     ('20260918000000'),('20260918010000'),('20260919000000'),('20260919010000'),
--     ('20260919020000'),('20260920000000'),('20260920100000'),('20260920200000'),
--     ('20260921140000')) x(v)
--   where not exists (select 1 from supabase_migrations.schema_migrations m
--                     where m.version = v)) d;
