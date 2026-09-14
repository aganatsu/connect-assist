-- Baseline schema for connect-assist.
--
-- Extracted 2026-09-14 from the previous Supabase project via catalog queries.
-- The repo's prior migrations described only 22 of 64 tables — the rest were
-- applied outside this folder and a 2026-09-01 revert deleted files the
-- database kept. Those files are archived under docs/legacy-migrations/ for
-- reference; this is the authoritative starting point.
--
-- Cron jobs are NOT here. They embed the project ref and need pg_cron enabled
-- first, so they live in supabase/cron/setup_cron.sql and are run once by hand.




-- ========================================================================
-- EXTENSIONS  (7 statements)
-- ========================================================================

create extension if not exists pg_cron;

create extension if not exists pg_net;

create extension if not exists pg_stat_statements;

create extension if not exists pgcrypto;

create extension if not exists plpgsql;

create extension if not exists supabase_vault;

create extension if not exists "uuid-ossp";


-- ========================================================================
-- SEQUENCES  (1 statements)
-- ========================================================================

CREATE SEQUENCE IF NOT EXISTS public.api_credit_usage_id_seq;


-- ========================================================================
-- TABLES  (59 statements)
-- ========================================================================

CREATE TABLE IF NOT EXISTS public.active_direction_verdicts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  verdict_version uuid NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  symbol text NOT NULL,
  game_plan_id uuid,
  game_plan_version uuid,
  verdict text NOT NULL,
  confidence numeric(5,2) NOT NULL,
  agreement numeric(6,5) NOT NULL,
  should_block boolean NOT NULL,
  block_reason text,
  score_adjustment numeric(8,3) DEFAULT 0 NOT NULL,
  verdict_json jsonb NOT NULL,
  source_candle_timestamp timestamp with time zone,
  evaluated_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  scan_cycle_id text,
  contract_version text DEFAULT 'phase3.v2'::text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  superseded_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  style_policy_version text,
  style_policy_hash text,
  style_policy jsonb,
  style_base_policy_hash text
);

CREATE TABLE IF NOT EXISTS public.active_game_plans (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  plan_version uuid NOT NULL,
  symbol text NOT NULL,
  session text NOT NULL,
  bias text NOT NULL,
  bias_confidence numeric(5,2) NOT NULL,
  v2_conviction jsonb DEFAULT '{}'::jsonb NOT NULL,
  state text NOT NULL,
  state_reason text,
  generated_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  invalidation_conditions jsonb DEFAULT '[]'::jsonb NOT NULL,
  source_candle_timestamps jsonb DEFAULT '{}'::jsonb NOT NULL,
  plan_json jsonb NOT NULL,
  focus_pairs jsonb DEFAULT '[]'::jsonb NOT NULL,
  news_events jsonb DEFAULT '[]'::jsonb NOT NULL,
  news_impacts jsonb DEFAULT '[]'::jsonb NOT NULL,
  summary text DEFAULT ''::text NOT NULL,
  generation_source text NOT NULL,
  contract_version text DEFAULT 'phase3.v1'::text NOT NULL,
  config_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
  market_data_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  superseded_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  style_policy_version text,
  style_policy_hash text,
  style_policy jsonb,
  style_base_policy_hash text
);

CREATE TABLE IF NOT EXISTS public.api_credit_usage (
  id bigint DEFAULT nextval('api_credit_usage_id_seq'::regclass) NOT NULL,
  provider text NOT NULL,
  reserved_at timestamp with time zone DEFAULT now() NOT NULL,
  caller text
);

CREATE TABLE IF NOT EXISTS public.backtest_history_datasets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  source text DEFAULT 'mt5'::text NOT NULL,
  base_timeframe text DEFAULT '1m'::text NOT NULL,
  storage_path text NOT NULL,
  original_filename text NOT NULL,
  candle_count integer NOT NULL,
  start_at timestamp with time zone NOT NULL,
  end_at timestamp with time zone NOT NULL,
  timezone text DEFAULT 'UTC'::text NOT NULL,
  validation jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.backtest_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  progress integer DEFAULT 0 NOT NULL,
  progress_message text,
  config jsonb DEFAULT '{}'::jsonb NOT NULL,
  results jsonb,
  error_message text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  heartbeat_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.bot_config_change_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  config_id uuid,
  connection_id uuid,
  change_type text NOT NULL,
  previous_config jsonb,
  next_config jsonb,
  previous_hash text,
  next_hash text,
  changed_by uuid,
  changed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.bot_configs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  connection_id uuid
);

CREATE TABLE IF NOT EXISTS public.bot_recommendations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  review_type text DEFAULT 'daily'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  performance_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
  diagnosis text DEFAULT ''::text NOT NULL,
  recommendations jsonb DEFAULT '[]'::jsonb NOT NULL,
  feature_gaps jsonb DEFAULT '[]'::jsonb NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  resolved_at timestamp with time zone,
  resolved_by text,
  impact_snapshot jsonb,
  llm_model text,
  token_usage jsonb,
  overall_assessment text
);

