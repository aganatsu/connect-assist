-- Paper account settlement ledger: a closed trade can move the balance once.
--
-- What went wrong. Every close path ran three separate requests — delete the
-- position, insert history, read-modify-write the balance — and nothing tied
-- the balance change to the trade. On 2026-09-16 two scan cycles closed USD/JPY
-- 0e76555c 0.7s apart and BOTH credited 871.19. The history insert had failed
-- (a trigger), the row was later backfilled from close_audit_log, and the
-- second credit stayed in paper_accounts.balance. #554 made the bot-scanner
-- breach path claim the row with DELETE ... RETURNING, but paper-trading's
-- auto/manual/kill-switch closes, the reverse-signal close and the prop-firm
-- emergency close still credited without any claim, and two of them insert
-- history BEFORE deleting the position — so a scanner close and a
-- paper-trading close of the same position each credited.
--
-- What this adds.
--   paper_account_ledger    append-only; UNIQUE (account_id, settlement_key).
--                           A close is keyed close:<bot>:<position_id>, the
--                           same lifecycle identity as the final-history
--                           unique index. A second settlement of the same
--                           trade cannot insert, so it cannot credit.
--   settle_paper_position   one transaction: lock account, lock position,
--                           write or link history, post ledger, move balance,
--                           delete position. A failure anywhere rolls all of
--                           it back and leaves the position open to retry.
--   settle_paper_partial    same, for the one partial-TP booking a position
--                           can have.
--   backfill_paper_trade_history
--                           history only. It never posts to the ledger and
--                           never touches the balance. A later settlement of
--                           the same position links the backfilled row
--                           instead of inserting, and credits exactly once.
--   reset_paper_account     posts a reset entry and starts a new epoch. A
--                           position opened before the epoch settles with a
--                           zero-amount ledger entry: an old trade cannot move
--                           the new balance.
--   balance guard           BEFORE UPDATE on paper_accounts. A balance or
--                           peak_balance change that did not come through the
--                           ledger is recorded (mode 'observe') or refused
--                           (mode 'enforce'). Ships in 'observe' so the edge
--                           functions can be deployed after the migration;
--                           switch to 'enforce' once they are — see
--                           docs/PAPER_SETTLEMENT_LEDGER_V1.md.
--   paper_account_reconciliation
--                           account balance vs ledger balance, unledgered
--                           writes, and post-epoch closes with no settlement.
--
-- Existing accounts get an 'opening' entry for their CURRENT balance, which
-- for the SMC account still includes the 871.19 phantom credit. The ledger
-- records what the account said at this moment; the clean reset is a separate,
-- approved step.

-- ── Epoch on the account ────────────────────────────────────────────────────
ALTER TABLE public.paper_accounts
  ADD COLUMN IF NOT EXISTS ledger_epoch_id uuid,
  ADD COLUMN IF NOT EXISTS ledger_epoch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS ledger_reset_at timestamptz;

COMMENT ON COLUMN public.paper_accounts.ledger_reset_at IS
  'Set only by reset_paper_account. A position created before it settles with a zero-amount ledger entry.';

