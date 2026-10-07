-- STEP 15 — per-trade attribution (PROPOSED MIGRATION — not applied).
--
-- One trade_attribution row per trade lifecycle, keyed by signal_id, minted by
-- bot-scanner when it decides to place an order. The same id is carried on
-- smc_scan_decision, pending_orders, paper_positions, paper_trade_history and
-- paper_account_ledger.
--
-- Column classes (enforced by trade_attribution_guard):
--   IMMUTABLE   every column not listed as write-once (sections A–D)
--   WRITE-ONCE  NULL → value, never changed again (sections E–G)
-- Lifecycle transitions are written by DATABASE triggers on pending_orders and
-- paper_positions and by the settlement RPCs, so every code path that cancels,
-- expires, fills or closes is covered without trusting each caller.
-- Additive only. No historical row is created or modified.

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

-- ── 5. lifecycle triggers (DB owns every transition) ────────────────────────
CREATE OR REPLACE FUNCTION public.ta_event(p_signal uuid, p_type text, p_source text, p_detail jsonb, p_dedupe text DEFAULT NULL)
RETURNS void LANGUAGE sql SET search_path TO 'public' AS $function$
  INSERT INTO public.trade_attribution_events (signal_id, event_type, source, detail, dedupe_key)
  VALUES (p_signal, p_type, p_source, COALESCE(p_detail, '{}'::jsonb), p_dedupe)
  ON CONFLICT (signal_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
$function$;

CREATE OR REPLACE FUNCTION public.pending_orders_attribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_terminal text;
  v_fs jsonb;
BEGIN
  IF NEW.signal_id IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    UPDATE public.trade_attribution
       SET order_id = NEW.order_id, pending_order_row_id = NEW.id, order_placed_at = NEW.placed_at
     WHERE signal_id = NEW.signal_id AND order_id IS NULL;
    PERFORM public.ta_event(NEW.signal_id, 'order_inserted', 'pending_orders', jsonb_build_object('order_id', NEW.order_id), 'insert');
    RETURN NEW;
  END IF;

  -- refresh in place: the order's live geometry changed; the plan (D) does not
  IF (NEW.stop_loss, NEW.take_profit, NEW.size, NEW.entry_price) IS DISTINCT FROM (OLD.stop_loss, OLD.take_profit, OLD.size, OLD.entry_price)
     AND NEW.status IN ('pending', 'awaiting_confirmation') THEN
    PERFORM public.ta_event(NEW.signal_id, 'refreshed_in_place', 'pending_orders', jsonb_build_object(
      'old', jsonb_build_object('entry', OLD.entry_price, 'stop', OLD.stop_loss, 'target', OLD.take_profit, 'size', OLD.size),
      'new', jsonb_build_object('entry', NEW.entry_price, 'stop', NEW.stop_loss, 'target', NEW.take_profit, 'size', NEW.size),
      'signal_score', NEW.signal_score));
  END IF;

  IF NEW.zone_touch_time IS NOT NULL AND OLD.zone_touch_time IS NULL THEN
    UPDATE public.trade_attribution SET touched_at = NEW.zone_touch_time WHERE signal_id = NEW.signal_id AND touched_at IS NULL;
    PERFORM public.ta_event(NEW.signal_id, 'touched', 'pending_orders', jsonb_build_object('at', NEW.zone_touch_time));
  END IF;
  IF NEW.status = 'pending' AND OLD.status = 'awaiting_confirmation' THEN
    PERFORM public.ta_event(NEW.signal_id, 'reset', 'pending_orders', jsonb_build_object('reason', NEW.reset_reason));
  END IF;
  IF NEW.confirmation_accepted_at IS NOT NULL AND OLD.confirmation_accepted_at IS NULL THEN
    UPDATE public.trade_attribution
       SET confirmed_at = NEW.confirmation_accepted_at,
           confirmation = jsonb_build_object('tier', NEW.confirmation_tier, 'type', NEW.confirmation_type, 'timeframe', NEW.confirmation_timeframe)
     WHERE signal_id = NEW.signal_id AND confirmed_at IS NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('cancelled', 'expired', 'filled') THEN
    IF NEW.status = 'filled' THEN
      v_terminal := CASE WHEN NEW.dry_run THEN 'hypothetical_fill' ELSE 'filled' END;
      v_fs := COALESCE(NEW.fill_sizing, NEW.dry_run_context -> 'fillSizing', '{}'::jsonb);
      UPDATE public.trade_attribution SET
        terminal_status = v_terminal, terminal_reason = 'FILLED', terminal_at = COALESCE(NEW.filled_at, now()),
        fill_kind = CASE WHEN NEW.dry_run THEN 'hypothetical' ELSE 'real' END,
        filled_at = NEW.filled_at, fill_price = NEW.fill_price,
        fill_stop_price = NEW.stop_loss, fill_target_price = NEW.take_profit,
        fill_stop_distance_pips = NULLIF(v_fs ->> 'stopDistancePips', '')::numeric,
        fill_inside_floor = (v_fs ->> 'insideFloor')::boolean,
        fill_uncapped_lots = (v_fs ->> 'uncappedLots')::numeric, fill_lots = (v_fs ->> 'lots')::numeric,
        fill_risk_usd = (v_fs ->> 'riskUsdActual')::numeric, fill_risk_pct = (v_fs ->> 'riskPercentActual')::numeric,
        fill_cap_reason = v_fs ->> 'capReason'
      WHERE signal_id = NEW.signal_id AND terminal_status IS NULL;
    ELSE
      v_terminal := CASE
        WHEN NEW.terminal_reason = 'CANCELLED_SUPERSEDED' THEN 'superseded'
        WHEN NEW.status = 'expired' OR NEW.terminal_reason LIKE 'EXPIRED%' THEN 'expired'
        WHEN NEW.terminal_reason = 'CANCELLED_POSITION_CAP' THEN 'blocked_caps'
        WHEN NEW.terminal_reason IN ('CANCELLED_IMPULSE_BROKEN', 'CANCELLED_DIRECTION_FLIP', 'CANCELLED_THESIS_INVALID', 'CANCELLED_SL_INVALIDATED')
             OR NEW.thesis_cancel_reason IS NOT NULL THEN 'invalidated'
        ELSE 'cancelled' END;
      -- superseded rows: bot-scanner has already set superseded_by_signal_id
      -- (the new row exists first), so ta_superseded_link holds.
      UPDATE public.trade_attribution SET
        terminal_status = v_terminal, terminal_reason = NEW.terminal_reason, terminal_at = COALESCE(NEW.resolved_at, now())
      WHERE signal_id = NEW.signal_id AND terminal_status IS NULL;
    END IF;
    PERFORM public.ta_event(NEW.signal_id, CASE WHEN NEW.status = 'filled' THEN 'filled' WHEN v_terminal = 'superseded' THEN 'superseded' WHEN NEW.status = 'expired' THEN 'expired' ELSE 'cancelled' END,
      'pending_orders', jsonb_build_object('terminal_reason', NEW.terminal_reason, 'cancel_reason', NEW.cancel_reason), 'terminal');
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS pending_orders_attribution ON public.pending_orders;
CREATE TRIGGER pending_orders_attribution AFTER INSERT OR UPDATE ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.pending_orders_attribution();

CREATE OR REPLACE FUNCTION public.paper_positions_attribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.signal_id IS NOT NULL THEN
      UPDATE public.trade_attribution SET position_row_id = NEW.id, position_id = NEW.position_id
       WHERE signal_id = NEW.signal_id AND position_row_id IS NULL;
      PERFORM public.ta_event(NEW.signal_id, 'position_opened', 'paper_positions', jsonb_build_object('position_id', NEW.position_id, 'size', NEW.size), 'opened');
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE: settlement writes G before deleting; anything else is unsettled
  IF OLD.signal_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.trade_attribution WHERE signal_id = OLD.signal_id AND closed_at IS NOT NULL) THEN
    PERFORM public.ta_event(OLD.signal_id, 'position_deleted_unsettled', 'paper_positions', jsonb_build_object('position_id', OLD.position_id), 'deleted');
  END IF;
  RETURN OLD;
