-- Impulse-on-V3 Shadow B (owner approval 2026-10-27): a second shadow arm on V3's OUTER INTERNAL leg, beside Shadow A (external leg).
--
-- 1. structure_v3_snapshots gains the outer internal leg (origin + extreme since origin), written by v32c-state from now on.
--    Earlier rows keep NULL (append-only: history is never rewritten); Shadow B reads NULL as "no internal leg known".
-- 2. The shadow tables gain `arm` ('A' = external leg, 'B' = outer internal leg). Existing rows are arm A (ADD COLUMN … DEFAULT is
--    metadata-only in Postgres ≥ 11, so the append-only UPDATE triggers never fire). Keys that must be unique per arm include it.
-- Apply BY HAND before merging (docs/DEPLOYMENT.md): v32c-state writes the new columns as soon as it is deployed.

alter table public.structure_v3_snapshots
  add column if not exists il_time    timestamptz,
  add column if not exists il_price   numeric,
  add column if not exists il_x_time  timestamptz,
  add column if not exists il_x_price numeric;

alter table public.iov3_shadow_state     add column if not exists arm text not null default 'A';
alter table public.iov3_shadow_decisions add column if not exists arm text not null default 'A';
alter table public.iov3_shadow_events    add column if not exists arm text not null default 'A';
alter table public.iov3_shadow_feedback  add column if not exists arm text not null default 'A';
alter table public.iov3_shadow_audit     add column if not exists arm text not null default 'A';

do $$
declare t text;
begin
  foreach t in array array['iov3_shadow_state','iov3_shadow_decisions','iov3_shadow_events','iov3_shadow_feedback','iov3_shadow_audit'] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_arm');
    execute format('alter table public.%I add constraint %I check (arm in (''A'',''B''))', t, t || '_arm');
  end loop;
end $$;

-- per-arm keys (order ids of arm B carry '|B|', so the events key is already unique per arm; state / decisions / audit need arm)
alter table public.iov3_shadow_state     drop constraint iov3_shadow_state_pkey,     add constraint iov3_shadow_state_pkey     primary key (cohort_id, arm, pair, seq);
alter table public.iov3_shadow_decisions drop constraint iov3_shadow_decisions_pkey, add constraint iov3_shadow_decisions_pkey primary key (cohort_id, arm, pair, t);
alter table public.iov3_shadow_audit     drop constraint iov3_shadow_audit_pkey,     add constraint iov3_shadow_audit_pkey     primary key (cohort_id, arm, pair, kind, ref);
create index if not exists iov3_shadow_decisions_by_pair_t on public.iov3_shadow_decisions (pair, arm, t desc);
