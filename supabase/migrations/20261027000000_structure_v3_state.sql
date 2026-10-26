-- V3.2c state service (PR3 of docs/V3_2C_PRODUCTION_INTEGRATION_DRAFT.md; owner approval 2026-10-26).
--
-- WHAT. The frozen V3.2c state of each pair after every completed bar of 1H / NY-4H / NY-Daily (D28 snapshots), a verification
-- record at each completed Daily close (D22 checkpoints), and an audit log of repaints / checkpoint mismatches / stale runs.
-- Written ONLY by the v32c-state function (hourly, recent window) and local-runner/v32c-state-backfill.ts (full history).
-- Nothing reads these tables yet: no gate, score, entry or decision. The scanner is untouched.
--
-- WHY APPEND-ONLY. Each run replays V3.2c from the epoch and compares every recomputed snapshot with the stored one. A stored
-- snapshot is evidence of what the service published at that time; a difference is a REPAINT and is logged, never overwritten.
--
-- Bars are identified by TIME (p_time, f_time, x_time), never by engine index: indices shift when the bar set changes.
-- Apply BY HAND before merging the PR that adds the function (docs/DEPLOYMENT.md). Reuses public.structure_bars_append_only()
-- from 20261015000000_structure_bars_1h.sql.

create table if not exists public.structure_v3_snapshots (
  symbol         text        not null,
  tf             text        not null,               -- '1H' | '4H' | 'D' (NY-aligned buckets, frozen aggregation)
  known_at       timestamptz not null,               -- close of the bar this state follows (consumers: freshest known_at ≤ now)
  bar_time       timestamptz not null,               -- open of that bar
  engine_version text        not null,               -- 'v3.2c-frozen-20261013'
  trend          text,                               -- 'bull' | 'bear' | null (no structure yet)
  p_time         timestamptz, p_price numeric,       -- protected swing P
  f_time         timestamptz, f_price numeric,       -- continuation level F
  x_time         timestamptz, x_price numeric,       -- extreme of the external leg since P (the P→X leg)
  close_pct      numeric,                            -- last close in the leg's premium/discount (100 = P, 0 = X)
  pending_kind   text,                               -- 'BOS' | 'FLIP' | null (a break awaiting its swing's confirmation)
  state_hash     text        not null,               -- digest of the full structural state (indices mapped to bar times)
  computed_at    timestamptz not null default now(),
  constraint structure_v3_snapshots_pkey primary key (symbol, tf, known_at, engine_version),
  constraint structure_v3_snapshots_symbol check (symbol in ('EUR/USD','GBP/USD','USD/JPY','CHF/JPY','NZD/CAD','NZD/CHF')),
  constraint structure_v3_snapshots_tf check (tf in ('1H','4H','D')),
  constraint structure_v3_snapshots_trend check (trend is null or trend in ('bull','bear')),
  constraint structure_v3_snapshots_pending check (pending_kind is null or pending_kind in ('BOS','FLIP')),
  constraint structure_v3_snapshots_epoch check (bar_time >= timestamptz '2025-04-16 21:00:00+00'),
  constraint structure_v3_snapshots_order check (known_at > bar_time)
);

create table if not exists public.structure_v3_checkpoints (
  symbol         text        not null,
  known_at       timestamptz not null,               -- the completed NY Daily close (17:00 New York)
  engine_version text        not null,
  bars_1h        integer     not null,               -- canonical 1H bars closed by then
  last_bar_time  timestamptz not null,
  h1_known_at    timestamptz, h1_state_hash text,
  h4_known_at    timestamptz, h4_state_hash text,
  d_state_hash   text        not null,
  computed_at    timestamptz not null default now(),
  constraint structure_v3_checkpoints_pkey primary key (symbol, known_at, engine_version),
  constraint structure_v3_checkpoints_symbol check (symbol in ('EUR/USD','GBP/USD','USD/JPY','CHF/JPY','NZD/CAD','NZD/CHF'))
);

create table if not exists public.structure_v3_audit (
  symbol      text        not null,
  kind        text        not null,                  -- 'repaint' | 'checkpoint_mismatch' | 'stale'
  tf          text        not null,                  -- '1H' | '4H' | 'D' | '-' (stale / checkpoint)
  known_at    timestamptz not null,                  -- the snapshot / checkpoint / expected hour concerned
  ref         text        not null,                  -- what makes the event distinct (hashes, field, expected hour)
  detail      jsonb       not null,
  recorded_at timestamptz not null default now(),
  constraint structure_v3_audit_pkey primary key (symbol, kind, tf, known_at, ref),
  constraint structure_v3_audit_kind check (kind in ('repaint','checkpoint_mismatch','stale'))
);

create index if not exists structure_v3_audit_by_time on public.structure_v3_audit (recorded_at desc);

do $$
declare t text;
begin
  foreach t in array array['structure_v3_snapshots','structure_v3_checkpoints','structure_v3_audit'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.structure_bars_append_only()', t || '_append_only', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.structure_bars_append_only()', t || '_no_truncate', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from service_role', t);
    execute format('grant select, insert on public.%I to service_role', t);
  end loop;
end $$;