END $function$;

DROP TRIGGER IF EXISTS paper_positions_attribution ON public.paper_positions;
CREATE TRIGGER paper_positions_attribution AFTER INSERT OR DELETE ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.paper_positions_attribution();

-- ── 6. settlement carries signal_id and writes G ────────────────────────────
-- (a) _paper_history_row: add  'signal_id', p_position.signal_id  to the
--     jsonb_build_object (one line; full function body in the PR).
-- (b) _paper_ledger_post: new trailing parameter  p_signal_id uuid DEFAULT NULL,
--     inserted into the new column (DROP the old 9-arg signature in the same
--     transaction so no caller resolves to it).
-- (c) settle_paper_position, after the ledger post (same transaction):
--       IF v_position.signal_id IS NOT NULL THEN
--         UPDATE public.trade_attribution SET
--           outcome_kind = 'real', outcome_method = 'ledger_settlement.v1',
--           closed_at = now(), exit_price = v_row.exit_price,
--           exit_reason = public.ta_exit_reason(p_source, v_row.close_reason),
--           close_source = p_source, realized_pnl_usd = v_amount,
--           realized_r_gross = CASE WHEN fill_price IS NOT NULL AND fill_stop_price IS NOT NULL AND fill_price <> fill_stop_price
--             THEN (CASE direction WHEN 'long' THEN v_row.exit_price - fill_price ELSE fill_price - v_row.exit_price END)
--                  / abs(fill_price - fill_stop_price) END,
--           realized_r_net = <gross − costs / |fill − stop|>,
--           history_id = v_history_id, ledger_id = v_entry.id
--         WHERE signal_id = v_position.signal_id AND closed_at IS NULL;
--         PERFORM public.ta_event(v_position.signal_id, 'closed', p_source, ..., 'closed');
--       END IF;
-- (d) settle_paper_partial: ledger row carries signal_id; event 'partial_close'.
-- (e) ta_exit_reason(source, close_reason):
--       paper_trading_manual → manual; prop_firm_emergency → prop_firm_emergency;
--       kill_switch → kill_switch; account_reset_flatten → reset_flatten;
--       scanner_reverse_signal → reverse_signal; close_reason sl_hit/stop → stop;
--       tp_hit/target → target; else other.

