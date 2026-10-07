-- STEP 15 PR 1 — attribution schema + settlement support. Behaviour-neutral.
--
-- Adds the canonical stored-config hash, the trade_attribution /
-- trade_attribution_events tables (immutable / write-once / append-only),
-- signal_id on the five lifecycle tables, and teaches the settlement
-- functions to carry signal_id to trade history and the ledger and to write
-- the attribution close fields in the same transaction.
--
-- Nothing writes a signal_id yet (the scanner and the fill path change in
-- PR 2), so every settlement takes the legacy path: signal_id NULL, behaviour
-- identical to today. The order / position lifecycle triggers and the
-- dry-run outcome resolver are NOT in this migration (PR 2 / PR 3).
--
-- Design: docs/STEP15_ATTRIBUTION_BUILD_PLAN_V1.md. Additive; idempotent.

-- ── pre-check: production settlement functions are the ones this replaces ──
-- Each must be either the 20261006010000 version (first application) or this
-- migration's version (re-run). Anything else means production was changed
-- outside the repo: stop rather than overwrite it.
DO $precheck$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('_paper_ledger_post', 'd23743b338a48cfd488952e0c348e516', '8ad22f914bc2a52a09e20323626a97d0'),
    ('_paper_history_row', '10eb5d96624efffb005f48a18e1bb582', '933820b41c43c8b68d1e601be658cac5'),
    ('settle_paper_position', '1b7c51ab70f297dc4043b04f84fe36d9', '498046d9e9010d238346f8944764afa6'),
    ('settle_paper_partial', '8b8752cd48d485d74dc7de7829a01e96', '6254340f31ffd4ecf915bb964840e807')
  ) AS e(fn, old_md5, new_md5) LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
                WHERE s.nspname = 'public' AND p.proname = r.fn)
       AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
                WHERE s.nspname = 'public' AND p.proname = r.fn AND md5(p.prosrc) IN (r.old_md5, r.new_md5)) THEN
      RAISE EXCEPTION 'step 15: public.% differs from the expected source — not overwriting (compare it with 20261006010000)', r.fn;
    END IF;
  END LOOP;
END $precheck$;

-- ── 0. Canonical stored-config hash ─────────────────────────────────────────
-- Byte-for-byte the expression audit_bot_config_change() writes to
-- bot_config_change_log.next_hash: md5(config_json::text) over jsonb.
ALTER TABLE public.bot_configs
  ADD COLUMN IF NOT EXISTS config_version text
  GENERATED ALWAYS AS (md5(config_json::text)) STORED;

