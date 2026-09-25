-- SMC scan candle observability. ADDITIVE, OBSERVATIONAL, IPO-STYLE ISOLATION.
--
-- WHY. No SMC engine can be determinism-tested today, because the candles the
-- scanner scored were never persisted. `scan_candle_snapshots` was created for
-- exactly this in the baseline schema and has NEVER been written to — it holds
-- zero rows. Stage 2 measured the consequence: a re-derivation from re-fetched
-- provider data reaches 92.1% and cannot be pushed higher, because production's
-- own inputs are unrecoverable.
--
-- WHY NOT THE EXISTING TABLE AS DESIGNED. Its `candles jsonb` column holds a
-- whole 300-bar array per (scan, symbol, timeframe). The scalper configuration
-- scans 12 pairs every 5 minutes across 3 slots:
--
--     12 x 288 x 3 = 10,368 rows/day  x  ~24 KB  =  ~249 MB/day  =  ~7.5 GB/month
--
-- for arrays that differ from the previous scan by ONE bar. That is not an
-- acceptable price for observability, so the same information is stored
-- normalized instead:
--
--     bars     12 x (288 + 96 + 24) =  4,896 rows/day  ~0.5 MB
--     manifest 12 x 288 x 3         = 10,368 rows/day  ~2.0 MB
--     context  12 x 288             =  3,456 rows/day  ~1.5 MB
--                                                      ~4.0 MB/day, ~120 MB/month
--
-- 60x cheaper, and reconstruction is exact: select the bars for a symbol and
-- timeframe between the manifest's first and last bar time, in order.
--
-- `scan_candle_snapshots` IS LEFT EXACTLY AS IT IS. It is not dropped, altered
-- or backfilled; it simply remains unused. Removing an empty table someone else
-- may have plans for is not this change's business.
--
-- THIS CHANGES NO STRATEGY DECISION. Nothing here is read by the scanner. The
-- write happens after the zone engine has run and its inputs are already fixed.

-- ─── bars: stored once, not once per scan ────────────────────────────────────
create table if not exists public.smc_scan_bars (
  symbol     text        not null,
  timeframe  text        not null,
  bar_time   timestamptz not null,

  open  double precision not null,
  high  double precision not null,
  low   double precision not null,
  close double precision not null,
  volume double precision,

  -- Which feed served this bar. Stage 1 found provider provenance was being
  -- discarded everywhere; previous research showed venue mismatch changes
  -- intrabar answers, so it is recorded at the bar.
  provider text,

  first_seen_at timestamptz not null default now(),

  -- The natural key. A bar is a bar: re-observing it must not duplicate it, and
  -- must not silently rewrite it either (see the upsert policy in the worker).
  constraint smc_scan_bars_pkey primary key (symbol, timeframe, bar_time)
);

create index if not exists smc_scan_bars_lookup
  on public.smc_scan_bars (symbol, timeframe, bar_time desc);

