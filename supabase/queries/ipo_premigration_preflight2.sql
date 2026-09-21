-- PREFLIGHT 2 — the question that actually gates the apply.
--
-- Read-only. Nothing is applied.
--
-- WHY A SECOND ONE. Preflight 1 asked about the three IPO migrations. It
-- answered something bigger by accident: `20260920100000` is STRUCTURALLY
-- APPLIED (user_id gone, four-column unique key live, FORCE RLS on) while,
-- per the same check, its version is NOT recorded in supabase_migrations.
--
-- That means the recorded history and the real schema have already diverged at
-- least once, and `supabase db push` decides what to run PURELY from the
-- recorded history. It will re-run anything unrecorded — including the Lovable
-- baseline, which contains dozens of unguarded
-- `ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY` statements, three unguarded
-- `CREATE TRIGGER`s and four unguarded `CREATE POLICY`s. None of those survive
-- a second run.
--
-- So before anything is applied we need the whole recorded history, not just
-- the three IPO rows. Section 1 is the answer; everything else is detail.

with
local_versions(v, name) as (values
  ('20260914000000','baseline_schema'),
  ('20260914010000','restore_column_comments'),
  ('20260915060000','trade_reasonings_leg_displacement'),
  ('20260915120000','frozen_decision_hash_trigger'),
  ('20260915130000','direction_blocked_rejection_type'),
  ('20260916000000','frozen_decision_version_allowed'),
  ('20260916010000','history_insert_ignores_foreign_contract'),
  ('20260917000000','structural_order_blocks_v2'),
  ('20260918000000','ob_parent_impulse_broken'),
  ('20260918010000','ob_extent_replaces_sweep_level'),
  ('20260919000000','structure_shadow_telemetry'),
  ('20260919010000','shadow_geometric_trend'),
  ('20260919020000','ezzy_labelled_examples'),
  ('20260920000000','ipo_corpus_examples'),
  ('20260920100000','ipo_corpus_project_owned'),
  ('20260920200000','ipo_corpus_tier_and_source_family'),
  ('20260921140000','ipo_paper_state')
),

-- ── 1. THE DECISIVE ONE ──────────────────────────────────────────────────────
-- Anything marked "would be RE-RUN" is a file db push will execute again.
-- Cross-reference against the safety column: the ones flagged UNSAFE contain
-- statements that fail if the object already exists.
plan as (
  select '1. WHAT db push WOULD DO' as section,
         l.v || '  ' || l.name as item,
         case when exists (select 1 from supabase_migrations.schema_migrations m
                           where m.version = l.v)
              then 'recorded — skipped'
              else 'NOT RECORDED — would be RE-RUN'
         end
         || case when l.v in ('20260914000000','20260915120000','20260917000000',
                              '20260919000000','20260919020000','20260920000000')
                 then '   [UNSAFE to re-run: unguarded CREATE POLICY / TRIGGER / ADD CONSTRAINT]'
                 else '' end as value
  from local_versions l
),

-- ── 2. the raw recorded history, in case a version exists that we have no file for
recorded as (
  select '2. RECORDED HISTORY' as section,
         version as item,
         coalesce((select name from local_versions where v = version),
                  'NO LOCAL FILE for this version') as value
  from supabase_migrations.schema_migrations
),

-- ── 3. confirm the corpus is already in its post-20260920100000 shape ────────
corpus_shape as (
  select '3. CORPUS SHAPE' as section, 'ice_unique_example' as item,
         coalesce((select pg_get_constraintdef(c.oid)
                   from pg_constraint c join pg_class t on t.oid=c.conrelid
                   where t.relname='ipo_corpus_examples' and c.conname='ice_unique_example'),
                  '(absent)') as value
  union all
  select '3. CORPUS SHAPE', 'indexes',
         coalesce((select string_agg(indexname || ' ' ||
                    substring(indexdef from '\\((.*)\\)$'), ' | ' order by indexname)
                   from pg_indexes where schemaname='public'
                     and tablename='ipo_corpus_examples'), '(none)')
  union all
  select '3. CORPUS SHAPE', 'policies',
         coalesce((select string_agg(policyname, ' | ') from pg_policies
                   where schemaname='public' and tablename='ipo_corpus_examples'),
                  '(none — project-owned, service_role only)')
),

-- ── 4. will 20260920200000's UPDATEs actually match anything? ────────────────
-- It sets tiers by (symbol, timeframe, candle_datetime, direction) using literal
-- strings like '2020-04-20T00:00:00Z'. candle_datetime is TEXT, so a different
-- stored format means zero rows updated and no error — the tier data would
-- silently fail to land. With 14 rows, just look at all of them.
rows_dump as (
  select '4. ALL 14 CORPUS ROWS' as section,
         symbol || ' | ' || timeframe || ' | ' ||
           coalesce(candle_datetime,'(null)') || ' | ' || direction as item,
         evidence_source as value
  from public.ipo_corpus_examples
),
update_match as (
  select '4b. TIER UPDATE WOULD MATCH' as section,
         'TIER_1 targets (expects 4)' as item, count(*)::text as value
  from public.ipo_corpus_examples
  where symbol='BTC/USD' and (
    (timeframe='1d' and candle_datetime='2020-04-20T00:00:00Z' and direction='demand') or
    (timeframe='4h' and candle_datetime='2020-05-08T16:00:00Z' and direction='supply') or
    (timeframe='1d' and candle_datetime='2020-05-11T00:00:00Z' and direction='demand') or
    (timeframe='4h' and candle_datetime='2020-05-11T16:00:00Z' and direction='demand'))
  union all
  select '4b. TIER UPDATE WOULD MATCH', 'TIER_3 targets (expects 2)', count(*)::text
  from public.ipo_corpus_examples
  where symbol='BTC/USD' and timeframe='1d' and (
    (candle_datetime='2020-03-27T00:00:00Z' and direction='demand') or
    (candle_datetime='2020-04-08T00:00:00Z' and direction='supply'))
  union all
  select '4b. TIER UPDATE WOULD MATCH', 'USER_INDEPENDENT targets', count(*)::text
  from public.ipo_corpus_examples where evidence_source='USER_CONFIRMED'
),

-- ── 5. the one Phase D fact not yet confirmed live ───────────────────────────
phase_d as (
  select '5. PHASE D TABLES' as section, t as item,
         case when to_regclass('public.'||t) is not null
              then 'ALREADY EXISTS — investigate' else 'absent (correct)' end as value
  from (values ('ipo_paper_positions'),('ipo_paper_trade_history'),
               ('ipo_execution_events'),('ipo_paper_ledger')) x(t)
)

select * from (
  select * from plan
  union all select * from recorded
  union all select * from corpus_shape
  union all select * from rows_dump
  union all select * from update_match
  union all select * from phase_d
) r
order by section, item;
