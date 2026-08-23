-- Phase 2 caller compatibility: return one service-only close snapshot from
-- rows locked during the RPC. External broker work happens after this short
-- transaction, while the durable execution ledger owns request idempotency.
CREATE OR REPLACE FUNCTION public.load_paper_position_close_context(
  p_user_id UUID,
  p_bot_id TEXT,
  p_position_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.load_paper_position_close_context(
  UUID, TEXT, TEXT
) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.load_paper_position_close_context(
  UUID, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.load_paper_position_close_context(
  UUID, TEXT, TEXT
) IS 'Returns the locked internal lifecycle and durable exact broker-close requirements consumed by broker-first close callers.';
