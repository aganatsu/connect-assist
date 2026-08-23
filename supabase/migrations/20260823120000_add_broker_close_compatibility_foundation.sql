-- Phase 1 compatibility foundation for broker-backed closes.
--
-- This migration is intentionally additive except for close-only hardening of
-- the existing broker execution RPCs and extra success metadata returned by
-- the existing entry RPCs. Enforcement triggers, table privilege changes,
-- foreign-key changes, and caller migrations belong to later rollout phases.

-- A terminal label alone is not broker-close proof. The acknowledgement must
-- be a JSON boolean and must name the exact position requested by the close.
CREATE OR REPLACE FUNCTION public.broker_close_has_terminal_proof(
  p_status TEXT,
  p_request_payload JSONB,
  p_response_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.broker_close_has_terminal_proof(
  TEXT, JSONB, JSONB
) FROM PUBLIC, authenticated, anon;

-- Only broker-specific position identifiers count. In particular, an OANDA
-- fill transaction id and a generic order id are not position identifiers.
CREATE OR REPLACE FUNCTION public.broker_open_exact_position_id(
  p_broker_type TEXT,
  p_response_payload JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.broker_open_exact_position_id(TEXT, JSONB)
  FROM PUBLIC, authenticated, anon;

-- Own the relationship between an exact open identity and a later close so
-- requirement and orphan queries cannot drift into different proof rules.
CREATE OR REPLACE FUNCTION public.broker_close_resolves_open(
  p_open_position_id TEXT,
  p_open_completed_at TIMESTAMPTZ,
  p_close_status TEXT,
  p_close_request_payload JSONB,
  p_close_response_payload JSONB,
  p_close_started_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.broker_close_resolves_open(
  TEXT, TIMESTAMPTZ, TEXT, JSONB, JSONB, TIMESTAMPTZ
) FROM PUBLIC, authenticated, anon;

-- One function owns the close requirements for an internal position. Legacy
-- mirror-only evidence remains required but unknown until an exact broker
-- position id can be recovered; it is never silently treated as closed.
CREATE OR REPLACE FUNCTION public.paper_position_broker_close_requirements(
  p_user_id UUID,
  p_bot_id TEXT,
  p_position_id TEXT
)
RETURNS TABLE (
  position_found BOOLEAN,
  required_connection_ids UUID[],
  missing_close_connection_ids UUID[],
  unknown_identity_connection_ids UUID[],
  broker_position_ids JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.paper_position_broker_close_requirements(
  UUID, TEXT, TEXT
) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.paper_position_broker_close_requirements(
  UUID, TEXT, TEXT
) TO service_role;

-- MetaAPI legacy rows stored the token and account UUID in opposite columns.
CREATE OR REPLACE FUNCTION public.broker_connection_effective_account_identity(
  p_broker_type TEXT,
  p_api_key TEXT,
  p_account_id TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.broker_connection_effective_account_identity(
  TEXT, TEXT, TEXT
) FROM PUBLIC, authenticated, anon;

-- Close is retryable because its desired state is idempotent. Existing open
-- and modify semantics remain the original insert-or-report behavior.
CREATE OR REPLACE FUNCTION public.claim_broker_execution(
  p_user_id UUID,
  p_bot_id TEXT,
  p_position_id TEXT,
  p_broker_connection_id UUID,
  p_action TEXT,
  p_route TEXT,
  p_request_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.finalize_pending_order_fill(
  p_pending_id UUID,
  p_user_id UUID,
  p_bot_id TEXT,
  p_fill_price NUMERIC,
  p_current_price NUMERIC,
  p_position_order_id TEXT,
  p_signal_reason JSONB,
  p_fill_reason TEXT,
  p_authorization JSONB,
  p_max_open_positions INTEGER,
  p_max_per_symbol INTEGER,
  p_allow_same_direction BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- Inventory interrupted broker opens whose durable ledger survived but whose
-- internal position row did not. Unknown exact identities remain unresolved.
CREATE OR REPLACE FUNCTION public.list_unresolved_broker_open_orphans(
  p_user_id UUID,
  p_bot_id TEXT,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
  open_ledger_id UUID,
  user_id UUID,
  bot_id TEXT,
  position_id TEXT,
  broker_connection_id UUID,
  request_payload JSONB,
  response_payload JSONB,
  broker_order_id TEXT,
  broker_position_id TEXT,
  status TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.list_unresolved_broker_open_orphans(
  UUID, TEXT, INTEGER
) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.list_unresolved_broker_open_orphans(
  UUID, TEXT, INTEGER
) TO service_role;

-- Connection exposure delegates position proof to the requirement helper and
-- missing-position proof to the orphan helper.
CREATE OR REPLACE FUNCTION public.broker_connection_has_unresolved_managed_exposure(
  p_connection_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.broker_connection_has_unresolved_managed_exposure(
  UUID, UUID
) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.broker_connection_has_unresolved_managed_exposure(
  UUID, UUID
) TO service_role;

-- This remains advisory in Phase 1. Race-closing enforcement is deliberately
-- deferred until all writers have moved to the compatible lifecycle contract.
CREATE OR REPLACE FUNCTION public.broker_connection_mutation_preflight(
  p_connection_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.broker_connection_mutation_preflight(
  UUID, UUID
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_connection_mutation_preflight(
  UUID, UUID
) TO authenticated, service_role;

-- Lifecycle labels cannot hide concrete ledger exposure. Missing close proof
-- blocks independently; a non-paper/non-rejected row with no durable identity
-- also remains unresolved.
CREATE OR REPLACE FUNCTION public.paper_account_has_unresolved_managed_exposure(
  p_user_id UUID,
  p_bot_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.paper_account_has_unresolved_managed_exposure(
  UUID, TEXT
) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.paper_account_has_unresolved_managed_exposure(
  UUID, TEXT
) TO service_role;

-- Completion remains backward-compatible for open and modify. An unproved
-- reported close success is durably recorded as uncertain for reconciliation.
CREATE OR REPLACE FUNCTION public.complete_broker_execution(
  p_ledger_id UUID,
  p_user_id UUID,
  p_claim_token UUID,
  p_status TEXT,
  p_response_payload JSONB,
  p_broker_order_id TEXT,
  p_last_error TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- Return the lifecycle state actually produced by the existing BEFORE INSERT
-- trigger. The function signature and all entry/capacity decisions are kept.
CREATE OR REPLACE FUNCTION public.finalize_market_entry(
  p_user_id UUID,
  p_bot_id TEXT,
  p_source_candidate_key TEXT,
  p_position JSONB,
  p_authorization JSONB,
  p_max_open_positions INTEGER,
  p_max_per_symbol INTEGER,
  p_allow_same_direction BOOLEAN,
  p_close_on_reverse BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;