-- ── 1. trade_attribution ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_attribution (
  signal_id uuid PRIMARY KEY,
  attribution_version text NOT NULL DEFAULT 'trade-attribution.v1',
  user_id uuid NOT NULL,
  bot_id text NOT NULL,

  -- A. identity and versions (immutable)
  symbol text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  dry_run boolean NOT NULL,
  scan_cycle_id uuid NOT NULL,
  decision_id uuid NOT NULL,                 -- = smc_scan_decision.id (that row is written later; linked by its signal_id FK)
  decision_at timestamptz NOT NULL,
  strategy_bar_time timestamptz,
  config_version text NOT NULL CHECK (config_version ~ '^[0-9a-f]{32}$'),
  strategy_version text NOT NULL,
  sizing_version text NOT NULL,
  stop_version text NOT NULL,
  management_version text NOT NULL,
  risk_profile_version text,                 -- NULL = no active risk profile at decision
  caps_version text NOT NULL,
  route text NOT NULL CHECK (route IN ('route2_pending_confirmation', 'route1_market', 'market_fill_at_zone', 'watchlist_promotion', 'manual')),

  -- B. engines (immutable)
  primary_engine text NOT NULL CHECK (primary_engine IN ('impulse_zone', 'ob_fvg', 'unified', 'smc_score', 'manual')),
  primary_engine_rule text NOT NULL,
  contributors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contributors) = 'array'),

  -- C. decision evidence (immutable)
  game_plan jsonb NOT NULL,
  impulse jsonb NOT NULL,
  ob_fvg_zone jsonb,
  unified jsonb NOT NULL,
  score jsonb NOT NULL,
  gates jsonb NOT NULL CHECK (jsonb_typeof(gates) = 'array'),
  risk_gate jsonb,
  legacy_would_admit boolean NOT NULL,
  logged_only_would_block text[] NOT NULL DEFAULT '{}',

  -- D. order plan (immutable)
  zone_id text,
  entry_source text,
  entry_depth numeric,
  limit_price numeric NOT NULL CHECK (limit_price > 0),
  stop_price numeric NOT NULL CHECK (stop_price > 0),
  stop_source text NOT NULL CHECK (stop_source IN ('swing', 'impulse', 'floor', 'market_chain')),
  stop_distance_pips numeric NOT NULL CHECK (stop_distance_pips > 0),
  stop_floor_pips numeric,
  stop_cap_pips numeric,
  market_anchored_stop jsonb,
  target_price numeric NOT NULL CHECK (target_price > 0),
  raw_rr numeric NOT NULL,
  effective_rr numeric NOT NULL,
  cost_in_price numeric,
  intended_risk_pct numeric NOT NULL CHECK (intended_risk_pct > 0 AND intended_risk_pct <= 5),
  intended_risk_usd numeric NOT NULL CHECK (intended_risk_usd > 0),
  planned_uncapped_lots numeric,
  planned_lots numeric,
  supersedes_signal_ids uuid[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,

  -- E. lifecycle (write-once)
  order_id text,
  pending_order_row_id uuid,
  order_placed_at timestamptz,
  touched_at timestamptz,
  confirmed_at timestamptz,
  confirmation jsonb,
  terminal_status text CHECK (terminal_status IN (
    'filled', 'hypothetical_fill', 'cancelled', 'expired', 'superseded', 'invalidated',
    'blocked_caps', 'blocked_risk_gate', 'entries_locked', 'insert_failed')),
  terminal_reason text,
  terminal_at timestamptz,
  superseded_by_signal_id uuid REFERENCES public.trade_attribution(signal_id) ON DELETE RESTRICT,

  -- F. fill (write-once)
  fill_kind text CHECK (fill_kind IN ('real', 'hypothetical')),
  filled_at timestamptz,
  fill_price numeric,
  fill_stop_price numeric,
  fill_target_price numeric,
  fill_stop_distance_pips numeric,
  fill_inside_floor boolean,
  fill_uncapped_lots numeric,
  fill_lots numeric,
  fill_risk_usd numeric,
  fill_risk_pct numeric,
  fill_cap_reason text,
  position_row_id uuid,                      -- no FK: positions are deleted at settlement
  position_id text,

  -- G. close and outcome (write-once)
  outcome_kind text CHECK (outcome_kind IN ('real', 'hypothetical')),
  outcome_method text,
  closed_at timestamptz,
  exit_price numeric,
  exit_reason text CHECK (exit_reason IN (
    'stop', 'target', 'manual', 'prop_firm_emergency', 'kill_switch', 'reset_flatten', 'reverse_signal',
    'hypothetical_stop', 'hypothetical_target', 'hypothetical_gap_through_stop', 'open_at_horizon', 'other')),
  close_source text,
  realized_pnl_usd numeric,
  realized_r_gross numeric,
  realized_r_net numeric,
  history_id uuid REFERENCES public.paper_trade_history(id) ON DELETE RESTRICT,
  ledger_id uuid REFERENCES public.paper_account_ledger(id) ON DELETE RESTRICT,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ta_fill_kind_matches_dry_run CHECK (fill_kind IS NULL OR ((fill_kind = 'hypothetical') = dry_run)),
  CONSTRAINT ta_outcome_kind_matches_fill CHECK (outcome_kind IS NULL OR outcome_kind = fill_kind),
  CONSTRAINT ta_close_requires_fill CHECK (closed_at IS NULL OR filled_at IS NOT NULL),
  CONSTRAINT ta_fill_terminal CHECK (fill_kind IS NULL OR terminal_status IN ('filled', 'hypothetical_fill')),
  CONSTRAINT ta_superseded_link CHECK ((terminal_status = 'superseded') = (superseded_by_signal_id IS NOT NULL) OR terminal_status IS NULL),
  CONSTRAINT ta_not_self_superseded CHECK (superseded_by_signal_id IS DISTINCT FROM signal_id),
  CONSTRAINT ta_real_close_has_ledger CHECK (outcome_kind IS DISTINCT FROM 'real' OR (history_id IS NOT NULL AND ledger_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ta_by_user_time ON public.trade_attribution (user_id, bot_id, decision_at DESC);
CREATE INDEX IF NOT EXISTS ta_by_config ON public.trade_attribution (config_version);
CREATE INDEX IF NOT EXISTS ta_by_symbol ON public.trade_attribution (symbol, decision_at DESC);
CREATE INDEX IF NOT EXISTS ta_by_engine_route ON public.trade_attribution (primary_engine, route);
CREATE UNIQUE INDEX IF NOT EXISTS ta_order_id ON public.trade_attribution (user_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ta_unresolved_hypothetical ON public.trade_attribution (filled_at)
  WHERE fill_kind = 'hypothetical' AND closed_at IS NULL;

-- ── 2. trade_attribution_events (append-only) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_attribution_events (
  id bigserial PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES public.trade_attribution(signal_id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN (
    'order_inserted', 'refreshed_in_place', 'touched', 'reset', 'confirmed', 'confirmation_rejected',
    'superseded', 'cancelled', 'expired', 'filled', 'blocked', 'position_opened', 'partial_close',
    'closed', 'position_deleted_unsettled', 'outcome_deferred_data_gap', 'outcome_resolved')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  dedupe_key text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS tae_by_signal ON public.trade_attribution_events (signal_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS tae_dedupe ON public.trade_attribution_events (signal_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ── 3. signal_id on the existing lifecycle tables ───────────────────────────
ALTER TABLE public.smc_scan_decision   ADD COLUMN IF NOT EXISTS signal_id uuid REFERENCES public.trade_attribution(signal_id) ON DELETE RESTRICT;
ALTER TABLE public.pending_orders      ADD COLUMN IF NOT EXISTS signal_id uuid REFERENCES public.trade_attribution(signal_id) ON DELETE RESTRICT;
ALTER TABLE public.pending_orders      ADD COLUMN IF NOT EXISTS fill_sizing jsonb;  -- fill-time sizing record, both real and dry-run
ALTER TABLE public.paper_positions     ADD COLUMN IF NOT EXISTS signal_id uuid REFERENCES public.trade_attribution(signal_id) ON DELETE RESTRICT;
ALTER TABLE public.paper_trade_history ADD COLUMN IF NOT EXISTS signal_id uuid REFERENCES public.trade_attribution(signal_id) ON DELETE RESTRICT;
ALTER TABLE public.paper_account_ledger ADD COLUMN IF NOT EXISTS signal_id uuid REFERENCES public.trade_attribution(signal_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS smc_scan_decision_signal ON public.smc_scan_decision (signal_id) WHERE signal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pending_orders_signal ON public.pending_orders (signal_id) WHERE signal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paper_positions_signal ON public.paper_positions (signal_id) WHERE signal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paper_trade_history_signal_final ON public.paper_trade_history (signal_id)
  WHERE signal_id IS NOT NULL AND close_reason <> 'partial_tp';
CREATE INDEX IF NOT EXISTS paper_account_ledger_signal ON public.paper_account_ledger (signal_id) WHERE signal_id IS NOT NULL;

-- ── 4. immutability ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trade_attribution_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE
  -- Everything NOT listed here is immutable after INSERT (sections A–D, ids,
  -- created_at), including any column added later — the safe default.
  write_once text[] := ARRAY[
    'order_id', 'pending_order_row_id', 'order_placed_at', 'touched_at', 'confirmed_at', 'confirmation',
    'terminal_status', 'terminal_reason', 'terminal_at', 'superseded_by_signal_id',
    'fill_kind', 'filled_at', 'fill_price', 'fill_stop_price', 'fill_target_price', 'fill_stop_distance_pips',
    'fill_inside_floor', 'fill_uncapped_lots', 'fill_lots', 'fill_risk_usd', 'fill_risk_pct', 'fill_cap_reason',
    'position_row_id', 'position_id',
    'outcome_kind', 'outcome_method', 'closed_at', 'exit_price', 'exit_reason', 'close_source',
    'realized_pnl_usd', 'realized_r_gross', 'realized_r_net', 'history_id', 'ledger_id'];
  o jsonb; n jsonb; k text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'trade_attribution is append-only (% refused)', TG_OP USING ERRCODE = 'check_violation';
  END IF;
  o := to_jsonb(OLD); n := to_jsonb(NEW);
  FOR k IN SELECT jsonb_object_keys(n) LOOP
    CONTINUE WHEN k = 'updated_at';
    IF k = ANY (write_once) THEN
      IF o -> k <> 'null'::jsonb AND (o -> k) IS DISTINCT FROM (n -> k) THEN
        RAISE EXCEPTION 'trade_attribution.% is write-once (already %)', k, o -> k USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (o -> k) IS DISTINCT FROM (n -> k) THEN
      RAISE EXCEPTION 'trade_attribution.% is immutable', k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  NEW.updated_at := now();
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trade_attribution_guard ON public.trade_attribution;
CREATE TRIGGER trade_attribution_guard BEFORE UPDATE OR DELETE ON public.trade_attribution
  FOR EACH ROW EXECUTE FUNCTION public.trade_attribution_guard();
DROP TRIGGER IF EXISTS trade_attribution_no_truncate ON public.trade_attribution;
CREATE TRIGGER trade_attribution_no_truncate BEFORE TRUNCATE ON public.trade_attribution
  FOR EACH STATEMENT EXECUTE FUNCTION public.trade_attribution_guard();

CREATE OR REPLACE FUNCTION public.trade_attribution_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'trade_attribution_events is append-only (% refused)', TG_OP USING ERRCODE = 'check_violation';
END $function$;
DROP TRIGGER IF EXISTS tae_append_only ON public.trade_attribution_events;
CREATE TRIGGER tae_append_only BEFORE UPDATE OR DELETE ON public.trade_attribution_events
  FOR EACH ROW EXECUTE FUNCTION public.trade_attribution_events_append_only();
DROP TRIGGER IF EXISTS tae_no_truncate ON public.trade_attribution_events;
CREATE TRIGGER tae_no_truncate BEFORE TRUNCATE ON public.trade_attribution_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.trade_attribution_events_append_only();

-- signal_id never changes once set on a lifecycle row
CREATE OR REPLACE FUNCTION public.signal_id_immutable()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.signal_id IS NOT NULL AND NEW.signal_id IS DISTINCT FROM OLD.signal_id THEN
    RAISE EXCEPTION '%.signal_id is immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['smc_scan_decision', 'pending_orders', 'paper_positions', 'paper_trade_history'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_signal_id_immutable ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_signal_id_immutable BEFORE UPDATE OF signal_id ON public.%I FOR EACH ROW EXECUTE FUNCTION public.signal_id_immutable()', t, t);
  END LOOP;
END $$;

-- ── 5. helpers ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ta_event(p_signal uuid, p_type text, p_source text, p_detail jsonb, p_dedupe text DEFAULT NULL)
RETURNS void LANGUAGE sql SET search_path TO 'public' AS $function$
  INSERT INTO public.trade_attribution_events (signal_id, event_type, source, detail, dedupe_key)
  VALUES (p_signal, p_type, p_source, COALESCE(p_detail, '{}'::jsonb), p_dedupe)
  ON CONFLICT (signal_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
$function$;

-- Settlement source + close reason → attribution exit reason.
CREATE OR REPLACE FUNCTION public.ta_exit_reason(p_source text, p_close_reason text)
RETURNS text LANGUAGE sql IMMUTABLE AS $function$
  SELECT CASE
    WHEN p_source = 'paper_trading_manual' THEN 'manual'
    WHEN p_source = 'prop_firm_emergency' THEN 'prop_firm_emergency'
    WHEN p_source = 'kill_switch' THEN 'kill_switch'
    WHEN p_source = 'account_reset_flatten' THEN 'reset_flatten'
    WHEN p_source = 'scanner_reverse_signal' THEN 'reverse_signal'
    WHEN lower(COALESCE(p_close_reason, '')) IN ('sl_hit', 'stop_loss', 'stop', 'sl', 'trailing_stop', 'breakeven_stop') THEN 'stop'
    WHEN lower(COALESCE(p_close_reason, '')) IN ('tp_hit', 'take_profit', 'target', 'tp') THEN 'target'
    ELSE 'other'
  END
$function$;

REVOKE ALL ON FUNCTION public.ta_event(uuid, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;

-- ── 6. settlement functions carry signal_id (legacy rows: NULL, unchanged) ──
-- _paper_ledger_post gains a trailing p_signal_id. The old 9-argument
-- signature is dropped so no caller can resolve to it.
DROP FUNCTION IF EXISTS public._paper_ledger_post(public.paper_accounts, text, text, numeric, uuid, text, uuid, text, jsonb);

CREATE OR REPLACE FUNCTION public._paper_ledger_post(
  p_account public.paper_accounts,
  p_settlement_key text,
  p_kind text,
  p_amount numeric,
  p_position_row_id uuid,
  p_position_id text,
  p_history_id uuid,
  p_source text,
  p_detail jsonb,
  p_signal_id uuid DEFAULT NULL
)
 RETURNS public.paper_account_ledger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry public.paper_account_ledger%ROWTYPE;
  v_before numeric := COALESCE(p_account.balance, 0);
  v_after numeric := COALESCE(p_account.balance, 0) + p_amount;
BEGIN
  INSERT INTO public.paper_account_ledger (
    account_id, user_id, bot_id, epoch_id, settlement_key, kind,
    amount, balance_before, balance_after,
    position_row_id, position_id, history_id, source, detail, signal_id
  ) VALUES (
    p_account.id, p_account.user_id, COALESCE(p_account.bot_id, 'smc'), p_account.ledger_epoch_id,
    p_settlement_key, p_kind, p_amount, v_before, v_after,
    p_position_row_id, p_position_id, p_history_id, COALESCE(p_source, 'unknown'), COALESCE(p_detail, '{}'::jsonb), p_signal_id
  )
  RETURNING * INTO v_entry;

  IF p_amount <> 0 THEN
    PERFORM set_config('app.ledger_write', 'on', true);
    UPDATE public.paper_accounts
       SET balance = v_after,
           peak_balance = GREATEST(COALESCE(peak_balance, v_after), v_after)
     WHERE id = p_account.id;
    PERFORM set_config('app.ledger_write', 'off', true);
  END IF;

  RETURN v_entry;
END $function$;

CREATE OR REPLACE FUNCTION public._paper_history_row(
  p_position public.paper_positions,
  p_user_id uuid,
  p_bot_id text,
  p_history jsonb
)
 RETURNS public.paper_trade_history
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.paper_trade_history%ROWTYPE;
BEGIN
  -- JSON in, so jsonb_populate_record does every text -> column type parse.
  v_row := jsonb_populate_record(
    NULL::public.paper_trade_history,
    jsonb_build_object(
      'symbol', p_position.symbol,
      'direction', p_position.direction,
      'size', p_position.size,
      'entry_price', p_position.entry_price,
      'open_time', p_position.open_time,
      'closed_at', now(),
      'signal_reason', COALESCE(p_position.signal_reason, ''),
      'signal_score', COALESCE(p_position.signal_score, '0'),
      'order_id', COALESCE(p_position.order_id, ''),
      'stop_loss', p_position.stop_loss,
      'take_profit', p_position.take_profit,
      'source_pending_order_id', p_position.source_pending_order_id
    )
    || jsonb_strip_nulls(COALESCE(p_history, '{}'::jsonb))
    || jsonb_build_object(
      'id', gen_random_uuid(),
      'created_at', now(),
      'user_id', p_user_id,
      'bot_id', p_bot_id,
      'position_id', p_position.position_id,
      -- Step 15: forced from the position, never taken from the caller.
      'signal_id', p_position.signal_id
    )
  );
  RETURN v_row;
END $function$;

CREATE OR REPLACE FUNCTION public.settle_paper_position(
  p_position_row_id uuid,
  p_user_id uuid,
  p_bot_id text,
  p_history jsonb,
  p_source text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account public.paper_accounts%ROWTYPE;
  v_position public.paper_positions%ROWTYPE;
  v_row public.paper_trade_history%ROWTYPE;
  v_existing public.paper_trade_history%ROWTYPE;
  v_prior public.paper_account_ledger%ROWTYPE;
  v_entry public.paper_account_ledger%ROWTYPE;
  v_key text;
  v_history_id uuid;
  v_fallback_error text;
  v_linked boolean := false;
  v_pre_epoch boolean;
  v_amount numeric;
BEGIN
  IF NOT public._paper_ledger_caller_ok(p_user_id) THEN
    RETURN jsonb_build_object('settled', false, 'code', 'forbidden');
  END IF;

  -- Account first, then position: every settlement for an account
  -- serialises here, so two closers of one position cannot interleave.
  SELECT * INTO v_account
    FROM public.paper_accounts
   WHERE user_id = p_user_id AND COALESCE(bot_id, 'smc') = p_bot_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('settled', false, 'code', 'account_missing');
  END IF;

  SELECT * INTO v_position
    FROM public.paper_positions
   WHERE id = p_position_row_id AND user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO v_prior FROM public.paper_account_ledger
     WHERE account_id = v_account.id AND position_row_id = p_position_row_id
       AND kind IN ('close', 'pre_epoch_close')
     ORDER BY seq DESC LIMIT 1;
    RETURN jsonb_build_object(
      'settled', false,
      'code', CASE WHEN v_prior.id IS NULL THEN 'position_missing' ELSE 'already_settled' END,
      'ledger_id', v_prior.id
    );
  END IF;
  IF COALESCE(v_position.bot_id, 'smc') <> p_bot_id THEN
    RETURN jsonb_build_object('settled', false, 'code', 'bot_mismatch');
  END IF;

  v_key := 'close:' || p_bot_id || ':' || v_position.position_id;

  SELECT * INTO v_prior FROM public.paper_account_ledger
   WHERE account_id = v_account.id AND settlement_key = v_key;
  IF FOUND THEN
    -- Settled already; this row is a leftover. Remove it, move no money.
    DELETE FROM public.paper_positions WHERE id = v_position.id;
    RETURN jsonb_build_object('settled', false, 'code', 'already_settled', 'ledger_id', v_prior.id);
  END IF;

  v_row := public._paper_history_row(v_position, p_user_id, p_bot_id, p_history);
  v_row.source_position_row_id := v_position.id;

  IF v_row.pnl IS NULL OR v_row.exit_price IS NULL OR v_row.exit_price <= 0
     OR v_row.close_reason IS NULL OR btrim(v_row.close_reason) = ''
     OR v_row.close_reason = 'partial_tp' THEN
    RETURN jsonb_build_object('settled', false, 'code', 'invalid_close',
      'reason', 'exit_price > 0, pnl and a final close_reason are required');
  END IF;

  -- A backfill may have written this trade's history already. Link it.
  SELECT * INTO v_existing FROM public.paper_trade_history
   WHERE user_id = p_user_id AND COALESCE(bot_id, 'smc') = p_bot_id
     AND position_id = v_position.position_id AND close_reason <> 'partial_tp'
   FOR UPDATE;
  IF FOUND THEN
    v_linked := true;
    v_history_id := v_existing.id;
    UPDATE public.paper_trade_history
       SET pnl = COALESCE(pnl, v_row.pnl),
           pnl_pips = COALESCE(pnl_pips, v_row.pnl_pips),
           exit_price = COALESCE(exit_price, v_row.exit_price),
           entry_price = COALESCE(entry_price, v_row.entry_price),
           size = COALESCE(size, v_row.size),
           source_position_row_id = COALESCE(source_position_row_id, v_position.id),
           signal_id = COALESCE(signal_id, v_position.signal_id)
     WHERE id = v_existing.id;
  ELSE
    BEGIN
      SELECT h.history_id, h.fallback_error INTO v_history_id, v_fallback_error
        FROM public._paper_history_insert(v_row) h;
    EXCEPTION WHEN unique_violation THEN
      -- A legacy writer inserted it between our check and insert. Link it.
      SELECT id INTO v_history_id FROM public.paper_trade_history
       WHERE user_id = p_user_id AND COALESCE(bot_id, 'smc') = p_bot_id
         AND position_id = v_position.position_id AND close_reason <> 'partial_tp';
      IF v_history_id IS NULL THEN RAISE; END IF;
      v_linked := true;
    END;
  END IF;

  v_pre_epoch := v_account.ledger_reset_at IS NOT NULL
             AND v_position.created_at < v_account.ledger_reset_at;
  v_amount := CASE WHEN v_pre_epoch THEN 0 ELSE v_row.pnl END;

  v_entry := public._paper_ledger_post(
    v_account, v_key,
    CASE WHEN v_pre_epoch THEN 'pre_epoch_close' ELSE 'close' END,
    v_amount, v_position.id, v_position.position_id, v_history_id, p_source,
    jsonb_strip_nulls(jsonb_build_object(
      'pnl', v_row.pnl,
      'close_reason', v_row.close_reason,
      'exit_price', v_row.exit_price,
      'linked_existing_history', v_linked,
      'existing_history_pnl', CASE WHEN v_linked THEN v_existing.pnl END,
      'history_fallback_error', v_fallback_error,
      'position_created_at', v_position.created_at,
      'reset_at', CASE WHEN v_pre_epoch THEN v_account.ledger_reset_at END
    )),
    v_position.signal_id
  );

  -- Step 15: attribution close, in this transaction. Only for an attributed
  -- position (signal_id set) whose attribution has a real fill recorded; a
  -- legacy position (signal_id NULL) settles exactly as before. Attribution
  -- can never block a settlement: any failure in this block is rolled back to
  -- its savepoint and recorded as an event, and the money still settles.
  IF v_position.signal_id IS NOT NULL THEN
    BEGIN
      UPDATE public.trade_attribution SET
        outcome_kind = 'real',
        outcome_method = 'ledger_settlement.v1',
        closed_at = now(),
        exit_price = v_row.exit_price,
        exit_reason = public.ta_exit_reason(p_source, v_row.close_reason),
        close_source = p_source,
        realized_pnl_usd = v_amount,
        realized_r_gross = CASE WHEN fill_price IS NOT NULL AND fill_stop_price IS NOT NULL AND fill_price <> fill_stop_price
          THEN (CASE direction WHEN 'long' THEN v_row.exit_price - fill_price ELSE fill_price - v_row.exit_price END)
               / abs(fill_price - fill_stop_price) END,
        realized_r_net = CASE WHEN fill_price IS NOT NULL AND fill_stop_price IS NOT NULL AND fill_price <> fill_stop_price
          THEN ((CASE direction WHEN 'long' THEN v_row.exit_price - fill_price ELSE fill_price - v_row.exit_price END)
                - COALESCE(cost_in_price, 0)) / abs(fill_price - fill_stop_price) END,
        history_id = v_history_id,
        ledger_id = v_entry.id
      WHERE signal_id = v_position.signal_id
        AND closed_at IS NULL AND filled_at IS NOT NULL AND fill_kind = 'real';
      IF FOUND THEN
        PERFORM public.ta_event(v_position.signal_id, 'closed', p_source, jsonb_build_object(
          'history_id', v_history_id, 'ledger_id', v_entry.id, 'pnl', v_amount,
          'exit_price', v_row.exit_price, 'close_reason', v_row.close_reason), 'closed');
      ELSE
        PERFORM public.ta_event(v_position.signal_id, 'closed', p_source, jsonb_build_object(
          'history_id', v_history_id, 'ledger_id', v_entry.id, 'pnl', v_amount,
          'note', 'attribution close fields not written: no real fill recorded or already closed'), 'closed');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.ta_event(v_position.signal_id, 'closed', p_source, jsonb_build_object(
          'history_id', v_history_id, 'ledger_id', v_entry.id,
          'attribution_error', SQLERRM), 'closed_error');
      EXCEPTION WHEN OTHERS THEN NULL;  -- the money path never fails on attribution
      END;
    END;
  END IF;

  DELETE FROM public.paper_positions WHERE id = v_position.id;

  RETURN jsonb_build_object(
    'settled', true,
    'code', CASE WHEN v_pre_epoch THEN 'settled_pre_epoch' ELSE 'settled' END,
    'history_id', v_history_id,
    'ledger_id', v_entry.id,
    'amount', v_entry.amount,
    'balance', v_entry.balance_after,
    'linked_existing_history', v_linked,
    'history_fallback_error', v_fallback_error
  );
END $function$;

CREATE OR REPLACE FUNCTION public.settle_paper_partial(
  p_position_row_id uuid,
  p_user_id uuid,
  p_bot_id text,
  p_remaining_size numeric,
  p_position_signal_reason text,
  p_history jsonb,
  p_source text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account public.paper_accounts%ROWTYPE;
  v_position public.paper_positions%ROWTYPE;
  v_row public.paper_trade_history%ROWTYPE;
  v_entry public.paper_account_ledger%ROWTYPE;
  v_key text;
  v_history_id uuid;
  v_fallback_error text;
  v_pre_epoch boolean;
BEGIN
  IF NOT public._paper_ledger_caller_ok(p_user_id) THEN
    RETURN jsonb_build_object('settled', false, 'code', 'forbidden');
  END IF;

  SELECT * INTO v_account
    FROM public.paper_accounts
   WHERE user_id = p_user_id AND COALESCE(bot_id, 'smc') = p_bot_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('settled', false, 'code', 'account_missing');
  END IF;

  SELECT * INTO v_position
    FROM public.paper_positions
   WHERE id = p_position_row_id AND user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('settled', false, 'code', 'position_missing');
  END IF;
  IF COALESCE(v_position.bot_id, 'smc') <> p_bot_id THEN
    RETURN jsonb_build_object('settled', false, 'code', 'bot_mismatch');
  END IF;

  v_key := 'partial:' || p_bot_id || ':' || v_position.position_id || ':1';
  IF v_position.partial_tp_fired
     OR EXISTS (SELECT 1 FROM public.paper_account_ledger
                 WHERE account_id = v_account.id AND settlement_key = v_key) THEN
    RETURN jsonb_build_object('settled', false, 'code', 'already_settled');
  END IF;

  IF p_remaining_size IS NULL OR p_remaining_size <= 0 OR p_remaining_size >= v_position.size THEN
    RETURN jsonb_build_object('settled', false, 'code', 'invalid_partial',
      'reason', 'remaining size must be between 0 and the open size');
  END IF;

  v_row := public._paper_history_row(v_position, p_user_id, p_bot_id, p_history);
  -- Existing convention for partial rows; excluded from the final-lifecycle
  -- unique index by close_reason. source_position_row_id stays NULL — it is
  -- unique and belongs to the final close.
  v_row.position_id := v_position.position_id || '_partial';
  v_row.close_reason := 'partial_tp';
  v_row.source_position_row_id := NULL;
  IF v_row.pnl IS NULL OR v_row.exit_price IS NULL OR v_row.exit_price <= 0 THEN
    RETURN jsonb_build_object('settled', false, 'code', 'invalid_close',
      'reason', 'exit_price > 0 and pnl are required');
  END IF;

  UPDATE public.paper_positions
     SET size = p_remaining_size,
         partial_tp_fired = true,
         signal_reason = COALESCE(p_position_signal_reason, signal_reason)
   WHERE id = v_position.id;

  SELECT h.history_id, h.fallback_error INTO v_history_id, v_fallback_error
    FROM public._paper_history_insert(v_row) h;

  v_pre_epoch := v_account.ledger_reset_at IS NOT NULL
             AND v_position.created_at < v_account.ledger_reset_at;

  v_entry := public._paper_ledger_post(
    v_account, v_key,
    CASE WHEN v_pre_epoch THEN 'pre_epoch_partial' ELSE 'partial' END,
    CASE WHEN v_pre_epoch THEN 0 ELSE v_row.pnl END,
    v_position.id, v_position.position_id, v_history_id, p_source,
    jsonb_strip_nulls(jsonb_build_object(
      'pnl', v_row.pnl, 'exit_price', v_row.exit_price, 'closed_size', v_row.size,
      'remaining_size', p_remaining_size, 'history_fallback_error', v_fallback_error
    )),
    v_position.signal_id
  );

  IF v_position.signal_id IS NOT NULL THEN
    BEGIN
      PERFORM public.ta_event(v_position.signal_id, 'partial_close', p_source, jsonb_build_object(
        'history_id', v_history_id, 'ledger_id', v_entry.id, 'pnl', v_entry.amount,
        'closed_size', v_row.size, 'remaining_size', p_remaining_size), 'partial:1');
    EXCEPTION WHEN OTHERS THEN NULL;  -- an event can never block a settlement
    END;
  END IF;

  RETURN jsonb_build_object(
    'settled', true,
    'code', CASE WHEN v_pre_epoch THEN 'settled_pre_epoch' ELSE 'settled' END,
    'history_id', v_history_id,
    'ledger_id', v_entry.id,
    'amount', v_entry.amount,
    'balance', v_entry.balance_after
  );
END $function$;

REVOKE ALL ON FUNCTION public._paper_ledger_post(public.paper_accounts, text, text, numeric, uuid, text, uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._paper_history_row(public.paper_positions, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ── 7. access ───────────────────────────────────────────────────────────────
ALTER TABLE public.trade_attribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_attribution_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ta_owner_read ON public.trade_attribution;
CREATE POLICY ta_owner_read ON public.trade_attribution FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS tae_owner_read ON public.trade_attribution_events;
CREATE POLICY tae_owner_read ON public.trade_attribution_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trade_attribution t WHERE t.signal_id = trade_attribution_events.signal_id AND t.user_id = auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.trade_attribution, public.trade_attribution_events FROM anon, authenticated;