CREATE TABLE IF NOT EXISTS public.broker_connections (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  broker_type text NOT NULL,
  display_name text NOT NULL,
  api_key text NOT NULL,
  account_id text NOT NULL,
  is_live boolean DEFAULT false NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  symbol_suffix text DEFAULT ''::text NOT NULL,
  symbol_overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
  commission_per_lot numeric DEFAULT 0 NOT NULL,
  detected_commission_per_lot numeric,
  commission_mode text DEFAULT 'auto'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.broker_execution_ledger (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  position_id text NOT NULL,
  broker_connection_id uuid NOT NULL,
  action text DEFAULT 'open'::text NOT NULL,
  route text NOT NULL,
  status text DEFAULT 'attempting'::text NOT NULL,
  claim_token uuid DEFAULT gen_random_uuid() NOT NULL,
  attempt_count integer DEFAULT 1 NOT NULL,
  request_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  response_payload jsonb,
  broker_order_id text,
  last_error text,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  finished_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.close_audit_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  position_id text NOT NULL,
  symbol text NOT NULL,
  broker_connection_id uuid,
  close_reason text NOT NULL,
  close_source text NOT NULL,
  pnl text,
  exit_price text,
  scan_cycle_id uuid,
  detail_json jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.config_backups (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  backup_id text NOT NULL,
  user_id uuid NOT NULL,
  config_id uuid NOT NULL,
  config_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.config_presets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text DEFAULT ''::text,
  config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.game_plan_refresh_status (
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  status text DEFAULT 'idle'::text NOT NULL,
  last_attempt_at timestamp with time zone,
  last_success_at timestamp with time zone,
  next_retry_at timestamp with time zone,
  active_plan_expires_at timestamp with time zone,
  failure_code text,
  failure_message text,
  details jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ict_entry_zone_authority_observations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  scan_cycle_id uuid NOT NULL,
  symbol text NOT NULL,
  trading_style text NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  direction text NOT NULL,
  legacy_candidate_id text,
  legacy_zone_type text,
  legacy_zone_low numeric(20,10),
  legacy_zone_high numeric(20,10),
  authority_candidate_id text NOT NULL,
  authority_zone_type text NOT NULL,
  authority_zone_low numeric(20,10) NOT NULL,
  authority_zone_high numeric(20,10) NOT NULL,
  authority_score numeric(12,4) NOT NULL,
  component_ids text[] DEFAULT ARRAY[]::text[] NOT NULL,
  disagreed boolean DEFAULT false NOT NULL,
  entry_price numeric(20,10),
  stop_loss numeric(20,10),
  take_profit numeric(20,10),
  authority_observation jsonb NOT NULL,
  outcome_status text DEFAULT 'pending'::text NOT NULL,
  outcome_checked_at timestamp with time zone,
  price_reached_entry boolean,
  tp_hit boolean,
  sl_hit boolean,
  mfe_pips numeric(10,2),
  mae_pips numeric(10,2),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  evidence_source text DEFAULT 'forward_observation'::text NOT NULL,
  replay_run_id uuid,
  replay_contract_version text,
  activation_eligible boolean DEFAULT true NOT NULL,
  legacy_outcome_status text,
  setup_family text DEFAULT 'impulse'::text NOT NULL,
  opportunity_key text,
  comparison_status text DEFAULT 'comparable'::text NOT NULL,
  geometry_failure_reason text,
  gross_risk_reward numeric(12,4),
  effective_risk_reward numeric(12,4),
  minimum_risk_reward numeric(12,4),
  risk_reward_passed boolean,
  cost_assumptions jsonb,
  style_policy_version text,
  style_base_policy_hash text,
  style_policy_hash text,
  timeframe_roles jsonb,
  source_evidence_ids text[] DEFAULT ARRAY[]::text[] NOT NULL,
  source_window jsonb,
  current_impulse_decision jsonb,
  decision_observations jsonb,
  timeframe_evidence_id text,
  candle_snapshot_refs jsonb DEFAULT '[]'::jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.impulse_entry_lifecycle_replays (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  lifecycle_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  evidence_source text DEFAULT 'retrospective_replay'::text NOT NULL,
  contract_version text DEFAULT 'impulse-lifecycle-replay.v1'::text NOT NULL,
  result jsonb NOT NULL,
  outcome text NOT NULL,
  entered boolean NOT NULL,
  rescued_deeper_entry boolean NOT NULL,
  retained_winner boolean NOT NULL,
  mfe numeric,
  mae numeric,
  replayed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.impulse_entry_lifecycle_transitions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  lifecycle_id uuid NOT NULL,
  user_id uuid NOT NULL,
  from_revision integer NOT NULL,
  to_revision integer NOT NULL,
  event_type text NOT NULL,
  from_candidate_id text,
  to_candidate_id text,
  reason text NOT NULL,
  event_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  lifecycle_snapshot jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.impulse_entry_lifecycles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  setup_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  impulse_id text NOT NULL,
  impulse_timeframe text NOT NULL,
  mode text DEFAULT 'observe'::text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  active_candidate_id text,
  revision integer DEFAULT 1 NOT NULL,
  lifecycle jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.impulse_lifecycle_enforcement_certificates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  evidence_hash text NOT NULL,
  status text NOT NULL,
  replay_count integer NOT NULL,
  resolved_count integer NOT NULL,
  rescued_winners integer NOT NULL,
  added_losses integer NOT NULL,
  minimum_sample_ready boolean NOT NULL,
  reviewed boolean DEFAULT false NOT NULL,
  reviewed_at timestamp with time zone,
  is_current boolean DEFAULT true NOT NULL,
  evidence jsonb NOT NULL,
  generated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.kv_cache (
  key text NOT NULL,
  value text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.manual_impulses (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  high numeric NOT NULL,
  low numeric NOT NULL,
  timeframe text DEFAULT '1H'::text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  resolution_reason text,
  last_resolved_at timestamp with time zone,
  last_resolution_detail text,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  high_time timestamp with time zone,
  low_time timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.optimizer_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  status text DEFAULT 'running'::text NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  trials_count integer DEFAULT 0,
  baseline_score double precision,
  best_score double precision,
  improvement_percent double precision,
  auto_applied boolean DEFAULT false,
  reject_reason text,
  config_snapshot jsonb,
  result_summary jsonb,
  error_message text,
  progress integer DEFAULT 0,
  progress_message text
);

CREATE TABLE IF NOT EXISTS public.paper_accounts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  balance_old text DEFAULT '10000'::text NOT NULL,
  peak_balance_old text DEFAULT '10000'::text NOT NULL,
  is_running boolean DEFAULT false NOT NULL,
  is_paused boolean DEFAULT false NOT NULL,
  started_at timestamp with time zone,
  scan_count integer DEFAULT 0 NOT NULL,
  signal_count integer DEFAULT 0 NOT NULL,
  rejected_count integer DEFAULT 0 NOT NULL,
  daily_pnl_base_old text DEFAULT '10000'::text NOT NULL,
  daily_pnl_date text DEFAULT ''::text NOT NULL,
  execution_mode text DEFAULT 'paper'::text NOT NULL,
  kill_switch_active boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  scan_lock_until timestamp with time zone,
  enable_orphan_close boolean DEFAULT false NOT NULL,
  bot_id text DEFAULT 'smc'::text,
  daily_pnl_base_date text,
  balance numeric(20,8),
  peak_balance numeric(20,8),
  daily_pnl_base numeric(20,8)
);

CREATE TABLE IF NOT EXISTS public.paper_positions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  position_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  size_old text,
  entry_price_old text,
  current_price_old text,
  stop_loss_old text,
  take_profit_old text,
  open_time text NOT NULL,
  signal_reason text,
  signal_score text DEFAULT '0'::text NOT NULL,
  order_id text NOT NULL,
  position_status text DEFAULT 'open'::text NOT NULL,
  trigger_price text,
  order_type text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  close_reason text,
  mirrored_connection_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  partial_tp_fired boolean DEFAULT false NOT NULL,
  bot_id text DEFAULT 'smc'::text,
  entry_price numeric(20,8),
  size numeric(20,8),
  stop_loss numeric(20,8),
  take_profit numeric(20,8),
  current_price numeric(20,8),
  trade_overrides jsonb,
  source_pending_order_id uuid,
  source_candidate_key text,
  final_authorization jsonb,
  decision_context jsonb,
  game_plan_id uuid,
  game_plan_version uuid,
  direction_verdict_id uuid,
  direction_verdict jsonb,
  thesis_validation jsonb,
  entry_confirmation jsonb,
  candidate_id uuid,
  staged_setup_id uuid,
  originating_zone jsonb,
  thesis_version text,
  confirmation_method text,
  confirmation_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  style_policy_version text,
  style_policy_hash text,
  style_policy jsonb,
  style_base_policy_hash text,
  frozen_strategy_context jsonb,
  frozen_strategy_hash text,
  policy_frozen_at timestamp with time zone,
  cross_tf_context_version text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,contractVersion}'::text[]),
  cross_tf_timeframe_evidence_id text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,timeframeEvidenceId}'::text[]),
  cross_tf_relationship text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,relationship,classification}'::text[]),
  cross_tf_entry_authority jsonb DEFAULT (frozen_strategy_context #> '{crossTimeframeContext,authority}'::text[]),
  cross_tf_effective_mode text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,authority,effectiveMode}'::text[]),
  cross_tf_entry_allowed boolean DEFAULT 
CASE
    WHEN ((frozen_strategy_context #> '{crossTimeframeContext,authority,allowed}'::text[]) IS NULL) THEN NULL::boolean
    ELSE ((frozen_strategy_context #>> '{crossTimeframeContext,authority,allowed}'::text[]))::boolean
END,
  streamlined_decision_origin jsonb,
  streamlined_decision_latest jsonb,
  streamlined_decision_frozen_at timestamp with time zone,
  canonical_dealing_range jsonb DEFAULT (frozen_strategy_context #> '{crossTimeframeContext,canonicalDealingRange}'::text[]),
  canonical_dealing_range_version text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,canonicalDealingRange,range,contractVersion}'::text[]),
  canonical_dealing_range_impulse_id text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,canonicalDealingRange,range,impulseId}'::text[]),
  canonical_dealing_range_timeframe text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,canonicalDealingRange,range,timeframe}'::text[]),
  broker_execution_state text DEFAULT 'paper'::text NOT NULL,
  broker_execution_error text,
  broker_execution_updated_at timestamp with time zone,
  broker_close_state text DEFAULT 'none'::text NOT NULL,
  broker_close_error text,
  impulse_entry_lifecycle_id uuid,
  impulse_entry_lifecycle jsonb DEFAULT (frozen_strategy_context #> '{crossTimeframeContext,impulseEntryLifecycle}'::text[])
);

CREATE TABLE IF NOT EXISTS public.paper_trade_history (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  position_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  size_old text,
  entry_price_old text,
  exit_price_old text,
  pnl_old text,
  pnl_pips_old text,
  open_time text NOT NULL,
  closed_at text NOT NULL,
  close_reason text NOT NULL,
  signal_reason text,
  signal_score text DEFAULT '0'::text NOT NULL,
  order_id text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  bot_id text DEFAULT 'smc'::text,
  stop_loss text,
  take_profit text,
  entry_price numeric(20,8),
  exit_price numeric(20,8),
  size numeric(20,8),
  pnl numeric(20,8),
  pnl_pips numeric(20,4),
  streamlined_decision_origin jsonb,
  streamlined_decision_latest jsonb,
  streamlined_decision_frozen_at timestamp with time zone,
  source_pending_order_id uuid,
  source_position_row_id uuid
);

CREATE TABLE IF NOT EXISTS public.paper_trade_history_duplicate_audit (
  duplicate_history_id uuid NOT NULL,
  kept_history_id uuid NOT NULL,
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  position_id text NOT NULL,
  duplicate_pnl numeric(20,8) NOT NULL,
  duplicate_row jsonb NOT NULL,
  reconciled_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pending_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  order_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  order_type text DEFAULT 'limit'::text NOT NULL,
  entry_price numeric(20,10) NOT NULL,
  current_price numeric(20,10) NOT NULL,
  stop_loss numeric(20,10) NOT NULL,
  take_profit numeric(20,10) NOT NULL,
  size numeric(20,8),
  entry_zone_type text,
  entry_zone_low numeric(20,10),
  entry_zone_high numeric(20,10),
  status text DEFAULT 'pending'::text NOT NULL,
  expiry_minutes integer DEFAULT 60 NOT NULL,
  fill_reason text,
  cancel_reason text,
  signal_reason jsonb,
  signal_score numeric(6,2),
  setup_type text,
  setup_confidence numeric(4,2),
  from_watchlist boolean DEFAULT false NOT NULL,
  staged_cycles integer,
  staged_initial_score numeric(6,2),
  exit_flags jsonb,
  placed_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  filled_at timestamp with time zone,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  zone_touch_time timestamp with time zone,
  confirmation_attempts integer DEFAULT 0,
  thesis_cancel_reason text,
  refined_zone_low numeric(20,10) DEFAULT NULL::numeric,
  refined_zone_high numeric(20,10) DEFAULT NULL::numeric,
  final_authorization jsonb,
  decision_context jsonb,
  game_plan_id uuid,
  game_plan_version uuid,
  direction_verdict_id uuid,
  direction_verdict jsonb,
  thesis_validation jsonb,
  entry_confirmation jsonb,
  candidate_id uuid,
  staged_setup_id uuid,
  originating_zone jsonb,
  thesis_version text,
  confirmation_method text,
  confirmation_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  last_confirmation_checked_at timestamp with time zone,
  style_policy_version text,
  style_policy_hash text,
  style_policy jsonb,
  style_base_policy_hash text,
  frozen_strategy_context jsonb,
  frozen_strategy_hash text,
  policy_frozen_at timestamp with time zone,
  cross_tf_context_version text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,contractVersion}'::text[]),
  cross_tf_timeframe_evidence_id text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,timeframeEvidenceId}'::text[]),
  cross_tf_relationship text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,relationship,classification}'::text[]),
  cross_tf_entry_authority jsonb DEFAULT (frozen_strategy_context #> '{crossTimeframeContext,authority}'::text[]),
  cross_tf_effective_mode text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,authority,effectiveMode}'::text[]),
  cross_tf_entry_allowed boolean DEFAULT 
CASE
    WHEN ((frozen_strategy_context #> '{crossTimeframeContext,authority,allowed}'::text[]) IS NULL) THEN NULL::boolean
    ELSE ((frozen_strategy_context #>> '{crossTimeframeContext,authority,allowed}'::text[]))::boolean
END,
  streamlined_decision_origin jsonb,
  streamlined_decision_latest jsonb,
  streamlined_decision_frozen_at timestamp with time zone,
  canonical_dealing_range jsonb DEFAULT (frozen_strategy_context #> '{crossTimeframeContext,canonicalDealingRange}'::text[]),
  canonical_dealing_range_version text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,canonicalDealingRange,range,contractVersion}'::text[]),
  canonical_dealing_range_impulse_id text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,canonicalDealingRange,range,impulseId}'::text[]),
  canonical_dealing_range_timeframe text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,canonicalDealingRange,range,timeframe}'::text[]),
  impulse_entry_lifecycle_id uuid,
  impulse_entry_lifecycle jsonb DEFAULT (frozen_strategy_context #> '{crossTimeframeContext,impulseEntryLifecycle}'::text[]),
  post_confirmation_entry jsonb,
  post_confirmation_observation jsonb,
  superseded_candidate_id text,
  handoff_reason text,
  structural_invalidation numeric(20,10),
  structural_invalidation_source text,
  last_touch_checked_at timestamp with time zone,
  liquidity_confirmation_observation jsonb,
  pending_authorization_observation jsonb,
  confirmation_build_diagnostic jsonb
);

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  display_name text,
  avatar_url text,
  preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.prop_firm_config (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc-bot-v1'::text NOT NULL,
  firm_type text DEFAULT 'ftmo_2step'::text NOT NULL,
  account_stage text DEFAULT 'challenge'::text NOT NULL,
  initial_balance numeric DEFAULT 100000 NOT NULL,
  account_currency text DEFAULT 'USD'::text NOT NULL,
  max_daily_loss_pct numeric DEFAULT 0.05 NOT NULL,
  max_overall_loss_pct numeric DEFAULT 0.10 NOT NULL,
  profit_target_pct numeric DEFAULT 0.10,
  best_day_rule_pct numeric,
  trailing_drawdown boolean DEFAULT false NOT NULL,
  safety_buffer_pct numeric DEFAULT 0.008 NOT NULL,
  emergency_close_pct numeric DEFAULT 0.002 NOT NULL,
  close_on_breach boolean DEFAULT true NOT NULL,
  reduce_size_near_limit boolean DEFAULT true NOT NULL,
  size_reduction_threshold_pct numeric DEFAULT 0.60 NOT NULL,
  day_reset_hour_utc integer DEFAULT 22 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.prop_firm_daily_state (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  config_id uuid NOT NULL,
  trading_day date NOT NULL,
  day_start_balance numeric NOT NULL,
  day_start_equity numeric NOT NULL,
  highest_equity_today numeric NOT NULL,
  lowest_equity_today numeric NOT NULL,
  current_equity numeric,
  end_of_day_balance numeric,
  highest_eod_balance_ever numeric NOT NULL,
  realized_pnl_today numeric DEFAULT 0 NOT NULL,
  trade_count_today integer DEFAULT 0 NOT NULL,
  is_locked boolean DEFAULT false NOT NULL,
  locked_at timestamp with time zone,
  lock_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.prop_firm_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  config_id uuid NOT NULL,
  event_type text NOT NULL,
  severity text NOT NULL,
  balance_at_event numeric,
  equity_at_event numeric,
  daily_loss_at_event numeric,
  drawdown_at_event numeric,
  message text NOT NULL,
  details jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.rejected_setups (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  rejected_at timestamp with time zone DEFAULT now() NOT NULL,
  rejection_type text NOT NULL,
  failed_gates text[],
  confluence_score numeric(6,2) NOT NULL,
  tier1_count integer DEFAULT 0 NOT NULL,
  tier1_factors text[],
  entry_price numeric(20,10) NOT NULL,
  stop_loss numeric(20,10),
  take_profit numeric(20,10),
  rr_ratio numeric(6,2),
  session_name text,
  regime text,
  gp_bias text,
  gp_bias_confidence integer,
  fotsi_base_tsi numeric(8,2),
  fotsi_quote_tsi numeric(8,2),
  price_at_rejection numeric(20,10),
  outcome_status text DEFAULT 'pending'::text NOT NULL,
  outcome_checked_at timestamp with time zone,
  price_reached_entry boolean,
  tp_hit boolean,
  sl_hit boolean,
  tp_hit_time_minutes integer,
  mfe_pips numeric(10,2),
  mae_pips numeric(10,2),
  raw_detail jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  normalized_gates text[] DEFAULT '{}'::text[] NOT NULL,
  opportunity_key text,
  shadow_decision jsonb,
  streamlined_decision_origin jsonb,
  streamlined_decision_latest jsonb,
  streamlined_decision_frozen_at timestamp with time zone,
  decision_outcome_snapshot jsonb,
  outcome_contract_version text,
  outcome_window_hours integer,
  outcome_reason text,
  sl_hit_time_minutes integer,
  mfe_r numeric(10,3),
  mae_r numeric(10,3),
  outcome_r numeric(10,3)
);

CREATE TABLE IF NOT EXISTS public.scan_candle_snapshots (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  scan_cycle_id text NOT NULL,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  provider text NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  completed_candle_cutoff timestamp with time zone,
  candle_count integer NOT NULL,
  candles jsonb NOT NULL,
  contract_version text DEFAULT 'scan-candles.v1'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.scan_history (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text,
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.scan_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  scanned_at timestamp with time zone DEFAULT now() NOT NULL,
  pairs_scanned integer DEFAULT 0 NOT NULL,
  signals_found integer DEFAULT 0 NOT NULL,
  trades_placed integer DEFAULT 0 NOT NULL,
  details_json jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.scanner_authorization_failures (
  id bigint NOT NULL,
  function_name text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL,
  request_metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.scanner_health_monitor_state (
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  first_observed_at timestamp with time zone DEFAULT now() NOT NULL,
  last_evaluated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.scanner_operation_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  function_name text NOT NULL,
  operation text NOT NULL,
  trigger_source text NOT NULL,
  status text DEFAULT 'invoked'::text NOT NULL,
  phase text DEFAULT 'cron_invoked'::text NOT NULL,
  scan_cycle_id uuid,
  invoked_at timestamp with time zone DEFAULT now() NOT NULL,
  scan_started_at timestamp with time zone,
  pair_processing_completed_at timestamp with time zone,
  scan_completed_at timestamp with time zone,
  position_management_completed_at timestamp with time zone,
  heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
  expected_pairs integer,
  processed_pairs integer DEFAULT 0 NOT NULL,
  error_code text,
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.scanner_operational_alerts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  alert_type text NOT NULL,
  dedupe_key text DEFAULT 'default'::text NOT NULL,
  severity text DEFAULT 'warning'::text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  run_id uuid,
  evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
  occurrences integer DEFAULT 1 NOT NULL,
  first_detected_at timestamp with time zone DEFAULT now() NOT NULL,
  last_detected_at timestamp with time zone DEFAULT now() NOT NULL,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.scanner_runtime_locks (
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  lock_scope text NOT NULL,
  lease_token uuid NOT NULL,
  run_id uuid,
  acquired_at timestamp with time zone DEFAULT now() NOT NULL,
  heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
  lease_until timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS public.scheduled_tasks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  function_name text NOT NULL,
  action text NOT NULL,
  display_name text NOT NULL,
  description text,
  category text DEFAULT 'other'::text,
  enabled boolean DEFAULT true,
  interval_minutes integer NOT NULL,
  default_interval_minutes integer NOT NULL,
  cron_expression text,
  last_run_at timestamp with time zone,
  last_status text,
  last_error text,
  run_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.setup_lifecycle_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  staged_setup_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text,
  evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  reason_code text,
  lifecycle_phase text
);

CREATE TABLE IF NOT EXISTS public.staged_setups (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  initial_score numeric(6,2) NOT NULL,
  current_score numeric(6,2) NOT NULL,
  watch_threshold numeric(6,2) NOT NULL,
  initial_factors jsonb DEFAULT '[]'::jsonb NOT NULL,
  current_factors jsonb DEFAULT '[]'::jsonb NOT NULL,
  missing_factors jsonb DEFAULT '[]'::jsonb NOT NULL,
  entry_price numeric(20,10),
  sl_level numeric(20,10),
  tp_level numeric(20,10),
  status text DEFAULT 'watching'::text NOT NULL,
  scan_cycles integer DEFAULT 1 NOT NULL,
  min_cycles integer DEFAULT 1 NOT NULL,
  ttl_minutes integer DEFAULT 240 NOT NULL,
  promotion_reason text,
  invalidation_reason text,
  setup_type text,
  tier1_count integer DEFAULT 0 NOT NULL,
  tier2_count integer DEFAULT 0 NOT NULL,
  tier3_count integer DEFAULT 0 NOT NULL,
  analysis_snapshot jsonb,
  staged_at timestamp with time zone DEFAULT now() NOT NULL,
  last_eval_at timestamp with time zone DEFAULT now() NOT NULL,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  candidate_id uuid DEFAULT gen_random_uuid() NOT NULL,
  lifecycle_version text DEFAULT 'phase4.v1'::text NOT NULL,
  lifecycle_reason text,
  qualified_at timestamp with time zone,
  pending_order_id uuid,
  position_id uuid,
  game_plan_id uuid,
  game_plan_version text,
  direction_verdict_id uuid,
  direction_verdict jsonb,
  thesis_version text,
  originating_zone jsonb,
  confirmation_method text,
  confirmation_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  authorization_result jsonb,
  style_policy_version text,
  style_policy_hash text,
  style_policy jsonb,
  style_base_policy_hash text,
  frozen_strategy_context jsonb,
  frozen_strategy_hash text,
  policy_frozen_at timestamp with time zone,
  execution_eligible boolean DEFAULT true NOT NULL,
  observation_parent_id uuid,
  observation_reason text,
  cross_tf_context_version text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,contractVersion}'::text[]),
  cross_tf_timeframe_evidence_id text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,timeframeEvidenceId}'::text[]),
  cross_tf_relationship text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,relationship,classification}'::text[]),
  cross_tf_entry_authority jsonb DEFAULT (frozen_strategy_context #> '{crossTimeframeContext,authority}'::text[]),
  cross_tf_effective_mode text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,authority,effectiveMode}'::text[]),
  cross_tf_entry_allowed boolean DEFAULT 
CASE
    WHEN ((frozen_strategy_context #> '{crossTimeframeContext,authority,allowed}'::text[]) IS NULL) THEN NULL::boolean
    ELSE ((frozen_strategy_context #>> '{crossTimeframeContext,authority,allowed}'::text[]))::boolean
END,
  lifecycle_reason_code text,
  lifecycle_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
  lifecycle_phase text,
  streamlined_decision_origin jsonb,
  streamlined_decision_latest jsonb,
  streamlined_decision_frozen_at timestamp with time zone,
  canonical_dealing_range jsonb DEFAULT (frozen_strategy_context #> '{crossTimeframeContext,canonicalDealingRange}'::text[]),
  canonical_dealing_range_version text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,canonicalDealingRange,range,contractVersion}'::text[]),
  canonical_dealing_range_impulse_id text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,canonicalDealingRange,range,impulseId}'::text[]),
  canonical_dealing_range_timeframe text DEFAULT (frozen_strategy_context #>> '{crossTimeframeContext,canonicalDealingRange,range,timeframe}'::text[]),
  impulse_entry_lifecycle_id uuid,
  impulse_entry_lifecycle jsonb DEFAULT (frozen_strategy_context #> '{crossTimeframeContext,impulseEntryLifecycle}'::text[]),
  liquidity_confirmation_observation jsonb
);

CREATE TABLE IF NOT EXISTS public.stop_policy_observations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  scan_cycle_id text NOT NULL,
  candidate_id text NOT NULL,
  contract_version text DEFAULT 'stop-policy-evidence.v1'::text NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  trading_style text NOT NULL,
  setup_source text NOT NULL,
  confirmation_timeframe text NOT NULL,
  entry_price numeric(24,10) NOT NULL,
  structural_invalidation numeric(24,10) NOT NULL,
  confirmation_atr numeric(24,10) NOT NULL,
  pip_size numeric(24,10) NOT NULL,
  spread_pips numeric(16,4) NOT NULL,
  spread_source text NOT NULL,
  spread_safety_multiplier numeric(10,4) NOT NULL,
  execution_floor_quote_distance numeric(24,10) NOT NULL,
  execution_floor_source text NOT NULL,
  broker_stops_level numeric(16,4),
  broker_digits integer,
  tick_size numeric(24,10),
  current_plan_valid boolean NOT NULL,
  current_stop_loss numeric(24,10),
  current_take_profit numeric(24,10),
  current_risk_reward numeric(16,6),
  current_take_profit_source text,
  current_take_profit_fallback_reason text,
  current_plan_reason text,
  shadow_plan_valid boolean NOT NULL,
  shadow_stop_loss numeric(24,10),
  shadow_take_profit numeric(24,10),
  shadow_risk_reward numeric(16,6),
  shadow_take_profit_source text,
  shadow_take_profit_fallback_reason text,
  shadow_plan_reason text,
  shadow_measurements jsonb NOT NULL,
  observation_only boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.strategy_activation_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  activation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  feature_key text NOT NULL,
  variant_key text NOT NULL,
  from_authority_stage text,
  to_authority_stage text NOT NULL,
  from_runtime_scope text,
  to_runtime_scope text NOT NULL,
  evidence_contract_version text NOT NULL,
  evidence_snapshot jsonb NOT NULL,
  evidence_hash text NOT NULL,
  reason text NOT NULL,
  actor_id uuid,
  revision integer NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.strategy_activation_registry (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  feature_key text NOT NULL,
  variant_key text DEFAULT 'default'::text NOT NULL,
  activation_scope jsonb DEFAULT '{}'::jsonb NOT NULL,
  activation_scope_hash text NOT NULL,
  authority_stage text DEFAULT 'shadow'::text NOT NULL,
  runtime_scope text DEFAULT 'observation'::text NOT NULL,
  evidence_contract_version text DEFAULT 'strategy-evidence.v1'::text NOT NULL,
  evidence_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
  evidence_hash text NOT NULL,
  evidence_window_start timestamp with time zone,
  evidence_window_end timestamp with time zone,
  transition_reason text,
  approved_by uuid,
  approved_at timestamp with time zone,
  runtime_enforced boolean DEFAULT false NOT NULL,
  revision integer DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.strategy_evidence_certificates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  feature_key text NOT NULL,
  variant_key text DEFAULT 'default'::text NOT NULL,
  activation_scope jsonb DEFAULT '{}'::jsonb NOT NULL,
  activation_scope_hash text NOT NULL,
  contract_version text DEFAULT 'strategy-evidence.v1'::text NOT NULL,
  generator_version text NOT NULL,
  certificate jsonb NOT NULL,
  certificate_hash text NOT NULL,
  status text NOT NULL,
  total_candidates integer NOT NULL,
  evidence_count integer NOT NULL,
  resolved_count integer NOT NULL,
  changed_count integer NOT NULL,
  coverage_percent numeric(7,3) NOT NULL,
  beneficial_rate_percent numeric(7,3),
  expectancy_delta_r numeric(12,6) NOT NULL,
  max_drawdown_delta_percent numeric(12,4) NOT NULL,
  good_trade_retention_percent numeric(7,3) NOT NULL,
  out_of_sample_passed boolean NOT NULL,
  walk_forward_consistent boolean NOT NULL,
  source_window_start timestamp with time zone,
  source_window_end timestamp with time zone,
  generated_at timestamp with time zone NOT NULL,
  is_current boolean DEFAULT true NOT NULL,
  superseded_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.streamlined_decision_certificates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  certified boolean DEFAULT false NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  runtime_targets text[] DEFAULT ARRAY['paper'::text] NOT NULL,
  styles text[] DEFAULT ARRAY[]::text[] NOT NULL,
  minimum_comparable integer DEFAULT 100 NOT NULL,
  comparable integer DEFAULT 0 NOT NULL,
  evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.telegram_notification_claims (
  claim_key text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.trade_archive (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  entry_price text,
  exit_price text,
  size text,
  pnl text,
  pnl_pips text,
  open_time timestamp with time zone,
  closed_at timestamp with time zone,
  close_reason text,
  signal_reason text,
  signal_score text,
  order_id text,
  bot_id text DEFAULT 'smc'::text,
  created_at timestamp with time zone DEFAULT now(),
  archived_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.trade_post_mortems (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  position_id text NOT NULL,
  trade_id uuid,
  symbol text NOT NULL,
  exit_reason text NOT NULL,
  what_worked text,
  what_failed text,
  lesson_learned text,
  exit_price text,
  pnl text,
  detail_json jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.trade_reasonings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  position_id text NOT NULL,
  trade_id uuid,
  symbol text NOT NULL,
  direction text NOT NULL,
  confluence_score integer NOT NULL,
  session text,
  timeframe text,
  bias text,
  factors_json jsonb,
  summary text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.trade_review_notes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  position_id text NOT NULL,
  review_status text DEFAULT 'pending'::text NOT NULL,
  notes text,
  lesson text,
  tags text[] DEFAULT '{}'::text[] NOT NULL,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.trades (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  status text DEFAULT 'open'::text NOT NULL,
  entry_price_old text,
  exit_price_old text,
  stop_loss_old text,
  take_profit_old text,
  position_size_old text,
  risk_reward_old text,
  risk_percent_old text,
  pnl_pips_old text,
  pnl_amount_old text,
  timeframe text,
  followed_strategy boolean,
  setup_type text,
  notes text,
  deviations text,
  improvements text,
  entry_time timestamp with time zone NOT NULL,
  exit_time timestamp with time zone,
  screenshot_url text,
  confluence_score integer,
  reasoning_json jsonb,
  post_mortem_json jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  entry_price numeric(20,8),
  exit_price numeric(20,8),
  stop_loss numeric(20,8),
  take_profit numeric(20,8),
  position_size numeric(20,8),
  risk_reward numeric(10,4),
  risk_percent numeric(10,4),
  pnl_pips numeric(20,4),
  pnl_amount numeric(20,8)
);

CREATE TABLE IF NOT EXISTS public.user_settings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  risk_settings_json jsonb,
  preferences_json jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.zone_candidate_shadow_observations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text DEFAULT 'smc'::text NOT NULL,
  scan_cycle_id uuid NOT NULL,
  observed_at timestamp with time zone DEFAULT now() NOT NULL,
  symbol text NOT NULL,
  trading_style text NOT NULL,
  style_policy_version text,
  style_base_policy_hash text,
  style_policy_hash text,
  direction text NOT NULL,
  candidate_id text NOT NULL,
  zone_type text NOT NULL,
  zone_low numeric(20,10) NOT NULL,
  zone_high numeric(20,10) NOT NULL,
  entry_price numeric(20,10) NOT NULL,
  stop_loss numeric(20,10),
  take_profit numeric(20,10),
  legacy_rank integer NOT NULL,
  shadow_rank integer NOT NULL,
  rank_delta integer NOT NULL,
  legacy_winner boolean DEFAULT false NOT NULL,
  shadow_winner boolean DEFAULT false NOT NULL,
  ranking_disagreed boolean DEFAULT false NOT NULL,
  legacy_zone_score numeric(8,3) NOT NULL,
  legacy_comparable_score numeric(8,3) NOT NULL,
  shadow_local_score numeric(8,3) NOT NULL,
  local_confluence jsonb NOT NULL,
  shadow_ranking jsonb NOT NULL,
  outcome_status text DEFAULT 'pending'::text NOT NULL,
  outcome_checked_at timestamp with time zone,
  price_reached_entry boolean,
  tp_hit boolean,
  sl_hit boolean,
  tp_hit_time_minutes integer,
  mfe_pips numeric(10,2),
  mae_pips numeric(10,2),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  evidence_source text DEFAULT 'forward_observation'::text NOT NULL,
  replay_run_id uuid,
  replay_contract_version text,
  activation_eligible boolean DEFAULT true NOT NULL,
  candidate_model_version text,
  candidate_model_rank integer,
  candidate_model_winner boolean DEFAULT false NOT NULL,
  candidate_lifecycle_state text,
  candidate_lifecycle jsonb,
  candidate_model jsonb,
  timeframe_relationship text,
  parent_candidate_id text,
  candidate_lineage jsonb,
  cross_tf_policy_version text,
  cross_tf_policy jsonb,
  legacy_execution_decision text,
  cross_tf_shadow_decision text,
  cross_tf_disagreed boolean DEFAULT false NOT NULL,
  cross_tf_reason_codes text[] DEFAULT ARRAY[]::text[] NOT NULL,
  cross_tf_evaluation jsonb
);

CREATE TABLE IF NOT EXISTS public.zone_confirmation_evidence_counters (
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  pending_order_id uuid NOT NULL,
  last_attempt integer DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.zone_timeframe_evidence (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  scan_cycle_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  observed_at timestamp with time zone DEFAULT now() NOT NULL,
  evaluated_at timestamp with time zone DEFAULT now() NOT NULL,
  trading_style text,
  style_policy_version text,
  style_base_policy_hash text,
  style_policy_hash text,
  contract_version text DEFAULT 'zone-tf-evidence.v1'::text NOT NULL,
  selected_timeframe text,
  final_reason text,
  evidence_source text DEFAULT 'live_scan'::text NOT NULL,
  replay_run_id uuid,
  replay_provenance text,
  parent_evidence_id uuid,
  pending_order_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
  confirmation_attempt integer DEFAULT 0 NOT NULL,
  slots jsonb DEFAULT '[]'::jsonb NOT NULL,
  engine_options jsonb DEFAULT '{}'::jsonb NOT NULL,
  payload_truncated boolean DEFAULT false NOT NULL,
  truncation_detail jsonb,
  linked_setup_id uuid,
  linked_trade_id uuid,
  has_disagreement boolean DEFAULT false NOT NULL,
  golden_replay_linked boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  event_linked boolean DEFAULT false NOT NULL,
  style_policy_snapshot jsonb,
  canonical_detector_version text,
  canonical_parity boolean
);

CREATE TABLE IF NOT EXISTS public.zone_timeframe_evidence_summary (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  evidence_id uuid NOT NULL,
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  scan_cycle_id text NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  selected_timeframe text,
  winner_candidate_id text,
  rejection_code_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
  final_reason text,
  evidence_hash text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  parent_evidence_id uuid,
  evidence_source text,
  contract_version text,
  trading_style text,
  style_policy_version text,
  style_base_policy_hash text,
  style_policy_hash text,
  style_policy_snapshot jsonb,
  pending_order_id uuid,
  confirmation_attempt integer,
  event_linked boolean DEFAULT false NOT NULL,
  has_disagreement boolean DEFAULT false NOT NULL,
  golden_replay_linked boolean DEFAULT false NOT NULL,
  canonical_detector_version text,
  canonical_parity boolean
);


-- ========================================================================
-- IDENTITY COLUMNS  (1 statements)
-- ========================================================================

ALTER TABLE public.scanner_authorization_failures ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;


-- ========================================================================
-- SEQUENCE OWNERSHIP  (1 statements)
-- ========================================================================

ALTER SEQUENCE public.api_credit_usage_id_seq OWNED BY public.api_credit_usage.id;


-- ========================================================================
-- CONSTRAINTS  (275 statements)
-- ========================================================================

ALTER TABLE public.active_direction_verdicts ADD CONSTRAINT active_direction_verdicts_pkey PRIMARY KEY (id);

ALTER TABLE public.active_direction_verdicts ADD CONSTRAINT active_direction_verdicts_game_plan_id_fkey FOREIGN KEY (game_plan_id) REFERENCES active_game_plans(id);

ALTER TABLE public.active_direction_verdicts ADD CONSTRAINT active_direction_verdicts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.active_direction_verdicts ADD CONSTRAINT active_direction_verdicts_agreement_check CHECK (((agreement >= (0)::numeric) AND (agreement <= (1)::numeric)));

ALTER TABLE public.active_direction_verdicts ADD CONSTRAINT active_direction_verdicts_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (100)::numeric)));

ALTER TABLE public.active_direction_verdicts ADD CONSTRAINT active_direction_verdicts_verdict_check CHECK ((verdict = ANY (ARRAY['long'::text, 'short'::text, 'neutral'::text])));

ALTER TABLE public.active_game_plans ADD CONSTRAINT active_game_plans_pkey PRIMARY KEY (id);

ALTER TABLE public.active_game_plans ADD CONSTRAINT active_game_plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.active_game_plans ADD CONSTRAINT active_game_plans_bias_check CHECK ((bias = ANY (ARRAY['bullish'::text, 'bearish'::text, 'neutral'::text])));

ALTER TABLE public.active_game_plans ADD CONSTRAINT active_game_plans_bias_confidence_check CHECK (((bias_confidence >= (0)::numeric) AND (bias_confidence <= (100)::numeric)));

ALTER TABLE public.active_game_plans ADD CONSTRAINT active_game_plans_generation_source_check CHECK ((generation_source = ANY (ARRAY['automatic_scan'::text, 'manual_refresh'::text])));

ALTER TABLE public.active_game_plans ADD CONSTRAINT active_game_plans_session_check CHECK ((session = ANY (ARRAY['Asian'::text, 'London'::text, 'New York'::text])));

ALTER TABLE public.active_game_plans ADD CONSTRAINT active_game_plans_state_check CHECK ((state = ANY (ARRAY['tradeable'::text, 'wait'::text, 'skip'::text])));

ALTER TABLE public.api_credit_usage ADD CONSTRAINT api_credit_usage_pkey PRIMARY KEY (id);

ALTER TABLE public.backtest_history_datasets ADD CONSTRAINT backtest_history_datasets_storage_path_key UNIQUE (storage_path);

ALTER TABLE public.backtest_history_datasets ADD CONSTRAINT backtest_history_datasets_pkey PRIMARY KEY (id);

ALTER TABLE public.backtest_history_datasets ADD CONSTRAINT backtest_history_datasets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.backtest_history_datasets ADD CONSTRAINT backtest_history_datasets_base_timeframe_check CHECK ((base_timeframe = '1m'::text));

ALTER TABLE public.backtest_history_datasets ADD CONSTRAINT backtest_history_datasets_candle_count_check CHECK ((candle_count > 0));

ALTER TABLE public.backtest_history_datasets ADD CONSTRAINT backtest_history_datasets_check CHECK ((end_at > start_at));

ALTER TABLE public.backtest_history_datasets ADD CONSTRAINT backtest_history_datasets_source_check CHECK ((source = ANY (ARRAY['mt4'::text, 'mt5'::text])));

ALTER TABLE public.backtest_runs ADD CONSTRAINT backtest_runs_pkey PRIMARY KEY (id);

ALTER TABLE public.bot_config_change_log ADD CONSTRAINT bot_config_change_log_pkey PRIMARY KEY (id);

ALTER TABLE public.bot_config_change_log ADD CONSTRAINT bot_config_change_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.bot_config_change_log ADD CONSTRAINT bot_config_change_log_change_type_check CHECK ((change_type = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])));

ALTER TABLE public.bot_configs ADD CONSTRAINT bot_configs_user_connection_unique UNIQUE (user_id, connection_id);

ALTER TABLE public.bot_configs ADD CONSTRAINT bot_configs_user_id_key UNIQUE (user_id);

ALTER TABLE public.bot_configs ADD CONSTRAINT bot_configs_pkey PRIMARY KEY (id);

ALTER TABLE public.bot_configs ADD CONSTRAINT bot_configs_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES broker_connections(id) ON DELETE CASCADE;

ALTER TABLE public.bot_recommendations ADD CONSTRAINT bot_recommendations_pkey PRIMARY KEY (id);

ALTER TABLE public.broker_connections ADD CONSTRAINT broker_connections_pkey PRIMARY KEY (id);

ALTER TABLE public.broker_connections ADD CONSTRAINT broker_connections_broker_type_check CHECK ((broker_type = ANY (ARRAY['oanda'::text, 'metaapi'::text])));

ALTER TABLE public.broker_connections ADD CONSTRAINT broker_connections_commission_mode_check CHECK ((commission_mode = ANY (ARRAY['auto'::text, 'manual'::text, 'none'::text])));

ALTER TABLE public.broker_connections ADD CONSTRAINT broker_connections_manual_commission_check CHECK (((commission_mode <> 'manual'::text) OR (commission_per_lot > (0)::numeric)));

ALTER TABLE public.broker_execution_ledger ADD CONSTRAINT broker_execution_ledger_unique UNIQUE (user_id, bot_id, position_id, broker_connection_id, action);

ALTER TABLE public.broker_execution_ledger ADD CONSTRAINT broker_execution_ledger_pkey PRIMARY KEY (id);

ALTER TABLE public.broker_execution_ledger ADD CONSTRAINT broker_execution_ledger_broker_connection_id_fkey FOREIGN KEY (broker_connection_id) REFERENCES broker_connections(id) ON DELETE CASCADE;

ALTER TABLE public.broker_execution_ledger ADD CONSTRAINT broker_execution_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.broker_execution_ledger ADD CONSTRAINT broker_execution_ledger_action_check CHECK ((action = ANY (ARRAY['open'::text, 'close'::text, 'modify'::text])));

ALTER TABLE public.broker_execution_ledger ADD CONSTRAINT broker_execution_ledger_attempt_count_check CHECK ((attempt_count > 0));

ALTER TABLE public.broker_execution_ledger ADD CONSTRAINT broker_execution_ledger_status_check CHECK ((status = ANY (ARRAY['attempting'::text, 'succeeded'::text, 'rejected'::text, 'uncertain'::text])));

ALTER TABLE public.close_audit_log ADD CONSTRAINT close_audit_log_pkey PRIMARY KEY (id);

ALTER TABLE public.config_backups ADD CONSTRAINT config_backups_backup_id_key UNIQUE (backup_id);

ALTER TABLE public.config_backups ADD CONSTRAINT config_backups_pkey PRIMARY KEY (id);

ALTER TABLE public.config_presets ADD CONSTRAINT config_presets_pkey PRIMARY KEY (id);

ALTER TABLE public.game_plan_refresh_status ADD CONSTRAINT game_plan_refresh_status_pkey PRIMARY KEY (user_id, bot_id);

ALTER TABLE public.game_plan_refresh_status ADD CONSTRAINT game_plan_refresh_status_status_check CHECK ((status = ANY (ARRAY['idle'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text])));

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_one_family_per_scan UNIQUE (user_id, bot_id, scan_cycle_id, symbol, setup_family);

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_one_structure_opportunity UNIQUE (user_id, bot_id, setup_family, opportunity_key);

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_observations_pkey PRIMARY KEY (id);

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_observations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_bounds_valid CHECK ((authority_zone_low < authority_zone_high));

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_comparable_geometry_check CHECK (((comparison_status = 'geometry_unavailable'::text) OR ((entry_price IS NOT NULL) AND (stop_loss IS NOT NULL) AND (take_profit IS NOT NULL))));

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_comparison_status_check CHECK ((comparison_status = ANY (ARRAY['comparable'::text, 'geometry_unavailable'::text])));

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_evidence_source_check CHECK ((evidence_source = ANY (ARRAY['forward_observation'::text, 'retrospective_replay'::text])));

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_legacy_outcome_check CHECK (((legacy_outcome_status IS NULL) OR (legacy_outcome_status = ANY (ARRAY['no_entry'::text, 'inconclusive'::text, 'would_have_won'::text, 'would_have_lost'::text]))));

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_observations_authority_zone_type_check CHECK ((authority_zone_type = ANY (ARRAY['ob'::text, 'fvg'::text, 'breaker'::text, 'ob_fvg'::text, 'breaker_fvg'::text])));

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_observations_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_observations_outcome_status_check CHECK ((outcome_status = ANY (ARRAY['pending'::text, 'no_entry'::text, 'inconclusive'::text, 'would_have_won'::text, 'would_have_lost'::text, 'unavailable'::text])));

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_opportunity_key_check CHECK (((setup_family <> 'structure_poi'::text) OR (opportunity_key IS NOT NULL)));

ALTER TABLE public.ict_entry_zone_authority_observations ADD CONSTRAINT ict_entry_zone_authority_setup_family_check CHECK ((setup_family = ANY (ARRAY['impulse'::text, 'structure_poi'::text])));

ALTER TABLE public.impulse_entry_lifecycle_replays ADD CONSTRAINT impulse_lifecycle_replay_unique UNIQUE (lifecycle_id, snapshot_id, evidence_source);

ALTER TABLE public.impulse_entry_lifecycle_replays ADD CONSTRAINT impulse_entry_lifecycle_replays_pkey PRIMARY KEY (id);

ALTER TABLE public.impulse_entry_lifecycle_replays ADD CONSTRAINT impulse_entry_lifecycle_replays_lifecycle_id_fkey FOREIGN KEY (lifecycle_id) REFERENCES impulse_entry_lifecycles(id) ON DELETE CASCADE;

ALTER TABLE public.impulse_entry_lifecycle_replays ADD CONSTRAINT impulse_entry_lifecycle_replays_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES scan_candle_snapshots(id) ON DELETE CASCADE;

ALTER TABLE public.impulse_entry_lifecycle_replays ADD CONSTRAINT impulse_entry_lifecycle_replays_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.impulse_entry_lifecycle_replays ADD CONSTRAINT impulse_entry_lifecycle_replays_evidence_source_check CHECK ((evidence_source = ANY (ARRAY['forward_observation'::text, 'retrospective_replay'::text, 'backtest'::text])));

ALTER TABLE public.impulse_entry_lifecycle_replays ADD CONSTRAINT impulse_entry_lifecycle_replays_outcome_check CHECK ((outcome = ANY (ARRAY['won'::text, 'lost'::text, 'inconclusive'::text, 'no_entry'::text])));

ALTER TABLE public.impulse_entry_lifecycle_replays ADD CONSTRAINT impulse_lifecycle_replay_contract CHECK (((result ->> 'contractVersion'::text) = 'impulse-lifecycle-replay.v1'::text));

ALTER TABLE public.impulse_entry_lifecycle_transitions ADD CONSTRAINT impulse_entry_transition_revision_unique UNIQUE (lifecycle_id, to_revision);

ALTER TABLE public.impulse_entry_lifecycle_transitions ADD CONSTRAINT impulse_entry_lifecycle_transitions_pkey PRIMARY KEY (id);

ALTER TABLE public.impulse_entry_lifecycle_transitions ADD CONSTRAINT impulse_entry_lifecycle_transitions_lifecycle_id_fkey FOREIGN KEY (lifecycle_id) REFERENCES impulse_entry_lifecycles(id) ON DELETE CASCADE;

ALTER TABLE public.impulse_entry_lifecycle_transitions ADD CONSTRAINT impulse_entry_lifecycle_transitions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.impulse_entry_lifecycle_transitions ADD CONSTRAINT impulse_entry_lifecycle_transitions_check CHECK ((to_revision = (from_revision + 1)));

ALTER TABLE public.impulse_entry_lifecycle_transitions ADD CONSTRAINT impulse_entry_lifecycle_transitions_event_type_check CHECK ((event_type = ANY (ARRAY['created'::text, 'zone_touched'::text, 'entry_trigger_touched'::text, 'candidate_failed'::text, 'trigger_revised'::text, 'trigger_locked'::text, 'confirmation_passed'::text, 'impulse_invalidated'::text, 'expired'::text, 'setup_resolved'::text])));

ALTER TABLE public.impulse_entry_lifecycle_transitions ADD CONSTRAINT impulse_entry_transition_snapshot_valid CHECK ((((lifecycle_snapshot ->> 'contractVersion'::text) = 'impulse-entry-lifecycle.v1'::text) AND (((lifecycle_snapshot ->> 'revision'::text))::integer = to_revision)));

ALTER TABLE public.impulse_entry_lifecycles ADD CONSTRAINT impulse_entry_lifecycle_setup_unique UNIQUE (user_id, bot_id, setup_id);

ALTER TABLE public.impulse_entry_lifecycles ADD CONSTRAINT impulse_entry_lifecycles_pkey PRIMARY KEY (id);

ALTER TABLE public.impulse_entry_lifecycles ADD CONSTRAINT impulse_entry_lifecycles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.impulse_entry_lifecycles ADD CONSTRAINT impulse_entry_lifecycle_contract_valid CHECK ((((lifecycle ->> 'contractVersion'::text) = 'impulse-entry-lifecycle.v1'::text) AND ((lifecycle ->> 'mode'::text) = mode) AND ((lifecycle #>> '{impulse,id}'::text[]) = impulse_id) AND ((lifecycle #>> '{impulse,direction}'::text[]) = direction) AND ((lifecycle #>> '{impulse,timeframe}'::text[]) = impulse_timeframe) AND ((lifecycle ->> 'status'::text) = status) AND (((lifecycle ->> 'revision'::text))::integer = revision) AND (COALESCE((lifecycle ->> 'activeCandidateId'::text), ''::text) = COALESCE(active_candidate_id, ''::text))));

ALTER TABLE public.impulse_entry_lifecycles ADD CONSTRAINT impulse_entry_lifecycles_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.impulse_entry_lifecycles ADD CONSTRAINT impulse_entry_lifecycles_mode_check CHECK ((mode = ANY (ARRAY['off'::text, 'observe'::text, 'enforce'::text])));

ALTER TABLE public.impulse_entry_lifecycles ADD CONSTRAINT impulse_entry_lifecycles_revision_check CHECK ((revision > 0));

ALTER TABLE public.impulse_entry_lifecycles ADD CONSTRAINT impulse_entry_lifecycles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'entered'::text, 'invalidated'::text, 'expired'::text, 'exhausted'::text])));

ALTER TABLE public.impulse_lifecycle_enforcement_certificates ADD CONSTRAINT impulse_lifecycle_enforcement__user_id_bot_id_evidence_hash_key UNIQUE (user_id, bot_id, evidence_hash);

ALTER TABLE public.impulse_lifecycle_enforcement_certificates ADD CONSTRAINT impulse_lifecycle_enforcement_certificates_pkey PRIMARY KEY (id);

ALTER TABLE public.impulse_lifecycle_enforcement_certificates ADD CONSTRAINT impulse_lifecycle_enforcement_certificates_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.impulse_lifecycle_enforcement_certificates ADD CONSTRAINT impulse_lifecycle_enforcement_certificates_status_check CHECK ((status = ANY (ARRAY['collecting'::text, 'eligible'::text, 'rejected'::text])));

ALTER TABLE public.kv_cache ADD CONSTRAINT kv_cache_pkey PRIMARY KEY (key);

ALTER TABLE public.manual_impulses ADD CONSTRAINT manual_impulses_pkey PRIMARY KEY (id);

ALTER TABLE public.manual_impulses ADD CONSTRAINT manual_impulses_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.manual_impulses ADD CONSTRAINT manual_impulses_check CHECK ((high > low));

ALTER TABLE public.manual_impulses ADD CONSTRAINT manual_impulses_direction_check CHECK ((direction = ANY (ARRAY['bullish'::text, 'bearish'::text])));

ALTER TABLE public.manual_impulses ADD CONSTRAINT manual_impulses_status_check CHECK ((status = ANY (ARRAY['active'::text, 'invalidated'::text, 'expired'::text, 'cancelled'::text, 'filled'::text])));

ALTER TABLE public.manual_impulses ADD CONSTRAINT manual_impulses_timeframe_check CHECK ((timeframe = ANY (ARRAY['D'::text, '4H'::text, '1H'::text])));

ALTER TABLE public.optimizer_runs ADD CONSTRAINT optimizer_runs_pkey PRIMARY KEY (id);

ALTER TABLE public.paper_accounts ADD CONSTRAINT paper_accounts_user_id_key UNIQUE (user_id);

ALTER TABLE public.paper_accounts ADD CONSTRAINT paper_accounts_pkey PRIMARY KEY (id);

ALTER TABLE public.paper_accounts ADD CONSTRAINT paper_accounts_execution_mode_check CHECK ((execution_mode = ANY (ARRAY['paper'::text, 'live'::text])));

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_pkey PRIMARY KEY (id);

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_direction_verdict_id_fkey FOREIGN KEY (direction_verdict_id) REFERENCES active_direction_verdicts(id);

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_game_plan_id_fkey FOREIGN KEY (game_plan_id) REFERENCES active_game_plans(id);

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_impulse_entry_lifecycle_id_fkey FOREIGN KEY (impulse_entry_lifecycle_id) REFERENCES impulse_entry_lifecycles(id) ON DELETE SET NULL;

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_staged_setup_id_fkey FOREIGN KEY (staged_setup_id) REFERENCES staged_setups(id) ON DELETE SET NULL;

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_broker_close_state_check CHECK ((broker_close_state = ANY (ARRAY['none'::text, 'pending'::text, 'confirmed'::text, 'reconciliation_required'::text])));

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_broker_execution_state_check CHECK ((broker_execution_state = ANY (ARRAY['paper'::text, 'pending'::text, 'confirmed'::text, 'reconciliation_required'::text, 'rejected'::text])));

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_canonical_dealing_range_valid CHECK (((canonical_dealing_range IS NULL) OR ((canonical_dealing_range ->> 'available'::text) = 'false'::text) OR ((canonical_dealing_range_version = 'canonical-dealing-range.v1'::text) AND (canonical_dealing_range_impulse_id IS NOT NULL) AND (canonical_dealing_range_timeframe IS NOT NULL) AND (((canonical_dealing_range #>> '{range,high}'::text[]))::numeric > ((canonical_dealing_range #>> '{range,low}'::text[]))::numeric) AND (((canonical_dealing_range #>> '{range,midpoint}'::text[]))::numeric = ((((canonical_dealing_range #>> '{range,high}'::text[]))::numeric + ((canonical_dealing_range #>> '{range,low}'::text[]))::numeric) / (2)::numeric)))));

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_cross_tf_context_contract CHECK ((((frozen_strategy_context #> '{crossTimeframeContext}'::text[]) IS NULL) OR (cross_tf_context_version = ANY (ARRAY['frozen-cross-tf-context.v1'::text, 'frozen-cross-tf-context.v2'::text]))));

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.paper_positions ADD CONSTRAINT paper_positions_position_status_check CHECK ((position_status = ANY (ARRAY['open'::text, 'pending'::text])));

ALTER TABLE public.paper_positions ADD CONSTRAINT position_cross_tf_entry_authority_valid CHECK (((cross_tf_entry_authority IS NULL) OR (((cross_tf_entry_authority ->> 'contractVersion'::text) = 'cross-tf-entry-authority.v1'::text) AND (cross_tf_effective_mode = ANY (ARRAY['observe'::text, 'soft'::text, 'hard'::text])) AND (cross_tf_entry_allowed IS TRUE) AND ((final_authorization #>> '{crossTimeframeAuthority,contractVersion}'::text[]) = 'cross-tf-entry-authority.v1'::text) AND ((final_authorization #>> '{crossTimeframeAuthority,allowed}'::text[]) = 'true'::text))));

ALTER TABLE public.paper_positions ADD CONSTRAINT position_frozen_strategy_hash_matches CHECK (((frozen_strategy_context IS NULL) OR (frozen_strategy_hash = md5((frozen_strategy_context)::text)))) NOT VALID;

ALTER TABLE public.paper_positions ADD CONSTRAINT position_impulse_entry_lifecycle_valid CHECK (((impulse_entry_lifecycle IS NULL) OR ((impulse_entry_lifecycle ->> 'contractVersion'::text) = 'impulse-entry-lifecycle.v1'::text)));

ALTER TABLE public.paper_trade_history ADD CONSTRAINT paper_trade_history_pkey PRIMARY KEY (id);

ALTER TABLE public.paper_trade_history ADD CONSTRAINT paper_trade_history_source_pending_order_id_fkey FOREIGN KEY (source_pending_order_id) REFERENCES pending_orders(id) ON DELETE SET NULL;

ALTER TABLE public.paper_trade_history ADD CONSTRAINT paper_trade_history_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.paper_trade_history_duplicate_audit ADD CONSTRAINT paper_trade_history_duplicate_audit_pkey PRIMARY KEY (duplicate_history_id);

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_pkey PRIMARY KEY (id);

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_direction_verdict_id_fkey FOREIGN KEY (direction_verdict_id) REFERENCES active_direction_verdicts(id);

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_game_plan_id_fkey FOREIGN KEY (game_plan_id) REFERENCES active_game_plans(id);

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_impulse_entry_lifecycle_id_fkey FOREIGN KEY (impulse_entry_lifecycle_id) REFERENCES impulse_entry_lifecycles(id) ON DELETE SET NULL;

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_staged_setup_id_fkey FOREIGN KEY (staged_setup_id) REFERENCES staged_setups(id) ON DELETE SET NULL;

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_cross_tf_entry_authority_valid CHECK (((cross_tf_entry_authority IS NULL) OR (((cross_tf_entry_authority ->> 'contractVersion'::text) = 'cross-tf-entry-authority.v1'::text) AND (cross_tf_effective_mode = ANY (ARRAY['observe'::text, 'soft'::text, 'hard'::text])) AND (cross_tf_entry_allowed IS NOT NULL))));

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_frozen_strategy_hash_matches CHECK (((frozen_strategy_context IS NULL) OR (frozen_strategy_hash = md5((frozen_strategy_context)::text)))) NOT VALID;

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_impulse_entry_lifecycle_valid CHECK (((impulse_entry_lifecycle IS NULL) OR ((impulse_entry_lifecycle ->> 'contractVersion'::text) = 'impulse-entry-lifecycle.v1'::text)));

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_canonical_dealing_range_valid CHECK (((canonical_dealing_range IS NULL) OR ((canonical_dealing_range ->> 'available'::text) = 'false'::text) OR ((canonical_dealing_range_version = 'canonical-dealing-range.v1'::text) AND (canonical_dealing_range_impulse_id IS NOT NULL) AND (canonical_dealing_range_timeframe IS NOT NULL) AND (((canonical_dealing_range #>> '{range,high}'::text[]))::numeric > ((canonical_dealing_range #>> '{range,low}'::text[]))::numeric) AND (((canonical_dealing_range #>> '{range,midpoint}'::text[]))::numeric = ((((canonical_dealing_range #>> '{range,high}'::text[]))::numeric + ((canonical_dealing_range #>> '{range,low}'::text[]))::numeric) / (2)::numeric)))));

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_confirmation_method_check CHECK (((confirmation_method IS NULL) OR (confirmation_method = ANY (ARRAY['choch'::text, 'indicators'::text, 'choch_and_indicators'::text]))));

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_cross_tf_context_contract CHECK ((((frozen_strategy_context #> '{crossTimeframeContext}'::text[]) IS NULL) OR (cross_tf_context_version = ANY (ARRAY['frozen-cross-tf-context.v1'::text, 'frozen-cross-tf-context.v2'::text]))));

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_order_type_check CHECK ((order_type = ANY (ARRAY['limit'::text, 'stop'::text])));

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'awaiting_confirmation'::text, 'triggered'::text, 'filled'::text, 'expired'::text, 'cancelled'::text, 'invalidated'::text, 'reconciliation_required'::text, 'broker_rejected'::text])));

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_post_confirmation_entry_valid CHECK (((post_confirmation_entry IS NULL) OR (((post_confirmation_entry ->> 'contractVersion'::text) = 'post-choch-retracement.v1'::text) AND ((post_confirmation_entry ->> 'state'::text) = ANY (ARRAY['awaiting_retracement'::text, 'ready'::text, 'invalidated'::text, 'expired'::text])) AND (((post_confirmation_entry #>> '{zone,low}'::text[]))::numeric < ((post_confirmation_entry #>> '{zone,high}'::text[]))::numeric))));

ALTER TABLE public.pending_orders ADD CONSTRAINT pending_watchlist_identity_required CHECK (((NOT from_watchlist) OR ((staged_setup_id IS NOT NULL) AND (candidate_id IS NOT NULL)))) NOT VALID;

ALTER TABLE public.profiles ADD CONSTRAINT profiles_user_id_key UNIQUE (user_id);

ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE public.prop_firm_config ADD CONSTRAINT prop_firm_config_user_id_bot_id_key UNIQUE (user_id, bot_id);

ALTER TABLE public.prop_firm_config ADD CONSTRAINT prop_firm_config_pkey PRIMARY KEY (id);

ALTER TABLE public.prop_firm_config ADD CONSTRAINT prop_firm_config_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.prop_firm_config ADD CONSTRAINT prop_firm_config_account_stage_check CHECK ((account_stage = ANY (ARRAY['challenge'::text, 'verification'::text, 'funded'::text])));

ALTER TABLE public.prop_firm_config ADD CONSTRAINT prop_firm_config_firm_type_check CHECK ((firm_type = ANY (ARRAY['ftmo_2step'::text, 'ftmo_1step'::text, 'generic'::text])));

ALTER TABLE public.prop_firm_daily_state ADD CONSTRAINT prop_firm_daily_state_config_id_trading_day_key UNIQUE (config_id, trading_day);

ALTER TABLE public.prop_firm_daily_state ADD CONSTRAINT prop_firm_daily_state_pkey PRIMARY KEY (id);

ALTER TABLE public.prop_firm_daily_state ADD CONSTRAINT prop_firm_daily_state_config_id_fkey FOREIGN KEY (config_id) REFERENCES prop_firm_config(id) ON DELETE CASCADE;

ALTER TABLE public.prop_firm_events ADD CONSTRAINT prop_firm_events_pkey PRIMARY KEY (id);

ALTER TABLE public.prop_firm_events ADD CONSTRAINT prop_firm_events_config_id_fkey FOREIGN KEY (config_id) REFERENCES prop_firm_config(id) ON DELETE CASCADE;

ALTER TABLE public.prop_firm_events ADD CONSTRAINT prop_firm_events_event_type_check CHECK ((event_type = ANY (ARRAY['daily_warning'::text, 'daily_soft_lock'::text, 'daily_hard_lock'::text, 'drawdown_warning'::text, 'drawdown_breach'::text, 'target_reached'::text, 'target_warning'::text, 'emergency_close'::text, 'size_reduction'::text, 'day_reset'::text, 'best_day_warning'::text])));

ALTER TABLE public.prop_firm_events ADD CONSTRAINT prop_firm_events_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])));

ALTER TABLE public.rejected_setups ADD CONSTRAINT rejected_setups_pkey PRIMARY KEY (id);

ALTER TABLE public.rejected_setups ADD CONSTRAINT rejected_setups_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.rejected_setups ADD CONSTRAINT rejected_setups_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.rejected_setups ADD CONSTRAINT rejected_setups_outcome_status_check CHECK ((outcome_status = ANY (ARRAY['pending'::text, 'inconclusive'::text, 'would_have_won'::text, 'would_have_lost'::text])));

ALTER TABLE public.rejected_setups ADD CONSTRAINT rejected_setups_rejection_type_check CHECK ((rejection_type = ANY (ARRAY['gate_blocked'::text, 'below_threshold_strong_t1'::text])));

ALTER TABLE public.scan_candle_snapshots ADD CONSTRAINT scan_candle_snapshots_user_id_bot_id_scan_cycle_id_symbol_t_key UNIQUE (user_id, bot_id, scan_cycle_id, symbol, timeframe);

ALTER TABLE public.scan_candle_snapshots ADD CONSTRAINT scan_candle_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE public.scan_candle_snapshots ADD CONSTRAINT scan_candle_snapshots_candles_chk CHECK ((jsonb_typeof(candles) = 'array'::text));

ALTER TABLE public.scan_candle_snapshots ADD CONSTRAINT scan_candle_snapshots_count_chk CHECK (((candle_count >= 0) AND (candle_count <= 500)));

ALTER TABLE public.scan_history ADD CONSTRAINT scan_history_pkey PRIMARY KEY (id);

ALTER TABLE public.scan_logs ADD CONSTRAINT scan_logs_pkey PRIMARY KEY (id);

ALTER TABLE public.scanner_authorization_failures ADD CONSTRAINT scanner_authorization_failures_pkey PRIMARY KEY (id);

ALTER TABLE public.scanner_health_monitor_state ADD CONSTRAINT scanner_health_monitor_state_pkey PRIMARY KEY (user_id, bot_id);

ALTER TABLE public.scanner_operation_runs ADD CONSTRAINT scanner_operation_runs_pkey PRIMARY KEY (id);

ALTER TABLE public.scanner_operation_runs ADD CONSTRAINT scanner_operation_runs_operation_check CHECK ((operation = ANY (ARRAY['scan'::text, 'manage'::text, 'zone_confirmation'::text])));

ALTER TABLE public.scanner_operation_runs ADD CONSTRAINT scanner_operation_runs_status_check CHECK ((status = ANY (ARRAY['invoked'::text, 'running'::text, 'completed'::text, 'failed'::text, 'skipped'::text])));

ALTER TABLE public.scanner_operation_runs ADD CONSTRAINT scanner_operation_runs_trigger_source_check CHECK ((trigger_source = ANY (ARRAY['cron'::text, 'manual'::text])));

ALTER TABLE public.scanner_operational_alerts ADD CONSTRAINT scanner_operational_alerts_pkey PRIMARY KEY (id);

ALTER TABLE public.scanner_operational_alerts ADD CONSTRAINT scanner_operational_alerts_alert_type_check CHECK ((alert_type = ANY (ARRAY['scanner_heartbeat_missing'::text, 'scan_incomplete'::text, 'metaapi_certificate_failure'::text, 'metaapi_connection_failure'::text, 'candle_source_exhaustion'::text, 'stuck_confirmation_order'::text, 'authorization_error'::text, 'migration_drift'::text])));

ALTER TABLE public.scanner_operational_alerts ADD CONSTRAINT scanner_operational_alerts_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])));

ALTER TABLE public.scanner_operational_alerts ADD CONSTRAINT scanner_operational_alerts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'resolved'::text])));

ALTER TABLE public.scanner_runtime_locks ADD CONSTRAINT scanner_runtime_locks_pkey PRIMARY KEY (user_id, bot_id, lock_scope);

ALTER TABLE public.scheduled_tasks ADD CONSTRAINT scheduled_tasks_pkey PRIMARY KEY (id);

ALTER TABLE public.scheduled_tasks ADD CONSTRAINT scheduled_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);

ALTER TABLE public.setup_lifecycle_events ADD CONSTRAINT setup_lifecycle_events_pkey PRIMARY KEY (id);

ALTER TABLE public.setup_lifecycle_events ADD CONSTRAINT setup_lifecycle_events_staged_setup_id_fkey FOREIGN KEY (staged_setup_id) REFERENCES staged_setups(id) ON DELETE CASCADE;

ALTER TABLE public.setup_lifecycle_events ADD CONSTRAINT setup_lifecycle_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.setup_lifecycle_events ADD CONSTRAINT setup_lifecycle_events_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_pkey PRIMARY KEY (id);

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_direction_verdict_id_fkey FOREIGN KEY (direction_verdict_id) REFERENCES active_direction_verdicts(id) ON DELETE SET NULL;

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_game_plan_id_fkey FOREIGN KEY (game_plan_id) REFERENCES active_game_plans(id) ON DELETE SET NULL;

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_impulse_entry_lifecycle_id_fkey FOREIGN KEY (impulse_entry_lifecycle_id) REFERENCES impulse_entry_lifecycles(id) ON DELETE SET NULL;

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_observation_parent_id_fkey FOREIGN KEY (observation_parent_id) REFERENCES staged_setups(id) ON DELETE SET NULL;

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_pending_order_id_fkey FOREIGN KEY (pending_order_id) REFERENCES pending_orders(id) ON DELETE SET NULL;

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_position_id_fkey FOREIGN KEY (position_id) REFERENCES paper_positions(id) ON DELETE SET NULL;

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_cross_tf_entry_authority_valid CHECK (((cross_tf_entry_authority IS NULL) OR (((cross_tf_entry_authority ->> 'contractVersion'::text) = 'cross-tf-entry-authority.v1'::text) AND (cross_tf_effective_mode = ANY (ARRAY['observe'::text, 'soft'::text, 'hard'::text])) AND (cross_tf_entry_allowed IS NOT NULL))));

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_frozen_strategy_hash_matches CHECK (((frozen_strategy_context IS NULL) OR (frozen_strategy_hash = md5((frozen_strategy_context)::text)))) NOT VALID;

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_impulse_entry_lifecycle_valid CHECK (((impulse_entry_lifecycle IS NULL) OR ((impulse_entry_lifecycle ->> 'contractVersion'::text) = 'impulse-entry-lifecycle.v1'::text)));

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_prezone_observation_shape CHECK ((execution_eligible OR (setup_type = 'waiting_for_unified_zone'::text))) NOT VALID;

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_canonical_dealing_range_valid CHECK (((canonical_dealing_range IS NULL) OR ((canonical_dealing_range ->> 'available'::text) = 'false'::text) OR ((canonical_dealing_range_version = 'canonical-dealing-range.v1'::text) AND (canonical_dealing_range_impulse_id IS NOT NULL) AND (canonical_dealing_range_timeframe IS NOT NULL) AND (((canonical_dealing_range #>> '{range,high}'::text[]))::numeric > ((canonical_dealing_range #>> '{range,low}'::text[]))::numeric) AND (((canonical_dealing_range #>> '{range,midpoint}'::text[]))::numeric = ((((canonical_dealing_range #>> '{range,high}'::text[]))::numeric + ((canonical_dealing_range #>> '{range,low}'::text[]))::numeric) / (2)::numeric)))));

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_confirmation_method_check CHECK (((confirmation_method IS NULL) OR (confirmation_method = ANY (ARRAY['choch'::text, 'indicators'::text, 'choch_and_indicators'::text]))));

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_cross_tf_context_contract CHECK ((((frozen_strategy_context #> '{crossTimeframeContext}'::text[]) IS NULL) OR (cross_tf_context_version = ANY (ARRAY['frozen-cross-tf-context.v1'::text, 'frozen-cross-tf-context.v2'::text]))));

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_lifecycle_phase_check CHECK (((lifecycle_phase IS NULL) OR (lifecycle_phase = ANY (ARRAY['monitoring_pre_zone'::text, 'zone_discovered'::text, 'approaching_zone'::text, 'at_zone'::text, 'local_trigger_active'::text, 'local_trigger_swept'::text, 'sweep_rejected'::text, 'confirmation_ready'::text, 'entry_authorized'::text, 'position_managing'::text]))));

ALTER TABLE public.staged_setups ADD CONSTRAINT staged_setups_status_check CHECK ((status = ANY (ARRAY['watching'::text, 'qualified'::text, 'pending'::text, 'awaiting_confirmation'::text, 'filled'::text, 'blocked_after_qualification'::text, 'invalidated'::text, 'expired'::text, 'cancelled'::text, 'promoted'::text])));

ALTER TABLE public.stop_policy_observations ADD CONSTRAINT stop_policy_observations_user_id_bot_id_candidate_id_contra_key UNIQUE (user_id, bot_id, candidate_id, contract_version);

ALTER TABLE public.stop_policy_observations ADD CONSTRAINT stop_policy_observations_pkey PRIMARY KEY (id);

ALTER TABLE public.stop_policy_observations ADD CONSTRAINT stop_policy_observations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.stop_policy_observations ADD CONSTRAINT stop_policy_observations_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.stop_policy_observations ADD CONSTRAINT stop_policy_observations_execution_floor_source_check CHECK ((execution_floor_source = ANY (ARRAY['spread_proxy'::text, 'broker_snapshot'::text])));

ALTER TABLE public.stop_policy_observations ADD CONSTRAINT stop_policy_observations_observation_only_check CHECK (observation_only);

ALTER TABLE public.stop_policy_observations ADD CONSTRAINT stop_policy_observations_positive_prices CHECK (((entry_price > (0)::numeric) AND (structural_invalidation > (0)::numeric) AND (confirmation_atr >= (0)::numeric) AND (pip_size > (0)::numeric) AND (execution_floor_quote_distance >= (0)::numeric)));

ALTER TABLE public.stop_policy_observations ADD CONSTRAINT stop_policy_observations_spread_source_check CHECK ((spread_source = ANY (ARRAY['spec_proxy'::text, 'live'::text])));

ALTER TABLE public.strategy_activation_events ADD CONSTRAINT strategy_activation_events_pkey PRIMARY KEY (id);

ALTER TABLE public.strategy_activation_events ADD CONSTRAINT strategy_activation_events_activation_id_fkey FOREIGN KEY (activation_id) REFERENCES strategy_activation_registry(id) ON DELETE CASCADE;

ALTER TABLE public.strategy_activation_events ADD CONSTRAINT strategy_activation_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.strategy_activation_events ADD CONSTRAINT strategy_activation_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.strategy_activation_registry ADD CONSTRAINT strategy_activation_registry_pkey PRIMARY KEY (id);

ALTER TABLE public.strategy_activation_registry ADD CONSTRAINT strategy_activation_registry_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.strategy_activation_registry ADD CONSTRAINT strategy_activation_registry_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.strategy_activation_registry ADD CONSTRAINT strategy_activation_registry_authority_stage_check CHECK ((authority_stage = ANY (ARRAY['shadow'::text, 'log_only'::text, 'soft_adjustment'::text, 'hard_block'::text])));

ALTER TABLE public.strategy_activation_registry ADD CONSTRAINT strategy_activation_registry_check CHECK (((evidence_window_end IS NULL) OR (evidence_window_start IS NULL) OR (evidence_window_end >= evidence_window_start)));

ALTER TABLE public.strategy_activation_registry ADD CONSTRAINT strategy_activation_registry_check1 CHECK (((runtime_enforced = false) OR ((authority_stage = ANY (ARRAY['soft_adjustment'::text, 'hard_block'::text])) AND (runtime_scope = ANY (ARRAY['paper'::text, 'live_canary'::text, 'live'::text])))));

ALTER TABLE public.strategy_activation_registry ADD CONSTRAINT strategy_activation_registry_feature_key_check CHECK (((length(feature_key) >= 1) AND (length(feature_key) <= 100)));

ALTER TABLE public.strategy_activation_registry ADD CONSTRAINT strategy_activation_registry_revision_check CHECK ((revision > 0));

ALTER TABLE public.strategy_activation_registry ADD CONSTRAINT strategy_activation_registry_runtime_scope_check CHECK ((runtime_scope = ANY (ARRAY['observation'::text, 'paper'::text, 'live_canary'::text, 'live'::text])));

ALTER TABLE public.strategy_activation_registry ADD CONSTRAINT strategy_activation_registry_variant_key_check CHECK (((length(variant_key) >= 1) AND (length(variant_key) <= 100)));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_pkey PRIMARY KEY (id);

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificat_good_trade_retention_percent_check CHECK (((good_trade_retention_percent >= (0)::numeric) AND (good_trade_retention_percent <= (100)::numeric)));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_beneficial_rate_percent_check CHECK (((beneficial_rate_percent IS NULL) OR ((beneficial_rate_percent >= (0)::numeric) AND (beneficial_rate_percent <= (100)::numeric))));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_changed_count_check CHECK ((changed_count >= 0));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_check CHECK (((source_window_end IS NULL) OR (source_window_start IS NULL) OR (source_window_end >= source_window_start)));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_check1 CHECK (((contract_version = (certificate ->> 'contractVersion'::text)) AND (generator_version = (certificate ->> 'generatorVersion'::text)) AND (feature_key = (certificate ->> 'featureKey'::text)) AND (variant_key = (certificate ->> 'variantKey'::text)) AND (status = (certificate #>> '{eligibility,status}'::text[]))));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_check2 CHECK ((activation_scope_hash = strategy_activation_json_hash(activation_scope)));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_check3 CHECK ((certificate_hash = strategy_activation_json_hash(certificate)));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_coverage_percent_check CHECK (((coverage_percent >= (0)::numeric) AND (coverage_percent <= (100)::numeric)));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_evidence_count_check CHECK ((evidence_count >= 0));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_feature_key_check CHECK (((length(feature_key) >= 1) AND (length(feature_key) <= 100)));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_resolved_count_check CHECK ((resolved_count >= 0));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_status_check CHECK ((status = ANY (ARRAY['collecting'::text, 'eligible_log_only'::text, 'keep_shadow'::text])));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_total_candidates_check CHECK ((total_candidates >= 0));

ALTER TABLE public.strategy_evidence_certificates ADD CONSTRAINT strategy_evidence_certificates_variant_key_check CHECK (((length(variant_key) >= 1) AND (length(variant_key) <= 100)));

ALTER TABLE public.streamlined_decision_certificates ADD CONSTRAINT streamlined_decision_certificates_pkey PRIMARY KEY (id);

ALTER TABLE public.streamlined_decision_certificates ADD CONSTRAINT streamlined_decision_certificates_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.streamlined_decision_certificates ADD CONSTRAINT streamlined_decision_certificates_comparable_check CHECK ((comparable >= 0));

ALTER TABLE public.streamlined_decision_certificates ADD CONSTRAINT streamlined_decision_certificates_minimum_comparable_check CHECK ((minimum_comparable >= 100));

ALTER TABLE public.telegram_notification_claims ADD CONSTRAINT telegram_notification_claims_pkey PRIMARY KEY (claim_key);

ALTER TABLE public.trade_archive ADD CONSTRAINT trade_archive_pkey PRIMARY KEY (id);

ALTER TABLE public.trade_post_mortems ADD CONSTRAINT trade_post_mortems_pkey PRIMARY KEY (id);

ALTER TABLE public.trade_post_mortems ADD CONSTRAINT trade_post_mortems_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE SET NULL;

ALTER TABLE public.trade_reasonings ADD CONSTRAINT trade_reasonings_pkey PRIMARY KEY (id);

ALTER TABLE public.trade_reasonings ADD CONSTRAINT trade_reasonings_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE SET NULL;

ALTER TABLE public.trade_reasonings ADD CONSTRAINT trade_reasonings_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.trade_review_notes ADD CONSTRAINT trade_review_notes_user_id_position_id_key UNIQUE (user_id, position_id);

ALTER TABLE public.trade_review_notes ADD CONSTRAINT trade_review_notes_pkey PRIMARY KEY (id);

ALTER TABLE public.trade_review_notes ADD CONSTRAINT trade_review_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.trade_review_notes ADD CONSTRAINT trade_review_notes_review_status_check CHECK ((review_status = ANY (ARRAY['pending'::text, 'reviewed'::text])));

ALTER TABLE public.trades ADD CONSTRAINT trades_pkey PRIMARY KEY (id);

ALTER TABLE public.trades ADD CONSTRAINT trades_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.trades ADD CONSTRAINT trades_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text, 'cancelled'::text])));

ALTER TABLE public.user_settings ADD CONSTRAINT user_settings_user_id_key UNIQUE (user_id);

ALTER TABLE public.user_settings ADD CONSTRAINT user_settings_pkey PRIMARY KEY (id);

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_shadow_one_candidate_per_scan UNIQUE (user_id, bot_id, scan_cycle_id, symbol, candidate_id);

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_candidate_shadow_observations_pkey PRIMARY KEY (id);

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_candidate_shadow_observations_replay_run_id_fkey FOREIGN KEY (replay_run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE;

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_candidate_shadow_observations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_candidate_shadow_observations_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text])));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_candidate_shadow_observations_legacy_rank_check CHECK ((legacy_rank > 0));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_candidate_shadow_observations_outcome_status_check CHECK ((outcome_status = ANY (ARRAY['pending'::text, 'no_entry'::text, 'inconclusive'::text, 'would_have_won'::text, 'would_have_lost'::text])));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_candidate_shadow_observations_shadow_rank_check CHECK ((shadow_rank > 0));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_candidate_shadow_observations_zone_type_check CHECK ((zone_type = ANY (ARRAY['ob'::text, 'fvg'::text])));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_shadow_bounds_valid CHECK ((zone_low <= zone_high));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_shadow_candidate_lifecycle_valid CHECK (((candidate_lifecycle_state IS NULL) OR (candidate_lifecycle_state = ANY (ARRAY['fresh'::text, 'tapped_and_held'::text, 'partially_mitigated'::text, 'violated'::text]))));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_shadow_candidate_model_rank_valid CHECK (((candidate_model_rank IS NULL) OR (candidate_model_rank > 0)));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_shadow_cross_tf_decisions_valid CHECK ((((cross_tf_policy_version IS NULL) AND (legacy_execution_decision IS NULL) AND (cross_tf_shadow_decision IS NULL)) OR ((cross_tf_policy_version = 'cross-tf-shadow-policy.v1'::text) AND (legacy_execution_decision = ANY (ARRAY['allow'::text, 'block'::text])) AND (cross_tf_shadow_decision = ANY (ARRAY['allow'::text, 'block'::text])) AND ((cross_tf_policy #>> '{enforcement}'::text[]) = 'observe_only'::text) AND ((cross_tf_evaluation #>> '{enforcement}'::text[]) = 'observe_only'::text))));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_shadow_evidence_source_valid CHECK ((evidence_source = ANY (ARRAY['forward_observation'::text, 'retrospective_replay'::text])));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_shadow_replay_never_activation CHECK (((evidence_source <> 'retrospective_replay'::text) OR (activation_eligible = false)));

ALTER TABLE public.zone_candidate_shadow_observations ADD CONSTRAINT zone_shadow_timeframe_relationship_valid CHECK (((timeframe_relationship IS NULL) OR (timeframe_relationship = ANY (ARRAY['qualified_nested'::text, 'context_only'::text, 'standalone_lower_tf'::text, 'timeframe_conflict'::text, 'no_parent_context'::text]))));

ALTER TABLE public.zone_confirmation_evidence_counters ADD CONSTRAINT zone_confirmation_evidence_counters_pkey PRIMARY KEY (user_id, bot_id, pending_order_id);

ALTER TABLE public.zone_timeframe_evidence ADD CONSTRAINT zone_timeframe_evidence_pkey PRIMARY KEY (id);

ALTER TABLE public.zone_timeframe_evidence ADD CONSTRAINT zone_tf_evidence_direction_chk CHECK ((direction = ANY (ARRAY['bullish'::text, 'bearish'::text, 'long'::text, 'short'::text])));

ALTER TABLE public.zone_timeframe_evidence ADD CONSTRAINT zone_tf_evidence_provenance_chk CHECK (((replay_provenance IS NULL) OR (replay_provenance = ANY (ARRAY['exact_input'::text, 'historically_refetched'::text, 'approximate_config'::text, 'unreplayable'::text]))));

ALTER TABLE public.zone_timeframe_evidence ADD CONSTRAINT zone_tf_evidence_source_chk CHECK ((evidence_source = ANY (ARRAY['live_scan'::text, 'confirmation'::text, 'replay'::text, 'backtest'::text])));

ALTER TABLE public.zone_timeframe_evidence_summary ADD CONSTRAINT zone_timeframe_evidence_summary_evidence_id_key UNIQUE (evidence_id);

ALTER TABLE public.zone_timeframe_evidence_summary ADD CONSTRAINT zone_timeframe_evidence_summary_pkey PRIMARY KEY (id);


-- ========================================================================
-- INDEXES  (144 statements)
-- ========================================================================

CREATE INDEX idx_active_direction_verdicts_style_base_policy ON public.active_direction_verdicts USING btree (user_id, bot_id, style_base_policy_hash) WHERE (style_base_policy_hash IS NOT NULL);

CREATE INDEX idx_active_direction_verdicts_style_policy ON public.active_direction_verdicts USING btree (user_id, bot_id, style_policy_hash) WHERE (style_policy_hash IS NOT NULL);

CREATE INDEX idx_direction_verdict_history ON public.active_direction_verdicts USING btree (user_id, bot_id, symbol, evaluated_at DESC);

CREATE UNIQUE INDEX idx_direction_verdict_one_active ON public.active_direction_verdicts USING btree (user_id, bot_id, symbol) WHERE is_active;

CREATE UNIQUE INDEX idx_direction_verdict_version ON public.active_direction_verdicts USING btree (user_id, bot_id, symbol, verdict_version);

CREATE INDEX idx_active_game_plans_style_base_policy ON public.active_game_plans USING btree (user_id, bot_id, style_base_policy_hash) WHERE (style_base_policy_hash IS NOT NULL);

CREATE INDEX idx_active_game_plans_style_policy ON public.active_game_plans USING btree (user_id, bot_id, style_policy_hash) WHERE (style_policy_hash IS NOT NULL);

CREATE INDEX idx_game_plan_active_expiry ON public.active_game_plans USING btree (user_id, bot_id, expires_at) WHERE is_active;

CREATE INDEX idx_game_plan_history ON public.active_game_plans USING btree (user_id, bot_id, generated_at DESC);

CREATE UNIQUE INDEX idx_game_plan_one_active_symbol ON public.active_game_plans USING btree (user_id, bot_id, symbol) WHERE is_active;

CREATE UNIQUE INDEX idx_game_plan_version_symbol ON public.active_game_plans USING btree (user_id, bot_id, plan_version, symbol);

CREATE INDEX api_credit_usage_caller_time ON public.api_credit_usage USING btree (provider, caller, reserved_at DESC);

CREATE INDEX api_credit_usage_provider_time ON public.api_credit_usage USING btree (provider, reserved_at DESC);

CREATE INDEX backtest_history_owner_symbol_idx ON public.backtest_history_datasets USING btree (user_id, symbol, created_at DESC);

CREATE INDEX idx_backtest_runs_user_status ON public.backtest_runs USING btree (user_id, status, created_at DESC);

CREATE INDEX idx_bot_config_change_log_config_time ON public.bot_config_change_log USING btree (config_id, changed_at DESC);

CREATE INDEX idx_bot_config_change_log_user_time ON public.bot_config_change_log USING btree (user_id, changed_at DESC);

CREATE INDEX idx_bot_configs_user_conn ON public.bot_configs USING btree (user_id, connection_id);

CREATE INDEX idx_bot_rec_created ON public.bot_recommendations USING btree (created_at DESC);

CREATE INDEX idx_bot_rec_status ON public.bot_recommendations USING btree (status) WHERE (status = 'pending'::text);

CREATE INDEX idx_bot_rec_user_bot ON public.bot_recommendations USING btree (user_id, bot_id);

CREATE INDEX idx_bot_rec_user_status ON public.bot_recommendations USING btree (user_id, status);

CREATE INDEX idx_bot_recs_dedup ON public.bot_recommendations USING btree (bot_id, review_type, status) WHERE (status = 'pending'::text);

CREATE INDEX idx_broker_conn_user_active ON public.broker_connections USING btree (user_id, is_active);

CREATE INDEX idx_broker_execution_ledger_unresolved ON public.broker_execution_ledger USING btree (user_id, bot_id, status, started_at DESC) WHERE (status = ANY (ARRAY['attempting'::text, 'uncertain'::text]));

CREATE INDEX idx_close_audit_log_position ON public.close_audit_log USING btree (position_id);

CREATE INDEX idx_close_audit_log_user_created ON public.close_audit_log USING btree (user_id, created_at DESC);

CREATE INDEX idx_config_backups_user ON public.config_backups USING btree (user_id, created_at DESC);

CREATE INDEX idx_config_presets_user ON public.config_presets USING btree (user_id);

CREATE INDEX idx_config_presets_user_id ON public.config_presets USING btree (user_id);

CREATE UNIQUE INDEX idx_config_presets_user_name ON public.config_presets USING btree (user_id, name);

CREATE INDEX idx_ict_entry_zone_authority_family_outcome ON public.ict_entry_zone_authority_observations USING btree (user_id, bot_id, setup_family, evidence_source, outcome_status, observed_at);

CREATE INDEX idx_ict_entry_zone_authority_pending ON public.ict_entry_zone_authority_observations USING btree (outcome_status, observed_at) WHERE (outcome_status = 'pending'::text);

CREATE INDEX idx_ict_entry_zone_authority_replay ON public.ict_entry_zone_authority_observations USING btree (replay_run_id) WHERE (evidence_source = 'retrospective_replay'::text);

CREATE INDEX idx_impulse_lifecycle_replay_summary ON public.impulse_entry_lifecycle_replays USING btree (user_id, bot_id, evidence_source, outcome, rescued_deeper_entry);

CREATE INDEX idx_impulse_confirmation_transition ON public.impulse_entry_lifecycle_transitions USING btree (lifecycle_id, event_type, created_at DESC) WHERE (event_type = ANY (ARRAY['trigger_revised'::text, 'trigger_locked'::text, 'confirmation_passed'::text]));

CREATE INDEX idx_impulse_entry_transition_history ON public.impulse_entry_lifecycle_transitions USING btree (lifecycle_id, to_revision);

CREATE INDEX idx_impulse_entry_lifecycle_impulse ON public.impulse_entry_lifecycles USING btree (user_id, bot_id, symbol, impulse_id);

CREATE INDEX idx_impulse_entry_lifecycle_monitor ON public.impulse_entry_lifecycles USING btree (user_id, bot_id, status, updated_at DESC);

CREATE UNIQUE INDEX idx_impulse_lifecycle_current_certificate ON public.impulse_lifecycle_enforcement_certificates USING btree (user_id, bot_id) WHERE is_current;

CREATE INDEX idx_kv_cache_expires_at ON public.kv_cache USING btree (expires_at);

CREATE INDEX manual_impulses_active_lookup ON public.manual_impulses USING btree (user_id, bot_id, status, expires_at);

CREATE UNIQUE INDEX manual_impulses_one_active_per_symbol ON public.manual_impulses USING btree (user_id, bot_id, symbol) WHERE (status = 'active'::text);

CREATE INDEX idx_optimizer_runs_user_started ON public.optimizer_runs USING btree (user_id, started_at DESC);

CREATE INDEX idx_paper_accounts_bot_id ON public.paper_accounts USING btree (user_id, bot_id);

CREATE INDEX idx_paper_positions_bot_id ON public.paper_positions USING btree (user_id, bot_id);

CREATE UNIQUE INDEX idx_paper_positions_candidate_id ON public.paper_positions USING btree (user_id, bot_id, candidate_id) WHERE (candidate_id IS NOT NULL);

CREATE UNIQUE INDEX idx_paper_positions_candidate_source ON public.paper_positions USING btree (user_id, bot_id, source_candidate_key) WHERE (source_candidate_key IS NOT NULL);

CREATE INDEX idx_paper_positions_cross_tf_evidence ON public.paper_positions USING btree (cross_tf_timeframe_evidence_id) WHERE (cross_tf_timeframe_evidence_id IS NOT NULL);

CREATE INDEX idx_paper_positions_frozen_strategy ON public.paper_positions USING btree (user_id, bot_id, frozen_strategy_hash) WHERE (frozen_strategy_hash IS NOT NULL);

CREATE INDEX idx_paper_positions_game_plan ON public.paper_positions USING btree (user_id, bot_id, game_plan_version);

CREATE UNIQUE INDEX idx_paper_positions_pending_source ON public.paper_positions USING btree (source_pending_order_id) WHERE (source_pending_order_id IS NOT NULL);

CREATE INDEX idx_paper_positions_style_base_policy ON public.paper_positions USING btree (user_id, bot_id, style_base_policy_hash) WHERE (style_base_policy_hash IS NOT NULL);

CREATE INDEX idx_paper_positions_style_policy ON public.paper_positions USING btree (user_id, bot_id, style_policy_hash) WHERE (style_policy_hash IS NOT NULL);

CREATE INDEX idx_paper_positions_user ON public.paper_positions USING btree (user_id, position_status);

CREATE INDEX idx_positions_canonical_dealing_range ON public.paper_positions USING btree (user_id, bot_id, canonical_dealing_range_timeframe, canonical_dealing_range_impulse_id) WHERE (canonical_dealing_range_impulse_id IS NOT NULL);

CREATE INDEX idx_positions_cross_tf_authority ON public.paper_positions USING btree (user_id, bot_id, cross_tf_effective_mode, cross_tf_entry_allowed) WHERE (cross_tf_entry_authority IS NOT NULL);

CREATE INDEX idx_positions_user_bot ON public.paper_positions USING btree (user_id, bot_id);

CREATE INDEX idx_positions_user_status ON public.paper_positions USING btree (user_id, position_status);

CREATE INDEX idx_paper_trade_history_bot_id ON public.paper_trade_history USING btree (user_id, bot_id);

CREATE UNIQUE INDEX idx_paper_trade_history_final_lifecycle ON public.paper_trade_history USING btree (user_id, bot_id, position_id) WHERE (close_reason <> 'partial_tp'::text);

CREATE INDEX idx_paper_trade_history_pending_source ON public.paper_trade_history USING btree (source_pending_order_id) WHERE (source_pending_order_id IS NOT NULL);

CREATE UNIQUE INDEX idx_paper_trade_history_source_position ON public.paper_trade_history USING btree (source_position_row_id) WHERE (source_position_row_id IS NOT NULL);

CREATE INDEX idx_paper_trade_history_user ON public.paper_trade_history USING btree (user_id, created_at DESC);

CREATE INDEX idx_trade_history_user_symbol ON public.paper_trade_history USING btree (user_id, symbol);

CREATE INDEX idx_pending_canonical_dealing_range ON public.pending_orders USING btree (user_id, bot_id, canonical_dealing_range_timeframe, canonical_dealing_range_impulse_id) WHERE (canonical_dealing_range_impulse_id IS NOT NULL);

CREATE INDEX idx_pending_cross_tf_authority ON public.pending_orders USING btree (user_id, bot_id, cross_tf_effective_mode, cross_tf_entry_allowed) WHERE (cross_tf_entry_authority IS NOT NULL);

CREATE INDEX idx_pending_orders_active ON public.pending_orders USING btree (user_id, bot_id, status) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX idx_pending_orders_candidate_active ON public.pending_orders USING btree (user_id, bot_id, candidate_id) WHERE ((candidate_id IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'awaiting_confirmation'::text])));

CREATE INDEX idx_pending_orders_confirmation_status ON public.pending_orders USING btree (user_id, bot_id, status) WHERE (status = ANY (ARRAY['pending'::text, 'awaiting_confirmation'::text]));

CREATE INDEX idx_pending_orders_cross_tf_evidence ON public.pending_orders USING btree (cross_tf_timeframe_evidence_id) WHERE (cross_tf_timeframe_evidence_id IS NOT NULL);

CREATE INDEX idx_pending_orders_expiry ON public.pending_orders USING btree (expires_at, status) WHERE (status = 'pending'::text);

CREATE INDEX idx_pending_orders_frozen_strategy ON public.pending_orders USING btree (user_id, bot_id, frozen_strategy_hash) WHERE (frozen_strategy_hash IS NOT NULL);

CREATE INDEX idx_pending_orders_game_plan ON public.pending_orders USING btree (user_id, bot_id, game_plan_version);

CREATE INDEX idx_pending_orders_style_base_policy ON public.pending_orders USING btree (user_id, bot_id, style_base_policy_hash) WHERE (style_base_policy_hash IS NOT NULL);

CREATE INDEX idx_pending_orders_style_policy ON public.pending_orders USING btree (user_id, bot_id, style_policy_hash) WHERE (style_policy_hash IS NOT NULL);

CREATE INDEX idx_pending_orders_superseded_candidate ON public.pending_orders USING btree (user_id, bot_id, superseded_candidate_id) WHERE (superseded_candidate_id IS NOT NULL);

CREATE INDEX idx_pending_orders_symbol ON public.pending_orders USING btree (user_id, symbol, direction, status) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX idx_pending_orders_unique_active ON public.pending_orders USING btree (user_id, bot_id, symbol, direction) WHERE (status = ANY (ARRAY['pending'::text, 'awaiting_confirmation'::text]));

CREATE INDEX idx_pending_post_confirmation_wait ON public.pending_orders USING btree (user_id, bot_id, status) WHERE ((status = 'awaiting_confirmation'::text) AND ((post_confirmation_entry ->> 'state'::text) = 'awaiting_retracement'::text));

CREATE INDEX idx_prop_firm_daily_state_config_day ON public.prop_firm_daily_state USING btree (config_id, trading_day DESC);

CREATE INDEX idx_prop_firm_events_config_time ON public.prop_firm_events USING btree (config_id, created_at DESC);

CREATE INDEX idx_prop_firm_events_severity ON public.prop_firm_events USING btree (severity, created_at DESC);

CREATE INDEX idx_rejected_setups_normalized_gates ON public.rejected_setups USING gin (normalized_gates);

CREATE INDEX idx_rejected_setups_opportunity_recent ON public.rejected_setups USING btree (user_id, bot_id, opportunity_key, rejected_at DESC);

CREATE INDEX idx_rejected_setups_pending_outcome ON public.rejected_setups USING btree (outcome_status, rejected_at) WHERE (outcome_status = 'pending'::text);

CREATE INDEX idx_rejected_setups_symbol ON public.rejected_setups USING btree (symbol, rejected_at DESC);

CREATE INDEX idx_rejected_setups_user_recent ON public.rejected_setups USING btree (user_id, bot_id, rejected_at DESC);

CREATE INDEX scan_candle_snapshots_lookup_idx ON public.scan_candle_snapshots USING btree (user_id, symbol, timeframe, observed_at DESC);

CREATE INDEX scan_candle_snapshots_retention_idx ON public.scan_candle_snapshots USING btree (created_at);

CREATE INDEX idx_scan_history_created ON public.scan_history USING btree (created_at DESC);

CREATE INDEX idx_scan_history_user ON public.scan_history USING btree (user_id);

CREATE INDEX idx_scan_logs_user_bot_created ON public.scan_logs USING btree (user_id, bot_id, created_at DESC);

CREATE INDEX idx_scan_logs_user_date ON public.scan_logs USING btree (user_id, scanned_at DESC);

CREATE INDEX idx_scanner_auth_failures_function_time ON public.scanner_authorization_failures USING btree (function_name, occurred_at DESC);

CREATE INDEX idx_scanner_operation_runs_incomplete ON public.scanner_operation_runs USING btree (heartbeat_at) WHERE (status = ANY (ARRAY['invoked'::text, 'running'::text]));

CREATE INDEX idx_scanner_operation_runs_user_task ON public.scanner_operation_runs USING btree (user_id, bot_id, function_name, operation, invoked_at DESC);

CREATE UNIQUE INDEX idx_scanner_alerts_one_active ON public.scanner_operational_alerts USING btree (user_id, bot_id, alert_type, dedupe_key) WHERE (status = 'active'::text);

CREATE INDEX idx_scanner_alerts_user_status ON public.scanner_operational_alerts USING btree (user_id, bot_id, status, severity, last_detected_at DESC);

CREATE INDEX idx_setup_lifecycle_events_candidate ON public.setup_lifecycle_events USING btree (user_id, bot_id, candidate_id, created_at);

CREATE INDEX idx_setup_lifecycle_events_setup ON public.setup_lifecycle_events USING btree (staged_setup_id, created_at);

CREATE INDEX idx_staged_canonical_dealing_range ON public.staged_setups USING btree (user_id, bot_id, canonical_dealing_range_timeframe, canonical_dealing_range_impulse_id) WHERE (canonical_dealing_range_impulse_id IS NOT NULL);

CREATE INDEX idx_staged_cross_tf_authority ON public.staged_setups USING btree (user_id, bot_id, cross_tf_effective_mode, cross_tf_entry_allowed) WHERE (cross_tf_entry_authority IS NOT NULL);

CREATE INDEX idx_staged_setups_active ON public.staged_setups USING btree (user_id, bot_id, status) WHERE (status = 'watching'::text);

CREATE UNIQUE INDEX idx_staged_setups_candidate_active ON public.staged_setups USING btree (user_id, bot_id, candidate_id) WHERE (status = ANY (ARRAY['watching'::text, 'qualified'::text, 'pending'::text, 'awaiting_confirmation'::text]));

CREATE INDEX idx_staged_setups_cross_tf_evidence ON public.staged_setups USING btree (cross_tf_timeframe_evidence_id) WHERE (cross_tf_timeframe_evidence_id IS NOT NULL);

CREATE INDEX idx_staged_setups_execution_visibility ON public.staged_setups USING btree (user_id, bot_id, execution_eligible, status);

CREATE INDEX idx_staged_setups_frozen_strategy ON public.staged_setups USING btree (user_id, bot_id, frozen_strategy_hash) WHERE (frozen_strategy_hash IS NOT NULL);

CREATE INDEX idx_staged_setups_lifecycle_phase ON public.staged_setups USING btree (user_id, bot_id, lifecycle_phase, updated_at DESC);

CREATE INDEX idx_staged_setups_observation_parent ON public.staged_setups USING btree (observation_parent_id) WHERE (observation_parent_id IS NOT NULL);

CREATE INDEX idx_staged_setups_style_base_policy ON public.staged_setups USING btree (user_id, bot_id, style_base_policy_hash) WHERE (style_base_policy_hash IS NOT NULL);

CREATE INDEX idx_staged_setups_style_policy ON public.staged_setups USING btree (user_id, bot_id, style_policy_hash) WHERE (style_policy_hash IS NOT NULL);

CREATE INDEX idx_staged_setups_symbol ON public.staged_setups USING btree (user_id, symbol, direction, status) WHERE (status = 'watching'::text);

CREATE UNIQUE INDEX idx_staged_setups_unique_active ON public.staged_setups USING btree (user_id, bot_id, symbol, direction) WHERE (status = ANY (ARRAY['watching'::text, 'qualified'::text, 'pending'::text, 'awaiting_confirmation'::text]));

CREATE INDEX stop_policy_observations_lookup_idx ON public.stop_policy_observations USING btree (user_id, bot_id, observed_at DESC);

CREATE INDEX stop_policy_observations_retention_idx ON public.stop_policy_observations USING btree (created_at);

CREATE INDEX idx_strategy_activation_events_history ON public.strategy_activation_events USING btree (activation_id, revision, created_at);

CREATE INDEX idx_strategy_activation_events_owner ON public.strategy_activation_events USING btree (user_id, bot_id, feature_key, created_at DESC);

CREATE UNIQUE INDEX idx_strategy_activation_identity ON public.strategy_activation_registry USING btree (user_id, bot_id, feature_key, variant_key, activation_scope_hash);

CREATE INDEX idx_strategy_activation_status ON public.strategy_activation_registry USING btree (user_id, bot_id, authority_stage, runtime_scope);

CREATE UNIQUE INDEX idx_strategy_evidence_certificate_hash ON public.strategy_evidence_certificates USING btree (user_id, bot_id, feature_key, variant_key, activation_scope_hash, certificate_hash);

CREATE INDEX idx_strategy_evidence_history ON public.strategy_evidence_certificates USING btree (user_id, bot_id, feature_key, generated_at DESC);

CREATE UNIQUE INDEX idx_strategy_evidence_one_current ON public.strategy_evidence_certificates USING btree (user_id, bot_id, feature_key, variant_key, activation_scope_hash) WHERE is_current;

CREATE INDEX telegram_notification_claims_expires_at_idx ON public.telegram_notification_claims USING btree (expires_at);

CREATE INDEX idx_trade_archive_user ON public.trade_archive USING btree (user_id, closed_at DESC);

CREATE INDEX idx_trade_post_mortems_position ON public.trade_post_mortems USING btree (position_id);

CREATE INDEX idx_trade_reasonings_position ON public.trade_reasonings USING btree (position_id);

CREATE INDEX idx_trades_user_entry ON public.trades USING btree (user_id, entry_time DESC);

CREATE INDEX idx_zone_shadow_candidate_model ON public.zone_candidate_shadow_observations USING btree (user_id, bot_id, trading_style, candidate_model_version, candidate_model_rank, observed_at DESC) WHERE (candidate_model_version IS NOT NULL);

CREATE INDEX idx_zone_shadow_cross_tf_disagreement ON public.zone_candidate_shadow_observations USING btree (user_id, bot_id, evidence_source, cross_tf_disagreed, outcome_status) WHERE (cross_tf_policy_version IS NOT NULL);

CREATE INDEX idx_zone_shadow_pending_outcome ON public.zone_candidate_shadow_observations USING btree (outcome_status, observed_at) WHERE (outcome_status = 'pending'::text);

CREATE INDEX idx_zone_shadow_replay_run ON public.zone_candidate_shadow_observations USING btree (user_id, replay_run_id, symbol, observed_at) WHERE (evidence_source = 'retrospective_replay'::text);

CREATE INDEX idx_zone_shadow_style_evidence ON public.zone_candidate_shadow_observations USING btree (user_id, trading_style, symbol, ranking_disagreed, outcome_status);

CREATE INDEX idx_zone_shadow_timeframe_lineage ON public.zone_candidate_shadow_observations USING btree (user_id, bot_id, trading_style, timeframe_relationship, observed_at DESC) WHERE (timeframe_relationship IS NOT NULL);

CREATE INDEX idx_zone_shadow_user_recent ON public.zone_candidate_shadow_observations USING btree (user_id, bot_id, observed_at DESC);

CREATE INDEX zone_tf_evidence_canonical_parity_idx ON public.zone_timeframe_evidence USING btree (user_id, canonical_detector_version, canonical_parity, observed_at DESC) WHERE (canonical_detector_version IS NOT NULL);

CREATE INDEX zone_tf_evidence_cycle_idx ON public.zone_timeframe_evidence USING btree (scan_cycle_id);

CREATE INDEX zone_tf_evidence_event_retention_idx ON public.zone_timeframe_evidence USING btree (event_linked, observed_at);

CREATE UNIQUE INDEX zone_tf_evidence_identity_uidx ON public.zone_timeframe_evidence USING btree (user_id, bot_id, scan_cycle_id, symbol, direction, contract_version, evidence_source, pending_order_id, confirmation_attempt);

CREATE INDEX zone_tf_evidence_pending_attempt_idx ON public.zone_timeframe_evidence USING btree (user_id, bot_id, pending_order_id, confirmation_attempt) WHERE (evidence_source = 'confirmation'::text);

CREATE INDEX zone_tf_evidence_replay_idx ON public.zone_timeframe_evidence USING btree (replay_run_id);

CREATE INDEX zone_tf_evidence_retention_idx ON public.zone_timeframe_evidence USING btree (observed_at);

CREATE INDEX zone_tf_evidence_symbol_idx ON public.zone_timeframe_evidence USING btree (user_id, symbol, observed_at DESC);

CREATE INDEX zone_tf_evidence_summary_symbol_idx ON public.zone_timeframe_evidence_summary USING btree (user_id, symbol, observed_at DESC);


-- ========================================================================
-- FUNCTIONS  (67 statements)
-- ========================================================================

CREATE OR REPLACE FUNCTION public.activate_direction_verdict(p_user_id uuid, p_bot_id text, p_symbol text, p_verdict_version uuid, p_game_plan_id uuid, p_game_plan_version uuid, p_verdict text, p_confidence numeric, p_agreement numeric, p_should_block boolean, p_block_reason text, p_score_adjustment numeric, p_verdict_json jsonb, p_source_candle_timestamp timestamp with time zone, p_evaluated_at timestamp with time zone, p_expires_at timestamp with time zone, p_scan_cycle_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.active_direction_verdicts%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
     OR NULLIF(p_bot_id, '') IS NULL
     OR NULLIF(p_symbol, '') IS NULL
     OR p_verdict_version IS NULL THEN
    RAISE EXCEPTION 'Direction Verdict user, bot, symbol and version are required';
  END IF;
  IF p_verdict NOT IN ('long', 'short', 'neutral') THEN
    RAISE EXCEPTION 'Invalid Direction Verdict: %', p_verdict;
  END IF;
  IF p_expires_at <= p_evaluated_at THEN
    RAISE EXCEPTION 'Direction Verdict expiry must follow evaluation';
  END IF;

  UPDATE public.active_direction_verdicts
     SET is_active = false,
         superseded_at = now()
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND symbol = p_symbol
     AND is_active;

  INSERT INTO public.active_direction_verdicts (
    verdict_version, user_id, bot_id, symbol, game_plan_id, game_plan_version,
    verdict, confidence, agreement, should_block, block_reason, score_adjustment,
    verdict_json, source_candle_timestamp, evaluated_at, expires_at, scan_cycle_id
  ) VALUES (
    p_verdict_version, p_user_id, p_bot_id, p_symbol, p_game_plan_id, p_game_plan_version,
    p_verdict,
    LEAST(100, GREATEST(0, COALESCE(p_confidence, 0))),
    LEAST(1, GREATEST(0, COALESCE(p_agreement, 0))),
    COALESCE(p_should_block, true),
    p_block_reason,
    COALESCE(p_score_adjustment, 0),
    COALESCE(p_verdict_json, '{}'::JSONB),
    p_source_candle_timestamp, p_evaluated_at, p_expires_at, p_scan_cycle_id
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('activated', true, 'row', to_jsonb(v_row));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.activate_game_plan_version(p_user_id uuid, p_bot_id text, p_plan_version uuid, p_source text, p_config_snapshot jsonb, p_market_data_snapshot jsonb, p_session_plan jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session TEXT := p_session_plan->>'session';
  v_generated_at TIMESTAMPTZ :=
    COALESCE(NULLIF(p_session_plan->>'generatedAt', '')::TIMESTAMPTZ, now());
  v_rows JSONB;
BEGIN
  IF p_user_id IS NULL
     OR NULLIF(p_bot_id, '') IS NULL
     OR p_plan_version IS NULL THEN
    RAISE EXCEPTION 'Gameplan user, bot and version are required';
  END IF;

  IF p_source NOT IN ('automatic_scan', 'manual_refresh') THEN
    RAISE EXCEPTION 'Invalid Gameplan generation source: %', p_source;
  END IF;

  IF v_session NOT IN ('Asian', 'London', 'New York') THEN
    RAISE EXCEPTION 'Invalid Gameplan session: %', v_session;
  END IF;

  IF jsonb_typeof(p_session_plan->'plans') <> 'array'
     OR jsonb_array_length(p_session_plan->'plans') = 0 THEN
    RAISE EXCEPTION 'A Gameplan version requires at least one instrument plan';
  END IF;

  -- A refresh is atomic: no reader can observe half of the new version.
  UPDATE public.active_game_plans
     SET is_active = false,
         superseded_at = now()
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND is_active;

  INSERT INTO public.active_game_plans (
    user_id,
    bot_id,
    plan_version,
    symbol,
    session,
    bias,
    bias_confidence,
    v2_conviction,
    state,
    state_reason,
    generated_at,
    expires_at,
    invalidation_conditions,
    source_candle_timestamps,
    plan_json,
    focus_pairs,
    news_events,
    news_impacts,
    summary,
    generation_source,
    contract_version,
    config_snapshot,
    market_data_snapshot
  )
  SELECT
    p_user_id,
    p_bot_id,
    p_plan_version,
    plan->>'symbol',
    v_session,
    plan->>'bias',
    COALESCE(NULLIF(plan->>'biasConfidence', '')::NUMERIC, 0),
    COALESCE(plan->'conviction', '{}'::JSONB),
    COALESCE(
      NULLIF(plan->>'state', ''),
      CASE WHEN COALESCE((plan->>'tradeable')::BOOLEAN, false)
        THEN 'tradeable' ELSE 'skip' END
    ),
    COALESCE(plan->>'stateReason', plan->>'skipReason'),
    v_generated_at,
    COALESCE(
      NULLIF(plan->>'expiresAt', '')::TIMESTAMPTZ,
      v_generated_at + INTERVAL '4 hours'
    ),
    COALESCE(plan->'invalidationConditions', '[]'::JSONB),
    COALESCE(plan->'sourceCandleTimestamps', '{}'::JSONB),
    plan,
    COALESCE(p_session_plan->'focusPairs', '[]'::JSONB),
    COALESCE(p_session_plan->'newsEvents', '[]'::JSONB),
    COALESCE(p_session_plan->'newsImpacts', '[]'::JSONB),
    COALESCE(p_session_plan->>'summary', ''),
    p_source,
    COALESCE(NULLIF(p_session_plan->>'contractVersion', ''), 'phase3.v1'),
    COALESCE(p_config_snapshot, '{}'::JSONB),
    COALESCE(p_market_data_snapshot, '{}'::JSONB)
  FROM jsonb_array_elements(p_session_plan->'plans') AS item(plan);

  SELECT jsonb_agg(
    jsonb_build_object('id', id, 'symbol', symbol)
    ORDER BY symbol
  )
    INTO v_rows
    FROM public.active_game_plans
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND plan_version = p_plan_version;

  RETURN jsonb_build_object(
    'plan_version', p_plan_version,
    'activated', true,
    'rows', COALESCE(v_rows, '[]'::JSONB)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.advance_impulse_entry_lifecycle(p_lifecycle_id uuid, p_expected_revision integer, p_event_type text, p_reason text, p_event_payload jsonb, p_next_lifecycle jsonb)
 RETURNS impulse_entry_lifecycles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current public.impulse_entry_lifecycles;
  v_updated public.impulse_entry_lifecycles;
  v_next_revision INTEGER;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  SELECT * INTO v_current FROM public.impulse_entry_lifecycles
    WHERE id = p_lifecycle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle not found'; END IF;
  IF v_current.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale lifecycle revision: expected %, current %',
      p_expected_revision, v_current.revision;
  END IF;
  v_next_revision := p_expected_revision + 1;
  IF p_next_lifecycle ->> 'contractVersion' <> 'impulse-entry-lifecycle.v1'
    OR (p_next_lifecycle ->> 'revision')::INTEGER <> v_next_revision
    OR p_next_lifecycle #>> '{impulse,id}' <> v_current.impulse_id
    OR p_next_lifecycle #>> '{impulse,direction}' <> v_current.direction THEN
    RAISE EXCEPTION 'invalid next lifecycle contract';
  END IF;

  UPDATE public.impulse_entry_lifecycles SET
    mode = p_next_lifecycle ->> 'mode',
    status = p_next_lifecycle ->> 'status',
    active_candidate_id = p_next_lifecycle ->> 'activeCandidateId',
    revision = v_next_revision,
    lifecycle = p_next_lifecycle,
    updated_at = now()
  WHERE id = p_lifecycle_id RETURNING * INTO v_updated;

  INSERT INTO public.impulse_entry_lifecycle_transitions (
    lifecycle_id, user_id, from_revision, to_revision, event_type,
    from_candidate_id, to_candidate_id, reason, event_payload, lifecycle_snapshot
  ) VALUES (
    v_current.id, v_current.user_id, p_expected_revision, v_next_revision,
    p_event_type, v_current.active_candidate_id, v_updated.active_candidate_id,
    p_reason, COALESCE(p_event_payload, '{}'::JSONB), p_next_lifecycle
  );
  RETURN v_updated;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.allocate_zone_confirmation_evidence_attempt(p_user_id uuid, p_bot_id text, p_pending_order_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  allocated integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  SELECT COALESCE(MAX(confirmation_attempt), 0) + 1
  INTO allocated
  FROM public.zone_timeframe_evidence
  WHERE user_id = p_user_id
    AND bot_id = p_bot_id
    AND pending_order_id = p_pending_order_id
    AND evidence_source = 'confirmation';

  INSERT INTO public.zone_confirmation_evidence_counters (
    user_id,
    bot_id,
    pending_order_id,
    last_attempt,
    updated_at
  )
  VALUES (
    p_user_id,
    p_bot_id,
    p_pending_order_id,
    allocated,
    now()
  )
  ON CONFLICT (user_id, bot_id, pending_order_id)
  DO UPDATE SET
    last_attempt =
      public.zone_confirmation_evidence_counters.last_attempt + 1,
    updated_at = now()
  RETURNING last_attempt INTO allocated;

  RETURN allocated;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.attach_impulse_entry_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lifecycle JSONB;
  v_id UUID;
  v_created BOOLEAN := false;
  v_setup_id TEXT;
BEGIN
  v_lifecycle := NEW.frozen_strategy_context #> '{crossTimeframeContext,impulseEntryLifecycle}';
  IF v_lifecycle IS NULL OR v_lifecycle ->> 'mode' = 'off' THEN RETURN NEW; END IF;
  v_setup_id := NEW.frozen_strategy_context ->> 'setupId';
  IF v_setup_id IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.impulse_entry_lifecycles (
    user_id, bot_id, setup_id, symbol, direction, impulse_id, impulse_timeframe,
    mode, status, active_candidate_id, revision, lifecycle
  ) VALUES (
    NEW.user_id, COALESCE(NEW.bot_id, 'smc'), v_setup_id, NEW.symbol, NEW.direction,
    v_lifecycle #>> '{impulse,id}', v_lifecycle #>> '{impulse,timeframe}',
    v_lifecycle ->> 'mode', v_lifecycle ->> 'status',
    v_lifecycle ->> 'activeCandidateId',
    (v_lifecycle ->> 'revision')::INTEGER, v_lifecycle
  ) ON CONFLICT (user_id, bot_id, setup_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    v_created := true;
  ELSE
    SELECT id INTO v_id FROM public.impulse_entry_lifecycles
      WHERE user_id = NEW.user_id AND bot_id = COALESCE(NEW.bot_id, 'smc')
        AND setup_id = v_setup_id;
  END IF;
  NEW.impulse_entry_lifecycle_id := v_id;
  IF v_created THEN
    INSERT INTO public.impulse_entry_lifecycle_transitions (
      lifecycle_id, user_id, from_revision, to_revision, event_type,
      to_candidate_id, reason, lifecycle_snapshot
    ) VALUES (
      v_id, NEW.user_id, 0, 1, 'created',
      v_lifecycle ->> 'activeCandidateId',
      COALESCE(v_lifecycle ->> 'lastTransitionReason', 'Lifecycle created'),
      v_lifecycle
    );
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.audit_bot_config_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.config_json END;
  v_new JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.config_json END;
  v_user_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  v_config_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  v_connection_id UUID := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.connection_id
    ELSE NEW.connection_id
  END;
BEGIN
  IF TG_OP = 'UPDATE' AND v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.bot_config_change_log (
    user_id,
    config_id,
    connection_id,
    change_type,
    previous_config,
    next_config,
    previous_hash,
    next_hash,
    changed_by
  ) VALUES (
    v_user_id,
    v_config_id,
    v_connection_id,
    lower(TG_OP),
    v_old,
    v_new,
    CASE WHEN v_old IS NULL THEN NULL ELSE md5(v_old::TEXT) END,
    CASE WHEN v_new IS NULL THEN NULL ELSE md5(v_new::TEXT) END,
    auth.uid()
  );

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.audit_staged_setup_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR
     NEW.status IS DISTINCT FROM OLD.status OR
     NEW.lifecycle_phase IS DISTINCT FROM OLD.lifecycle_phase OR
     NEW.lifecycle_reason_code IS DISTINCT FROM OLD.lifecycle_reason_code THEN
    INSERT INTO public.setup_lifecycle_events (
      staged_setup_id,
      candidate_id,
      user_id,
      bot_id,
      symbol,
      direction,
      from_status,
      to_status,
      reason,
      reason_code,
      lifecycle_phase,
      evidence
    ) VALUES (
      NEW.id,
      NEW.candidate_id,
      NEW.user_id,
      NEW.bot_id,
      NEW.symbol,
      NEW.direction,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
      NEW.status,
      COALESCE(
        NEW.lifecycle_reason,
        NEW.invalidation_reason,
        NEW.promotion_reason
      ),
      COALESCE(NEW.lifecycle_reason_code, 'legacy_transition'),
      NEW.lifecycle_phase,
      jsonb_strip_nulls(jsonb_build_object(
        'lifecycleVersion', NEW.lifecycle_version,
        'lifecyclePhase', NEW.lifecycle_phase,
        'lifecycleEvidence', NEW.lifecycle_evidence,
        'gamePlanId', NEW.game_plan_id,
        'gamePlanVersion', NEW.game_plan_version,
        'directionVerdictId', NEW.direction_verdict_id,
        'directionVerdict', NEW.direction_verdict,
        'thesisVersion', NEW.thesis_version,
        'originatingZone', NEW.originating_zone,
        'confirmationMethod', NEW.confirmation_method,
        'confirmationConfig', NEW.confirmation_config,
        'authorizationResult', NEW.authorization_result,
        'pendingOrderId', NEW.pending_order_id,
        'positionId', NEW.position_id
      ))
    );
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.broker_close_has_terminal_proof(p_status text, p_request_payload jsonb, p_response_payload jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    p_status = 'succeeded'
      AND p_response_payload->'close_confirmed' = 'true'::JSONB
      AND NULLIF(
        btrim(COALESCE(p_request_payload->>'brokerPositionId', '')),
        ''
      ) IS NOT NULL
      AND btrim(COALESCE(p_response_payload->>'broker_position_id', '')) =
        btrim(p_request_payload->>'brokerPositionId'),
    false
  );
$function$
;

CREATE OR REPLACE FUNCTION public.broker_close_resolves_open(p_open_position_id text, p_open_completed_at timestamp with time zone, p_close_status text, p_close_request_payload jsonb, p_close_response_payload jsonb, p_close_started_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    NULLIF(btrim(COALESCE(p_open_position_id, '')), '') IS NOT NULL
      AND p_close_started_at > p_open_completed_at
      AND public.broker_close_has_terminal_proof(
        p_close_status,
        p_close_request_payload,
        p_close_response_payload
      )
      AND btrim(p_close_request_payload->>'brokerPositionId') =
        btrim(p_open_position_id),
    false
  );
$function$
;

CREATE OR REPLACE FUNCTION public.broker_connection_effective_account_identity(p_broker_type text, p_api_key text, p_account_id text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN lower(COALESCE(p_broker_type, '')) = 'metaapi'
      AND COALESCE(p_account_id, '') LIKE 'eyJ%'
      AND COALESCE(p_api_key, '') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN lower(btrim(p_api_key))
    WHEN lower(COALESCE(p_broker_type, '')) = 'metaapi'
      THEN lower(btrim(COALESCE(p_account_id, '')))
    ELSE btrim(COALESCE(p_account_id, ''))
  END;
$function$
;

CREATE OR REPLACE FUNCTION public.broker_connection_has_unresolved_managed_exposure(p_connection_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.paper_positions position
    CROSS JOIN LATERAL public.paper_position_broker_close_requirements(
      position.user_id,
      position.bot_id,
      position.position_id
    ) requirements
    WHERE position.user_id = p_user_id
      AND position.position_status IN ('open', 'pending')
      AND p_connection_id = ANY(
        requirements.missing_close_connection_ids
      )
  ) OR EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT open_ledger.bot_id
      FROM public.broker_execution_ledger open_ledger
      WHERE open_ledger.user_id = p_user_id
        AND open_ledger.broker_connection_id = p_connection_id
        AND open_ledger.action = 'open'
    ) bot_scope
    CROSS JOIN LATERAL public.list_unresolved_broker_open_orphans(
      p_user_id,
      bot_scope.bot_id,
      2147483647
    ) orphan
    WHERE orphan.broker_connection_id = p_connection_id
  );
$function$
;

CREATE OR REPLACE FUNCTION public.broker_connection_mutation_preflight(p_connection_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_exists BOOLEAN;
  v_unresolved BOOLEAN;
  v_has_history BOOLEAN;
BEGIN
  IF auth.role() <> 'service_role'
     AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'forbidden',
      'unresolved_exposure', true,
      'has_history', false
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.broker_connections connection
    WHERE connection.id = p_connection_id
      AND connection.user_id = p_user_id
  ) INTO v_exists;

  IF NOT v_exists THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'connection_missing',
      'unresolved_exposure', false,
      'has_history', false
    );
  END IF;

  v_unresolved := public.broker_connection_has_unresolved_managed_exposure(
    p_connection_id,
    p_user_id
  );

  SELECT EXISTS (
    SELECT 1
    FROM public.broker_execution_ledger ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.broker_connection_id = p_connection_id
  ) INTO v_has_history;

  RETURN jsonb_build_object(
    'allowed', NOT v_unresolved,
    'code', CASE WHEN v_unresolved
      THEN 'managed_exposure_unresolved'
      ELSE 'allowed'
    END,
    'unresolved_exposure', v_unresolved,
    'has_history', v_has_history
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.broker_open_exact_position_id(p_broker_type text, p_response_payload jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT NULLIF(
    btrim(COALESCE(
      p_response_payload->>'broker_position_id',
      p_response_payload#>>'{data,broker_position_id}',
      CASE lower(COALESCE(p_broker_type, ''))
        WHEN 'metaapi' THEN COALESCE(
          p_response_payload->>'positionId',
          p_response_payload#>>'{data,positionId}'
        )
        WHEN 'oanda' THEN COALESCE(
          p_response_payload#>>'{orderFillTransaction,tradeOpened,tradeID}',
          p_response_payload#>>'{data,orderFillTransaction,tradeOpened,tradeID}'
        )
        ELSE COALESCE(
          p_response_payload->>'positionId',
          p_response_payload#>>'{data,positionId}',
          p_response_payload#>>'{orderFillTransaction,tradeOpened,tradeID}',
          p_response_payload#>>'{data,orderFillTransaction,tradeOpened,tradeID}'
        )
      END,
      ''
    )),
    ''
  );
$function$
;

CREATE OR REPLACE FUNCTION public.claim_broker_execution(p_user_id uuid, p_bot_id text, p_position_id text, p_broker_connection_id uuid, p_action text, p_route text, p_request_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
  v_row public.broker_execution_ledger%ROWTYPE;
  v_open_attempt public.broker_execution_ledger%ROWTYPE;
  v_connection public.broker_connections%ROWTYPE;
  v_exact_open_position_id TEXT;
BEGIN
  IF p_action = 'close' THEN
    IF NULLIF(
      btrim(COALESCE(p_request_payload->>'brokerPositionId', '')),
      ''
    ) IS NULL THEN
      RETURN jsonb_build_object(
        'claimed', false,
        'code', 'broker_position_identity_unavailable',
        'reason', 'Broker close refused because its exact broker position identifier was not supplied'
      );
    END IF;

    SELECT *
      INTO v_connection
      FROM public.broker_connections connection
     WHERE connection.id = p_broker_connection_id
       AND connection.user_id = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'claimed', false,
        'code', 'broker_connection_missing',
        'reason', 'Broker close refused because its connection is unavailable'
      );
    END IF;

    IF lower(COALESCE(p_request_payload->>'observedAbsent', '')) = 'true' THEN
      RETURN jsonb_build_object(
        'claimed', false,
        'code', 'observed_absence_not_terminal_proof',
        'reason', 'An empty broker inventory snapshot cannot prove that a late open did not execute'
      );
    END IF;

    SELECT *
      INTO v_open_attempt
      FROM public.broker_execution_ledger
     WHERE user_id = p_user_id
       AND bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
       AND position_id = p_position_id
       AND broker_connection_id = p_broker_connection_id
       AND action = 'open'
     FOR UPDATE;

    IF FOUND THEN
      v_exact_open_position_id := public.broker_open_exact_position_id(
        v_connection.broker_type,
        v_open_attempt.response_payload
      );

      IF v_open_attempt.status IN ('succeeded', 'attempting', 'uncertain')
         AND v_exact_open_position_id IS NOT NULL
         AND v_exact_open_position_id IS DISTINCT FROM
           btrim(p_request_payload->>'brokerPositionId') THEN
        RETURN jsonb_build_object(
          'claimed', false,
          'code', 'broker_position_identity_changed',
          'reason', 'Broker close refused because its position identifier does not match the durable open'
        );
      END IF;

      IF v_open_attempt.status = 'attempting'
         AND v_open_attempt.updated_at > now() - interval '2 minutes' THEN
        RETURN jsonb_build_object(
          'claimed', false,
          'code', 'open_execution_in_flight',
          'ledger_id', v_open_attempt.id,
          'status', v_open_attempt.status,
          'reason', 'Broker close must wait for the in-flight open attempt to settle'
        );
      END IF;

      IF v_open_attempt.status = 'attempting' THEN
        UPDATE public.broker_execution_ledger
           SET status = 'uncertain',
               claim_token = gen_random_uuid(),
               last_error = COALESCE(
                 last_error,
                 'Open claim lease expired before completion; broker reconciliation required'
               ),
               updated_at = now()
         WHERE id = v_open_attempt.id
           AND status = 'attempting';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.broker_execution_ledger (
    user_id,
    bot_id,
    position_id,
    broker_connection_id,
    action,
    route,
    request_payload
  ) VALUES (
    p_user_id,
    COALESCE(NULLIF(p_bot_id, ''), 'smc'),
    p_position_id,
    p_broker_connection_id,
    p_action,
    p_route,
    COALESCE(p_request_payload, '{}'::JSONB)
  )
  ON CONFLICT ON CONSTRAINT broker_execution_ledger_unique DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    SELECT *
      INTO v_row
      FROM public.broker_execution_ledger
     WHERE id = v_id;

    RETURN jsonb_build_object(
      'claimed', true,
      'code', 'claimed',
      'ledger_id', v_row.id,
      'claim_token', v_row.claim_token,
      'status', v_row.status
    );
  END IF;

  SELECT *
    INTO v_row
    FROM public.broker_execution_ledger
   WHERE user_id = p_user_id
     AND bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
     AND position_id = p_position_id
     AND broker_connection_id = p_broker_connection_id
     AND action = p_action
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'code', 'claim_missing',
      'reason', 'Execution claim could not be created or found'
    );
  END IF;

  IF p_action = 'close'
     AND v_row.action = 'close'
     AND (
       (v_row.status IN ('rejected', 'uncertain')
         AND v_row.updated_at <= now() - interval '30 seconds')
       OR
       (v_row.status = 'attempting'
         AND v_row.updated_at <= now() - interval '2 minutes')
       OR
       (v_row.status = 'succeeded'
         AND (
           NOT public.broker_close_has_terminal_proof(
             v_row.status,
             v_row.request_payload,
             v_row.response_payload
           )
           OR btrim(v_row.request_payload->>'brokerPositionId') IS DISTINCT FROM
             btrim(p_request_payload->>'brokerPositionId')
           OR EXISTS (
             SELECT 1
             FROM public.broker_execution_ledger later_open
             WHERE later_open.user_id = p_user_id
               AND later_open.bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
               AND later_open.position_id = p_position_id
               AND later_open.broker_connection_id = p_broker_connection_id
               AND later_open.action = 'open'
               AND later_open.updated_at >= v_row.updated_at
           )
         ))
     ) THEN
    UPDATE public.broker_execution_ledger
       SET status = 'attempting',
           claim_token = gen_random_uuid(),
           attempt_count = attempt_count + 1,
           route = p_route,
           request_payload = COALESCE(p_request_payload, '{}'::JSONB),
           response_payload = NULL,
           broker_order_id = NULL,
           last_error = NULL,
           started_at = now(),
           finished_at = NULL,
           updated_at = now()
     WHERE id = v_row.id
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'claimed', true,
      'code', 'reclaimed',
      'ledger_id', v_row.id,
      'claim_token', v_row.claim_token,
      'status', v_row.status
    );
  END IF;

  RETURN jsonb_build_object(
    'claimed', false,
    'code', CASE
      WHEN v_row.status = 'succeeded' THEN 'already_succeeded'
      ELSE 'already_claimed'
    END,
    'ledger_id', v_row.id,
    'status', v_row.status,
    'reason', 'Existing execution state must be reconciled before another broker request'
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_scanner_runtime_lock(p_user_id uuid, p_bot_id text, p_lock_scope text, p_lease_token uuid, p_run_id uuid, p_lease_seconds integer DEFAULT 180)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  affected integer := 0;
BEGIN
  INSERT INTO public.scanner_runtime_locks (
    user_id,
    bot_id,
    lock_scope,
    lease_token,
    run_id,
    acquired_at,
    heartbeat_at,
    lease_until
  )
  VALUES (
    p_user_id,
    p_bot_id,
    p_lock_scope,
    p_lease_token,
    p_run_id,
    now(),
    now(),
    now() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 600)))
  )
  ON CONFLICT (user_id, bot_id, lock_scope)
  DO UPDATE SET
    lease_token = EXCLUDED.lease_token,
    run_id = EXCLUDED.run_id,
    acquired_at = now(),
    heartbeat_at = now(),
    lease_until = EXCLUDED.lease_until
  WHERE public.scanner_runtime_locks.lease_until <= now()
     OR public.scanner_runtime_locks.lease_token = p_lease_token;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_telegram_notification(p_claim_key text, p_expires_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  claimed text;
begin
  insert into public.telegram_notification_claims (claim_key, expires_at)
  values (p_claim_key, p_expires_at)
  on conflict (claim_key) do update
    set expires_at = excluded.expires_at,
        created_at = now()
    where telegram_notification_claims.expires_at <= now()
  returning claim_key into claimed;

  return claimed is not null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.complete_broker_execution(p_ledger_id uuid, p_user_id uuid, p_claim_token uuid, p_status text, p_response_payload jsonb, p_broker_order_id text, p_last_error text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.broker_execution_ledger%ROWTYPE;
  v_effective_status TEXT := p_status;
  v_code TEXT := 'completed';
  v_effective_error TEXT := NULLIF(p_last_error, '');
BEGIN
  IF p_status NOT IN ('succeeded', 'rejected', 'uncertain') THEN
    RETURN jsonb_build_object(
      'completed', false,
      'code', 'invalid_status',
      'reason', format('Unsupported terminal status: %s', p_status)
    );
  END IF;

  SELECT *
    INTO v_row
    FROM public.broker_execution_ledger
   WHERE id = p_ledger_id
     AND user_id = p_user_id
     AND claim_token = p_claim_token
     AND status = 'attempting'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'completed', false,
      'code', 'claim_not_active',
      'reason', 'Execution claim is missing, stale, or already completed'
    );
  END IF;

  IF p_status = 'succeeded'
     AND v_row.action = 'close'
     AND NOT public.broker_close_has_terminal_proof(
       p_status,
       v_row.request_payload,
       p_response_payload
     ) THEN
    v_effective_status := 'uncertain';
    v_code := 'broker_close_proof_missing';
    v_effective_error := COALESCE(
      v_effective_error,
      'Reported broker close success lacked an exact close acknowledgement'
    );
  END IF;

  UPDATE public.broker_execution_ledger
     SET status = v_effective_status,
         response_payload = p_response_payload,
         broker_order_id = NULLIF(p_broker_order_id, ''),
         last_error = v_effective_error,
         finished_at = now(),
         updated_at = now()
   WHERE id = v_row.id
     AND claim_token = p_claim_token
     AND status = 'attempting'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'completed', false,
      'code', 'claim_not_active',
      'reason', 'Execution claim is missing, stale, or already completed'
    );
  END IF;

  IF v_code = 'broker_close_proof_missing' THEN
    RETURN jsonb_build_object(
      'completed', true,
      'code', v_code,
      'ledger_id', v_row.id,
      'requested_status', p_status,
      'status', v_row.status,
      'broker_order_id', v_row.broker_order_id
    );
  END IF;

  RETURN jsonb_build_object(
    'completed', true,
    'code', 'completed',
    'ledger_id', v_row.id,
    'status', v_row.status,
    'broker_order_id', v_row.broker_order_id
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.evaluate_scanner_operational_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  account_row record;
  operation_row record;
  latest_invocation timestamptz;
  stale_run_id uuid;
  stale_run_phase text;
  stale_run_heartbeat timestamptz;
  stale_confirmation_count integer;
  auth_failure_count integer;
  drift_items text[];
  grace_complete boolean;
  active_alerts integer;
BEGIN
  DELETE FROM public.scanner_authorization_failures
  WHERE occurred_at < now() - interval '24 hours';

  FOR account_row IN
    SELECT
      user_id,
      COALESCE(NULLIF(bot_id, ''), 'smc') AS bot_id
    FROM public.paper_accounts
    WHERE is_running = true
      AND kill_switch_active = false
  LOOP
    INSERT INTO public.scanner_health_monitor_state (
      user_id,
      bot_id,
      first_observed_at,
      last_evaluated_at
    )
    VALUES (account_row.user_id, account_row.bot_id, now(), now())
    ON CONFLICT (user_id, bot_id)
    DO UPDATE SET last_evaluated_at = now();

    SELECT first_observed_at <= now() - interval '12 minutes'
    INTO grace_complete
    FROM public.scanner_health_monitor_state
    WHERE user_id = account_row.user_id
      AND bot_id = account_row.bot_id;

    FOR operation_row IN
      SELECT *
      FROM (
        VALUES
          ('bot-scanner', 'scan', 5),
          ('bot-scanner', 'manage', 1),
          ('zone-confirmation-scanner', 'zone_confirmation', 1)
      ) AS operations(function_name, operation, default_interval)
    LOOP
      SELECT sor.invoked_at
      INTO latest_invocation
      FROM public.scanner_operation_runs sor
      WHERE sor.user_id = account_row.user_id
        AND sor.bot_id = account_row.bot_id
        AND sor.function_name = operation_row.function_name
        AND sor.operation = operation_row.operation
        AND sor.trigger_source = 'cron'
      ORDER BY sor.invoked_at DESC
      LIMIT 1;

      IF grace_complete AND (
        latest_invocation IS NULL
        OR latest_invocation < now() - make_interval(
          mins => GREATEST(operation_row.default_interval * 2 + 1, 3)
        )
      ) THEN
        PERFORM public.upsert_scanner_operational_alert(
          account_row.user_id,
          account_row.bot_id,
          'scanner_heartbeat_missing',
          operation_row.function_name || ':' || operation_row.operation,
          CASE WHEN operation_row.operation = 'scan' THEN 'critical' ELSE 'warning' END,
          'Scanner heartbeat missing',
          operation_row.function_name || ' ' || operation_row.operation ||
            ' has not been invoked within its expected window.',
          NULL,
          jsonb_build_object(
            'function_name', operation_row.function_name,
            'operation', operation_row.operation,
            'latest_invocation', latest_invocation
          )
        );
      ELSE
        PERFORM public.resolve_scanner_operational_alert(
          account_row.user_id,
          account_row.bot_id,
          'scanner_heartbeat_missing',
          operation_row.function_name || ':' || operation_row.operation
        );
      END IF;

      SELECT sor.id, sor.phase, sor.heartbeat_at
      INTO stale_run_id, stale_run_phase, stale_run_heartbeat
      FROM public.scanner_operation_runs sor
      WHERE sor.user_id = account_row.user_id
        AND sor.bot_id = account_row.bot_id
        AND sor.function_name = operation_row.function_name
        AND sor.operation = operation_row.operation
        AND sor.status IN ('invoked', 'running')
        AND sor.heartbeat_at < now() - interval '3 minutes'
      ORDER BY sor.heartbeat_at ASC
      LIMIT 1;

      IF stale_run_id IS NOT NULL THEN
        PERFORM public.upsert_scanner_operational_alert(
          account_row.user_id,
          account_row.bot_id,
          'scan_incomplete',
          operation_row.function_name || ':' || operation_row.operation,
          'critical',
          'Scanner run stopped before completion',
          'The last durable heartbeat stopped at phase "' ||
            COALESCE(stale_run_phase, 'unknown') || '".',
          stale_run_id,
          jsonb_build_object(
            'phase', stale_run_phase,
            'heartbeat_at', stale_run_heartbeat
          )
        );
      ELSE
        PERFORM public.resolve_scanner_operational_alert(
          account_row.user_id,
          account_row.bot_id,
          'scan_incomplete',
          operation_row.function_name || ':' || operation_row.operation
        );
      END IF;
      stale_run_id := NULL;
      stale_run_phase := NULL;
      stale_run_heartbeat := NULL;
    END LOOP;

    SELECT count(*)
    INTO stale_confirmation_count
    FROM public.pending_orders po
    WHERE po.user_id = account_row.user_id
      AND po.bot_id = account_row.bot_id
      AND po.status = 'awaiting_confirmation'
      AND po.expires_at > now()
      AND COALESCE(
        po.last_confirmation_checked_at,
        po.zone_touch_time,
        po.updated_at
      ) < now() - interval '3 minutes';

    IF stale_confirmation_count > 0 THEN
      PERFORM public.upsert_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'stuck_confirmation_order',
        'awaiting_confirmation',
        'critical',
        'Confirmation order is not being checked',
        stale_confirmation_count || ' awaiting-confirmation order(s) have not ' ||
          'been checked for more than three minutes.',
        NULL,
        jsonb_build_object('stale_order_count', stale_confirmation_count)
      );
    ELSE
      PERFORM public.resolve_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'stuck_confirmation_order',
        'awaiting_confirmation'
      );
    END IF;

    FOR operation_row IN
      SELECT function_name, count(*)::integer AS failure_count
      FROM public.scanner_authorization_failures
      WHERE occurred_at >= now() - interval '10 minutes'
      GROUP BY function_name
    LOOP
      auth_failure_count := operation_row.failure_count;
      IF auth_failure_count >= 3 THEN
        PERFORM public.upsert_scanner_operational_alert(
          account_row.user_id,
          account_row.bot_id,
          'authorization_error',
          operation_row.function_name,
          'critical',
          'Repeated scanner authorization failures',
          operation_row.function_name || ' rejected ' || auth_failure_count ||
            ' scheduler request(s) in the last ten minutes.',
          NULL,
          jsonb_build_object(
            'function_name', operation_row.function_name,
            'failures_10m', auth_failure_count
          )
        );
      END IF;
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM public.scanner_authorization_failures
      WHERE function_name = 'bot-scanner'
        AND occurred_at >= now() - interval '10 minutes'
      GROUP BY function_name
      HAVING count(*) >= 3
    ) THEN
      PERFORM public.resolve_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'authorization_error',
        'bot-scanner'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.scanner_authorization_failures
      WHERE function_name = 'zone-confirmation-scanner'
        AND occurred_at >= now() - interval '10 minutes'
      GROUP BY function_name
      HAVING count(*) >= 3
    ) THEN
      PERFORM public.resolve_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'authorization_error',
        'zone-confirmation-scanner'
      );
    END IF;

    drift_items := ARRAY[]::text[];
    IF to_regclass('public.scanner_operation_runs') IS NULL THEN
      drift_items := array_append(drift_items, 'scanner_operation_runs');
    END IF;
    IF to_regclass('public.scanner_runtime_locks') IS NULL THEN
      drift_items := array_append(drift_items, 'scanner_runtime_locks');
    END IF;
    IF to_regclass('public.scanner_operational_alerts') IS NULL THEN
      drift_items := array_append(drift_items, 'scanner_operational_alerts');
    END IF;
    IF to_regprocedure(
      'public.claim_scanner_runtime_lock(uuid,text,text,uuid,uuid,integer)'
    ) IS NULL THEN
      drift_items := array_append(drift_items, 'claim_scanner_runtime_lock');
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pending_orders'
        AND column_name = 'last_confirmation_checked_at'
    ) THEN
      drift_items := array_append(
        drift_items,
        'pending_orders.last_confirmation_checked_at'
      );
    END IF;

    IF cardinality(drift_items) > 0 THEN
      PERFORM public.upsert_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'migration_drift',
        'phase5_objects',
        'critical',
        'Scanner database migration mismatch',
        'Required runtime objects are missing: ' || array_to_string(drift_items, ', '),
        NULL,
        jsonb_build_object('missing_objects', to_jsonb(drift_items))
      );
    ELSE
      PERFORM public.resolve_scanner_operational_alert(
        account_row.user_id,
        account_row.bot_id,
        'migration_drift',
        'phase5_objects'
      );
    END IF;
  END LOOP;

  SELECT count(*)
  INTO active_alerts
  FROM public.scanner_operational_alerts
  WHERE status = 'active';

  RETURN jsonb_build_object(
    'evaluated_at', now(),
    'active_alerts', active_alerts
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.finalize_live_broker_position(p_user_id uuid, p_bot_id text, p_position_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_success_ids UUID[]; v_unresolved_count INTEGER; v_error TEXT; v_state TEXT; v_position_uuid UUID;
BEGIN
  SELECT COALESCE(array_agg(broker_connection_id) FILTER (WHERE status = $s$succeeded$s$), ARRAY[]::UUID[]),
    COUNT(*) FILTER (WHERE status IN ($s$attempting$s$, $s$uncertain$s$)),
    string_agg(last_error, $s$; $s$ ORDER BY updated_at DESC) FILTER (WHERE last_error IS NOT NULL)
  INTO v_success_ids, v_unresolved_count, v_error FROM public.broker_execution_ledger
  WHERE user_id = p_user_id AND bot_id = p_bot_id AND position_id = p_position_id AND action = $s$open$s$;

  IF cardinality(v_success_ids) > 0 THEN v_state := $s$confirmed$s$;
  ELSIF v_unresolved_count > 0 THEN v_state := $s$reconciliation_required$s$;
  ELSE v_state := $s$rejected$s$; END IF;

  UPDATE public.paper_positions SET
    position_status = CASE WHEN v_state = $s$confirmed$s$ THEN $s$open$s$ ELSE $s$pending$s$ END,
    broker_execution_state = v_state,
    broker_execution_error = CASE WHEN v_state = $s$confirmed$s$ THEN NULL
      ELSE COALESCE(v_error, CASE WHEN v_state = $s$rejected$s$ THEN $s$No broker confirmed the order$s$ ELSE $s$Broker outcome is uncertain$s$ END) END,
    broker_execution_updated_at = now(),
    mirrored_connection_ids = CASE WHEN v_state = $s$confirmed$s$ THEN v_success_ids ELSE mirrored_connection_ids END
  WHERE user_id = p_user_id AND bot_id = p_bot_id AND position_id = p_position_id
  RETURNING id INTO v_position_uuid;

  UPDATE public.pending_orders SET
    status = CASE WHEN v_state = $s$confirmed$s$ THEN $s$filled$s$
      WHEN v_state = $s$reconciliation_required$s$ THEN $s$reconciliation_required$s$
      ELSE $s$broker_rejected$s$ END,
    cancel_reason = CASE WHEN v_state = $s$confirmed$s$ THEN cancel_reason ELSE COALESCE(v_error, v_state) END,
    resolved_at = CASE WHEN v_state IN ($s$confirmed$s$, $s$rejected$s$) THEN now() ELSE NULL END
  WHERE id = (
    SELECT position.source_pending_order_id FROM public.paper_positions position
    WHERE position.id = v_position_uuid
  );

  RETURN jsonb_build_object($s$state$s$, v_state, $s$open$s$, v_state = $s$confirmed$s$,
    $s$mirrored_connection_ids$s$, to_jsonb(v_success_ids), $s$reason$s$, v_error);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.finalize_market_entry(p_user_id uuid, p_bot_id text, p_source_candidate_key text, p_position jsonb, p_authorization jsonb, p_max_open_positions integer, p_max_per_symbol integer, p_allow_same_direction boolean, p_close_on_reverse boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account public.paper_accounts%ROWTYPE;
  v_position_uuid UUID;
  v_position_status TEXT;
  v_broker_execution_state TEXT;
  v_symbol TEXT := p_position->>'symbol';
  v_direction TEXT := p_position->>'direction';
  v_entry NUMERIC := (p_position->>'entry_price')::NUMERIC;
  v_stop NUMERIC := (p_position->>'stop_loss')::NUMERIC;
  v_target NUMERIC := (p_position->>'take_profit')::NUMERIC;
  v_size NUMERIC := (p_position->>'size')::NUMERIC;
  v_open_count INTEGER;
  v_symbol_count INTEGER;
  v_same_direction_count INTEGER;
BEGIN
  IF COALESCE((p_authorization->>'authorized')::BOOLEAN, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'authorization_missing',
      'reason', 'A successful final authorization decision is required'
    );
  END IF;

  IF NULLIF(p_source_candidate_key, '') IS NULL THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'candidate_key_missing',
      'reason', 'A stable source candidate key is required'
    );
  END IF;

  IF v_symbol IS NULL OR v_direction NOT IN ('long', 'short')
     OR v_entry IS NULL OR v_entry <= 0
     OR v_stop IS NULL OR v_stop <= 0
     OR v_target IS NULL OR v_target <= 0
     OR v_size IS NULL OR v_size <= 0 THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'invalid_price',
      'reason', 'Symbol, direction, entry, stop-loss, take-profit and size must be valid'
    );
  END IF;

  IF (v_direction = 'long'
      AND NOT (v_stop < v_entry AND v_target > v_entry))
     OR (v_direction = 'short'
      AND NOT (v_stop > v_entry AND v_target < v_entry)) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'invalid_orientation',
      'reason', 'SL/TP orientation does not match the trade direction'
    );
  END IF;

  SELECT *
    INTO v_account
    FROM public.paper_accounts
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'account_missing',
      'reason', 'Execution account is unavailable'
    );
  END IF;
  IF v_account.kill_switch_active THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'kill_switch',
      'reason', 'Kill switch is active'
    );
  END IF;
  IF NOT v_account.is_running THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'bot_stopped',
      'reason', 'Bot is stopped'
    );
  END IF;
  IF v_account.is_paused THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'bot_paused',
      'reason', 'Bot is paused'
    );
  END IF;
  IF v_account.execution_mode NOT IN ('paper', 'live') THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'execution_mode',
      'reason', 'Account execution mode is invalid'
    );
  END IF;

  SELECT COUNT(*)
    INTO v_open_count
    FROM public.paper_positions
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND position_status = 'open'
     AND NOT (
       COALESCE(p_close_on_reverse, false)
       AND symbol = v_symbol
       AND direction <> v_direction
     );

  IF v_open_count >= GREATEST(COALESCE(p_max_open_positions, 1), 1) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'max_positions',
      'reason', format(
        'Max open positions reached (%s/%s)',
        v_open_count,
        p_max_open_positions
      )
    );
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE direction = v_direction)
    INTO v_symbol_count, v_same_direction_count
    FROM public.paper_positions
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND position_status = 'open'
     AND symbol = v_symbol
     AND NOT (
       COALESCE(p_close_on_reverse, false)
       AND direction <> v_direction
     );

  IF v_same_direction_count > 0
     AND NOT COALESCE(p_allow_same_direction, false) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'duplicate_direction',
      'reason', format(
        'An open %s position already exists for %s',
        v_direction,
        v_symbol
      )
    );
  END IF;

  IF v_symbol_count >= GREATEST(COALESCE(p_max_per_symbol, 1), 1) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'max_per_symbol',
      'reason', format(
        'Max positions for %s reached (%s/%s)',
        v_symbol,
        v_symbol_count,
        p_max_per_symbol
      )
    );
  END IF;

  INSERT INTO public.paper_positions (
    user_id,
    position_id,
    symbol,
    direction,
    size,
    entry_price,
    current_price,
    stop_loss,
    take_profit,
    open_time,
    signal_reason,
    signal_score,
    order_id,
    position_status,
    bot_id,
    source_candidate_key,
    final_authorization
  ) VALUES (
    p_user_id,
    p_position->>'position_id',
    v_symbol,
    v_direction,
    v_size,
    v_entry,
    COALESCE((p_position->>'current_price')::NUMERIC, v_entry),
    v_stop,
    v_target,
    COALESCE(p_position->>'open_time', now()::TEXT),
    COALESCE(p_position->'signal_reason', '{}'::JSONB)::TEXT,
    COALESCE(p_position->>'signal_score', '0'),
    p_position->>'order_id',
    'open',
    p_bot_id,
    p_source_candidate_key,
    p_authorization
  )
  RETURNING id, position_status, broker_execution_state
    INTO v_position_uuid, v_position_status, v_broker_execution_state;

  RETURN jsonb_build_object(
    'filled', true,
    'code', 'filled',
    'position_id', p_position->>'position_id',
    'position_uuid', v_position_uuid,
    'execution_mode', v_account.execution_mode,
    'position_status', v_position_status,
    'broker_execution_state', v_broker_execution_state
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'already_filled',
      'reason', 'A position already exists for this market candidate'
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.finalize_paper_position_close(p_position_row_id uuid, p_user_id uuid, p_bot_id text, p_exit_price numeric, p_pnl numeric, p_pnl_pips numeric, p_close_reason text, p_closed_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_position public.paper_positions%ROWTYPE;
  v_account public.paper_accounts%ROWTYPE;
  v_history_id UUID;
  v_new_balance NUMERIC;
  v_new_peak NUMERIC;
BEGIN
  IF auth.role() <> 'service_role' AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object(
      'closed', false,
      'code', 'forbidden',
      'reason', 'Cannot close another user''s paper position'
    );
  END IF;

  SELECT *
    INTO v_position
    FROM public.paper_positions
   WHERE id = p_position_row_id
     AND user_id = p_user_id
     AND bot_id = p_bot_id
     AND position_status = 'open'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'closed', false,
      'code', 'already_resolved',
      'reason', 'Paper position is no longer open'
    );
  END IF;

  SELECT *
    INTO v_account
    FROM public.paper_accounts
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'closed', false,
      'code', 'account_missing',
      'reason', 'Paper account is unavailable'
    );
  END IF;

  IF p_exit_price IS NULL OR p_exit_price <= 0
     OR p_pnl IS NULL
     OR p_close_reason IS NULL OR btrim(p_close_reason) = '' THEN
    RETURN jsonb_build_object(
      'closed', false,
      'code', 'invalid_close',
      'reason', 'Exit price, P&L and close reason are required'
    );
  END IF;

  INSERT INTO public.paper_trade_history (
    user_id,
    position_id,
    symbol,
    direction,
    size,
    entry_price,
    exit_price,
    pnl,
    pnl_pips,
    open_time,
    closed_at,
    close_reason,
    signal_reason,
    signal_score,
    order_id,
    source_pending_order_id,
    bot_id,
    stop_loss,
    take_profit,
    source_position_row_id
  ) VALUES (
    p_user_id,
    v_position.position_id,
    v_position.symbol,
    v_position.direction,
    v_position.size,
    v_position.entry_price,
    p_exit_price,
    p_pnl,
    p_pnl_pips,
    v_position.open_time,
    COALESCE(p_closed_at, now())::TEXT,
    p_close_reason,
    v_position.signal_reason,
    v_position.signal_score,
    v_position.order_id,
    v_position.source_pending_order_id,
    p_bot_id,
    v_position.stop_loss,
    v_position.take_profit,
    v_position.id
  )
  RETURNING id INTO v_history_id;

  v_new_balance := v_account.balance + p_pnl;
  v_new_peak := GREATEST(v_account.peak_balance, v_new_balance);

  UPDATE public.paper_accounts
     SET balance = v_new_balance,
         peak_balance = v_new_peak
   WHERE id = v_account.id;

  DELETE FROM public.paper_positions
   WHERE id = v_position.id;

  RETURN jsonb_build_object(
    'closed', true,
    'code', 'closed',
    'history_id', v_history_id,
    'balance', v_new_balance,
    'peak_balance', v_new_peak
  );
EXCEPTION
  WHEN unique_violation THEN
    -- A second source row may share the already-finalized lifecycle identity.
    -- Remove that duplicate open row without moving the ledger again.
    DELETE FROM public.paper_positions
     WHERE id = p_position_row_id
       AND user_id = p_user_id
       AND bot_id = p_bot_id;
    RETURN jsonb_build_object(
      'closed', false,
      'code', 'already_resolved',
      'reason', 'A final close already exists for this paper position'
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.finalize_pending_order_fill(p_pending_id uuid, p_user_id uuid, p_bot_id text, p_fill_price numeric, p_current_price numeric, p_position_order_id text, p_signal_reason jsonb, p_fill_reason text, p_authorization jsonb, p_max_open_positions integer, p_max_per_symbol integer, p_allow_same_direction boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pending public.pending_orders%ROWTYPE;
  v_account public.paper_accounts%ROWTYPE;
  v_position_uuid UUID;
  v_position_status TEXT;
  v_broker_execution_state TEXT;
  v_open_count INTEGER;
  v_symbol_count INTEGER;
  v_same_direction_count INTEGER;
BEGIN
  SELECT *
    INTO v_pending
    FROM public.pending_orders
   WHERE id = p_pending_id
     AND user_id = p_user_id
     AND bot_id = p_bot_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'order_not_found',
      'reason', 'Pending order was not found'
    );
  END IF;

  IF v_pending.status <> 'awaiting_confirmation' THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'already_resolved',
      'reason', format('Pending order status is %s', v_pending.status)
    );
  END IF;

  IF v_pending.expires_at IS NOT NULL
     AND v_pending.expires_at <= now() THEN
    UPDATE public.pending_orders
       SET status = 'expired',
           cancel_reason = 'TTL expired before confirmation fill',
           resolved_at = now()
     WHERE id = v_pending.id;
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'order_expired',
      'reason', 'Pending order expired before confirmation fill'
    );
  END IF;

  SELECT *
    INTO v_account
    FROM public.paper_accounts
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'account_missing',
      'reason', 'Execution account is unavailable'
    );
  END IF;

  IF v_account.kill_switch_active THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'kill_switch',
      'reason', 'Kill switch is active'
    );
  END IF;

  IF NOT v_account.is_running THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'bot_stopped',
      'reason', 'Bot is stopped'
    );
  END IF;

  IF v_account.is_paused THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'bot_paused',
      'reason', 'Bot is paused'
    );
  END IF;

  -- The account row lock serializes fills for this user. Counts below are
  -- therefore checked against fills committed while this transaction waited.
  SELECT COUNT(*)
    INTO v_open_count
    FROM public.paper_positions
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND position_status = 'open';

  IF v_open_count >= GREATEST(COALESCE(p_max_open_positions, 1), 1) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'max_positions',
      'reason', format(
        'Max open positions reached (%s/%s)',
        v_open_count,
        p_max_open_positions
      )
    );
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE direction = v_pending.direction)
    INTO v_symbol_count, v_same_direction_count
    FROM public.paper_positions
   WHERE user_id = p_user_id
     AND bot_id = p_bot_id
     AND position_status = 'open'
     AND symbol = v_pending.symbol;

  IF v_same_direction_count > 0
     AND NOT COALESCE(p_allow_same_direction, false) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'duplicate_direction',
      'reason', format(
        'An open %s position already exists for %s',
        v_pending.direction,
        v_pending.symbol
      )
    );
  END IF;

  IF v_symbol_count >= GREATEST(COALESCE(p_max_per_symbol, 1), 1) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'max_per_symbol',
      'reason', format(
        'Max positions for %s reached (%s/%s)',
        v_pending.symbol,
        v_symbol_count,
        p_max_per_symbol
      )
    );
  END IF;

  IF p_fill_price IS NULL OR p_fill_price <= 0
     OR v_pending.stop_loss IS NULL OR v_pending.stop_loss <= 0
     OR v_pending.take_profit IS NULL OR v_pending.take_profit <= 0 THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'invalid_price',
      'reason', 'Entry, stop-loss and take-profit must be positive'
    );
  END IF;

  IF (v_pending.direction = 'long'
      AND NOT (
        v_pending.stop_loss < p_fill_price
        AND v_pending.take_profit > p_fill_price
      ))
     OR (v_pending.direction = 'short'
      AND NOT (
        v_pending.stop_loss > p_fill_price
        AND v_pending.take_profit < p_fill_price
      )) THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'invalid_orientation',
      'reason', 'SL/TP orientation does not match the trade direction'
    );
  END IF;

  INSERT INTO public.paper_positions (
    user_id,
    position_id,
    symbol,
    direction,
    size,
    entry_price,
    current_price,
    stop_loss,
    take_profit,
    open_time,
    signal_reason,
    signal_score,
    order_id,
    position_status,
    bot_id,
    order_type,
    trigger_price,
    source_pending_order_id
  ) VALUES (
    p_user_id,
    v_pending.order_id,
    v_pending.symbol,
    v_pending.direction,
    v_pending.size,
    p_fill_price,
    COALESCE(p_current_price, p_fill_price),
    v_pending.stop_loss,
    v_pending.take_profit,
    now()::TEXT,
    COALESCE(p_signal_reason, '{}'::JSONB)::TEXT,
    COALESCE(v_pending.signal_score, 0),
    p_position_order_id,
    'open',
    p_bot_id,
    v_pending.order_type,
    v_pending.entry_price,
    v_pending.id
  )
  RETURNING id, position_status, broker_execution_state
    INTO v_position_uuid, v_position_status, v_broker_execution_state;

  UPDATE public.pending_orders
     SET status = 'filled',
         fill_reason = p_fill_reason,
         final_authorization = p_authorization,
         filled_at = now(),
         resolved_at = now()
   WHERE id = v_pending.id;

  RETURN jsonb_build_object(
    'filled', true,
    'code', 'filled',
    'position_id', v_pending.order_id,
    'position_uuid', v_position_uuid,
    'execution_mode', v_account.execution_mode,
    'position_status', v_position_status,
    'broker_execution_state', v_broker_execution_state
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'filled', false,
      'code', 'already_filled',
      'reason', 'A position already exists for this pending order'
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.freeze_setup_strategy_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_signal JSONB := '{}'::JSONB;
  v_context JSONB;
  v_staged_context JSONB;
  v_pending_context JSONB;
  v_entry_zone JSONB;
  v_staged_id UUID;
  v_pending_id UUID;
  v_frozen_at TIMESTAMPTZ;
  v_version TEXT;
BEGIN
  -- Once frozen, neither application code nor another trigger may silently
  -- replace the setup's origin evidence.
  IF TG_OP = 'UPDATE' AND OLD.frozen_strategy_context IS NOT NULL THEN
    IF NEW.frozen_strategy_context IS DISTINCT FROM
       OLD.frozen_strategy_context THEN
      RAISE EXCEPTION
        'frozen strategy context is immutable for %.%',
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME;
    END IF;
    IF NEW.frozen_strategy_hash IS DISTINCT FROM OLD.frozen_strategy_hash THEN
      RAISE EXCEPTION
        'frozen strategy hash is immutable for %.%',
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME;
    END IF;
    NEW.policy_frozen_at := OLD.policy_frozen_at;
    NEW.style_policy := OLD.style_policy;
    NEW.style_policy_version := OLD.style_policy_version;
    NEW.style_base_policy_hash := OLD.style_base_policy_hash;
    NEW.style_policy_hash := OLD.style_policy_hash;
    RETURN NEW;
  END IF;

  BEGIN
    v_signal := CASE
      WHEN v_row->'signal_reason' IS NULL THEN '{}'::JSONB
      WHEN jsonb_typeof(v_row->'signal_reason') = 'object'
        THEN v_row->'signal_reason'
      WHEN jsonb_typeof(v_row->'signal_reason') = 'string'
        AND left(ltrim(v_row#>>'{signal_reason}'), 1) = '{'
        THEN (v_row#>>'{signal_reason}')::JSONB
      ELSE '{}'::JSONB
    END;
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_signal := '{}'::JSONB;
  END;

  v_context := COALESCE(
    NULLIF(NEW.frozen_strategy_context, 'null'::JSONB),
    NULLIF(v_signal->'frozenStrategyContext', 'null'::JSONB),
    NULLIF(
      v_signal->'watchlistLifecycle'->'frozenStrategyContext',
      'null'::JSONB
    ),
    NULLIF(
      v_row->'authorization_result'->'frozenStrategyContext',
      'null'::JSONB
    ),
    NULLIF(
      v_row->'final_authorization'->'decisionContext'
        ->'frozenStrategyContext',
      'null'::JSONB
    )
  );

  BEGIN
    v_staged_id := NULLIF(v_row->>'staged_setup_id', '')::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_staged_id := NULL;
  END;
  IF v_context IS NULL AND v_staged_id IS NOT NULL THEN
    SELECT setup.frozen_strategy_context
      INTO v_staged_context
      FROM public.staged_setups AS setup
     WHERE setup.id = v_staged_id;
    v_context := v_staged_context;
  END IF;

  BEGIN
    v_pending_id := NULLIF(v_row->>'source_pending_order_id', '')::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_pending_id := NULL;
  END;
  IF v_context IS NULL AND v_pending_id IS NOT NULL THEN
    SELECT pending.frozen_strategy_context
      INTO v_pending_context
      FROM public.pending_orders AS pending
     WHERE pending.id = v_pending_id;
    v_context := v_pending_context;
  END IF;

  -- Historical rows can still be frozen from evidence they already contain.
  -- The generated package remains v1 so no migration invents neutral
  -- provenance that was not captured when the setup was created.
  IF v_context IS NULL
     AND jsonb_typeof(v_row->'style_policy') = 'object' THEN
    v_context := jsonb_strip_nulls(jsonb_build_object(
      'contractVersion', 'setup-policy-freeze.v1',
      'frozenAt', now(),
      'setupId', COALESCE(
        v_row->>'staged_setup_id',
        v_row->>'candidate_id',
        v_row->>'id'
      ),
      'candidateId', COALESCE(
        v_row->>'candidate_id',
        v_row->>'id'
      ),
      'symbol', v_row->>'symbol',
      'direction', v_row->>'direction',
      'stylePolicy', v_row->'style_policy',
      'decisionContext', v_row->'decision_context',
      'gamePlan', jsonb_strip_nulls(jsonb_build_object(
        'id', v_row->>'game_plan_id',
        'version', v_row->>'game_plan_version'
      )),
      'directionVerdict', v_row->'direction_verdict',
      'scenarioZoneStory', jsonb_build_object(
        'contractVersion', 'scenario-zone-story.v1',
        'enforcement', 'observe_only',
        'originatingZone', v_row->'originating_zone',
        'scenarioCandidates', '[]'::JSONB,
        'selectedScenarioIndex', NULL,
        'status', 'no_directional_scenario',
        'reason',
          'Historical row frozen from existing evidence; no scenario match was inferred'
      ),
      'confirmation', jsonb_strip_nulls(jsonb_build_object(
        'method', COALESCE(v_row->>'confirmation_method', 'choch'),
        'indicatorMinCount', COALESCE(
          v_row#>>'{confirmation_config,indicatorMinCount}',
          '3'
        ),
        'maxAttempts', COALESCE(
          v_row#>>'{confirmation_config,maxConfirmationAttempts}',
          v_row#>>'{style_policy,lifecycle,maxConfirmationAttempts}',
          '3'
        ),
        'timeframe',
          v_row#>>'{style_policy,timeframes,roles,confirmation}',
        'refinementTimeframe',
          v_row#>>'{style_policy,timeframes,roles,refinement}'
      ))
    ));
  END IF;

  IF v_context IS NULL THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(v_context) <> 'object' THEN
    RAISE EXCEPTION 'frozen strategy context must be a JSON object';
  END IF;

  v_version := v_context->>'contractVersion';
  IF v_version IS NULL OR v_version NOT IN (
    'setup-policy-freeze.v1',
    'setup-policy-freeze.v2'
  ) THEN
    RAISE EXCEPTION 'unsupported frozen strategy context version: %',
      COALESCE(v_version, 'missing');
  END IF;

  IF jsonb_typeof(v_context->'stylePolicy') IS DISTINCT FROM 'object'
     OR NULLIF(v_context->>'setupId', '') IS NULL
     OR NULLIF(v_context->>'candidateId', '') IS NULL
     OR NULLIF(v_context->>'symbol', '') IS NULL
     OR NULLIF(v_context->>'direction', '') IS NULL
     OR v_context->>'direction' NOT IN ('long', 'short')
     OR jsonb_typeof(v_context->'confirmation') IS DISTINCT FROM 'object'
     OR NULLIF(v_context#>>'{confirmation,method}', '') IS NULL
     OR v_context#>>'{confirmation,method}' NOT IN (
       'choch',
       'indicators',
       'choch_and_indicators'
     )
     OR NULLIF(v_context#>>'{confirmation,timeframe}', '') IS NULL
     OR NULLIF(
       v_context#>>'{confirmation,refinementTimeframe}',
       ''
     ) IS NULL THEN
    RAISE EXCEPTION 'frozen strategy context is incomplete';
  END IF;

  IF v_version = 'setup-policy-freeze.v1' AND (
    (v_context#>>'{scenarioZoneStory,contractVersion}')
      IS DISTINCT FROM 'scenario-zone-story.v1'
    OR (v_context#>>'{scenarioZoneStory,enforcement}')
      IS DISTINCT FROM 'observe_only'
  ) THEN
    RAISE EXCEPTION 'legacy frozen strategy context is incomplete';
  END IF;

  IF v_version = 'setup-policy-freeze.v2' THEN
    IF NULLIF(v_context->>'frozenAt', '') IS NULL
       OR NULLIF(v_context#>>'{stylePolicy,contractVersion}', '') IS NULL
       OR NULLIF(v_context#>>'{stylePolicy,basePolicyHash}', '') IS NULL
       OR NULLIF(v_context#>>'{stylePolicy,policyHash}', '') IS NULL
       OR NULLIF(v_context#>>'{stylePolicy,style}', '') IS NULL
       OR NOT (v_context ? 'entryZone')
       OR jsonb_typeof(v_context->'entryZone') NOT IN ('object', 'null')
       OR (v_context#>>'{scenarioStory,contractVersion}')
         IS DISTINCT FROM 'scenario-story.v1'
       OR (v_context#>>'{scenarioStory,enforcement}')
         IS DISTINCT FROM 'observe_only'
       OR jsonb_typeof(v_context#>'{scenarioStory,scenarioCandidates}')
         IS DISTINCT FROM 'array'
       OR (v_context#>'{scenarioStory,selectedScenarioIndex}')
         IS DISTINCT FROM 'null'::JSONB
       OR NULLIF(v_context#>>'{scenarioStory,status}', '') IS NULL
       OR v_context#>>'{scenarioStory,status}' NOT IN (
         'captured',
         'no_directional_scenario'
       ) THEN
      RAISE EXCEPTION 'neutral frozen strategy context is incomplete';
    END IF;

    IF jsonb_typeof(v_context->'entryZone') = 'object' THEN
      v_entry_zone := v_context->'entryZone';
      IF v_entry_zone->>'contractVersion' IS DISTINCT FROM
           'frozen-entry-zone.v1'
         OR v_entry_zone->>'enforcement' IS DISTINCT FROM 'observe_only'
         OR v_entry_zone->'affectsAuthorization' IS DISTINCT FROM 'false'::JSONB
         OR NULLIF(v_entry_zone->>'setupFamily', '') IS NULL
         OR v_entry_zone->>'setupFamily' NOT IN (
           'impulse',
           'cascade',
           'structure_poi'
         )
         OR v_entry_zone->>'direction' IS DISTINCT FROM
           v_context->>'direction'
         OR NULLIF(v_entry_zone->>'type', '') IS NULL
         OR jsonb_typeof(v_entry_zone->'sourceEvidenceIds')
           IS DISTINCT FROM 'array'
         OR jsonb_typeof(v_entry_zone->'bounds') IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_entry_zone#>'{bounds,low}')
           IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_entry_zone#>'{bounds,high}')
           IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_entry_zone->'geometry') IS DISTINCT FROM 'object'
         OR NOT (v_entry_zone->'geometry' ? 'entry')
         OR NOT (v_entry_zone->'geometry' ? 'structuralInvalidation')
         OR NOT (v_entry_zone->'geometry' ? 'positionStop')
         OR NOT (v_entry_zone->'geometry' ? 'target')
         OR jsonb_typeof(v_entry_zone#>'{geometry,entry}') NOT IN (
           'number',
           'null'
         )
         OR jsonb_typeof(v_entry_zone#>'{geometry,structuralInvalidation}')
           NOT IN ('number', 'null')
         OR jsonb_typeof(v_entry_zone#>'{geometry,positionStop}') NOT IN (
           'number',
           'null'
         )
         OR jsonb_typeof(v_entry_zone#>'{geometry,target}') NOT IN (
           'number',
           'null'
         )
         OR jsonb_typeof(v_entry_zone->'stylePolicy')
           IS DISTINCT FROM 'object'
         OR v_entry_zone#>>'{stylePolicy,version}' IS DISTINCT FROM
           v_context#>>'{stylePolicy,contractVersion}'
         OR v_entry_zone#>>'{stylePolicy,basePolicyHash}' IS DISTINCT FROM
           v_context#>>'{stylePolicy,basePolicyHash}'
         OR v_entry_zone#>>'{stylePolicy,policyHash}' IS DISTINCT FROM
           v_context#>>'{stylePolicy,policyHash}'
         OR v_entry_zone#>>'{stylePolicy,style}' IS DISTINCT FROM
           v_context#>>'{stylePolicy,style}'
         OR jsonb_typeof(v_entry_zone->'timeframeRoles')
           IS DISTINCT FROM 'object'
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,bias}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,structure}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,setup}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,confirmation}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,refinement}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,runtimeEntry}', '') IS NULL
         OR NULLIF(v_entry_zone#>>'{timeframeRoles,runtimeHTF}', '') IS NULL
         OR NULLIF(v_entry_zone->>'frozenAt', '') IS NULL
         OR v_entry_zone->>'frozenAt' IS DISTINCT FROM v_context->>'frozenAt'
         OR jsonb_typeof(v_entry_zone->'sourceWindow') IS NULL
         OR jsonb_typeof(v_entry_zone->'sourceWindow') NOT IN (
           'object',
           'null'
         ) THEN
        RAISE EXCEPTION 'frozen entry zone is incomplete';
      END IF;

      IF jsonb_typeof(v_entry_zone->'sourceWindow') = 'object' AND (
        NULLIF(v_entry_zone#>>'{sourceWindow,start}', '') IS NULL
        OR NULLIF(v_entry_zone#>>'{sourceWindow,end}', '') IS NULL
      ) THEN
        RAISE EXCEPTION 'frozen entry zone source window is incomplete';
      END IF;

      IF v_entry_zone->>'setupFamily' = 'structure_poi' AND (
        NULLIF(v_entry_zone->>'candidateId', '') IS NULL
        OR NULLIF(v_entry_zone->>'sourceContextId', '') IS NULL
        OR jsonb_array_length(v_entry_zone->'sourceEvidenceIds') = 0
        OR jsonb_typeof(v_entry_zone->'sourceWindow') <> 'object'
        OR NULLIF(v_entry_zone->>'timeframe', '') IS NULL
      ) THEN
        RAISE EXCEPTION 'structure POI entry zone provenance is incomplete';
      END IF;
    END IF;
  END IF;

  BEGIN
    v_frozen_at := NULLIF(v_context->>'frozenAt', '')::TIMESTAMPTZ;
  EXCEPTION
    WHEN invalid_datetime_format THEN
      v_frozen_at := NULL;
  END;
  NEW.frozen_strategy_context := v_context;
  NEW.frozen_strategy_hash := md5(v_context::TEXT);
  NEW.policy_frozen_at := COALESCE(v_frozen_at, now());
  NEW.style_policy := v_context->'stylePolicy';
  NEW.style_policy_version := NULLIF(
    v_context#>>'{stylePolicy,contractVersion}',
    ''
  );
  NEW.style_base_policy_hash := NULLIF(
    v_context#>>'{stylePolicy,basePolicyHash}',
    ''
  );
  NEW.style_policy_hash := NULLIF(
    v_context#>>'{stylePolicy,policyHash}',
    ''
  );
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.freeze_streamlined_decision_origin()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE row_data JSONB := to_jsonb(NEW); payload JSONB; signal JSONB := '{}'::JSONB;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.streamlined_decision_origin IS NOT NULL THEN
    IF NEW.streamlined_decision_origin IS DISTINCT FROM OLD.streamlined_decision_origin THEN
      RAISE EXCEPTION 'streamlined decision origin is immutable for %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END IF;
    NEW.streamlined_decision_frozen_at := OLD.streamlined_decision_frozen_at;
    RETURN NEW;
  END IF;
  BEGIN
    signal := CASE WHEN jsonb_typeof(row_data->'signal_reason') = 'object' THEN row_data->'signal_reason'
      WHEN jsonb_typeof(row_data->'signal_reason') = 'string' THEN (row_data->>'signal_reason')::JSONB
      ELSE '{}'::JSONB END;
  EXCEPTION WHEN OTHERS THEN signal := '{}'::JSONB; END;
  payload := COALESCE(
    NULLIF(NEW.streamlined_decision_origin, 'null'::JSONB),
    NULLIF(row_data->'raw_detail'->'streamlinedDecisionOrigin', 'null'::JSONB),
    NULLIF(row_data->'analysis_snapshot'->'streamlinedDecisionOrigin', 'null'::JSONB),
    NULLIF(signal->'streamlinedDecisionOrigin', 'null'::JSONB),
    CASE WHEN row_data->'raw_detail'->'streamlinedTradeDecision' IS NOT NULL THEN jsonb_build_object(
      'contractVersion','streamlined-decision-lifecycle.v1',
      'frozenAt',COALESCE(row_data->'raw_detail'->'streamlinedTradeDecision'->>'evaluatedAt',now()::TEXT),
      'candidateId',row_data->'raw_detail'->'streamlinedTradeDecision'->'identity'->>'candidateId',
      'originStage','rejected','summary',row_data->'raw_detail'->'streamlinedTradeDecision') END
  );
  IF payload IS NULL THEN RETURN NEW; END IF;
  IF payload->>'contractVersion' <> 'streamlined-decision-lifecycle.v1'
     OR payload->'summary'->>'contractVersion' <> 'streamlined-trade-decision.v1'
     OR COALESCE((payload->'summary'->>'observationOnly')::BOOLEAN,FALSE) IS NOT TRUE
     OR COALESCE((payload->'summary'->>'affectsAuthorization')::BOOLEAN,TRUE) IS NOT FALSE
     OR NULLIF(payload->>'candidateId','') IS NULL THEN
    RAISE EXCEPTION 'invalid streamlined decision origin';
  END IF;
  NEW.streamlined_decision_origin := payload;
  NEW.streamlined_decision_frozen_at := COALESCE((payload->>'frozenAt')::TIMESTAMPTZ, now());
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.guard_prezone_observation_execution()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_signal JSONB := '{}'::JSONB;
  v_staged_id UUID;
  v_candidate_id UUID;
  v_observation_id UUID;
BEGIN
  BEGIN
    v_signal := CASE
      WHEN v_row->'signal_reason' IS NULL THEN '{}'::JSONB
      WHEN jsonb_typeof(v_row->'signal_reason') = 'object'
        THEN v_row->'signal_reason'
      WHEN jsonb_typeof(v_row->'signal_reason') = 'string'
        AND left(ltrim(v_row#>>'{signal_reason}'), 1) = '{'
        THEN (v_row#>>'{signal_reason}')::JSONB
      ELSE '{}'::JSONB
    END;
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_signal := '{}'::JSONB;
  END;

  BEGIN
    v_staged_id := COALESCE(
      NULLIF(v_row->>'staged_setup_id', '')::UUID,
      NULLIF(v_signal#>>'{watchlistLifecycle,setupId}', '')::UUID
    );
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_staged_id := NULL;
  END;

  BEGIN
    v_candidate_id := COALESCE(
      NULLIF(v_row->>'candidate_id', '')::UUID,
      NULLIF(v_signal#>>'{watchlistLifecycle,candidateId}', '')::UUID,
      NULLIF(v_signal->>'candidateId', '')::UUID
    );
  EXCEPTION
    WHEN invalid_text_representation THEN
      v_candidate_id := NULL;
  END;

  SELECT setup.id
    INTO v_observation_id
    FROM public.staged_setups AS setup
   WHERE setup.user_id = NEW.user_id
     AND setup.bot_id = NEW.bot_id
     AND setup.execution_eligible = false
     AND (
       (v_staged_id IS NOT NULL AND setup.id = v_staged_id)
       OR (
         v_candidate_id IS NOT NULL
         AND setup.candidate_id = v_candidate_id
       )
     )
   LIMIT 1;

  IF v_observation_id IS NOT NULL THEN
    RAISE EXCEPTION
      'pre-zone observation % cannot create an order or position',
      v_observation_id;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.raw_user_meta_data ->> 'name'),
    NEW.raw_user_meta_data ->> 'avatar_url'
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.heartbeat_scanner_runtime_lock(p_user_id uuid, p_bot_id text, p_lock_scope text, p_lease_token uuid, p_lease_seconds integer DEFAULT 180)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  affected integer := 0;
BEGIN
  UPDATE public.scanner_runtime_locks
  SET
    heartbeat_at = now(),
    lease_until = now() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 600)))
  WHERE user_id = p_user_id
    AND bot_id = p_bot_id
    AND lock_scope = p_lock_scope
    AND lease_token = p_lease_token;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.hold_staged_setup_until_live_broker_confirmation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_position public.paper_positions%ROWTYPE;
BEGIN
  IF NEW.staged_setup_id IS NULL OR NEW.status <> $s$filled$s$ THEN RETURN NEW; END IF;
  SELECT * INTO v_position FROM public.paper_positions
   WHERE source_pending_order_id = NEW.id ORDER BY open_time DESC LIMIT 1;
  IF FOUND AND v_position.position_status <> $s$open$s$ THEN
    UPDATE public.staged_setups SET status = $s$pending$s$,
      lifecycle_reason = CASE v_position.broker_execution_state
        WHEN $s$reconciliation_required$s$ THEN $s$Broker outcome requires reconciliation$s$
        WHEN $s$rejected$s$ THEN $s$No broker confirmed the live order$s$
        ELSE $s$Live order submitted; awaiting broker confirmation$s$ END,
      position_id = v_position.id, pending_order_id = NEW.id,
      resolved_at = NULL, updated_at = now()
    WHERE id = NEW.staged_setup_id;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.list_unresolved_broker_open_orphans(p_user_id uuid, p_bot_id text, p_limit integer DEFAULT 100)
 RETURNS TABLE(open_ledger_id uuid, user_id uuid, bot_id text, position_id text, broker_connection_id uuid, request_payload jsonb, response_payload jsonb, broker_order_id text, broker_position_id text, status text, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    open_ledger.id,
    open_ledger.user_id,
    open_ledger.bot_id,
    open_ledger.position_id,
    open_ledger.broker_connection_id,
    open_ledger.request_payload,
    open_ledger.response_payload,
    open_ledger.broker_order_id,
    evidence.broker_position_id,
    open_ledger.status,
    open_ledger.updated_at
  FROM public.broker_execution_ledger open_ledger
  LEFT JOIN public.broker_connections connection
    ON connection.id = open_ledger.broker_connection_id
  CROSS JOIN LATERAL (
    SELECT public.broker_open_exact_position_id(
      connection.broker_type,
      open_ledger.response_payload
    ) AS broker_position_id
  ) evidence
  WHERE open_ledger.user_id = p_user_id
    AND open_ledger.bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
    AND open_ledger.action = 'open'
    AND open_ledger.status IN ('succeeded', 'attempting', 'uncertain')
    AND NOT EXISTS (
      SELECT 1
      FROM public.paper_positions position
      WHERE position.user_id = open_ledger.user_id
        AND position.bot_id = open_ledger.bot_id
        AND position.position_id = open_ledger.position_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.broker_execution_ledger close_ledger
      WHERE close_ledger.user_id = open_ledger.user_id
        AND close_ledger.bot_id = open_ledger.bot_id
        AND close_ledger.position_id = open_ledger.position_id
        AND close_ledger.broker_connection_id =
          open_ledger.broker_connection_id
        AND close_ledger.action = 'close'
        AND public.broker_close_resolves_open(
          evidence.broker_position_id,
          COALESCE(open_ledger.finished_at, open_ledger.started_at),
          close_ledger.status,
          close_ledger.request_payload,
          close_ledger.response_payload,
          close_ledger.started_at
        )
    )
  ORDER BY open_ledger.updated_at, open_ledger.id
  LIMIT GREATEST(COALESCE(p_limit, 100), 1);
$function$
;

CREATE OR REPLACE FUNCTION public.load_paper_position_close_context(p_user_id uuid, p_bot_id text, p_position_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_position public.paper_positions%ROWTYPE;
  v_account public.paper_accounts%ROWTYPE;
  v_requirements RECORD;
BEGIN
  SELECT *
    INTO v_position
    FROM public.paper_positions position
   WHERE position.user_id = p_user_id
     AND position.bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
     AND position.position_id = p_position_id
     AND position.position_status IN ('open', 'pending')
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'position_found', false,
      'required_connection_ids', '[]'::JSONB,
      'missing_close_connection_ids', '[]'::JSONB,
      'unknown_identity_connection_ids', '[]'::JSONB,
      'broker_position_ids', '{}'::JSONB
    );
  END IF;

  SELECT *
    INTO v_account
    FROM public.paper_accounts account
   WHERE account.user_id = p_user_id
     AND account.bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
   FOR UPDATE;

  SELECT *
    INTO v_requirements
    FROM public.paper_position_broker_close_requirements(
      p_user_id,
      COALESCE(NULLIF(p_bot_id, ''), 'smc'),
      p_position_id
    );

  RETURN jsonb_build_object(
    'position_found', true,
    'position_status', v_position.position_status,
    'broker_execution_state', v_position.broker_execution_state,
    'execution_mode', CASE WHEN v_account.id IS NULL
      THEN NULL
      ELSE v_account.execution_mode
    END,
    'required_connection_ids', to_jsonb(
      COALESCE(v_requirements.required_connection_ids, ARRAY[]::UUID[])
    ),
    'missing_close_connection_ids', to_jsonb(
      COALESCE(v_requirements.missing_close_connection_ids, ARRAY[]::UUID[])
    ),
    'unknown_identity_connection_ids', to_jsonb(
      COALESCE(
        v_requirements.unknown_identity_connection_ids,
        ARRAY[]::UUID[]
      )
    ),
    'broker_position_ids', COALESCE(
      v_requirements.broker_position_ids,
      '{}'::JSONB
    )
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.mirror_staged_setup_resolution_reason()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('invalidated', 'expired', 'cancelled', 'blocked_after_qualification') THEN
    IF NEW.invalidation_reason IS NULL OR btrim(NEW.invalidation_reason) = '' THEN
      NEW.invalidation_reason := NULLIF(btrim(COALESCE(NEW.lifecycle_reason, '')), '');
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.paper_account_has_unresolved_managed_exposure(p_user_id uuid, p_bot_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.paper_positions position
    CROSS JOIN LATERAL public.paper_position_broker_close_requirements(
      position.user_id,
      position.bot_id,
      position.position_id
    ) requirements
    WHERE position.user_id = p_user_id
      AND position.bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
      AND position.position_status IN ('open', 'pending')
      AND (
        cardinality(requirements.missing_close_connection_ids) > 0
        OR (
          cardinality(requirements.required_connection_ids) = 0
          AND lower(COALESCE(
            position.broker_execution_state,
            'unknown'
          )) NOT IN ('paper', 'rejected')
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.list_unresolved_broker_open_orphans(
      p_user_id,
      COALESCE(NULLIF(p_bot_id, ''), 'smc'),
      1
    )
  );
$function$
;

CREATE OR REPLACE FUNCTION public.paper_position_broker_close_requirements(p_user_id uuid, p_bot_id text, p_position_id text)
 RETURNS TABLE(position_found boolean, required_connection_ids uuid[], missing_close_connection_ids uuid[], unknown_identity_connection_ids uuid[], broker_position_ids jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH target_position AS (
    SELECT position.mirrored_connection_ids
    FROM public.paper_positions position
    WHERE position.user_id = p_user_id
      AND position.bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
      AND position.position_id = p_position_id
    LIMIT 1
  ),
  mirrored_connections AS (
    SELECT DISTINCT connection_id
    FROM target_position
    CROSS JOIN LATERAL unnest(
      COALESCE(
        target_position.mirrored_connection_ids,
        ARRAY[]::UUID[]
      )
    ) AS connection_id
    WHERE connection_id IS NOT NULL
  ),
  open_attempts AS (
    SELECT
      open_ledger.broker_connection_id AS connection_id,
      public.broker_open_exact_position_id(
        connection.broker_type,
        open_ledger.response_payload
      ) AS broker_position_id,
      COALESCE(
        open_ledger.finished_at,
        open_ledger.started_at
      ) AS open_completed_at
    FROM target_position
    JOIN public.broker_execution_ledger open_ledger
      ON open_ledger.user_id = p_user_id
     AND open_ledger.bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
     AND open_ledger.position_id = p_position_id
     AND open_ledger.action = 'open'
     AND open_ledger.status IN ('succeeded', 'attempting', 'uncertain')
    LEFT JOIN public.broker_connections connection
      ON connection.id = open_ledger.broker_connection_id
  ),
  required_connections AS (
    SELECT connection_id FROM mirrored_connections
    UNION
    SELECT connection_id FROM open_attempts
  ),
  connection_evidence AS (
    SELECT
      required.connection_id,
      open_attempt.broker_position_id,
      open_attempt.open_completed_at
    FROM required_connections required
    LEFT JOIN open_attempts open_attempt
      ON open_attempt.connection_id = required.connection_id
  ),
  resolved_connections AS (
    SELECT evidence.connection_id
    FROM connection_evidence evidence
    WHERE evidence.broker_position_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.broker_execution_ledger close_ledger
        WHERE close_ledger.user_id = p_user_id
          AND close_ledger.bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
          AND close_ledger.position_id = p_position_id
          AND close_ledger.broker_connection_id = evidence.connection_id
          AND close_ledger.action = 'close'
          AND public.broker_close_resolves_open(
            evidence.broker_position_id,
            evidence.open_completed_at,
            close_ledger.status,
            close_ledger.request_payload,
            close_ledger.response_payload,
            close_ledger.started_at
          )
      )
  )
  SELECT
    EXISTS (SELECT 1 FROM target_position),
    COALESCE(
      (SELECT array_agg(connection_id ORDER BY connection_id)
       FROM required_connections),
      ARRAY[]::UUID[]
    ),
    COALESCE(
      (SELECT array_agg(connection_id ORDER BY connection_id)
       FROM connection_evidence evidence
       WHERE NOT EXISTS (
         SELECT 1 FROM resolved_connections resolved
         WHERE resolved.connection_id = evidence.connection_id
       )),
      ARRAY[]::UUID[]
    ),
    COALESCE(
      (SELECT array_agg(connection_id ORDER BY connection_id)
       FROM connection_evidence
       WHERE broker_position_id IS NULL),
      ARRAY[]::UUID[]
    ),
    COALESCE(
      (SELECT jsonb_object_agg(
         connection_id::TEXT,
         broker_position_id
         ORDER BY connection_id::TEXT
       )
       FROM connection_evidence
       WHERE broker_position_id IS NOT NULL),
      '{}'::JSONB
    );
$function$
;

CREATE OR REPLACE FUNCTION public.persist_pending_fill_authorization()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'filled' AND NEW.final_authorization IS NOT NULL THEN
    UPDATE public.paper_positions
       SET final_authorization = NEW.final_authorization
     WHERE source_pending_order_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.populate_execution_style_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_signal JSONB;
  v_policy JSONB;
BEGIN
  v_signal := CASE
    WHEN v_row->'signal_reason' IS NULL THEN NULL
    WHEN jsonb_typeof(v_row->'signal_reason') = 'object'
      THEN v_row->'signal_reason'
    WHEN jsonb_typeof(v_row->'signal_reason') = 'string'
      AND left(ltrim(v_row#>>'{signal_reason}'), 1) IN ('{', '[')
      THEN (v_row#>>'{signal_reason}')::JSONB
    ELSE NULL
  END;

  v_policy := COALESCE(
    v_row->'decision_context'->'stylePolicy',
    v_row->'final_authorization'->'decisionContext'->'stylePolicy',
    v_signal->'decisionContext'->'stylePolicy',
    v_signal->'stylePolicy',
    v_row->'authorization_result'->'stylePolicy',
    v_row->'style_policy'
  );

  IF v_policy IS NULL OR jsonb_typeof(v_policy) <> 'object' THEN
    RETURN NEW;
  END IF;

  NEW.style_policy := v_policy;
  NEW.style_policy_version := NULLIF(
    v_policy->>'contractVersion',
    ''
  );
  NEW.style_base_policy_hash := NULLIF(
    v_policy->>'basePolicyHash',
    ''
  );
  NEW.style_policy_hash := NULLIF(v_policy->>'policyHash', '');
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.populate_pending_decision_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_context JSONB;
  v_signal JSONB;
BEGIN
  v_signal := CASE
    WHEN NEW.signal_reason IS NULL THEN NULL
    WHEN jsonb_typeof(NEW.signal_reason) = 'string'
      THEN (NEW.signal_reason #>> '{}')::JSONB
    ELSE NEW.signal_reason
  END;
  v_context := COALESCE(
    NEW.final_authorization->'decisionContext',
    v_signal->'decisionContext',
    NEW.decision_context
  );
  IF v_context IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.decision_context := v_context;
  NEW.game_plan_id :=
    NULLIF(v_context#>>'{gamePlan,id}', '')::UUID;
  NEW.game_plan_version :=
    NULLIF(v_context#>>'{gamePlan,version}', '')::UUID;
  NEW.direction_verdict_id :=
    NULLIF(v_context#>>'{directionVerdict,id}', '')::UUID;
  NEW.direction_verdict := v_context->'directionVerdict';
  NEW.thesis_validation := v_context->'thesisValidity';
  NEW.entry_confirmation := v_context->'entryConfirmation';
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.populate_pending_lifecycle_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_signal JSONB := COALESCE(NEW.signal_reason, '{}'::JSONB);
  v_lifecycle JSONB := COALESCE(
    v_signal->'watchlistLifecycle',
    '{}'::JSONB
  );
BEGIN
  NEW.staged_setup_id := COALESCE(
    NEW.staged_setup_id,
    NULLIF(v_lifecycle->>'setupId', '')::UUID
  );
  NEW.candidate_id := COALESCE(
    NEW.candidate_id,
    NULLIF(v_lifecycle->>'candidateId', '')::UUID,
    NULLIF(v_signal->>'candidateId', '')::UUID
  );
  NEW.originating_zone := COALESCE(
    NEW.originating_zone,
    v_lifecycle->'originatingZone',
    v_signal->'originatingZone'
  );
  NEW.thesis_version := COALESCE(
    NEW.thesis_version,
    v_lifecycle->>'thesisVersion',
    v_signal->>'thesisVersion'
  );
  NEW.confirmation_method := COALESCE(
    NEW.confirmation_method,
    v_lifecycle->>'confirmationMethod',
    v_signal->>'confirmationMethod'
  );
  NEW.confirmation_config := COALESCE(
    NULLIF(NEW.confirmation_config, '{}'::JSONB),
    v_lifecycle->'confirmationConfig',
    '{}'::JSONB
  );
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.populate_position_decision_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_context JSONB;
BEGIN
  v_context := COALESCE(
    NEW.final_authorization->'decisionContext',
    NEW.decision_context
  );
  IF v_context IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.decision_context := v_context;
  NEW.game_plan_id :=
    NULLIF(v_context#>>'{gamePlan,id}', '')::UUID;
  NEW.game_plan_version :=
    NULLIF(v_context#>>'{gamePlan,version}', '')::UUID;
  NEW.direction_verdict_id :=
    NULLIF(v_context#>>'{directionVerdict,id}', '')::UUID;
  NEW.direction_verdict := v_context->'directionVerdict';
  NEW.thesis_validation := v_context->'thesisValidity';
  NEW.entry_confirmation := v_context->'entryConfirmation';
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.populate_position_lifecycle_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_signal JSONB := CASE
    WHEN NEW.signal_reason IS NULL OR NEW.signal_reason = '' THEN '{}'::JSONB
    ELSE NEW.signal_reason::JSONB
  END;
  v_lifecycle JSONB := COALESCE(
    v_signal->'watchlistLifecycle',
    '{}'::JSONB
  );
BEGIN
  NEW.staged_setup_id := COALESCE(
    NEW.staged_setup_id,
    NULLIF(v_lifecycle->>'setupId', '')::UUID
  );
  NEW.candidate_id := COALESCE(
    NEW.candidate_id,
    NULLIF(v_lifecycle->>'candidateId', '')::UUID,
    NULLIF(v_signal->>'candidateId', '')::UUID
  );
  NEW.originating_zone := COALESCE(
    NEW.originating_zone,
    v_lifecycle->'originatingZone',
    v_signal->'originatingZone'
  );
  NEW.thesis_version := COALESCE(
    NEW.thesis_version,
    v_lifecycle->>'thesisVersion',
    v_signal->>'thesisVersion'
  );
  NEW.confirmation_method := COALESCE(
    NEW.confirmation_method,
    v_lifecycle->>'confirmationMethod',
    v_signal->>'confirmationMethod'
  );
  NEW.confirmation_config := COALESCE(
    NULLIF(NEW.confirmation_config, '{}'::JSONB),
    v_lifecycle->'confirmationConfig',
    '{}'::JSONB
  );
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.populate_staged_setup_lifecycle_phase()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_phase TEXT;
  v_milestones JSONB;
BEGIN
  IF NEW.status = 'filled' AND NEW.position_id IS NOT NULL THEN
    v_phase := 'position_managing';
    NEW.lifecycle_reason_code := 'position_managing';
    NEW.lifecycle_reason := COALESCE(
      NEW.lifecycle_reason,
      'Position successfully created and is under management'
    );
  ELSIF NEW.status = 'filled' THEN
    v_phase := 'entry_authorized';
    NEW.lifecycle_reason_code := 'entry_authorized';
    NEW.lifecycle_reason := COALESCE(
      NEW.lifecycle_reason,
      'Entry authorization completed'
    );
  ELSE
    v_phase := COALESCE(
      NULLIF(NEW.lifecycle_evidence->>'phase', ''),
      NEW.lifecycle_phase,
      CASE
        WHEN NEW.status IN (
          'qualified',
          'pending',
          'awaiting_confirmation'
        ) THEN 'confirmation_ready'
        WHEN NEW.execution_eligible = false THEN 'monitoring_pre_zone'
        ELSE 'zone_discovered'
      END
    );
  END IF;

  NEW.lifecycle_phase := v_phase;
  v_milestones := CASE
    WHEN jsonb_typeof(NEW.lifecycle_evidence->'milestones') = 'array'
      THEN NEW.lifecycle_evidence->'milestones'
    ELSE '[]'::JSONB
  END;

  IF NEW.status = 'filled' AND NOT (v_milestones ? 'entry_authorized') THEN
    v_milestones := v_milestones || '"entry_authorized"'::JSONB;
  END IF;
  IF v_phase = 'position_managing' AND
     NOT (v_milestones ? 'position_managing') THEN
    v_milestones := v_milestones || '"position_managing"'::JSONB;
  END IF;
  IF jsonb_array_length(v_milestones) = 0 THEN
    v_milestones := jsonb_build_array(v_phase);
  END IF;

  NEW.lifecycle_evidence := jsonb_set(
    jsonb_set(
      jsonb_set(
        COALESCE(NEW.lifecycle_evidence, '{}'::JSONB),
        '{phase}',
        to_jsonb(v_phase),
        true
      ),
      '{milestones}',
      v_milestones,
      true
    ),
    '{reasonCode}',
    to_jsonb(COALESCE(NEW.lifecycle_reason_code, 'legacy_transition')),
    true
  );
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.populate_strategy_activation_hashes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  NEW.activation_scope := COALESCE(NEW.activation_scope, '{}'::JSONB);
  NEW.evidence_snapshot := COALESCE(NEW.evidence_snapshot, '{}'::JSONB);
  NEW.activation_scope_hash :=
    public.strategy_activation_json_hash(NEW.activation_scope);
  NEW.evidence_hash :=
    public.strategy_activation_json_hash(NEW.evidence_snapshot);
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.populate_strategy_style_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_policy JSONB;
BEGIN
  v_policy := COALESCE(
    v_row->'config_snapshot'->'stylePolicy',
    v_row->'verdict_json'->'stylePolicy',
    v_row->'style_policy'
  );

  IF v_policy IS NULL OR jsonb_typeof(v_policy) <> 'object' THEN
    RETURN NEW;
  END IF;

  NEW.style_policy := v_policy;
  NEW.style_policy_version := NULLIF(
    v_policy->>'contractVersion',
    ''
  );
  NEW.style_base_policy_hash := NULLIF(
    v_policy->>'basePolicyHash',
    ''
  );
  NEW.style_policy_hash := NULLIF(v_policy->>'policyHash', '');
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_cross_tf_shadow_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF ROW(
    NEW.cross_tf_policy_version,
    NEW.cross_tf_policy,
    NEW.legacy_execution_decision,
    NEW.cross_tf_shadow_decision,
    NEW.cross_tf_disagreed,
    NEW.cross_tf_reason_codes,
    NEW.cross_tf_evaluation
  ) IS DISTINCT FROM ROW(
    OLD.cross_tf_policy_version,
    OLD.cross_tf_policy,
    OLD.legacy_execution_decision,
    OLD.cross_tf_shadow_decision,
    OLD.cross_tf_disagreed,
    OLD.cross_tf_reason_codes,
    OLD.cross_tf_evaluation
  ) THEN
    RAISE EXCEPTION 'cross-timeframe shadow evidence is immutable';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_cross_timeframe_zone_lineage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF ROW(
    NEW.timeframe_relationship,
    NEW.parent_candidate_id,
    NEW.candidate_lineage
  ) IS DISTINCT FROM ROW(
    OLD.timeframe_relationship,
    OLD.parent_candidate_id,
    OLD.candidate_lineage
  ) THEN
    RAISE EXCEPTION 'cross-timeframe zone lineage is immutable';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_prezone_observation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.execution_eligible = false
     AND NEW.execution_eligible = true THEN
    RAISE EXCEPTION
      'pre-zone observation % cannot become execution eligible; create a fresh candidate',
      OLD.id;
  END IF;

  IF NEW.execution_eligible = false
     AND NEW.setup_type IS DISTINCT FROM 'waiting_for_unified_zone' THEN
    RAISE EXCEPTION
      'non-executable staged setup must use waiting_for_unified_zone';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_scan_candle_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'scan candle snapshots are immutable';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_stop_policy_observation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'stop policy observations are immutable';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_strategy_evidence_certificate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.bot_id IS DISTINCT FROM OLD.bot_id
     OR NEW.feature_key IS DISTINCT FROM OLD.feature_key
     OR NEW.variant_key IS DISTINCT FROM OLD.variant_key
     OR NEW.activation_scope IS DISTINCT FROM OLD.activation_scope
     OR NEW.activation_scope_hash IS DISTINCT FROM OLD.activation_scope_hash
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.generator_version IS DISTINCT FROM OLD.generator_version
     OR NEW.certificate IS DISTINCT FROM OLD.certificate
     OR NEW.certificate_hash IS DISTINCT FROM OLD.certificate_hash
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.total_candidates IS DISTINCT FROM OLD.total_candidates
     OR NEW.evidence_count IS DISTINCT FROM OLD.evidence_count
     OR NEW.resolved_count IS DISTINCT FROM OLD.resolved_count
     OR NEW.changed_count IS DISTINCT FROM OLD.changed_count
     OR NEW.coverage_percent IS DISTINCT FROM OLD.coverage_percent
     OR NEW.beneficial_rate_percent IS DISTINCT FROM OLD.beneficial_rate_percent
     OR NEW.expectancy_delta_r IS DISTINCT FROM OLD.expectancy_delta_r
     OR NEW.max_drawdown_delta_percent IS DISTINCT
        FROM OLD.max_drawdown_delta_percent
     OR NEW.good_trade_retention_percent IS DISTINCT
        FROM OLD.good_trade_retention_percent
     OR NEW.out_of_sample_passed IS DISTINCT FROM OLD.out_of_sample_passed
     OR NEW.walk_forward_consistent IS DISTINCT
        FROM OLD.walk_forward_consistent
     OR NEW.source_window_start IS DISTINCT FROM OLD.source_window_start
     OR NEW.source_window_end IS DISTINCT FROM OLD.source_window_end
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at THEN
    RAISE EXCEPTION 'Strategy evidence certificate payload is immutable';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_zone_candidate_model_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF ROW(
    NEW.candidate_model_version,
    NEW.candidate_model_rank,
    NEW.candidate_model_winner,
    NEW.candidate_lifecycle_state,
    NEW.candidate_lifecycle,
    NEW.candidate_model
  ) IS DISTINCT FROM ROW(
    OLD.candidate_model_version,
    OLD.candidate_model_rank,
    OLD.candidate_model_winner,
    OLD.candidate_lifecycle_state,
    OLD.candidate_lifecycle,
    OLD.candidate_model
  ) THEN
    RAISE EXCEPTION 'zone candidate model evidence is immutable';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_zone_shadow_observation_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF ROW(
    NEW.user_id,
    NEW.bot_id,
    NEW.scan_cycle_id,
    NEW.observed_at,
    NEW.symbol,
    NEW.trading_style,
    NEW.style_policy_version,
    NEW.style_base_policy_hash,
    NEW.style_policy_hash,
    NEW.direction,
    NEW.candidate_id,
    NEW.zone_type,
    NEW.zone_low,
    NEW.zone_high,
    NEW.entry_price,
    NEW.stop_loss,
    NEW.take_profit,
    NEW.legacy_rank,
    NEW.shadow_rank,
    NEW.rank_delta,
    NEW.legacy_winner,
    NEW.shadow_winner,
    NEW.ranking_disagreed,
    NEW.legacy_zone_score,
    NEW.legacy_comparable_score,
    NEW.shadow_local_score,
    NEW.local_confluence,
    NEW.shadow_ranking
  ) IS DISTINCT FROM ROW(
    OLD.user_id,
    OLD.bot_id,
    OLD.scan_cycle_id,
    OLD.observed_at,
    OLD.symbol,
    OLD.trading_style,
    OLD.style_policy_version,
    OLD.style_base_policy_hash,
    OLD.style_policy_hash,
    OLD.direction,
    OLD.candidate_id,
    OLD.zone_type,
    OLD.zone_low,
    OLD.zone_high,
    OLD.entry_price,
    OLD.stop_loss,
    OLD.take_profit,
    OLD.legacy_rank,
    OLD.shadow_rank,
    OLD.rank_delta,
    OLD.legacy_winner,
    OLD.shadow_winner,
    OLD.ranking_disagreed,
    OLD.legacy_zone_score,
    OLD.legacy_comparable_score,
    OLD.shadow_local_score,
    OLD.local_confluence,
    OLD.shadow_ranking
  ) THEN
    RAISE EXCEPTION
      'zone shadow observation evidence is immutable';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_zone_shadow_replay_provenance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF ROW(
    NEW.evidence_source,
    NEW.replay_run_id,
    NEW.replay_contract_version,
    NEW.activation_eligible
  ) IS DISTINCT FROM ROW(
    OLD.evidence_source,
    OLD.replay_run_id,
    OLD.replay_contract_version,
    OLD.activation_eligible
  ) THEN
    RAISE EXCEPTION 'zone shadow replay provenance is immutable';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_zone_timeframe_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.bot_id IS DISTINCT FROM OLD.bot_id
     OR NEW.scan_cycle_id IS DISTINCT FROM OLD.scan_cycle_id
     OR NEW.symbol IS DISTINCT FROM OLD.symbol
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.evaluated_at IS DISTINCT FROM OLD.evaluated_at
     OR NEW.trading_style IS DISTINCT FROM OLD.trading_style
     OR NEW.style_policy_version IS DISTINCT FROM OLD.style_policy_version
     OR NEW.style_base_policy_hash IS DISTINCT FROM OLD.style_base_policy_hash
     OR NEW.style_policy_hash IS DISTINCT FROM OLD.style_policy_hash
     OR NEW.style_policy_snapshot::text IS DISTINCT FROM OLD.style_policy_snapshot::text
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.selected_timeframe IS DISTINCT FROM OLD.selected_timeframe
     OR NEW.final_reason IS DISTINCT FROM OLD.final_reason
     OR NEW.evidence_source IS DISTINCT FROM OLD.evidence_source
     OR NEW.replay_run_id IS DISTINCT FROM OLD.replay_run_id
     OR NEW.replay_provenance IS DISTINCT FROM OLD.replay_provenance
     OR NEW.parent_evidence_id IS DISTINCT FROM OLD.parent_evidence_id
     OR NEW.pending_order_id IS DISTINCT FROM OLD.pending_order_id
     OR NEW.confirmation_attempt IS DISTINCT FROM OLD.confirmation_attempt
     OR NEW.canonical_detector_version IS DISTINCT FROM OLD.canonical_detector_version
     OR NEW.canonical_parity IS DISTINCT FROM OLD.canonical_parity
     OR NEW.slots::text IS DISTINCT FROM OLD.slots::text
     OR NEW.engine_options::text IS DISTINCT FROM OLD.engine_options::text
     OR NEW.payload_truncated IS DISTINCT FROM OLD.payload_truncated
     OR NEW.truncation_detail::text IS DISTINCT FROM OLD.truncation_detail::text
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'zone_timeframe_evidence rows are immutable; only retention/link annotations may change';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.publish_strategy_evidence_certificate(p_user_id uuid, p_bot_id text, p_feature_key text, p_variant_key text, p_activation_scope jsonb, p_certificate jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_scope JSONB := COALESCE(p_activation_scope, '{}'::JSONB);
  v_scope_hash TEXT;
  v_certificate_hash TEXT;
  v_current public.strategy_evidence_certificates%ROWTYPE;
  v_inserted public.strategy_evidence_certificates%ROWTYPE;
  v_status TEXT;
  v_contract_version TEXT;
  v_generator_version TEXT;
  v_variant_key TEXT := trim(COALESCE(p_variant_key, 'default'));
BEGIN
  IF p_user_id IS NULL
     OR NULLIF(trim(COALESCE(p_bot_id, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_feature_key, '')), '') IS NULL
     OR jsonb_typeof(p_certificate) <> 'object' THEN
    RAISE EXCEPTION
      'Certificate user, bot, feature and object payload are required';
  END IF;

  v_contract_version := p_certificate->>'contractVersion';
  v_generator_version := p_certificate->>'generatorVersion';
  v_status := p_certificate#>>'{eligibility,status}';
  IF v_contract_version <> 'strategy-evidence.v1' THEN
    RAISE EXCEPTION 'Unsupported evidence contract: %', v_contract_version;
  END IF;
  IF NULLIF(v_generator_version, '') IS NULL THEN
    RAISE EXCEPTION 'Evidence generator version is required';
  END IF;
  IF p_certificate->>'featureKey' <> trim(p_feature_key)
     OR p_certificate->>'variantKey' <> v_variant_key THEN
    RAISE EXCEPTION 'Certificate feature or variant does not match request';
  END IF;
  IF v_status NOT IN ('collecting', 'eligible_log_only', 'keep_shadow') THEN
    RAISE EXCEPTION 'Invalid evidence status: %', v_status;
  END IF;

  v_scope_hash := public.strategy_activation_json_hash(v_scope);
  v_certificate_hash :=
    public.strategy_activation_json_hash(p_certificate);

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_user_id::TEXT || '|' || trim(p_bot_id) || '|'
      || trim(p_feature_key) || '|' || v_variant_key || '|'
      || v_scope_hash,
      0
    )
  );

  SELECT *
    INTO v_current
    FROM public.strategy_evidence_certificates
   WHERE user_id = p_user_id
     AND bot_id = trim(p_bot_id)
     AND feature_key = trim(p_feature_key)
     AND variant_key = v_variant_key
     AND activation_scope_hash = v_scope_hash
     AND is_current
   FOR UPDATE;

  IF FOUND AND v_current.certificate_hash = v_certificate_hash THEN
    RETURN jsonb_build_object(
      'changed', false,
      'code', 'certificate_unchanged',
      'row', to_jsonb(v_current)
    );
  END IF;

  UPDATE public.strategy_evidence_certificates
     SET is_current = false,
         superseded_at = now()
   WHERE user_id = p_user_id
     AND bot_id = trim(p_bot_id)
     AND feature_key = trim(p_feature_key)
     AND variant_key = v_variant_key
     AND activation_scope_hash = v_scope_hash
     AND is_current;

  INSERT INTO public.strategy_evidence_certificates (
    user_id,
    bot_id,
    feature_key,
    variant_key,
    activation_scope,
    activation_scope_hash,
    contract_version,
    generator_version,
    certificate,
    certificate_hash,
    status,
    total_candidates,
    evidence_count,
    resolved_count,
    changed_count,
    coverage_percent,
    beneficial_rate_percent,
    expectancy_delta_r,
    max_drawdown_delta_percent,
    good_trade_retention_percent,
    out_of_sample_passed,
    walk_forward_consistent,
    source_window_start,
    source_window_end,
    generated_at
  ) VALUES (
    p_user_id,
    trim(p_bot_id),
    trim(p_feature_key),
    v_variant_key,
    v_scope,
    v_scope_hash,
    v_contract_version,
    v_generator_version,
    p_certificate,
    v_certificate_hash,
    v_status,
    COALESCE((p_certificate#>>'{sample,totalCandidates}')::INTEGER, 0),
    COALESCE((p_certificate#>>'{sample,evidence}')::INTEGER, 0),
    COALESCE((p_certificate#>>'{sample,resolved}')::INTEGER, 0),
    COALESCE((p_certificate#>>'{sample,changed}')::INTEGER, 0),
    COALESCE((p_certificate#>>'{sample,coveragePercent}')::NUMERIC, 0),
    NULLIF(
      p_certificate#>>'{effect,beneficialRatePercent}',
      ''
    )::NUMERIC,
    COALESCE((p_certificate#>>'{effect,expectancyDeltaR}')::NUMERIC, 0),
    COALESCE(
      (p_certificate#>>'{effect,maxDrawdownDeltaPercent}')::NUMERIC,
      0
    ),
    COALESCE(
      (p_certificate#>>'{effect,goodTradeRetentionPercent}')::NUMERIC,
      100
    ),
    COALESCE(
      (p_certificate#>>'{validation,outOfSample}')::BOOLEAN,
      false
    ),
    COALESCE(
      (p_certificate#>>'{validation,walkForwardConsistent}')::BOOLEAN,
      false
    ),
    NULLIF(p_certificate#>>'{sourceWindow,start}', '')::TIMESTAMPTZ,
    NULLIF(p_certificate#>>'{sourceWindow,end}', '')::TIMESTAMPTZ,
    COALESCE(
      NULLIF(p_certificate->>'generatedAt', '')::TIMESTAMPTZ,
      now()
    )
  )
  RETURNING * INTO v_inserted;

  RETURN jsonb_build_object(
    'changed', true,
    'code', 'certificate_published',
    'runtimeEnforced', false,
    'row', to_jsonb(v_inserted)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.release_scanner_runtime_lock(p_user_id uuid, p_bot_id text, p_lock_scope text, p_lease_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  affected integer := 0;
BEGIN
  DELETE FROM public.scanner_runtime_locks
  WHERE user_id = p_user_id
    AND bot_id = p_bot_id
    AND lock_scope = p_lock_scope
    AND lease_token = p_lease_token;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.reserve_api_credit(p_provider text, p_limit integer, p_window_seconds integer DEFAULT 60, p_caller text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  used INT;
  -- How long rows stick around for inspection. Deliberately unrelated to
  -- p_window_seconds: shortening the rate window must not silently shorten
  -- the audit trail.
  retention_seconds CONSTANT INT := 1800;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('api_credit:' || p_provider));

  DELETE FROM public.api_credit_usage
   WHERE provider = p_provider
     AND reserved_at < now() - make_interval(secs => retention_seconds);

  SELECT count(*) INTO used
    FROM public.api_credit_usage
   WHERE provider = p_provider
     AND reserved_at > now() - make_interval(secs => p_window_seconds);

  IF used >= p_limit THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.api_credit_usage (provider, caller) VALUES (p_provider, p_caller);
  RETURN TRUE;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.resolve_scanner_operational_alert(p_user_id uuid, p_bot_id text, p_alert_type text, p_dedupe_key text DEFAULT 'default'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  affected integer := 0;
BEGIN
  UPDATE public.scanner_operational_alerts
  SET
    status = 'resolved',
    resolved_at = now(),
    updated_at = now()
  WHERE user_id = p_user_id
    AND bot_id = COALESCE(NULLIF(p_bot_id, ''), 'smc')
    AND alert_type = p_alert_type
    AND dedupe_key = COALESCE(NULLIF(p_dedupe_key, ''), 'default')
    AND status = 'active';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.retarget_pending_to_impulse_candidate(p_pending_id uuid, p_user_id uuid, p_bot_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pending public.pending_orders%ROWTYPE;
  v_authority public.impulse_entry_lifecycles%ROWTYPE;
  v_candidate JSONB;
  v_entry NUMERIC;
  v_stop NUMERIC;
BEGIN
  SELECT * INTO v_pending FROM public.pending_orders
   WHERE id = p_pending_id AND user_id = p_user_id AND bot_id = p_bot_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('retargeted', false, 'code', 'order_missing'); END IF;

  SELECT * INTO v_authority FROM public.impulse_entry_lifecycles
   WHERE id = v_pending.impulse_entry_lifecycle_id FOR UPDATE;
  IF NOT FOUND OR v_authority.mode <> 'enforce' OR v_authority.status <> 'active' THEN
    RETURN jsonb_build_object('retargeted', false, 'code', 'authority_not_enforcing');
  END IF;

  SELECT candidate INTO v_candidate
    FROM jsonb_array_elements(v_authority.lifecycle -> 'candidates') candidate
   WHERE candidate ->> 'id' = v_authority.active_candidate_id;
  IF v_candidate IS NULL THEN
    RETURN jsonb_build_object('retargeted', false, 'code', 'candidate_missing');
  END IF;

  v_entry := CASE WHEN v_pending.direction = 'long'
    THEN (v_candidate ->> 'high')::NUMERIC ELSE (v_candidate ->> 'low')::NUMERIC END;
  v_stop := (v_authority.lifecycle #>> '{impulse,protectedLevel}')::NUMERIC;
  IF (v_pending.direction = 'long' AND v_stop >= v_entry)
    OR (v_pending.direction = 'short' AND v_stop <= v_entry) THEN
    RETURN jsonb_build_object('retargeted', false, 'code', 'invalid_stop_orientation');
  END IF;

  UPDATE public.pending_orders SET
    entry_zone_type = v_candidate ->> 'type',
    entry_zone_low = (v_candidate ->> 'low')::NUMERIC,
    entry_zone_high = (v_candidate ->> 'high')::NUMERIC,
    refined_zone_low = NULL,
    refined_zone_high = NULL,
    entry_price = v_entry,
    stop_loss = v_stop,
    status = 'pending',
    zone_touch_time = NULL,
    confirmation_attempts = 0,
    cancel_reason = NULL,
    resolved_at = NULL,
    signal_reason = COALESCE(v_pending.signal_reason, '{}'::JSONB) || jsonb_build_object(
      'impulseLifecycleRetarget', jsonb_build_object(
        'candidateId', v_authority.active_candidate_id,
        'generation', v_authority.lifecycle #>> '{confirmation,generation}',
        'authorizedBy', 'frozen_setup_config',
        'retargetedAt', now()
      )
    )
  WHERE id = v_pending.id;

  RETURN jsonb_build_object(
    'retargeted', true, 'candidate_id', v_authority.active_candidate_id,
    'entry_price', v_entry, 'stop_loss', v_stop
  );
END; $function$
;

CREATE OR REPLACE FUNCTION public.review_impulse_lifecycle_certificate(p_evidence_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row public.impulse_lifecycle_enforcement_certificates%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.impulse_lifecycle_enforcement_certificates
   WHERE user_id = auth.uid() AND bot_id = 'smc' AND evidence_hash = p_evidence_hash
     AND is_current FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current certificate not found'; END IF;
  IF v_row.status <> 'eligible' OR NOT v_row.minimum_sample_ready THEN
    RAISE EXCEPTION 'Certificate is not eligible for enforcement';
  END IF;
  UPDATE public.impulse_lifecycle_enforcement_certificates
     SET reviewed = true, reviewed_at = now()
   WHERE id = v_row.id;
  RETURN jsonb_build_object('reviewed', true, 'evidence_hash', p_evidence_hash);
END; $function$
;

CREATE OR REPLACE FUNCTION public.set_strategy_runtime_enforcement(p_user_id uuid, p_bot_id text, p_feature_key text, p_variant_key text, p_activation_scope jsonb, p_enabled boolean, p_reason text, p_actor_id uuid DEFAULT NULL::uuid, p_expected_revision integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_scope JSONB := COALESCE(p_activation_scope, '{}'::JSONB);
  v_scope_hash TEXT;
  v_row public.strategy_activation_registry%ROWTYPE;
  v_previous_enforced BOOLEAN;
BEGIN
  IF p_user_id IS NULL
     OR NULLIF(trim(COALESCE(p_bot_id, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_feature_key, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_variant_key, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION
      'User, bot, feature, variant and reason are required';
  END IF;

  v_scope_hash := public.strategy_activation_json_hash(v_scope);
  SELECT *
    INTO v_row
    FROM public.strategy_activation_registry
   WHERE user_id = p_user_id
     AND bot_id = trim(p_bot_id)
     AND feature_key = trim(p_feature_key)
     AND variant_key = trim(p_variant_key)
     AND activation_scope_hash = v_scope_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Strategy activation record does not exist';
  END IF;
  IF p_expected_revision IS NOT NULL
     AND v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION
      'Activation revision conflict: expected %, found %',
      p_expected_revision,
      v_row.revision;
  END IF;
  IF p_enabled AND (
    v_row.authority_stage NOT IN ('soft_adjustment', 'hard_block')
    OR v_row.runtime_scope NOT IN ('paper', 'live_canary', 'live')
    OR v_row.approved_at IS NULL
    OR v_row.approved_by IS NULL
    OR v_row.evidence_window_start IS NULL
    OR v_row.evidence_window_end IS NULL
    OR v_row.evidence_snapshot = '{}'::JSONB
  ) THEN
    RAISE EXCEPTION
      'Runtime enforcement requires approved Soft/Hard authority, paper-or-later scope and a dated evidence snapshot';
  END IF;

  v_previous_enforced := v_row.runtime_enforced;
  IF v_previous_enforced = p_enabled THEN
    RETURN jsonb_build_object(
      'changed', false,
      'code', 'already_at_requested_runtime_state',
      'row', to_jsonb(v_row)
    );
  END IF;

  UPDATE public.strategy_activation_registry
     SET runtime_enforced = p_enabled,
         transition_reason = trim(p_reason),
         approved_by = COALESCE(p_actor_id, approved_by),
         approved_at = CASE
           WHEN p_enabled THEN COALESCE(approved_at, now())
           ELSE approved_at
         END,
         revision = revision + 1,
         updated_at = now()
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  INSERT INTO public.strategy_activation_events (
    activation_id,
    user_id,
    bot_id,
    feature_key,
    variant_key,
    from_authority_stage,
    to_authority_stage,
    from_runtime_scope,
    to_runtime_scope,
    evidence_contract_version,
    evidence_snapshot,
    evidence_hash,
    reason,
    actor_id,
    revision
  ) VALUES (
    v_row.id,
    v_row.user_id,
    v_row.bot_id,
    v_row.feature_key,
    v_row.variant_key,
    v_row.authority_stage,
    v_row.authority_stage,
    v_row.runtime_scope,
    v_row.runtime_scope,
    v_row.evidence_contract_version,
    v_row.evidence_snapshot,
    v_row.evidence_hash,
    trim(p_reason) || CASE
      WHEN p_enabled THEN ' [runtime enabled]'
      ELSE ' [runtime disabled]'
    END,
    p_actor_id,
    v_row.revision
  );

  RETURN jsonb_build_object(
    'changed', true,
    'code', CASE
      WHEN p_enabled THEN 'runtime_enabled'
      ELSE 'runtime_disabled'
    END,
    'row', to_jsonb(v_row)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.strategy_activation_json_hash(p_value jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT encode(
    extensions.digest(
      convert_to(COALESCE(p_value, '{}'::JSONB)::TEXT, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.sync_staged_setup_from_live_position_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.staged_setup_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.position_status = $s$open$s$ THEN
    UPDATE public.staged_setups SET status = $s$filled$s$,
      lifecycle_reason = $s$Broker-confirmed position opened$s$, position_id = NEW.id,
      authorization_result = COALESCE(NEW.final_authorization, authorization_result),
      resolved_at = COALESCE(resolved_at, now()), updated_at = now()
    WHERE id = NEW.staged_setup_id;
  ELSE
    UPDATE public.staged_setups SET status = $s$pending$s$,
      lifecycle_reason = CASE NEW.broker_execution_state
        WHEN $s$reconciliation_required$s$ THEN $s$Broker outcome requires reconciliation$s$
        WHEN $s$rejected$s$ THEN $s$No broker confirmed the live order$s$
        ELSE $s$Live order submitted; awaiting broker confirmation$s$ END,
      position_id = NEW.id, resolved_at = NULL, updated_at = now()
    WHERE id = NEW.staged_setup_id;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_staged_setup_from_pending()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_reason TEXT; v_staged_status TEXT;
BEGIN
  IF NEW.staged_setup_id IS NULL THEN RETURN NEW; END IF;
  v_reason := COALESCE(NEW.fill_reason, NEW.cancel_reason, format($s$Pending order moved to %s$s$, NEW.status));
  v_staged_status := CASE
    WHEN NEW.status IN ($s$reconciliation_required$s$, $s$broker_rejected$s$) THEN $s$pending$s$
    ELSE NEW.status
  END;
  UPDATE public.staged_setups SET status = v_staged_status,
    lifecycle_reason = v_reason, pending_order_id = NEW.id,
    authorization_result = COALESCE(NEW.final_authorization, authorization_result),
    originating_zone = COALESCE(NEW.originating_zone, originating_zone),
    confirmation_method = COALESCE(NEW.confirmation_method, confirmation_method),
    confirmation_config = COALESCE(NEW.confirmation_config, confirmation_config),
    resolved_at = CASE WHEN NEW.status IN ($s$filled$s$, $s$invalidated$s$, $s$expired$s$, $s$cancelled$s$)
      THEN COALESCE(resolved_at, now()) ELSE NULL END,
    updated_at = now()
  WHERE id = NEW.staged_setup_id;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_staged_setup_from_position()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.staged_setup_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.staged_setups
     SET status = 'filled',
         lifecycle_reason = 'Position successfully created',
         position_id = NEW.id,
         authorization_result = COALESCE(
           NEW.final_authorization,
           authorization_result
         ),
         resolved_at = COALESCE(resolved_at, now()),
         updated_at = now()
   WHERE id = NEW.staged_setup_id
     AND status IN (
       'qualified',
       'pending',
       'awaiting_confirmation',
       'filled'
     );

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.transition_staged_setup(p_setup_id uuid, p_user_id uuid, p_to_status text, p_reason text, p_evidence jsonb DEFAULT '{}'::jsonb, p_pending_order_id uuid DEFAULT NULL::uuid, p_position_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_setup public.staged_setups%ROWTYPE;
  v_allowed BOOLEAN := false;
BEGIN
  SELECT *
    INTO v_setup
    FROM public.staged_setups
   WHERE id = p_setup_id
     AND user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'transitioned', false,
      'code', 'setup_not_found',
      'reason', 'Watchlist setup was not found'
    );
  END IF;

  IF v_setup.status = p_to_status THEN
    v_allowed := true;
  ELSIF v_setup.status = 'watching' THEN
    v_allowed := p_to_status IN (
      'qualified', 'invalidated', 'expired', 'cancelled'
    );
  ELSIF v_setup.status = 'qualified' THEN
    v_allowed := p_to_status IN (
      'pending', 'filled', 'blocked_after_qualification',
      'invalidated', 'expired', 'cancelled'
    );
  ELSIF v_setup.status = 'pending' THEN
    v_allowed := p_to_status IN (
      'awaiting_confirmation', 'filled', 'invalidated',
      'expired', 'cancelled'
    );
  ELSIF v_setup.status = 'awaiting_confirmation' THEN
    v_allowed := p_to_status IN (
      'pending', 'filled', 'invalidated', 'expired', 'cancelled'
    );
  END IF;

  IF NOT v_allowed THEN
    RETURN jsonb_build_object(
      'transitioned', false,
      'code', 'invalid_transition',
      'reason', format(
        'Setup lifecycle cannot transition from %s to %s',
        v_setup.status,
        p_to_status
      )
    );
  END IF;

  UPDATE public.staged_setups
     SET status = p_to_status,
         lifecycle_reason = p_reason,
         lifecycle_reason_code = COALESCE(
           NULLIF(p_evidence->>'reasonCode', ''),
           'legacy_transition'
         ),
         lifecycle_evidence = COALESCE(
           p_evidence->'lifecycleEvidence',
           '{}'::JSONB
         ),
         qualified_at = CASE
           WHEN p_to_status = 'qualified'
             THEN COALESCE(qualified_at, now())
           ELSE qualified_at
         END,
         resolved_at = CASE
           WHEN p_to_status IN (
             'filled',
             'blocked_after_qualification',
             'invalidated',
             'expired',
             'cancelled'
           ) THEN COALESCE(resolved_at, now())
           ELSE NULL
         END,
         pending_order_id = COALESCE(
           p_pending_order_id,
           pending_order_id
         ),
         position_id = COALESCE(p_position_id, position_id),
         authorization_result = COALESCE(
           p_evidence->'authorizationResult',
           authorization_result
         ),
         originating_zone = COALESCE(
           p_evidence->'originatingZone',
           originating_zone
         ),
         confirmation_method = COALESCE(
           p_evidence->>'confirmationMethod',
           confirmation_method
         ),
         confirmation_config = COALESCE(
           p_evidence->'confirmationConfig',
           confirmation_config,
           '{}'::JSONB
         ),
         game_plan_id = COALESCE(
           NULLIF(p_evidence->>'gamePlanId', '')::UUID,
           game_plan_id
         ),
         game_plan_version = COALESCE(
           p_evidence->>'gamePlanVersion',
           game_plan_version
         ),
         direction_verdict_id = COALESCE(
           NULLIF(p_evidence->>'directionVerdictId', '')::UUID,
           direction_verdict_id
         ),
         direction_verdict = COALESCE(
           p_evidence->'directionVerdict',
           direction_verdict
         ),
         thesis_version = COALESCE(
           p_evidence->>'thesisVersion',
           thesis_version
         ),
         updated_at = now()
   WHERE id = v_setup.id
   RETURNING * INTO v_setup;

  RETURN jsonb_build_object(
    'transitioned', true,
    'code', 'transitioned',
    'row', to_jsonb(v_setup)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.transition_strategy_activation(p_user_id uuid, p_bot_id text, p_feature_key text, p_variant_key text, p_activation_scope jsonb, p_to_authority_stage text, p_to_runtime_scope text, p_reason text, p_evidence_snapshot jsonb, p_evidence_window_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_evidence_window_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_actor_id uuid DEFAULT NULL::uuid, p_expected_revision integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_row public.strategy_activation_registry%ROWTYPE;
  v_scope JSONB := COALESCE(p_activation_scope, '{}'::JSONB);
  v_evidence JSONB := COALESCE(p_evidence_snapshot, '{}'::JSONB);
  v_scope_hash TEXT;
  v_from_stage_rank INTEGER;
  v_to_stage_rank INTEGER;
  v_from_scope_rank INTEGER;
  v_to_scope_rank INTEGER;
  v_resolved INTEGER;
  v_changed INTEGER;
  v_coverage NUMERIC;
  v_beneficial_rate NUMERIC;
  v_paper_resolved INTEGER;
  v_canary_resolved INTEGER;
  v_expectancy_delta NUMERIC;
  v_drawdown_delta NUMERIC;
  v_retention NUMERIC;
  v_is_rollback BOOLEAN := false;
BEGIN
  IF p_user_id IS NULL
     OR NULLIF(trim(COALESCE(p_bot_id, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_feature_key, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_variant_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Activation user, bot, feature and variant are required';
  END IF;
  IF p_to_authority_stage NOT IN (
    'shadow', 'log_only', 'soft_adjustment', 'hard_block'
  ) THEN
    RAISE EXCEPTION 'Invalid authority stage: %', p_to_authority_stage;
  END IF;
  IF p_to_runtime_scope NOT IN (
    'observation', 'paper', 'live_canary', 'live'
  ) THEN
    RAISE EXCEPTION 'Invalid runtime scope: %', p_to_runtime_scope;
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Every activation transition requires a reason';
  END IF;
  IF p_evidence_window_start IS NOT NULL
     AND p_evidence_window_end IS NOT NULL
     AND p_evidence_window_end < p_evidence_window_start THEN
    RAISE EXCEPTION 'Evidence window end must not precede its start';
  END IF;

  v_scope_hash := public.strategy_activation_json_hash(v_scope);

  INSERT INTO public.strategy_activation_registry (
    user_id,
    bot_id,
    feature_key,
    variant_key,
    activation_scope,
    activation_scope_hash,
    authority_stage,
    runtime_scope,
    evidence_snapshot,
    evidence_hash,
    transition_reason
  ) VALUES (
    p_user_id,
    trim(p_bot_id),
    trim(p_feature_key),
    trim(p_variant_key),
    v_scope,
    v_scope_hash,
    'shadow',
    'observation',
    '{}'::JSONB,
    public.strategy_activation_json_hash('{}'::JSONB),
    'Initialized in safe Shadow / Observation state'
  )
  ON CONFLICT (
    user_id,
    bot_id,
    feature_key,
    variant_key,
    activation_scope_hash
  ) DO NOTHING;

  SELECT *
    INTO v_row
    FROM public.strategy_activation_registry
   WHERE user_id = p_user_id
     AND bot_id = trim(p_bot_id)
     AND feature_key = trim(p_feature_key)
     AND variant_key = trim(p_variant_key)
     AND activation_scope_hash = v_scope_hash
   FOR UPDATE;

  IF p_expected_revision IS NOT NULL
     AND v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION
      'Activation revision conflict: expected %, found %',
      p_expected_revision,
      v_row.revision;
  END IF;

  IF v_row.authority_stage = p_to_authority_stage
     AND v_row.runtime_scope = p_to_runtime_scope THEN
    RETURN jsonb_build_object(
      'changed', false,
      'code', 'already_at_requested_state',
      'row', to_jsonb(v_row)
    );
  END IF;

  v_from_stage_rank := CASE v_row.authority_stage
    WHEN 'shadow' THEN 0
    WHEN 'log_only' THEN 1
    WHEN 'soft_adjustment' THEN 2
    WHEN 'hard_block' THEN 3
  END;
  v_to_stage_rank := CASE p_to_authority_stage
    WHEN 'shadow' THEN 0
    WHEN 'log_only' THEN 1
    WHEN 'soft_adjustment' THEN 2
    WHEN 'hard_block' THEN 3
  END;
  v_from_scope_rank := CASE v_row.runtime_scope
    WHEN 'observation' THEN 0
    WHEN 'paper' THEN 1
    WHEN 'live_canary' THEN 2
    WHEN 'live' THEN 3
  END;
  v_to_scope_rank := CASE p_to_runtime_scope
    WHEN 'observation' THEN 0
    WHEN 'paper' THEN 1
    WHEN 'live_canary' THEN 2
    WHEN 'live' THEN 3
  END;

  v_is_rollback :=
    v_to_stage_rank < v_from_stage_rank
    OR v_to_scope_rank < v_from_scope_rank;

  IF v_is_rollback THEN
    IF p_to_authority_stage <> 'shadow'
       OR p_to_runtime_scope <> 'observation' THEN
      RAISE EXCEPTION
        'Rollback must return directly to Shadow / Observation';
    END IF;
  ELSE
    IF (
      (v_to_stage_rank - v_from_stage_rank)
      + (v_to_scope_rank - v_from_scope_rank)
    ) <> 1 THEN
      RAISE EXCEPTION
        'Forward activation must advance exactly one stage or one runtime scope';
    END IF;

    v_resolved := COALESCE(
      NULLIF(v_evidence#>>'{sample,resolved}', '')::INTEGER,
      0
    );
    v_changed := COALESCE(
      NULLIF(v_evidence#>>'{sample,changed}', '')::INTEGER,
      0
    );
    v_coverage := COALESCE(
      NULLIF(v_evidence#>>'{sample,coveragePercent}', '')::NUMERIC,
      0
    );
    v_beneficial_rate := COALESCE(
      NULLIF(v_evidence#>>'{effect,beneficialRatePercent}', '')::NUMERIC,
      0
    );
    v_paper_resolved := COALESCE(
      NULLIF(v_evidence#>>'{sample,paperResolved}', '')::INTEGER,
      0
    );
    v_canary_resolved := COALESCE(
      NULLIF(v_evidence#>>'{sample,liveCanaryResolved}', '')::INTEGER,
      0
    );
    v_expectancy_delta := COALESCE(
      NULLIF(v_evidence#>>'{effect,expectancyDeltaR}', '')::NUMERIC,
      0
    );
    v_drawdown_delta := COALESCE(
      NULLIF(v_evidence#>>'{effect,maxDrawdownDeltaPercent}', '')::NUMERIC,
      0
    );
    v_retention := COALESCE(
      NULLIF(v_evidence#>>'{effect,goodTradeRetentionPercent}', '')::NUMERIC,
      0
    );

    IF v_row.authority_stage = 'shadow'
       AND p_to_authority_stage = 'log_only'
       AND (
         v_resolved < 30
         OR v_changed < 10
         OR v_coverage < 50
         OR v_beneficial_rate < 60
         OR COALESCE((v_evidence#>>'{validation,outOfSample}')::BOOLEAN, false) = false
         OR COALESCE((v_evidence#>>'{validation,walkForwardConsistent}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Log-only promotion requires 30 resolved, 10 changed, 50%% coverage, 60%% useful, out-of-sample and walk-forward evidence';
    END IF;

    IF v_row.runtime_scope = 'observation'
       AND p_to_runtime_scope = 'paper'
       AND (
         v_row.authority_stage <> 'log_only'
         OR COALESCE((v_evidence#>>'{approval,userConfirmed}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Paper scope requires Log-only authority and explicit user approval';
    END IF;

    IF v_row.authority_stage = 'log_only'
       AND p_to_authority_stage = 'soft_adjustment'
       AND (
         v_row.runtime_scope <> 'paper'
         OR v_paper_resolved < 30
         OR v_expectancy_delta <= 0
         OR v_drawdown_delta > 0
         OR v_retention < 70
         OR COALESCE((v_evidence#>>'{validation,paperForwardPassed}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Soft adjustment requires positive 30-sample paper-forward evidence without worse drawdown';
    END IF;

    IF v_row.runtime_scope = 'paper'
       AND p_to_runtime_scope = 'live_canary'
       AND (
         v_row.authority_stage <> 'soft_adjustment'
         OR v_paper_resolved < 30
         OR v_expectancy_delta <= 0
         OR COALESCE((v_evidence#>>'{approval,userConfirmed}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Live canary requires proven soft adjustment in paper and explicit user approval';
    END IF;

    IF v_row.authority_stage = 'soft_adjustment'
       AND p_to_authority_stage = 'hard_block'
       AND (
         v_row.runtime_scope <> 'live_canary'
         OR v_canary_resolved < 20
         OR v_expectancy_delta <= 0
         OR v_drawdown_delta > 0
         OR v_retention < 70
         OR COALESCE((v_evidence#>>'{validation,liveCanaryPassed}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Hard block requires positive 20-sample live-canary evidence without worse drawdown';
    END IF;

    IF v_row.runtime_scope = 'live_canary'
       AND p_to_runtime_scope = 'live'
       AND (
         v_row.authority_stage <> 'hard_block'
         OR v_canary_resolved < 20
         OR COALESCE((v_evidence#>>'{approval,userConfirmed}')::BOOLEAN, false) = false
       ) THEN
      RAISE EXCEPTION
        'Full live scope requires canary-tested Hard-block authority and explicit user approval';
    END IF;
  END IF;

  UPDATE public.strategy_activation_registry
     SET authority_stage = p_to_authority_stage,
         runtime_scope = p_to_runtime_scope,
         evidence_snapshot = v_evidence,
         evidence_hash = public.strategy_activation_json_hash(v_evidence),
         evidence_window_start = p_evidence_window_start,
         evidence_window_end = p_evidence_window_end,
         transition_reason = trim(p_reason),
         approved_by = p_actor_id,
         approved_at = now(),
         runtime_enforced = false,
         revision = revision + 1,
         updated_at = now()
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  INSERT INTO public.strategy_activation_events (
    activation_id,
    user_id,
    bot_id,
    feature_key,
    variant_key,
    from_authority_stage,
    to_authority_stage,
    from_runtime_scope,
    to_runtime_scope,
    evidence_contract_version,
    evidence_snapshot,
    evidence_hash,
    reason,
    actor_id,
    revision
  ) VALUES (
    v_row.id,
    v_row.user_id,
    v_row.bot_id,
    v_row.feature_key,
    v_row.variant_key,
    CASE v_from_stage_rank
      WHEN 0 THEN 'shadow'
      WHEN 1 THEN 'log_only'
      WHEN 2 THEN 'soft_adjustment'
      WHEN 3 THEN 'hard_block'
    END,
    v_row.authority_stage,
    CASE v_from_scope_rank
      WHEN 0 THEN 'observation'
      WHEN 1 THEN 'paper'
      WHEN 2 THEN 'live_canary'
      WHEN 3 THEN 'live'
    END,
    v_row.runtime_scope,
    v_row.evidence_contract_version,
    v_row.evidence_snapshot,
    v_row.evidence_hash,
    trim(p_reason),
    p_actor_id,
    v_row.revision
  );

  RETURN jsonb_build_object(
    'changed', true,
    'code', CASE WHEN v_is_rollback THEN 'rolled_back' ELSE 'transitioned' END,
    'runtimeEnforced', false,
    'row', to_jsonb(v_row)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_scanner_operational_alert(p_user_id uuid, p_bot_id text, p_alert_type text, p_dedupe_key text, p_severity text, p_title text, p_message text, p_run_id uuid DEFAULT NULL::uuid, p_evidence jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  alert_id uuid;
BEGIN
  INSERT INTO public.scanner_operational_alerts (
    user_id,
    bot_id,
    alert_type,
    dedupe_key,
    severity,
    status,
    title,
    message,
    run_id,
    evidence,
    occurrences,
    first_detected_at,
    last_detected_at,
    updated_at
  )
  VALUES (
    p_user_id,
    COALESCE(NULLIF(p_bot_id, ''), 'smc'),
    p_alert_type,
    COALESCE(NULLIF(p_dedupe_key, ''), 'default'),
    p_severity,
    'active',
    p_title,
    p_message,
    p_run_id,
    COALESCE(p_evidence, '{}'::jsonb),
    1,
    now(),
    now(),
    now()
  )
  ON CONFLICT (user_id, bot_id, alert_type, dedupe_key)
    WHERE status = 'active'
  DO UPDATE SET
    severity = EXCLUDED.severity,
    title = EXCLUDED.title,
    message = EXCLUDED.message,
    run_id = EXCLUDED.run_id,
    evidence = EXCLUDED.evidence,
    occurrences = public.scanner_operational_alerts.occurrences + 1,
    last_detected_at = now(),
    updated_at = now()
  RETURNING id INTO alert_id;

  RETURN alert_id;
END;
$function$
;


-- ========================================================================
-- TRIGGERS  (59 statements)
-- ========================================================================

CREATE TRIGGER on_auth_user_created_profile AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user_profile();

CREATE TRIGGER populate_direction_verdict_style_policy BEFORE INSERT OR UPDATE OF verdict_json, style_policy ON public.active_direction_verdicts FOR EACH ROW EXECUTE FUNCTION populate_strategy_style_policy();

CREATE TRIGGER populate_game_plan_style_policy BEFORE INSERT OR UPDATE OF config_snapshot, style_policy ON public.active_game_plans FOR EACH ROW EXECUTE FUNCTION populate_strategy_style_policy();

CREATE TRIGGER audit_bot_config_change AFTER INSERT OR DELETE OR UPDATE ON public.bot_configs FOR EACH ROW EXECUTE FUNCTION audit_bot_config_change();

CREATE TRIGGER update_bot_configs_updated_at BEFORE UPDATE ON public.bot_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_broker_connections_updated_at BEFORE UPDATE ON public.broker_connections FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_config_presets_updated_at BEFORE UPDATE ON public.config_presets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_manual_impulses_updated_at BEFORE UPDATE ON public.manual_impulses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_paper_accounts_updated_at BEFORE UPDATE ON public.paper_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER attach_impulse_entry_lifecycle BEFORE INSERT OR UPDATE OF frozen_strategy_context ON public.paper_positions FOR EACH ROW EXECUTE FUNCTION attach_impulse_entry_lifecycle();

CREATE TRIGGER populate_position_decision_context BEFORE INSERT OR UPDATE OF final_authorization, decision_context ON public.paper_positions FOR EACH ROW EXECUTE FUNCTION populate_position_decision_context();

CREATE TRIGGER populate_position_lifecycle_context BEFORE INSERT OR UPDATE OF signal_reason ON public.paper_positions FOR EACH ROW EXECUTE FUNCTION populate_position_lifecycle_context();

CREATE TRIGGER populate_position_style_policy BEFORE INSERT OR UPDATE OF final_authorization, decision_context, style_policy ON public.paper_positions FOR EACH ROW EXECUTE FUNCTION populate_execution_style_policy();

CREATE TRIGGER sync_staged_setup_from_position AFTER INSERT ON public.paper_positions FOR EACH ROW EXECUTE FUNCTION sync_staged_setup_from_position();

CREATE TRIGGER trg_freeze_streamlined_decision BEFORE INSERT OR UPDATE ON public.paper_positions FOR EACH ROW EXECUTE FUNCTION freeze_streamlined_decision_origin();

CREATE TRIGGER zz_freeze_position_strategy_context BEFORE INSERT OR UPDATE OF frozen_strategy_context, frozen_strategy_hash, policy_frozen_at, signal_reason, final_authorization, decision_context, style_policy, style_policy_version, style_base_policy_hash, style_policy_hash ON public.paper_positions FOR EACH ROW EXECUTE FUNCTION freeze_setup_strategy_context();

CREATE TRIGGER zz_sync_staged_setup_from_live_position_state AFTER INSERT OR UPDATE OF position_status, broker_execution_state ON public.paper_positions FOR EACH ROW WHEN ((new.staged_setup_id IS NOT NULL)) EXECUTE FUNCTION sync_staged_setup_from_live_position_state();

CREATE TRIGGER zzz_guard_position_prezone_execution BEFORE INSERT OR UPDATE OF staged_setup_id, candidate_id, signal_reason ON public.paper_positions FOR EACH ROW EXECUTE FUNCTION guard_prezone_observation_execution();

CREATE TRIGGER trg_freeze_streamlined_decision BEFORE INSERT OR UPDATE ON public.paper_trade_history FOR EACH ROW EXECUTE FUNCTION freeze_streamlined_decision_origin();

CREATE TRIGGER attach_impulse_entry_lifecycle BEFORE INSERT OR UPDATE OF frozen_strategy_context ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION attach_impulse_entry_lifecycle();

CREATE TRIGGER persist_pending_fill_authorization AFTER UPDATE OF status, final_authorization ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION persist_pending_fill_authorization();

CREATE TRIGGER populate_pending_decision_context BEFORE INSERT OR UPDATE OF signal_reason, final_authorization, decision_context ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION populate_pending_decision_context();

CREATE TRIGGER populate_pending_lifecycle_context BEFORE INSERT OR UPDATE OF signal_reason ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION populate_pending_lifecycle_context();

CREATE TRIGGER populate_pending_order_style_policy BEFORE INSERT OR UPDATE OF signal_reason, final_authorization, decision_context, style_policy ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION populate_execution_style_policy();

CREATE TRIGGER set_pending_orders_updated_at BEFORE UPDATE ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER sync_staged_setup_from_pending AFTER INSERT OR UPDATE OF status, final_authorization ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION sync_staged_setup_from_pending();

CREATE TRIGGER trg_freeze_streamlined_decision BEFORE INSERT OR UPDATE ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION freeze_streamlined_decision_origin();

CREATE TRIGGER zz_freeze_pending_order_strategy_context BEFORE INSERT OR UPDATE OF frozen_strategy_context, frozen_strategy_hash, policy_frozen_at, signal_reason, final_authorization, decision_context, style_policy, style_policy_version, style_base_policy_hash, style_policy_hash ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION freeze_setup_strategy_context();

CREATE TRIGGER zz_hold_staged_setup_until_live_broker_confirmation AFTER INSERT OR UPDATE OF status ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION hold_staged_setup_until_live_broker_confirmation();

CREATE TRIGGER zzz_guard_pending_prezone_execution BEFORE INSERT OR UPDATE OF staged_setup_id, candidate_id, signal_reason ON public.pending_orders FOR EACH ROW EXECUTE FUNCTION guard_prezone_observation_execution();

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_prop_firm_config_updated_at BEFORE UPDATE ON public.prop_firm_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_freeze_streamlined_decision BEFORE INSERT OR UPDATE ON public.rejected_setups FOR EACH ROW EXECUTE FUNCTION freeze_streamlined_decision_origin();

CREATE TRIGGER protect_scan_candle_snapshot_trg BEFORE UPDATE ON public.scan_candle_snapshots FOR EACH ROW EXECUTE FUNCTION protect_scan_candle_snapshot();

CREATE TRIGGER attach_impulse_entry_lifecycle BEFORE INSERT OR UPDATE OF frozen_strategy_context ON public.staged_setups FOR EACH ROW EXECUTE FUNCTION attach_impulse_entry_lifecycle();

CREATE TRIGGER audit_staged_setup_transition AFTER INSERT OR UPDATE OF status, lifecycle_phase, lifecycle_reason_code ON public.staged_setups FOR EACH ROW EXECUTE FUNCTION audit_staged_setup_transition();

CREATE TRIGGER populate_staged_setup_lifecycle_phase BEFORE INSERT OR UPDATE OF status, lifecycle_evidence, lifecycle_phase, position_id ON public.staged_setups FOR EACH ROW EXECUTE FUNCTION populate_staged_setup_lifecycle_phase();

CREATE TRIGGER populate_staged_setup_style_policy BEFORE INSERT OR UPDATE OF authorization_result, style_policy ON public.staged_setups FOR EACH ROW EXECUTE FUNCTION populate_execution_style_policy();

CREATE TRIGGER set_staged_setups_updated_at BEFORE UPDATE ON public.staged_setups FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_freeze_streamlined_decision BEFORE INSERT OR UPDATE ON public.staged_setups FOR EACH ROW EXECUTE FUNCTION freeze_streamlined_decision_origin();

CREATE TRIGGER trg_mirror_staged_setup_resolution_reason BEFORE INSERT OR UPDATE ON public.staged_setups FOR EACH ROW EXECUTE FUNCTION mirror_staged_setup_resolution_reason();

CREATE TRIGGER zz_freeze_staged_setup_strategy_context BEFORE INSERT OR UPDATE OF frozen_strategy_context, frozen_strategy_hash, policy_frozen_at, authorization_result, style_policy, style_policy_version, style_base_policy_hash, style_policy_hash ON public.staged_setups FOR EACH ROW EXECUTE FUNCTION freeze_setup_strategy_context();

CREATE TRIGGER zz_protect_prezone_observation BEFORE INSERT OR UPDATE OF execution_eligible, setup_type ON public.staged_setups FOR EACH ROW EXECUTE FUNCTION protect_prezone_observation();

CREATE TRIGGER protect_stop_policy_observation_trg BEFORE UPDATE ON public.stop_policy_observations FOR EACH ROW EXECUTE FUNCTION protect_stop_policy_observation();

CREATE TRIGGER populate_strategy_activation_hashes BEFORE INSERT OR UPDATE OF activation_scope, evidence_snapshot ON public.strategy_activation_registry FOR EACH ROW EXECUTE FUNCTION populate_strategy_activation_hashes();

CREATE TRIGGER protect_strategy_evidence_certificate BEFORE UPDATE ON public.strategy_evidence_certificates FOR EACH ROW EXECUTE FUNCTION protect_strategy_evidence_certificate();

CREATE TRIGGER set_trade_review_notes_updated_at BEFORE UPDATE ON public.trade_review_notes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trades_updated_at BEFORE UPDATE ON public.trades FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_settings_updated_at BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER protect_cross_tf_shadow_evidence BEFORE UPDATE ON public.zone_candidate_shadow_observations FOR EACH ROW EXECUTE FUNCTION protect_cross_tf_shadow_evidence();

CREATE TRIGGER protect_cross_timeframe_zone_lineage BEFORE UPDATE ON public.zone_candidate_shadow_observations FOR EACH ROW EXECUTE FUNCTION protect_cross_timeframe_zone_lineage();

CREATE TRIGGER protect_zone_candidate_model_evidence BEFORE UPDATE ON public.zone_candidate_shadow_observations FOR EACH ROW EXECUTE FUNCTION protect_zone_candidate_model_evidence();

CREATE TRIGGER protect_zone_shadow_observation_evidence BEFORE UPDATE ON public.zone_candidate_shadow_observations FOR EACH ROW EXECUTE FUNCTION protect_zone_shadow_observation_evidence();

CREATE TRIGGER protect_zone_shadow_replay_provenance BEFORE UPDATE ON public.zone_candidate_shadow_observations FOR EACH ROW EXECUTE FUNCTION protect_zone_shadow_replay_provenance();

CREATE TRIGGER protect_zone_timeframe_evidence_trg BEFORE UPDATE ON public.zone_timeframe_evidence FOR EACH ROW EXECUTE FUNCTION protect_zone_timeframe_evidence();

CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();

CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();

CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();

CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


-- ========================================================================
-- VIEWS  (5 statements)
-- ========================================================================

CREATE OR REPLACE VIEW public.cross_timeframe_authority_runtime_status AS  WITH configured AS (
         SELECT DISTINCT ON (cfg.user_id) cfg.user_id,
            COALESCE(cfg.config_json #>> '{strategy,crossTfAuthorityMode}'::text[], cfg.config_json ->> 'crossTfAuthorityMode'::text, 'observe'::text) AS requested_mode,
            COALESCE((cfg.config_json #>> '{strategy,crossTfRequireNestedImpulse}'::text[])::boolean, (cfg.config_json ->> 'crossTfRequireNestedImpulse'::text)::boolean, true) AS require_nested_impulse,
            COALESCE((cfg.config_json #>> '{strategy,crossTfAllowStandaloneLowerTimeframe}'::text[])::boolean, (cfg.config_json ->> 'crossTfAllowStandaloneLowerTimeframe'::text)::boolean, false) AS allow_standalone_lower_timeframe,
            COALESCE((cfg.config_json #>> '{strategy,crossTfMaximumZoneSeparationATR}'::text[])::numeric, (cfg.config_json ->> 'crossTfMaximumZoneSeparationATR'::text)::numeric, 0.25) AS maximum_zone_separation_atr,
            COALESCE((cfg.config_json #>> '{strategy,crossTfMinimumParentChildOverlapPercent}'::text[])::numeric, (cfg.config_json ->> 'crossTfMinimumParentChildOverlapPercent'::text)::numeric, 50::numeric) AS minimum_parent_child_overlap_percent,
            COALESCE((cfg.config_json #>> '{strategy,crossTfRequireSweepOrigin}'::text[])::boolean, (cfg.config_json ->> 'crossTfRequireSweepOrigin'::text)::boolean, false) AS require_sweep_origin,
            COALESCE(cfg.config_json #>> '{strategy,crossTfRetestQuality}'::text[], cfg.config_json ->> 'crossTfRetestQuality'::text, 'fresh_or_held'::text) AS retest_quality,
            COALESCE((cfg.config_json #>> '{strategy,crossTfMaximumCandidatesPerTimeframe}'::text[])::integer, (cfg.config_json ->> 'crossTfMaximumCandidatesPerTimeframe'::text)::integer, 3) AS maximum_candidates_per_timeframe
           FROM bot_configs cfg
          ORDER BY cfg.user_id, (cfg.connection_id IS NULL) DESC, cfg.updated_at DESC
        ), authority AS (
         SELECT activation.user_id,
            activation.bot_id,
            activation.authority_stage,
            activation.runtime_scope,
            activation.runtime_enforced,
            activation.revision,
            activation.evidence_hash,
            activation.updated_at
           FROM strategy_activation_registry activation
          WHERE activation.feature_key = 'cross_timeframe_authority'::text AND activation.variant_key = 'default'::text AND activation.activation_scope = '{}'::jsonb
        )
 SELECT account.user_id,
    account.bot_id,
    account.execution_mode AS runtime_target,
    COALESCE(configured.requested_mode, 'observe'::text) AS requested_mode,
        CASE
            WHEN authority.runtime_enforced IS NOT TRUE THEN 'observe'::text
            WHEN account.execution_mode = 'live'::text AND (authority.runtime_scope <> ALL (ARRAY['live_canary'::text, 'live'::text])) THEN 'observe'::text
            WHEN account.execution_mode <> 'live'::text AND (authority.runtime_scope <> ALL (ARRAY['paper'::text, 'live_canary'::text, 'live'::text])) THEN 'observe'::text
            WHEN authority.authority_stage = 'hard_block'::text THEN 'hard'::text
            WHEN authority.authority_stage = 'soft_adjustment'::text THEN 'soft'::text
            ELSE 'observe'::text
        END AS certified_maximum,
        CASE
            WHEN COALESCE(configured.requested_mode, 'observe'::text) = 'observe'::text THEN 'observe'::text
            WHEN authority.runtime_enforced IS NOT TRUE THEN 'observe'::text
            WHEN account.execution_mode = 'live'::text AND (authority.runtime_scope <> ALL (ARRAY['live_canary'::text, 'live'::text])) THEN 'observe'::text
            WHEN account.execution_mode <> 'live'::text AND (authority.runtime_scope <> ALL (ARRAY['paper'::text, 'live_canary'::text, 'live'::text])) THEN 'observe'::text
            WHEN COALESCE(configured.requested_mode, 'observe'::text) = 'soft'::text AND (authority.authority_stage = ANY (ARRAY['soft_adjustment'::text, 'hard_block'::text])) THEN 'soft'::text
            WHEN COALESCE(configured.requested_mode, 'observe'::text) = 'hard'::text AND authority.authority_stage = 'hard_block'::text THEN 'hard'::text
            WHEN COALESCE(configured.requested_mode, 'observe'::text) = 'hard'::text AND authority.authority_stage = 'soft_adjustment'::text THEN 'soft'::text
            ELSE 'observe'::text
        END AS effective_mode,
    true AS available,
    COALESCE(configured.require_nested_impulse, true) AS require_nested_impulse,
    COALESCE(configured.allow_standalone_lower_timeframe, false) AS allow_standalone_lower_timeframe,
    COALESCE(configured.maximum_zone_separation_atr, 0.25) AS maximum_zone_separation_atr,
    COALESCE(configured.minimum_parent_child_overlap_percent, 50::numeric) AS minimum_parent_child_overlap_percent,
    COALESCE(configured.require_sweep_origin, false) AS require_sweep_origin,
    COALESCE(configured.retest_quality, 'fresh_or_held'::text) AS retest_quality,
    COALESCE(configured.maximum_candidates_per_timeframe, 3) AS maximum_candidates_per_timeframe,
    authority.authority_stage,
    authority.runtime_scope,
    COALESCE(authority.runtime_enforced, false) AS runtime_enforced,
    authority.revision,
    authority.evidence_hash,
    authority.updated_at AS activation_updated_at
   FROM paper_accounts account
     LEFT JOIN configured ON configured.user_id = account.user_id
     LEFT JOIN authority ON authority.user_id = account.user_id AND authority.bot_id = account.bot_id;

CREATE OR REPLACE VIEW public.cross_timeframe_entry_authority_audit AS  SELECT 'watchlist'::text AS lifecycle_stage,
    staged.id AS row_id,
    staged.user_id,
    staged.bot_id,
    staged.symbol,
    staged.direction,
    staged.candidate_id,
    staged.cross_tf_effective_mode,
    staged.cross_tf_entry_allowed,
    staged.cross_tf_entry_authority,
    staged.staged_at AS observed_at
   FROM staged_setups staged
  WHERE staged.cross_tf_entry_authority IS NOT NULL
UNION ALL
 SELECT 'pending'::text AS lifecycle_stage,
    pending.id AS row_id,
    pending.user_id,
    pending.bot_id,
    pending.symbol,
    pending.direction,
    pending.candidate_id,
    pending.cross_tf_effective_mode,
    pending.cross_tf_entry_allowed,
    pending.cross_tf_entry_authority,
    pending.placed_at AS observed_at
   FROM pending_orders pending
  WHERE pending.cross_tf_entry_authority IS NOT NULL
UNION ALL
 SELECT 'position'::text AS lifecycle_stage,
    "position".id AS row_id,
    "position".user_id,
    "position".bot_id,
    "position".symbol,
    "position".direction,
    "position".candidate_id,
    "position".cross_tf_effective_mode,
    "position".cross_tf_entry_allowed,
    "position".cross_tf_entry_authority,
    "position".created_at AS observed_at
   FROM paper_positions "position"
  WHERE "position".cross_tf_entry_authority IS NOT NULL;

CREATE OR REPLACE VIEW public.ict_entry_zone_authority_validation_summary AS  WITH comparisons AS (
         SELECT authority.id,
            authority.user_id,
            authority.bot_id,
            authority.scan_cycle_id,
            authority.symbol,
            authority.trading_style,
            authority.observed_at,
            authority.direction,
            authority.legacy_candidate_id,
            authority.legacy_zone_type,
            authority.legacy_zone_low,
            authority.legacy_zone_high,
            authority.authority_candidate_id,
            authority.authority_zone_type,
            authority.authority_zone_low,
            authority.authority_zone_high,
            authority.authority_score,
            authority.component_ids,
            authority.disagreed,
            authority.entry_price,
            authority.stop_loss,
            authority.take_profit,
            authority.authority_observation,
            authority.outcome_status,
            authority.outcome_checked_at,
            authority.price_reached_entry,
            authority.tp_hit,
            authority.sl_hit,
            authority.mfe_pips,
            authority.mae_pips,
            authority.created_at,
            authority.evidence_source,
            authority.replay_run_id,
            authority.replay_contract_version,
            authority.activation_eligible,
            authority.legacy_outcome_status,
            authority.setup_family,
            authority.opportunity_key,
            authority.comparison_status,
            authority.geometry_failure_reason,
            authority.gross_risk_reward,
            authority.effective_risk_reward,
            authority.minimum_risk_reward,
            authority.risk_reward_passed,
            authority.cost_assumptions,
            authority.style_policy_version,
            authority.style_base_policy_hash,
            authority.style_policy_hash,
            authority.timeframe_roles,
            authority.source_evidence_ids,
            authority.source_window,
            authority.current_impulse_decision,
            authority.decision_observations,
            authority.timeframe_evidence_id,
            authority.candle_snapshot_refs,
            COALESCE(authority.legacy_outcome_status, legacy.outcome_status) AS compared_legacy_outcome_status
           FROM ict_entry_zone_authority_observations authority
             LEFT JOIN zone_candidate_shadow_observations legacy ON authority.setup_family = 'impulse'::text AND legacy.user_id = authority.user_id AND legacy.bot_id = authority.bot_id AND legacy.scan_cycle_id = authority.scan_cycle_id AND legacy.symbol = authority.symbol AND legacy.candidate_id = authority.legacy_candidate_id
        )
 SELECT user_id,
    bot_id,
    trading_style,
    symbol,
    setup_family,
    evidence_source,
    activation_eligible,
    count(DISTINCT replay_run_id) AS replay_runs,
    count(*) AS observed_scans,
    count(*) FILTER (WHERE comparison_status = 'comparable'::text) AS comparable_scans,
    count(*) FILTER (WHERE comparison_status = 'geometry_unavailable'::text OR outcome_status = 'unavailable'::text) AS geometry_unavailable_scans,
    count(*) FILTER (WHERE disagreed) AS disagreement_scans,
    count(*) FILTER (WHERE comparison_status = 'comparable'::text AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))) AS resolved_authority_setups,
    count(*) FILTER (WHERE disagreed AND outcome_status = 'would_have_won'::text) AS authority_winners,
    count(*) FILTER (WHERE disagreed AND outcome_status = 'would_have_lost'::text) AS authority_losers,
    count(*) FILTER (WHERE setup_family = 'impulse'::text AND disagreed AND compared_legacy_outcome_status = 'would_have_won'::text AND outcome_status = 'would_have_won'::text) AS winners_retained,
    count(*) FILTER (WHERE setup_family = 'impulse'::text AND disagreed AND compared_legacy_outcome_status = 'would_have_lost'::text AND outcome_status = 'would_have_won'::text) AS losers_avoided,
    count(*) FILTER (WHERE disagreed AND (setup_family = 'structure_poi'::text AND outcome_status = 'would_have_won'::text OR setup_family = 'impulse'::text AND compared_legacy_outcome_status = 'would_have_won'::text AND outcome_status = 'would_have_lost'::text)) AS missed_opportunities,
    count(*) FILTER (WHERE disagreed AND (setup_family = 'structure_poi'::text AND outcome_status = 'would_have_lost'::text OR setup_family = 'impulse'::text AND compared_legacy_outcome_status = 'would_have_lost'::text AND outcome_status = 'would_have_lost'::text)) AS false_positives,
    round(avg(mfe_pips) FILTER (WHERE disagreed), 2) AS authority_avg_mfe_pips,
    round(avg(mae_pips) FILTER (WHERE disagreed), 2) AS authority_avg_mae_pips,
    activation_eligible AND evidence_source = 'forward_observation'::text AND
        CASE
            WHEN setup_family = 'structure_poi'::text THEN count(*) FILTER (WHERE comparison_status = 'comparable'::text AND disagreed AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))) >= 30
            ELSE count(*) FILTER (WHERE disagreed AND (compared_legacy_outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text])) AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))) >= 30
        END AS minimum_sample_ready,
    'observe_only'::text AS enforcement
   FROM comparisons
  GROUP BY user_id, bot_id, trading_style, symbol, setup_family, evidence_source, activation_eligible;

CREATE OR REPLACE VIEW public.impulse_entry_lifecycle_replay_summary AS  SELECT user_id,
    bot_id,
    evidence_source,
    count(*) AS replay_count,
    count(*) FILTER (WHERE entered) AS entries,
    count(*) FILTER (WHERE rescued_deeper_entry) AS deeper_entries,
    count(*) FILTER (WHERE rescued_deeper_entry AND outcome = 'won'::text) AS rescued_winners,
    count(*) FILTER (WHERE retained_winner) AS winners_retained,
    count(*) FILTER (WHERE rescued_deeper_entry AND outcome = 'lost'::text) AS added_losses,
    count(*) FILTER (WHERE outcome = 'won'::text) AS winners,
    count(*) FILTER (WHERE outcome = 'lost'::text) AS losers,
    round(avg(mfe), 6) AS avg_mfe,
    round(avg(mae), 6) AS avg_mae,
    count(*) FILTER (WHERE outcome = ANY (ARRAY['won'::text, 'lost'::text])) >= 30 AS minimum_sample_ready,
    count(*) FILTER (WHERE NOT entered OR outcome = 'no_entry'::text) AS no_entries,
    count(*) FILTER (WHERE NOT entered AND NOT jsonb_path_exists(result, '$."transitions"[*]?(@."event" == "zone_touched")'::jsonpath)) AS never_touched,
    count(*) FILTER (WHERE NOT entered AND jsonb_path_exists(result, '$."transitions"[*]?(@."event" == "zone_touched")'::jsonpath) AND NOT jsonb_path_exists(result, '$."transitions"[*]?(@."event" == "trigger_locked")'::jsonpath)) AS touched_trigger_not_locked,
    count(*) FILTER (WHERE NOT entered AND jsonb_path_exists(result, '$."transitions"[*]?(@."event" == "trigger_locked")'::jsonpath) AND NOT jsonb_path_exists(result, '$."transitions"[*]?(@."event" == "confirmation_passed")'::jsonpath)) AS trigger_locked_not_confirmed,
    count(*) FILTER (WHERE outcome = 'inconclusive'::text) AS inconclusive,
    count(*) FILTER (WHERE outcome = ANY (ARRAY['won'::text, 'lost'::text])) AS resolved_outcomes,
    count(*) FILTER (WHERE (result ->> 'finalStatus'::text) = 'invalidated'::text) AS invalidated,
    count(*) FILTER (WHERE (result ->> 'finalStatus'::text) = 'expired'::text) AS expired,
    count(*) FILTER (WHERE (result ->> 'finalStatus'::text) = 'exhausted'::text) AS exhausted
   FROM impulse_entry_lifecycle_replays
  GROUP BY user_id, bot_id, evidence_source;

CREATE OR REPLACE VIEW public.zone_candidate_shadow_validation_summary AS  WITH resolved AS (
         SELECT observation.id,
            observation.user_id,
            observation.bot_id,
            observation.scan_cycle_id,
            observation.observed_at,
            observation.symbol,
            observation.trading_style,
            observation.style_policy_version,
            observation.style_base_policy_hash,
            observation.style_policy_hash,
            observation.direction,
            observation.candidate_id,
            observation.zone_type,
            observation.zone_low,
            observation.zone_high,
            observation.entry_price,
            observation.stop_loss,
            observation.take_profit,
            observation.legacy_rank,
            observation.shadow_rank,
            observation.rank_delta,
            observation.legacy_winner,
            observation.shadow_winner,
            observation.ranking_disagreed,
            observation.legacy_zone_score,
            observation.legacy_comparable_score,
            observation.shadow_local_score,
            observation.local_confluence,
            observation.shadow_ranking,
            observation.outcome_status,
            observation.outcome_checked_at,
            observation.price_reached_entry,
            observation.tp_hit,
            observation.sl_hit,
            observation.tp_hit_time_minutes,
            observation.mfe_pips,
            observation.mae_pips,
            observation.created_at,
            observation.evidence_source,
            observation.replay_run_id,
            observation.replay_contract_version,
            observation.activation_eligible,
            observation.candidate_model_version,
            observation.candidate_model_rank,
            observation.candidate_model_winner,
            observation.candidate_lifecycle_state,
            observation.candidate_lifecycle,
            observation.candidate_model,
            observation.timeframe_relationship,
            observation.parent_candidate_id,
            observation.candidate_lineage,
            observation.cross_tf_policy_version,
            observation.cross_tf_policy,
            observation.legacy_execution_decision,
            observation.cross_tf_shadow_decision,
            observation.cross_tf_disagreed,
            observation.cross_tf_reason_codes,
            observation.cross_tf_evaluation,
                CASE
                    WHEN observation.outcome_status = 'would_have_won'::text THEN abs(observation.take_profit - observation.entry_price) / NULLIF(abs(observation.entry_price - observation.stop_loss), 0::numeric)
                    WHEN observation.outcome_status = 'would_have_lost'::text THEN - 1::numeric
                    ELSE NULL::numeric
                END AS outcome_r
           FROM zone_candidate_shadow_observations observation
          WHERE observation.evidence_source = 'forward_observation'::text OR (EXISTS ( SELECT 1
                   FROM backtest_runs replay
                  WHERE replay.id = observation.replay_run_id AND replay.user_id = observation.user_id AND replay.status = 'completed'::text))
        )
 SELECT user_id,
    bot_id,
    trading_style,
    symbol,
    count(DISTINCT scan_cycle_id) AS observed_scans,
    count(DISTINCT scan_cycle_id) FILTER (WHERE ranking_disagreed) AS disagreement_scans,
    count(*) FILTER (WHERE outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text])) AS resolved_candidates,
    count(*) FILTER (WHERE legacy_winner AND ranking_disagreed AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))) AS legacy_disagreement_samples,
    count(*) FILTER (WHERE shadow_winner AND ranking_disagreed AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))) AS shadow_disagreement_samples,
    round(100.0 * count(*) FILTER (WHERE legacy_winner AND ranking_disagreed AND outcome_status = 'would_have_won'::text)::numeric / NULLIF(count(*) FILTER (WHERE legacy_winner AND ranking_disagreed AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))), 0)::numeric, 2) AS legacy_disagreement_win_rate,
    round(100.0 * count(*) FILTER (WHERE shadow_winner AND ranking_disagreed AND outcome_status = 'would_have_won'::text)::numeric / NULLIF(count(*) FILTER (WHERE shadow_winner AND ranking_disagreed AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))), 0)::numeric, 2) AS shadow_disagreement_win_rate,
    round(avg(mfe_pips) FILTER (WHERE shadow_winner AND ranking_disagreed), 2) AS shadow_winner_avg_mfe_pips,
    round(avg(mae_pips) FILTER (WHERE shadow_winner AND ranking_disagreed), 2) AS shadow_winner_avg_mae_pips,
    evidence_source = 'forward_observation'::text AND activation_eligible AND count(*) FILTER (WHERE shadow_winner AND ranking_disagreed AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))) >= 30 AS minimum_sample_ready,
    'observe_only'::text AS enforcement,
    evidence_source,
    activation_eligible,
    count(DISTINCT replay_run_id) FILTER (WHERE replay_run_id IS NOT NULL) AS replay_runs,
    count(DISTINCT scan_cycle_id) FILTER (WHERE cross_tf_disagreed) AS cross_tf_disagreement_scans,
    count(*) FILTER (WHERE legacy_winner AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'::text AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))) AS cross_tf_resolved_legacy_trades,
    count(*) FILTER (WHERE legacy_winner AND cross_tf_shadow_decision = 'allow'::text AND outcome_status = 'would_have_won'::text) AS winners_retained,
    count(*) FILTER (WHERE legacy_winner AND cross_tf_shadow_decision = 'block'::text AND outcome_status = 'would_have_lost'::text) AS losers_avoided,
    count(*) FILTER (WHERE legacy_winner AND cross_tf_shadow_decision = 'block'::text AND outcome_status = 'would_have_won'::text) AS missed_opportunities,
    count(*) FILTER (WHERE legacy_winner AND cross_tf_shadow_decision = 'allow'::text AND outcome_status = 'would_have_lost'::text) AS false_positives,
    round(avg(outcome_r) FILTER (WHERE legacy_winner AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'::text AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))), 4) AS legacy_expectancy_r,
    round(avg(
        CASE
            WHEN cross_tf_shadow_decision = 'allow'::text THEN outcome_r
            ELSE 0::numeric
        END) FILTER (WHERE legacy_winner AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'::text AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))), 4) AS cross_tf_expectancy_r,
    round(avg(
        CASE
            WHEN cross_tf_shadow_decision = 'allow'::text THEN outcome_r
            ELSE 0::numeric
        END) FILTER (WHERE legacy_winner AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'::text AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))) - avg(outcome_r) FILTER (WHERE legacy_winner AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'::text AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))), 4) AS cross_tf_expectancy_delta_r,
    round(avg(mfe_pips) FILTER (WHERE legacy_winner AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'::text), 2) AS cross_tf_avg_mfe_pips,
    round(avg(mae_pips) FILTER (WHERE legacy_winner AND cross_tf_policy_version = 'cross-tf-shadow-policy.v1'::text), 2) AS cross_tf_avg_mae_pips,
    evidence_source = 'forward_observation'::text AND activation_eligible AND count(*) FILTER (WHERE legacy_winner AND cross_tf_disagreed AND (outcome_status = ANY (ARRAY['would_have_won'::text, 'would_have_lost'::text]))) >= 30 AS cross_tf_minimum_sample_ready,
    'observe_only'::text AS cross_tf_enforcement
   FROM resolved
  GROUP BY user_id, bot_id, trading_style, symbol, evidence_source, activation_eligible;


-- ========================================================================
-- ROW LEVEL SECURITY  (144 statements)
-- ========================================================================

ALTER TABLE public.scan_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.backtest_history_datasets ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.scan_history ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.telegram_notification_claims ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.trade_review_notes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.scanner_operation_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.trade_archive ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.scanner_authorization_failures ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.close_audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.prop_firm_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.game_plan_refresh_status ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.scan_candle_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.optimizer_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.paper_trade_history_duplicate_audit ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.backtest_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.paper_trade_history ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rejected_setups ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.paper_positions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.scheduled_tasks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.bot_recommendations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.config_backups ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.active_game_plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.active_direction_verdicts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.broker_execution_ledger ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.strategy_activation_registry ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.staged_setups ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.zone_candidate_shadow_observations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.setup_lifecycle_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.strategy_activation_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.zone_timeframe_evidence_summary ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.scanner_runtime_locks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.scanner_health_monitor_state ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.zone_confirmation_evidence_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.kv_cache ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.prop_firm_config ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.prop_firm_daily_state ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.scanner_operational_alerts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.trade_reasonings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.trade_post_mortems ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.paper_accounts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.zone_timeframe_evidence ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.impulse_entry_lifecycles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.config_presets ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.bot_config_change_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.bot_configs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.impulse_entry_lifecycle_replays ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.impulse_lifecycle_enforcement_certificates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.streamlined_decision_certificates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.strategy_evidence_certificates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.pending_orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.broker_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.impulse_entry_lifecycle_transitions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.api_credit_usage ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.manual_impulses ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ict_entry_zone_authority_observations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.stop_policy_observations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own scan logs" ON public.scan_logs AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users manage own backtest history metadata" ON public.backtest_history_datasets AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can insert own scan history" ON public.scan_history AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can view own scan history" ON public.scan_history AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Users manage own trade review notes" ON public.trade_review_notes AS PERMISSIVE FOR ALL TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users read own scanner operation runs" ON public.scanner_operation_runs AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Users can delete own archived trades" ON public.trade_archive AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can insert own archived trades" ON public.trade_archive AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can select own archived trades" ON public.trade_archive AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users manage own close audit log" ON public.close_audit_log AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Service role full access on prop_firm_events" ON public.prop_firm_events AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text));

CREATE POLICY "Users read own prop firm events" ON public.prop_firm_events AS PERMISSIVE FOR SELECT TO public USING ((config_id IN ( SELECT prop_firm_config.id
   FROM prop_firm_config
  WHERE (prop_firm_config.user_id = auth.uid()))));

CREATE POLICY "Users read own Game Plan refresh status" ON public.game_plan_refresh_status AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Service role manages scan candle snapshots" ON public.scan_candle_snapshots AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read own scan candle snapshots" ON public.scan_candle_snapshots AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Service role full access on optimizer_runs" ON public.optimizer_runs AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users can view own optimizer runs" ON public.optimizer_runs AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users read own duplicate close audit" ON public.paper_trade_history_duplicate_audit AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own backtest runs" ON public.backtest_runs AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users manage own trades" ON public.trades AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users manage own paper trade history" ON public.paper_trade_history AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users manage own settings" ON public.user_settings AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can view own rejected setups" ON public.rejected_setups AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users manage own paper positions" ON public.paper_positions AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can update own tasks" ON public.scheduled_tasks AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own tasks" ON public.scheduled_tasks AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can delete own recommendations" ON public.bot_recommendations AS PERMISSIVE FOR DELETE TO public USING (((auth.uid())::text = user_id));

CREATE POLICY "Users can insert own recommendations" ON public.bot_recommendations AS PERMISSIVE FOR INSERT TO public WITH CHECK (((auth.uid())::text = user_id));

CREATE POLICY "Users can select own recommendations" ON public.bot_recommendations AS PERMISSIVE FOR SELECT TO public USING (((auth.uid())::text = user_id));

CREATE POLICY "Users can update own recommendations" ON public.bot_recommendations AS PERMISSIVE FOR UPDATE TO public USING (((auth.uid())::text = user_id)) WITH CHECK (((auth.uid())::text = user_id));

CREATE POLICY "Service role full access on config_backups" ON public.config_backups AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users can view own config backups" ON public.config_backups AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own active game plans" ON public.active_game_plans AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own Direction Verdicts" ON public.active_direction_verdicts AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own broker execution ledger" ON public.broker_execution_ledger AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own strategy activation registry" ON public.strategy_activation_registry AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can delete own staged setups" ON public.staged_setups AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can insert own staged setups" ON public.staged_setups AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can update own staged setups" ON public.staged_setups AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own staged setups" ON public.staged_setups AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Service role can manage zone shadow observations" ON public.zone_candidate_shadow_observations AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users can view own zone shadow observations" ON public.zone_candidate_shadow_observations AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own setup lifecycle events" ON public.setup_lifecycle_events AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own strategy activation events" ON public.strategy_activation_events AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Service role manages evidence summaries" ON public.zone_timeframe_evidence_summary AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read their own evidence summaries" ON public.zone_timeframe_evidence_summary AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Service role manages confirmation evidence counters" ON public.zone_confirmation_evidence_counters AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on prop_firm_config" ON public.prop_firm_config AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text));

CREATE POLICY "Users manage own prop firm config" ON public.prop_firm_config AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Service role full access on prop_firm_daily_state" ON public.prop_firm_daily_state AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text));

CREATE POLICY "Users read own prop firm daily state" ON public.prop_firm_daily_state AS PERMISSIVE FOR SELECT TO public USING ((config_id IN ( SELECT prop_firm_config.id
   FROM prop_firm_config
  WHERE (prop_firm_config.user_id = auth.uid()))));

CREATE POLICY "Users read own scanner operational alerts" ON public.scanner_operational_alerts AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Users manage own trade reasonings" ON public.trade_reasonings AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users manage own post mortems" ON public.trade_post_mortems AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users manage own paper account" ON public.paper_accounts AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Service role manages timeframe evidence" ON public.zone_timeframe_evidence AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read their own timeframe evidence" ON public.zone_timeframe_evidence AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Service manages impulse entry lifecycles" ON public.impulse_entry_lifecycles AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read own impulse entry lifecycles" ON public.impulse_entry_lifecycles AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Users manage own presets" ON public.config_presets AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can read own bot config history" ON public.bot_config_change_log AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Users manage own bot config" ON public.bot_configs AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Service manages impulse lifecycle replays" ON public.impulse_entry_lifecycle_replays AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read own impulse lifecycle replays" ON public.impulse_entry_lifecycle_replays AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Service manages impulse lifecycle certificates" ON public.impulse_lifecycle_enforcement_certificates AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read own impulse lifecycle certificates" ON public.impulse_lifecycle_enforcement_certificates AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Users read own streamlined certificates" ON public.streamlined_decision_certificates AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own strategy evidence certificates" ON public.strategy_evidence_certificates AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can delete own pending orders" ON public.pending_orders AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can insert own pending orders" ON public.pending_orders AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can update own pending orders" ON public.pending_orders AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own pending orders" ON public.pending_orders AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users manage own broker connections" ON public.broker_connections AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Service manages impulse entry transitions" ON public.impulse_entry_lifecycle_transitions AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read own impulse entry transitions" ON public.impulse_entry_lifecycle_transitions AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Service role manages api credit usage" ON public.api_credit_usage AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role manages manual impulses" ON public.manual_impulses AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users manage own manual impulses" ON public.manual_impulses AS PERMISSIVE FOR ALL TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Service manages ICT entry zone observations" ON public.ict_entry_zone_authority_observations AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read own ICT entry zone observations" ON public.ict_entry_zone_authority_observations AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Service role manages stop policy observations" ON public.stop_policy_observations AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users read own stop policy observations" ON public.stop_policy_observations AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));

CREATE POLICY "Users can create their own profile" ON public.profiles AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can update their own profile" ON public.profiles AS PERMISSIVE FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can view their own profile" ON public.profiles AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));


-- ========================================================================
-- GRANTS  (178 statements)
-- ========================================================================

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.active_direction_verdicts TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.active_direction_verdicts TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.active_direction_verdicts TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.active_game_plans TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.active_game_plans TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.active_game_plans TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.api_credit_usage TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.api_credit_usage TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.api_credit_usage TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.backtest_history_datasets TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.backtest_history_datasets TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.backtest_history_datasets TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.backtest_runs TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.backtest_runs TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.backtest_runs TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.bot_config_change_log TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.bot_config_change_log TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.bot_configs TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.bot_configs TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.bot_configs TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.bot_recommendations TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.bot_recommendations TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.bot_recommendations TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.broker_connections TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.broker_connections TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.broker_connections TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.broker_execution_ledger TO anon;

GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON public.broker_execution_ledger TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.broker_execution_ledger TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.close_audit_log TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.close_audit_log TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.close_audit_log TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.config_backups TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.config_backups TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.config_backups TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.config_presets TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.config_presets TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.config_presets TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.cross_timeframe_authority_runtime_status TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.cross_timeframe_authority_runtime_status TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.cross_timeframe_authority_runtime_status TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.cross_timeframe_entry_authority_audit TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.cross_timeframe_entry_authority_audit TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.cross_timeframe_entry_authority_audit TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.game_plan_refresh_status TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.game_plan_refresh_status TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ict_entry_zone_authority_observations TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ict_entry_zone_authority_observations TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ict_entry_zone_authority_observations TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ict_entry_zone_authority_validation_summary TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ict_entry_zone_authority_validation_summary TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ict_entry_zone_authority_validation_summary TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycle_replay_summary TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycle_replay_summary TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycle_replay_summary TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycle_replays TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycle_replays TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycle_replays TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycle_transitions TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycle_transitions TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycle_transitions TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycles TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycles TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_entry_lifecycles TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_lifecycle_enforcement_certificates TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_lifecycle_enforcement_certificates TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.impulse_lifecycle_enforcement_certificates TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kv_cache TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kv_cache TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kv_cache TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.manual_impulses TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.manual_impulses TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.manual_impulses TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.optimizer_runs TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.optimizer_runs TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.optimizer_runs TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_accounts TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_accounts TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_accounts TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_positions TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_positions TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_positions TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_trade_history TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_trade_history TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_trade_history TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_trade_history_duplicate_audit TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_trade_history_duplicate_audit TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paper_trade_history_duplicate_audit TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.pending_orders TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.pending_orders TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.pending_orders TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profiles TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profiles TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profiles TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.prop_firm_config TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.prop_firm_config TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.prop_firm_config TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.prop_firm_daily_state TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.prop_firm_daily_state TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.prop_firm_daily_state TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.prop_firm_events TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.prop_firm_events TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.prop_firm_events TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.rejected_setups TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.rejected_setups TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.rejected_setups TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scan_candle_snapshots TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scan_candle_snapshots TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scan_candle_snapshots TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scan_history TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scan_history TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scan_history TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scan_logs TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scan_logs TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scan_logs TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scanner_authorization_failures TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scanner_health_monitor_state TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scanner_operation_runs TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scanner_operation_runs TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scanner_operational_alerts TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scanner_operational_alerts TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scanner_runtime_locks TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scheduled_tasks TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scheduled_tasks TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scheduled_tasks TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.setup_lifecycle_events TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.setup_lifecycle_events TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.setup_lifecycle_events TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.staged_setups TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.staged_setups TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.staged_setups TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stop_policy_observations TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stop_policy_observations TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stop_policy_observations TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.strategy_activation_events TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.strategy_activation_events TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.strategy_activation_events TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.strategy_activation_registry TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.strategy_activation_registry TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.strategy_activation_registry TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.strategy_evidence_certificates TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.strategy_evidence_certificates TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.strategy_evidence_certificates TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.streamlined_decision_certificates TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.streamlined_decision_certificates TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.streamlined_decision_certificates TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.telegram_notification_claims TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_archive TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_archive TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_archive TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_post_mortems TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_post_mortems TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_post_mortems TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_reasonings TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_reasonings TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_reasonings TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_review_notes TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_review_notes TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trade_review_notes TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trades TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trades TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trades TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_settings TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_settings TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_settings TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_candidate_shadow_observations TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_candidate_shadow_observations TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_candidate_shadow_observations TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_candidate_shadow_validation_summary TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_candidate_shadow_validation_summary TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_candidate_shadow_validation_summary TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_confirmation_evidence_counters TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_timeframe_evidence TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_timeframe_evidence TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_timeframe_evidence TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_timeframe_evidence_summary TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_timeframe_evidence_summary TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.zone_timeframe_evidence_summary TO service_role;
