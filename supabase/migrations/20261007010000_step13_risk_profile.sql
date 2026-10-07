-- STEP 13 — equity-based account risk limits: explicit profile values.
--
-- prop_firm_config is the risk PROFILE. FTMO's hard limits stay in the
-- existing columns (max_daily_loss_pct, max_overall_loss_pct of
-- initial_balance); our internal buffers become explicit columns instead of
-- being derived from safety_buffer_pct / emergency_close_pct:
--
--   daily_entry_stop_pct       stop new entries and fills (fraction of initial)
--   daily_flatten_pct          flatten all positions       (fraction of initial)
--   overall_entry_stop_equity  stop new entries and fills at/below this equity
--   overall_flatten_equity     flatten all positions at/below this equity
--   day_boundary_tz            the trading day is the local date in this zone
--   equity_source              'paper' (settlement ledger) | 'broker' (not yet supported → blocks)
--
-- The engine (_shared/accountRiskLimits.ts) hard-codes none of these. A
-- missing or inconsistent value blocks entries and never flattens.
--
-- Schema only. The account's profile values are set by the apply script
-- (docs/STEP13_EQUITY_RISK_LIMITS_V1.md); activation is a separate step.

alter table public.prop_firm_config
  add column if not exists daily_entry_stop_pct numeric,
  add column if not exists daily_flatten_pct numeric,
  add column if not exists overall_entry_stop_equity numeric,
  add column if not exists overall_flatten_equity numeric,
  add column if not exists day_boundary_tz text not null default 'Europe/Prague',
  add column if not exists equity_source text not null default 'paper';

alter table public.prop_firm_config
  drop constraint if exists prop_firm_config_equity_source,
  add constraint prop_firm_config_equity_source check (equity_source in ('paper', 'broker')),
  drop constraint if exists prop_firm_config_daily_thresholds,
  add constraint prop_firm_config_daily_thresholds check (
    daily_entry_stop_pct is null or daily_flatten_pct is null
    or (daily_entry_stop_pct > 0 and daily_entry_stop_pct < daily_flatten_pct and daily_flatten_pct < max_daily_loss_pct)),
  drop constraint if exists prop_firm_config_overall_thresholds,
  add constraint prop_firm_config_overall_thresholds check (
    overall_entry_stop_equity is null or overall_flatten_equity is null
    or (overall_flatten_equity < overall_entry_stop_equity
        and overall_entry_stop_equity < initial_balance
        and overall_flatten_equity > initial_balance * (1 - max_overall_loss_pct)));

comment on column public.prop_firm_config.daily_entry_stop_pct is 'Step 13: daily loss (fraction of initial_balance) at which new entries and Route 2 fills stop.';
comment on column public.prop_firm_config.daily_flatten_pct is 'Step 13: daily loss (fraction of initial_balance) at which all positions are flattened.';
comment on column public.prop_firm_config.overall_entry_stop_equity is 'Step 13: equity at/below which new entries and Route 2 fills stop.';
comment on column public.prop_firm_config.overall_flatten_equity is 'Step 13: equity at/below which all positions are flattened.';
comment on column public.prop_firm_config.day_boundary_tz is 'Step 13: the trading day is the local date in this IANA zone (FTMO: Europe/Prague = midnight CE(S)T).';
comment on column public.prop_firm_config.equity_source is 'Step 13: paper = settlement ledger + open positions; broker = not supported until broker reconciliation (blocks entries).';