-- ── Ledger ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.paper_account_ledger (
  seq bigserial PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  account_id uuid NOT NULL REFERENCES public.paper_accounts(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  bot_id text NOT NULL,
  epoch_id uuid NOT NULL,
  settlement_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening', 'close', 'partial', 'reset', 'pre_epoch_close', 'pre_epoch_partial')),
  amount numeric(20,8) NOT NULL,
  balance_before numeric(20,8) NOT NULL,
  balance_after numeric(20,8) NOT NULL,
  position_row_id uuid,
  position_id text,
  history_id uuid,
  source text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paper_account_ledger_settlement_key UNIQUE (account_id, settlement_key),
  CONSTRAINT paper_account_ledger_arithmetic CHECK (balance_after = balance_before + amount),
  CONSTRAINT paper_account_ledger_pre_epoch_moves_nothing
    CHECK (kind NOT IN ('pre_epoch_close', 'pre_epoch_partial') OR amount = 0)
);

CREATE INDEX IF NOT EXISTS idx_paper_account_ledger_account_seq
  ON public.paper_account_ledger (account_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_paper_account_ledger_position
  ON public.paper_account_ledger (user_id, bot_id, position_id);

COMMENT ON TABLE public.paper_account_ledger IS
  'Append-only record of every paper balance movement. UNIQUE settlement_key makes each settlement happen once.';

CREATE OR REPLACE FUNCTION public.paper_account_ledger_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'paper_account_ledger is append-only (% refused)', TG_OP;
END $function$;

DROP TRIGGER IF EXISTS trg_paper_account_ledger_append_only ON public.paper_account_ledger;
CREATE TRIGGER trg_paper_account_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.paper_account_ledger
  FOR EACH ROW EXECUTE FUNCTION public.paper_account_ledger_append_only();
DROP TRIGGER IF EXISTS trg_paper_account_ledger_no_truncate ON public.paper_account_ledger;
CREATE TRIGGER trg_paper_account_ledger_no_truncate
  BEFORE TRUNCATE ON public.paper_account_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public.paper_account_ledger_append_only();

ALTER TABLE public.paper_account_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own paper ledger" ON public.paper_account_ledger;
CREATE POLICY "Users read own paper ledger" ON public.paper_account_ledger
  FOR SELECT TO public USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.paper_account_ledger FROM anon, authenticated;
GRANT SELECT ON public.paper_account_ledger TO anon, authenticated, service_role;

-- ── Guard mode + unledgered-write audit ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.paper_ledger_guard (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode text NOT NULL DEFAULT 'observe' CHECK (mode IN ('observe', 'enforce')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.paper_ledger_guard (id, mode) VALUES (1, 'observe') ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.paper_ledger_guard ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paper_ledger_guard FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.paper_balance_unledgered_writes (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL,
  old_balance numeric(20,8),
  new_balance numeric(20,8),
  old_peak_balance numeric(20,8),
  new_peak_balance numeric(20,8),
  guard_mode text NOT NULL,
  request_role text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.paper_balance_unledgered_writes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paper_balance_unledgered_writes FROM anon, authenticated;

-- ── Existing accounts: epoch + opening entry ────────────────────────────────
-- Runs before the guard exists, so no flag is needed here.
UPDATE public.paper_accounts
   SET ledger_epoch_id = gen_random_uuid(),
       ledger_epoch_started_at = now()
 WHERE ledger_epoch_id IS NULL;

INSERT INTO public.paper_account_ledger (
  account_id, user_id, bot_id, epoch_id, settlement_key, kind,
  amount, balance_before, balance_after, source, detail
)
SELECT a.id, a.user_id, COALESCE(a.bot_id, 'smc'), a.ledger_epoch_id,
       'opening:' || a.ledger_epoch_id, 'opening',
       COALESCE(a.balance, 0), 0, COALESCE(a.balance, 0),
       'migration:20261006010000',
       jsonb_build_object('peak_balance', a.peak_balance,
                          'note', 'balance as found when the ledger was introduced; not reconciled')
  FROM public.paper_accounts a
ON CONFLICT (account_id, settlement_key) DO NOTHING;

-- ── Guard trigger ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.paper_accounts_balance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mode text;
BEGIN
  IF NEW.balance IS NOT DISTINCT FROM OLD.balance
     AND NEW.peak_balance IS NOT DISTINCT FROM OLD.peak_balance
     AND NEW.ledger_epoch_id IS NOT DISTINCT FROM OLD.ledger_epoch_id
     AND NEW.ledger_epoch_started_at IS NOT DISTINCT FROM OLD.ledger_epoch_started_at
     AND NEW.ledger_reset_at IS NOT DISTINCT FROM OLD.ledger_reset_at THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.ledger_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT mode INTO v_mode FROM public.paper_ledger_guard WHERE id = 1;
  v_mode := COALESCE(v_mode, 'enforce');

  IF v_mode = 'enforce' THEN
    RAISE EXCEPTION 'paper_accounts balance can only change through the settlement ledger (settle_paper_position / settle_paper_partial / reset_paper_account)'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.paper_balance_unledgered_writes (
    account_id, old_balance, new_balance, old_peak_balance, new_peak_balance, guard_mode, request_role
  ) VALUES (
    OLD.id, OLD.balance, NEW.balance, OLD.peak_balance, NEW.peak_balance, v_mode,
    current_setting('request.jwt.claim.role', true)
  );
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_paper_accounts_balance_guard ON public.paper_accounts;
CREATE TRIGGER trg_paper_accounts_balance_guard
  BEFORE UPDATE ON public.paper_accounts
  FOR EACH ROW EXECUTE FUNCTION public.paper_accounts_balance_guard();

-- New accounts open their own epoch.
CREATE OR REPLACE FUNCTION public.paper_accounts_open_epoch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND TG_WHEN = 'BEFORE' THEN
    NEW.ledger_epoch_id := COALESCE(NEW.ledger_epoch_id, gen_random_uuid());
    NEW.ledger_epoch_started_at := COALESCE(NEW.ledger_epoch_started_at, now());
    RETURN NEW;
  END IF;
  INSERT INTO public.paper_account_ledger (
    account_id, user_id, bot_id, epoch_id, settlement_key, kind,
    amount, balance_before, balance_after, source
  ) VALUES (
    NEW.id, NEW.user_id, COALESCE(NEW.bot_id, 'smc'), NEW.ledger_epoch_id,
    'opening:' || NEW.ledger_epoch_id, 'opening',
    COALESCE(NEW.balance, 0), 0, COALESCE(NEW.balance, 0), 'account_insert'
  ) ON CONFLICT (account_id, settlement_key) DO NOTHING;
  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS trg_paper_accounts_open_epoch ON public.paper_accounts;
CREATE TRIGGER trg_paper_accounts_open_epoch
  BEFORE INSERT ON public.paper_accounts
  FOR EACH ROW EXECUTE FUNCTION public.paper_accounts_open_epoch();
DROP TRIGGER IF EXISTS trg_paper_accounts_opening_entry ON public.paper_accounts;
CREATE TRIGGER trg_paper_accounts_opening_entry
  AFTER INSERT ON public.paper_accounts
  FOR EACH ROW EXECUTE FUNCTION public.paper_accounts_open_epoch();

-- ── Internal helpers (not callable through the API) ─────────────────────────
CREATE OR REPLACE FUNCTION public._paper_ledger_caller_ok(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(auth.role(), '') = 'service_role'
      OR auth.uid() IS NOT DISTINCT FROM p_user_id AND auth.uid() IS NOT NULL
      OR session_user IN ('postgres', 'supabase_admin')
$function$;

-- Posts one ledger entry and moves the locked account's balance by its amount.
-- The caller must already hold the account row lock.
CREATE OR REPLACE FUNCTION public._paper_ledger_post(
  p_account public.paper_accounts,
  p_settlement_key text,
  p_kind text,
  p_amount numeric,
  p_position_row_id uuid,
  p_position_id text,
  p_history_id uuid,
  p_source text,
  p_detail jsonb
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
    position_row_id, position_id, history_id, source, detail
  ) VALUES (
    p_account.id, p_account.user_id, COALESCE(p_account.bot_id, 'smc'), p_account.ledger_epoch_id,
    p_settlement_key, p_kind, p_amount, v_before, v_after,
    p_position_row_id, p_position_id, p_history_id, COALESCE(p_source, 'unknown'), COALESCE(p_detail, '{}'::jsonb)
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

-- Builds a history row from the caller's JSON, filling identity from the
-- position. Identity fields are forced, not trusted from the caller.
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
      'position_id', p_position.position_id
    )
  );
  RETURN v_row;
END $function$;

-- Inserts a history row. If the full row is refused (the 2026-09-16 failure
-- was a decision-contract trigger), retries once without the decision blobs:
-- a trade record without its decision snapshot is recoverable, a lost trade
-- is not. Returns the history id and any fallback error.
CREATE OR REPLACE FUNCTION public._paper_history_insert(p_row public.paper_trade_history, OUT history_id uuid, OUT fallback_error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.paper_trade_history := p_row;
BEGIN
  BEGIN
    INSERT INTO public.paper_trade_history SELECT (v_row).* RETURNING id INTO history_id;
    RETURN;
  EXCEPTION
    WHEN unique_violation THEN RAISE;
    WHEN OTHERS THEN fallback_error := SQLERRM;
  END;
  v_row.streamlined_decision_origin := NULL;
  v_row.streamlined_decision_latest := NULL;
  v_row.streamlined_decision_frozen_at := NULL;
  v_row.entry_decision_snapshot := NULL;
  v_row.entry_config_snapshot := NULL;
  INSERT INTO public.paper_trade_history SELECT (v_row).* RETURNING id INTO history_id;
END $function$;

REVOKE ALL ON FUNCTION public._paper_ledger_caller_ok(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._paper_ledger_post(public.paper_accounts, text, text, numeric, uuid, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._paper_history_row(public.paper_positions, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._paper_history_insert(public.paper_trade_history) FROM PUBLIC, anon, authenticated;

-- ── settle_paper_position ───────────────────────────────────────────────────
-- p_history carries the close as computed by the caller: at minimum exit_price,
-- pnl, close_reason; optionally pnl_pips, closed_at and any telemetry columns.
-- The ledger amount is p_history.pnl. Position identity comes from the row.
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
           source_position_row_id = COALESCE(source_position_row_id, v_position.id)
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
    ))
  );

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

-- ── settle_paper_partial ────────────────────────────────────────────────────
-- Claims the position's single partial TP and books it in one transaction.
-- p_history: exit_price, pnl, size (the closed portion), pnl_pips.
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
    ))
  );

  RETURN jsonb_build_object(
    'settled', true,
    'code', CASE WHEN v_pre_epoch THEN 'settled_pre_epoch' ELSE 'settled' END,
    'history_id', v_history_id,
    'ledger_id', v_entry.id,
    'amount', v_entry.amount,
    'balance', v_entry.balance_after
  );
END $function$;

-- ── backfill_paper_trade_history ────────────────────────────────────────────
-- Writes a missing history row. NEVER posts to the ledger, NEVER moves the
-- balance. Money for a trade moves only in settle_paper_position.
CREATE OR REPLACE FUNCTION public.backfill_paper_trade_history(
  p_user_id uuid,
  p_bot_id text,
  p_history jsonb,
  p_reason text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account public.paper_accounts%ROWTYPE;
  v_row public.paper_trade_history%ROWTYPE;
  v_existing uuid;
  v_settled uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('inserted', false, 'code', 'forbidden');
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN jsonb_build_object('inserted', false, 'code', 'reason_required');
  END IF;

  -- Same lock the settlements take, so a backfill and a settlement of one
  -- trade cannot interleave.
  SELECT * INTO v_account
    FROM public.paper_accounts
   WHERE user_id = p_user_id AND COALESCE(bot_id, 'smc') = p_bot_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('inserted', false, 'code', 'account_missing');
  END IF;

  -- jsonb_populate_record does not apply column defaults; supply the two
  -- NOT NULL ones a backfill source (close_audit_log) does not carry.
  v_row := jsonb_populate_record(
    NULL::public.paper_trade_history,
    jsonb_build_object('signal_score', '0', 'order_id', '')
    || jsonb_strip_nulls(COALESCE(p_history, '{}'::jsonb))
    || jsonb_build_object('id', gen_random_uuid(), 'created_at', now(),
                          'user_id', p_user_id, 'bot_id', p_bot_id)
  );
  IF v_row.position_id IS NULL OR v_row.closed_at IS NULL OR v_row.close_reason IS NULL THEN
    RETURN jsonb_build_object('inserted', false, 'code', 'invalid_history',
      'reason', 'position_id, closed_at and close_reason are required');
  END IF;

  SELECT id INTO v_existing FROM public.paper_trade_history
   WHERE user_id = p_user_id AND COALESCE(bot_id, 'smc') = p_bot_id
     AND position_id = v_row.position_id
     AND (close_reason <> 'partial_tp') = (v_row.close_reason <> 'partial_tp')
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('inserted', false, 'code', 'exists', 'history_id', v_existing);
  END IF;

  v_row.signal_reason := COALESCE(v_row.signal_reason, '')
    || CASE WHEN v_row.signal_reason IS NULL OR v_row.signal_reason = '' THEN '' ELSE ' ' END
    || '[backfilled: ' || p_reason || ']';
  INSERT INTO public.paper_trade_history SELECT (v_row).*;

  SELECT id INTO v_settled FROM public.paper_account_ledger
   WHERE account_id = v_account.id
     AND settlement_key = 'close:' || p_bot_id || ':' || v_row.position_id;

  RETURN jsonb_build_object('inserted', true, 'code', 'inserted', 'history_id', v_row.id,
                            'already_settled', v_settled IS NOT NULL, 'ledger_id', v_settled);
END $function$;

-- ── reset_paper_account ─────────────────────────────────────────────────────
-- Money and epoch only. Open positions, pending orders and history are left
-- to the caller's approved reset scope; a position opened before the new
-- epoch can no longer move the balance whenever it settles.
CREATE OR REPLACE FUNCTION public.reset_paper_account(
  p_user_id uuid,
  p_bot_id text,
  p_new_balance numeric,
  p_reason text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account public.paper_accounts%ROWTYPE;
  v_epoch uuid := gen_random_uuid();
  v_entry public.paper_account_ledger%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT public._paper_ledger_caller_ok(p_user_id) THEN
    RETURN jsonb_build_object('reset', false, 'code', 'forbidden');
  END IF;
  IF p_new_balance IS NULL OR p_new_balance < 0 THEN
    RETURN jsonb_build_object('reset', false, 'code', 'invalid_balance');
  END IF;

  SELECT * INTO v_account
    FROM public.paper_accounts
   WHERE user_id = p_user_id AND COALESCE(bot_id, 'smc') = p_bot_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('reset', false, 'code', 'account_missing');
  END IF;

  INSERT INTO public.paper_account_ledger (
    account_id, user_id, bot_id, epoch_id, settlement_key, kind,
    amount, balance_before, balance_after, source, detail
  ) VALUES (
    v_account.id, v_account.user_id, p_bot_id, v_epoch, 'reset:' || v_epoch, 'reset',
    p_new_balance - COALESCE(v_account.balance, 0), COALESCE(v_account.balance, 0), p_new_balance,
    'reset_paper_account',
    jsonb_build_object('reason', COALESCE(p_reason, ''),
                       'previous_epoch_id', v_account.ledger_epoch_id,
                       'previous_peak_balance', v_account.peak_balance,
                       'previous_daily_pnl_base', v_account.daily_pnl_base)
  ) RETURNING * INTO v_entry;

  PERFORM set_config('app.ledger_write', 'on', true);
  UPDATE public.paper_accounts
     SET balance = p_new_balance,
         peak_balance = p_new_balance,
         daily_pnl_base = p_new_balance,
         daily_pnl_base_date = to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
         ledger_epoch_id = v_epoch,
         ledger_epoch_started_at = v_now,
         ledger_reset_at = v_now
   WHERE id = v_account.id;
  PERFORM set_config('app.ledger_write', 'off', true);

  RETURN jsonb_build_object('reset', true, 'code', 'reset', 'epoch_id', v_epoch,
                            'epoch_started_at', v_now, 'ledger_id', v_entry.id,
                            'previous_balance', v_entry.balance_before, 'balance', p_new_balance);
END $function$;

REVOKE ALL ON FUNCTION public.settle_paper_position(uuid, uuid, text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.settle_paper_partial(uuid, uuid, text, numeric, text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.backfill_paper_trade_history(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_paper_account(uuid, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_paper_position(uuid, uuid, text, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_paper_partial(uuid, uuid, text, numeric, text, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backfill_paper_trade_history(uuid, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_paper_account(uuid, text, numeric, text) TO authenticated, service_role;

-- ── finalize_paper_position_close → settlement ──────────────────────────────
-- Unused by the edge functions but exposed through the API. It inserted
-- `now()::TEXT` and the position's text open_time, which the timestamptz
-- columns from 20261006000000 refuse, and its unique_violation branch refused
-- to credit a trade whose history had been backfilled. Same signature, now a
-- wrapper over settle_paper_position.
CREATE OR REPLACE FUNCTION public.finalize_paper_position_close(p_position_row_id uuid, p_user_id uuid, p_bot_id text, p_exit_price numeric, p_pnl numeric, p_pnl_pips numeric, p_close_reason text, p_closed_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.settle_paper_position(
    p_position_row_id, p_user_id, p_bot_id,
    jsonb_build_object('exit_price', p_exit_price, 'pnl', p_pnl, 'pnl_pips', p_pnl_pips,
                       'close_reason', p_close_reason, 'closed_at', COALESCE(p_closed_at, now())),
    'finalize_paper_position_close'
  );
  RETURN v_result || jsonb_build_object('closed', COALESCE((v_result->>'settled')::boolean, false));
END $function$;

-- ── Reconciliation ──────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.paper_account_reconciliation
WITH (security_invoker = true) AS
WITH latest AS (
  SELECT DISTINCT ON (account_id) account_id, seq, balance_after, epoch_id
    FROM public.paper_account_ledger
   ORDER BY account_id, seq DESC
)
SELECT
  a.id AS account_id,
  a.user_id,
  a.bot_id,
  a.ledger_epoch_id,
  a.ledger_epoch_started_at,
  a.balance AS account_balance,
  l.balance_after AS ledger_balance,
  a.balance - l.balance_after AS drift,
  (SELECT count(*) FROM public.paper_balance_unledgered_writes w
    WHERE w.account_id = a.id AND w.created_at >= a.ledger_epoch_started_at) AS unledgered_writes_this_epoch,
  (SELECT count(*) FROM public.paper_trade_history h
    WHERE h.user_id = a.user_id AND COALESCE(h.bot_id, 'smc') = COALESCE(a.bot_id, 'smc')
      AND h.closed_at >= a.ledger_epoch_started_at
      AND NOT EXISTS (
        SELECT 1 FROM public.paper_account_ledger e
         WHERE e.account_id = a.id
           AND e.settlement_key = CASE
             WHEN h.close_reason = 'partial_tp'
               THEN 'partial:' || COALESCE(h.bot_id, 'smc') || ':' || regexp_replace(h.position_id, '_partial$', '') || ':1'
             ELSE 'close:' || COALESCE(h.bot_id, 'smc') || ':' || h.position_id
           END)) AS history_rows_without_settlement_this_epoch,
  (SELECT COALESCE(sum(e.amount), 0) FROM public.paper_account_ledger e
    WHERE e.account_id = a.id AND e.epoch_id = a.ledger_epoch_id AND e.kind IN ('close', 'partial')) AS realized_pnl_this_epoch,
  (SELECT count(*) FROM public.paper_account_ledger e
    WHERE e.account_id = a.id AND e.epoch_id = a.ledger_epoch_id AND e.kind IN ('pre_epoch_close', 'pre_epoch_partial')) AS pre_epoch_settlements_this_epoch
FROM public.paper_accounts a
LEFT JOIN latest l ON l.account_id = a.id;

GRANT SELECT ON public.paper_account_reconciliation TO authenticated, service_role;