-- ── 7. access ───────────────────────────────────────────────────────────────
ALTER TABLE public.trade_attribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_attribution_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ta_owner_read ON public.trade_attribution;
CREATE POLICY ta_owner_read ON public.trade_attribution FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS tae_owner_read ON public.trade_attribution_events;
CREATE POLICY tae_owner_read ON public.trade_attribution_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trade_attribution t WHERE t.signal_id = trade_attribution_events.signal_id AND t.user_id = auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.trade_attribution, public.trade_attribution_events FROM anon, authenticated;

-- ── 8. hypothetical outcome (dry run) — called by the resolver only ─────────
CREATE OR REPLACE FUNCTION public.attribution_resolve_hypothetical(p_signal_id uuid, p_outcome jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('attribution_resolve:' || p_signal_id::text));
  UPDATE public.trade_attribution SET
    outcome_kind = 'hypothetical', outcome_method = p_outcome ->> 'method',
    closed_at = (p_outcome ->> 'closed_at')::timestamptz, exit_price = (p_outcome ->> 'exit_price')::numeric,
    exit_reason = p_outcome ->> 'exit_reason', close_source = 'attribution_outcome_resolver',
    realized_pnl_usd = (p_outcome ->> 'pnl_usd')::numeric,
    realized_r_gross = (p_outcome ->> 'r_gross')::numeric, realized_r_net = (p_outcome ->> 'r_net')::numeric
  WHERE signal_id = p_signal_id AND fill_kind = 'hypothetical' AND closed_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN 'already_resolved_or_not_hypothetical'; END IF;
  PERFORM public.ta_event(p_signal_id, 'outcome_resolved', 'attribution_outcome_resolver', p_outcome, 'outcome');
  RETURN 'resolved';
END $function$;
REVOKE EXECUTE ON FUNCTION public.attribution_resolve_hypothetical(uuid, jsonb) FROM anon, authenticated;
