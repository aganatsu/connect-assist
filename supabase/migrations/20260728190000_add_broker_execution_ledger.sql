-- Phase 1C: durable broker execution state.
--
-- Local position creation and broker execution cannot share one transaction.
-- This ledger gives every position/connection/action a single durable claim
-- before an external broker request is sent. An existing claim is never
-- automatically retried: a timeout may mean the broker accepted the order even
-- though the scanner did not receive the response.

CREATE TABLE IF NOT EXISTS public.broker_execution_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL DEFAULT 'smc',
  position_id TEXT NOT NULL,
  broker_connection_id UUID NOT NULL
    REFERENCES public.broker_connections(id) ON DELETE CASCADE,
  action TEXT NOT NULL DEFAULT 'open'
    CHECK (action IN ('open', 'close', 'modify')),
  route TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'attempting'
    CHECK (status IN ('attempting', 'succeeded', 'rejected', 'uncertain')),
  claim_token UUID NOT NULL DEFAULT gen_random_uuid(),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  request_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  response_payload JSONB,
  broker_order_id TEXT,
  last_error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT broker_execution_ledger_unique
    UNIQUE (user_id, bot_id, position_id, broker_connection_id, action)
);

CREATE INDEX IF NOT EXISTS idx_broker_execution_ledger_unresolved
  ON public.broker_execution_ledger (user_id, bot_id, status, started_at DESC)
  WHERE status IN ('attempting', 'uncertain');

ALTER TABLE public.broker_execution_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own broker execution ledger"
  ON public.broker_execution_ledger;
CREATE POLICY "Users can view own broker execution ledger"
  ON public.broker_execution_ledger
  FOR SELECT
  USING (auth.uid() = user_id);

REVOKE ALL ON TABLE public.broker_execution_ledger FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.broker_execution_ledger
  FROM authenticated;
GRANT SELECT ON TABLE public.broker_execution_ledger TO authenticated;

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
BEGIN
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
BEGIN
  IF p_status NOT IN ('succeeded', 'rejected', 'uncertain') THEN
    RETURN jsonb_build_object(
      'completed', false,
      'code', 'invalid_status',
      'reason', format('Unsupported terminal status: %s', p_status)
    );
  END IF;

  UPDATE public.broker_execution_ledger
     SET status = p_status,
         response_payload = p_response_payload,
         broker_order_id = NULLIF(p_broker_order_id, ''),
         last_error = NULLIF(p_last_error, ''),
         finished_at = now(),
         updated_at = now()
   WHERE id = p_ledger_id
     AND user_id = p_user_id
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

  RETURN jsonb_build_object(
    'completed', true,
    'code', 'completed',
    'ledger_id', v_row.id,
    'status', v_row.status,
    'broker_order_id', v_row.broker_order_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_broker_execution(
  UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_broker_execution(
  UUID, UUID, UUID, TEXT, JSONB, TEXT, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.claim_broker_execution(
  UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_broker_execution(
  UUID, UUID, UUID, TEXT, JSONB, TEXT, TEXT
) TO service_role;
