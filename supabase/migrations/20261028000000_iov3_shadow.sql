-- Impulse-on-V3 step 3: the OFF / SHADOW / ON switch and the shadow record (owner design + decisions 2026-10-26).
--
-- structure_mode      one row per (user, bot): the switch shown in Bot Config → Strategy. Deliberately NOT in bot_configs.config_json:
--                     config_version = md5(config_json), so a key there would start a new cohort on every flip, while SHADOW changes
--                     no trade (owner decision Q1 = a). Written only by the structure-mode function (service role).
-- structure_mode_log  every flip, append-only.
-- iov3_shadow_*       written only by the iov3-shadow function (cron) and local-runner/iov3-shadow-audit.ts. Append-only.
--                     Shadow orders NEVER go to pending_orders: they are not orders and must never be executed or block one.
-- The account owner may READ their own rows (Bot Config status, V3 Story panel, Pending Orders → V3 Shadow); all writes are
-- service role. Apply BY HAND before merging (docs/DEPLOYMENT.md). Reuses public.structure_bars_append_only().

create table if not exists public.structure_mode (
  user_id  uuid        not null references auth.users(id) on delete cascade,
  bot_id   text        not null default 'smc',
  mode     text        not null default 'OFF',
  set_at   timestamptz not null default now(),
  constraint structure_mode_pkey primary key (user_id, bot_id),
  constraint structure_mode_mode check (mode in ('OFF','SHADOW','ON'))
);

create table if not exists public.structure_mode_log (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  bot_id     text        not null,
  from_mode  text        not null,
  to_mode    text        not null,
  note       text,
  at         timestamptz not null default now(),
  constraint structure_mode_log_modes check (from_mode in ('OFF','SHADOW','ON') and to_mode in ('OFF','SHADOW','ON'))
);

-- A shadow cohort: one continuous SHADOW period under one live config version. A flip to SHADOW, or a change of the live config
-- while in SHADOW, starts a new cohort. params = the per-pair settings copied from the live config at the start (frozen).
create table if not exists public.iov3_shadow_cohorts (
  id                  text        primary key,                -- '<user>|<bot>|<start ISO>'
  user_id             uuid        not null references auth.users(id) on delete cascade,
  bot_id              text        not null,
  started_at          timestamptz not null,                   -- the flip (or config change) time
  first_decision_at   timestamptz not null,                   -- first 1H close at or after started_at
  live_config_version text,
  params              jsonb       not null,                   -- { "EUR/USD": {…ShadowParams}, … } or { pair: {reason} } when refused
  params_hash         text        not null,
  engine_version      text        not null,                   -- shadow engine + V3 engine labels
  created_at          timestamptz not null default now()
);
create index if not exists iov3_shadow_cohorts_by_account on public.iov3_shadow_cohorts (user_id, bot_id, started_at desc);

-- The resumable engine state per (cohort, pair); one new row per run that advanced, the latest seq is current.
create table if not exists public.iov3_shadow_state (
  cohort_id  text        not null references public.iov3_shadow_cohorts(id),
  pair       text        not null,
  seq        integer     not null,
  user_id    uuid        not null,
  as_of      timestamptz not null,                            -- everything closing at or before this was processed
  state      jsonb       not null,
  created_at timestamptz not null default now(),
  constraint iov3_shadow_state_pkey primary key (cohort_id, pair, seq)
);

-- One row per pair per 1H close: what V3 said, which zone, which order, or why none (the V3 Story panel).
create table if not exists public.iov3_shadow_decisions (
  cohort_id  text        not null references public.iov3_shadow_cohorts(id),
  pair       text        not null,
  t          timestamptz not null,                            -- the 1H close the decision was made at
  user_id    uuid        not null,
  dir        text,                                            -- 'long' | 'short' | null
  reason     text        not null,                            -- 'placed', 'same_level_kept', 'no_pois', 'too_far_from_zone', …
  price      numeric,                                         -- last 1H close at the decision
  leg        jsonb,                                           -- V3: trend, swing (P) time/price, extreme (X) time/price
  leg_bars   integer,
  zone       jsonb,
  order_plan jsonb,
  ctx4h      text,
  created_at timestamptz not null default now(),
  constraint iov3_shadow_decisions_pkey primary key (cohort_id, pair, t)
);

-- Order / position lifecycle events: placed, touched, filled, closed, cancelled, voided (the V3 Shadow section + results).
create table if not exists public.iov3_shadow_events (
  cohort_id  text        not null references public.iov3_shadow_cohorts(id),
  pair       text        not null,
  order_id   text        not null,                            -- '<pair>|<placed ISO>' (deterministic)
  type       text        not null,
  t          timestamptz not null,
  user_id    uuid        not null,
  payload    jsonb       not null,
  created_at timestamptz not null default now(),
  constraint iov3_shadow_events_pkey primary key (cohort_id, order_id, type, t),
  constraint iov3_shadow_events_type check (type in ('placed','touched','filled','closed','cancelled','voided'))
);
create index if not exists iov3_shadow_events_by_pair on public.iov3_shadow_events (cohort_id, pair, t);

-- The owner's chart check per shadow order (✓ looks right / ✗ wrong + note). Append-only; the latest row per order counts.
create table if not exists public.iov3_shadow_feedback (
  id         bigint generated always as identity primary key,
  cohort_id  text        not null references public.iov3_shadow_cohorts(id),
  order_id   text        not null,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  verdict    text        not null,
  note       text,
  at         timestamptz not null default now(),
  constraint iov3_shadow_feedback_verdict check (verdict in ('right','wrong'))
);

create table if not exists public.iov3_shadow_audit (
  cohort_id   text        not null,
  pair        text        not null,
  kind        text        not null,                           -- 'mismatch' | 'refused' | 'error'
  ref         text        not null,
  detail      jsonb       not null,
  recorded_at timestamptz not null default now(),
  constraint iov3_shadow_audit_pkey primary key (cohort_id, pair, kind, ref),
  constraint iov3_shadow_audit_kind check (kind in ('mismatch','refused','error'))
);

do $$
declare t text;
begin
  -- append-only everywhere except the single current-mode row per account
  foreach t in array array['structure_mode_log','iov3_shadow_cohorts','iov3_shadow_state','iov3_shadow_decisions','iov3_shadow_events','iov3_shadow_feedback','iov3_shadow_audit'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.structure_bars_append_only()', t || '_append_only', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.structure_bars_append_only()', t || '_no_truncate', t);
  end loop;
  foreach t in array array['structure_mode','structure_mode_log','iov3_shadow_cohorts','iov3_shadow_state','iov3_shadow_decisions','iov3_shadow_events','iov3_shadow_feedback','iov3_shadow_audit'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated, service_role', t);
    execute format('grant select, insert on public.%I to service_role', t);
  end loop;
  -- the owner reads their own rows (no audit / state access from the client)
  foreach t in array array['structure_mode','structure_mode_log','iov3_shadow_cohorts','iov3_shadow_decisions','iov3_shadow_events','iov3_shadow_feedback'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = auth.uid())', t || '_owner_read', t);
  end loop;
end $$;

-- the switch row is the one mutable table: the structure-mode function updates it in place (each change is also logged)
grant update (mode, set_at) on public.structure_mode to service_role;
