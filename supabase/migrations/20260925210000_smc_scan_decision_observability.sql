-- Capture the decision inputs the remaining SMC stages need, so they can be
-- extracted and parity-proved the way the zone slice was.
--
-- WHY. Stage 2H extracted the zone decision and proved it against 140 captured
-- scans, comparing the module's output field-by-field with what production
-- actually recorded. That method only worked because the inputs were stored.
-- For every OTHER stage — direction, confluence, safety gates, portfolio, ICT,
-- risk, session/news — the inputs were never recorded, so the same proof is
-- impossible and extracting them would mean deploying unverified strategy code.
--
-- WHAT WAS ALREADY THERE. `scan_logs.details_json[]` already carries most stage
-- OUTPUTS: direction, simpleDirection, directionVerdict, score, factors,
-- tieredScoring, ictHTF, ictKillZone, ictJudas, ictRisk, session, killZone,
-- zone, unifiedZone, impulseZone, status, skipReason. Those are deliberately
-- NOT duplicated here — the parity harness already reads them from scan_logs,
-- and a second copy is a second thing that can disagree.
--
-- WHAT WAS MISSING, and is added here:
--   * every stage INPUT (config objects, account, positions, rate map, risk
--     counters, news impacts, and the rows runSafetyGates reads from the
--     database mid-decision)
--   * the few outputs `detail` never recorded: the gate result array, the
--     portfolio-conflict result, entry/SL/TP/risk, and the final verdict
--
-- ONE ROW PER (scan, symbol), written once after the per-pair loop from an
-- object accumulated by reference. Nothing here is read by any gate, score or
-- execution path, and the write is fail-open: a failure is logged and counted,
-- never rethrown into trading.

create table if not exists public.smc_scan_decision (
  id uuid primary key default gen_random_uuid(),

  scan_cycle_id text        not null,
  scanned_at    timestamptz not null default now(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  bot_id        text        not null,
  symbol        text        not null,
  style         text,

  -- How far the pair got. Lets the funnel be counted without re-deriving it
  -- from prose reasons, and marks which stages SHOULD have inputs recorded.
  reached_stage text,

  -- ── per-stage inputs (the gap this table exists to close) ────────────────
  direction_input    jsonb,
  confluence_input   jsonb,
  gates_input        jsonb,
  portfolio_input    jsonb,
  ict_input          jsonb,
  risk_input         jsonb,
  session_news_input jsonb,

  -- ── outputs `detail` does not already carry ──────────────────────────────
  gates_output     jsonb,
  portfolio_output jsonb,
  final_decision   jsonb,

  -- ── tamper-evidence, one digest per group ────────────────────────────────
  -- Same construction as the zone slice's content_hash: a replay that rebuilds
  -- a different input is DETECTED rather than silently scored. Cheap enough to
  -- add, and the zone work proved the value — every reconstruction defect so
  -- far was caught by a digest rather than by inspection.
  direction_hash    text,
  confluence_hash   text,
  gates_hash        text,
  portfolio_hash    text,
  ict_hash          text,
  risk_hash         text,
  session_news_hash text,
  final_hash        text,

  contract_version text not null default 'smc-zone-impulse-control-v1',
  created_at       timestamptz not null default now(),

  -- A retried scan converges instead of duplicating.
  constraint smc_scan_decision_key unique (scan_cycle_id, symbol)
);

create index if not exists smc_scan_decision_lookup
  on public.smc_scan_decision (scan_cycle_id);
create index if not exists smc_scan_decision_symbol_time
  on public.smc_scan_decision (symbol, scanned_at desc);

-- Same posture as the other observability tables. ENABLE alone is not enough —
-- without FORCE the owner bypasses RLS — and REVOKE matters separately, because
-- RLS governs rows while grants govern reachability.
alter table public.smc_scan_decision enable row level security;
alter table public.smc_scan_decision force  row level security;
revoke all on public.smc_scan_decision from anon, authenticated;
grant all on public.smc_scan_decision to service_role;

-- No retention job. Deleting evidence needs a decision from a person rather
-- than a default in a migration.
