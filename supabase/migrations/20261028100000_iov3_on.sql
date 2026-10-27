-- Impulse-on-V3 step 4b: ON (owner decisions 2026-10-27).
--
-- structure_mode gains what ON needs: the arm ON trades ('A' = V3 external leg, 'B' = V3 outer internal leg), when ON began (the
-- automatic fallback counts ON trades from here), and why ON last stopped automatically. The structure-mode function (owner's
-- clicks) and the iov3-shadow function (the fallback) write them through onSwitch.ts only. Nothing on pending_orders changes:
-- V3 orders reuse the existing entry_source / terminal_reason values and are tagged by entry_zone_type ('V3A-…', 'V3B-…').
-- Apply BY HAND before merging (docs/DEPLOYMENT.md).

alter table public.structure_mode
  add column if not exists arm         text,
  add column if not exists on_since    timestamptz,
  add column if not exists kill_reason text;

do $$ begin
  alter table public.structure_mode add constraint structure_mode_arm check (arm is null or arm in ('A','B'));
exception when duplicate_object then null; end $$;

-- ON is only ever entered with an arm
do $$ begin
  alter table public.structure_mode add constraint structure_mode_on_has_arm check (mode <> 'ON' or arm is not null);
exception when duplicate_object then null; end $$;

grant update (mode, set_at, arm, on_since, kill_reason) on public.structure_mode to service_role;
