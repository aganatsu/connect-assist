-- Breaker shadow (owner choice "Show + Shadow", 2026-11-02): a Unified zone that price closes through flips to the other side, and
-- the flip is recorded as pretend trades (the rule pre-registered and tested in strategy-v2/flip-zones; it failed validation, so it
-- is recorded, never traded). Written only by the breaker-shadow function (service role). Append-only. The owner may read their own
-- events (Zone Story → Breakers). Apply BY HAND before merging (docs/DEPLOYMENT.md). Reuses public.structure_bars_append_only().

-- Zone and pretend-trade lifecycle: seen, flipped, touched, filled, skipped, cancelled, closed. arm = 'C' (confirmation entry),
-- 'L' (limit entry) or '-' for zone-level events.
create table if not exists public.breaker_shadow_events (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  pair       text        not null,
  zone_id    text        not null,                            -- '<pair>|<long|short>|<low pips>|<high pips>' (deterministic)
  arm        text        not null,
  type       text        not null,
  t          timestamptz not null,
  payload    jsonb       not null,
  created_at timestamptz not null default now(),
  constraint breaker_shadow_events_pkey primary key (user_id, zone_id, arm, type, t),
  constraint breaker_shadow_events_arm check (arm in ('C','L','-')),
  constraint breaker_shadow_events_type check (type in ('seen','flipped','touched','filled','skipped','cancelled','closed'))
);
create index if not exists breaker_shadow_events_by_pair on public.breaker_shadow_events (user_id, pair, t);

-- The resumable engine state per (user, pair); one new row per run that advanced, the latest seq is current.
create table if not exists public.breaker_shadow_state (
  user_id        uuid        not null references auth.users(id) on delete cascade,
  pair           text        not null,
  seq            integer     not null,
  as_of          timestamptz not null,                        -- 5m bars closing at or before this were processed
  last_scan_at   timestamptz not null,                        -- scans created at or before this were read
  engine_version text        not null,
  state          jsonb       not null,
  created_at     timestamptz not null default now(),
  constraint breaker_shadow_state_pkey primary key (user_id, pair, seq)
);

do $$
declare t text;
begin
  foreach t in array array['breaker_shadow_events','breaker_shadow_state'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.structure_bars_append_only()', t || '_append_only', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.structure_bars_append_only()', t || '_no_truncate', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated, service_role', t);
    execute format('grant select, insert on public.%I to service_role', t);
  end loop;
  -- the owner reads their own events (no state access from the client)
  grant select on public.breaker_shadow_events to authenticated;
  drop policy if exists breaker_shadow_events_owner_read on public.breaker_shadow_events;
  create policy breaker_shadow_events_owner_read on public.breaker_shadow_events for select to authenticated using (user_id = auth.uid());
end $$;