-- ─── manifest: what one scan actually held ───────────────────────────────────
create table if not exists public.smc_scan_manifest (
  id uuid primary key default gen_random_uuid(),

  scan_cycle_id text        not null,
  scanned_at    timestamptz not null default now(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  bot_id        text        not null,

  symbol    text not null,
  -- The trading style in force, because the slot mapping depends on it and
  -- Stage 1 had to recover it from a log line.
  style     text not null,
  -- Which zone-engine slot this array was passed to: top / mid / low / entry /
  -- confirm / ltf_confirm / context.
  slot      text not null,
  timeframe text not null,

  first_bar_time timestamptz not null,
  last_bar_time  timestamptz not null,
  bar_count      integer     not null,

  provider text,
  /**
   * Was the newest bar in the array still forming when it was scored?
   *
   * Stage 2 measured that production scores against a FORMING bar in ~61% of
   * scans — `closedBarsOnly` is imported only by the IPO runner. Recording the
   * answer per scan means a replay never has to re-derive it.
   */
  last_bar_closed boolean,
  fetched_at      timestamptz,

  -- Digest over the exact array passed to the engine. A replay that rebuilds a
  -- different array is then DETECTED rather than trusted.
  content_hash text not null,

  -- The frozen-behaviour label, so a later change is attributable. Stage 1 found
  -- the zone engine declares no version at all.
  contract_version text not null default 'smc-zone-impulse-control-v1',

  created_at timestamptz not null default now(),

  -- One manifest row per scan per symbol per slot. A retried scan converges
  -- instead of duplicating.
  constraint smc_scan_manifest_key unique (scan_cycle_id, symbol, slot)
);

create index if not exists smc_scan_manifest_lookup
  on public.smc_scan_manifest (scan_cycle_id);
create index if not exists smc_scan_manifest_symbol_time
  on public.smc_scan_manifest (symbol, scanned_at desc);

-- ─── context: the engine arguments that are NOT candles ──────────────────────
--
-- WHY THIS EXISTS. Candles alone do not reproduce a scan. `findUnifiedZone` also
-- takes a direction, a last price, liquidity pools, an HTF-confluence bundle and
-- a handful of config scalars. Stage 2E proved what happens when a replay omits
-- one of them: dropping `htfConfluenceData` moved AUD/USD agreement from 84.9%
-- down to 37.3%. A replay missing these is not a replay.
--
-- The heavy derived structures (h4 order blocks, FVGs, breakers, fib levels,
-- premium/discount, liquidity pools) are deliberately NOT stored as jsonb —
-- they would cost more than every other table combined. They are pure functions
-- of the 4H / Daily / 1H arrays, which ARE snapshotted as `context` slots and
-- cost almost nothing after deduplication. A replay re-derives them with the
-- production detectors and checks the result against `htf_confluence_hash`, so
-- a re-derivation that drifts is DETECTED rather than quietly scored.
create table if not exists public.smc_scan_context (
  id uuid primary key default gen_random_uuid(),

  scan_cycle_id text        not null,
  scanned_at    timestamptz not null default now(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  bot_id        text        not null,

  symbol text not null,
  style  text not null,

  -- The SMC verdict the zone engine was handed, not one a replay re-decides.
  direction  text,
  last_price double precision,

  -- Which array went to which positional slot. The slots are TF-agnostic in the
  -- engine, so without this a replay cannot even align its inputs.
  tf_labels jsonb not null default '{}'::jsonb,

  -- The scalars: strictATRMult, pipSize, fibMaxRetracement, originOBRetest,
  -- minZoneScore, maxSlPips, tpRatio, entryDepth.
  engine_args jsonb not null default '{}'::jsonb,

  -- Digests of the derived bundles, for verifying a re-derivation rather than
  -- storing the bundles themselves.
  htf_confluence_hash text,
  liquidity_pool_hash text,

  contract_version text not null default 'smc-zone-impulse-control-v1',
  created_at       timestamptz not null default now(),

  constraint smc_scan_context_key unique (scan_cycle_id, symbol)
);

create index if not exists smc_scan_context_lookup
  on public.smc_scan_context (scan_cycle_id);

-- ─── security: the same posture the IPO tables carry ─────────────────────────
-- ENABLE alone is not enough — without FORCE the table owner bypasses RLS — and
-- REVOKE matters separately, because RLS governs rows while grants govern
-- reachability.
alter table public.smc_scan_bars     enable row level security;
alter table public.smc_scan_bars     force  row level security;
alter table public.smc_scan_manifest enable row level security;
alter table public.smc_scan_manifest force  row level security;
alter table public.smc_scan_context  enable row level security;
alter table public.smc_scan_context  force  row level security;

revoke all on public.smc_scan_bars     from anon, authenticated;
revoke all on public.smc_scan_manifest from anon, authenticated;
revoke all on public.smc_scan_context  from anon, authenticated;

grant all on public.smc_scan_bars     to service_role;
grant all on public.smc_scan_manifest to service_role;
grant all on public.smc_scan_context  to service_role;

-- NO RETENTION JOB IS ADDED. ~2.5 MB/day is affordable, the bars are the
-- irreplaceable half, and automatic deletion of evidence needs a decision from
-- a person rather than a default in a migration.
