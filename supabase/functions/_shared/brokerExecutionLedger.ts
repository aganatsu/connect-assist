export type BrokerExecutionTerminalStatus =
  | "succeeded"
  | "rejected"
  | "uncertain";

export interface BrokerExecutionClaim {
  claimed: boolean;
  code: string;
  ledgerId?: string;
  claimToken?: string;
  status?: string;
  reason?: string;
}

interface SupabaseRpcClient {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: any; error: any }>;
}

export interface ClaimBrokerExecutionInput {
  userId: string;
  botId: string;
  positionId: string;
  brokerConnectionId: string;
  action?: "open" | "close" | "modify";
  route: string;
  requestPayload: Record<string, unknown>;
}

export async function claimBrokerExecution(
  supabase: SupabaseRpcClient,
  input: ClaimBrokerExecutionInput,
): Promise<BrokerExecutionClaim> {
  const { data, error } = await supabase.rpc("claim_broker_execution", {
    p_user_id: input.userId,
    p_bot_id: input.botId,
    p_position_id: input.positionId,
    p_broker_connection_id: input.brokerConnectionId,
    p_action: input.action || "open",
    p_route: input.route,
    p_request_payload: input.requestPayload,
  });
  if (error) {
    return {
      claimed: false,
      code: "claim_error",
      reason: error.message || String(error),
    };
  }
  return {
    claimed: data?.claimed === true,
    code: data?.code || "claim_error",
    ledgerId: data?.ledger_id,
    claimToken: data?.claim_token,
    status: data?.status,
    reason: data?.reason,
  };
}

export async function completeBrokerExecution(
  supabase: SupabaseRpcClient,
  claim: BrokerExecutionClaim,
  input: {
    userId: string;
    status: BrokerExecutionTerminalStatus;
    responsePayload?: Record<string, unknown> | null;
    brokerOrderId?: string | null;
    lastError?: string | null;
  },
): Promise<boolean> {
  if (!claim.claimed || !claim.ledgerId || !claim.claimToken) return false;
  const { data, error } = await supabase.rpc("complete_broker_execution", {
    p_ledger_id: claim.ledgerId,
    p_user_id: input.userId,
    p_claim_token: claim.claimToken,
    p_status: input.status,
    p_response_payload: input.responsePayload || null,
    p_broker_order_id: input.brokerOrderId || null,
    p_last_error: input.lastError || null,
  });
  return !error && data?.completed === true;
}

export function classifyBrokerExecutionResponse(input: {
  ok: boolean;
  httpStatus?: number;
  parsedBody?: any;
  rawBody?: string;
  confirmationMode?: "default" | "metaapi_trade";
}): {
  status: BrokerExecutionTerminalStatus;
  brokerOrderId?: string;
  error?: string;
} {
  const statusCode = input.httpStatus || 0;
  const parsed = input.parsedBody;
  const brokerCode = parsed?.stringCode || parsed?.errorCode;
  const explicitError = parsed?.error || parsed?.errorMessage;
  const explicitSuccessCode = brokerCode === "TRADE_RETCODE_DONE" ||
    brokerCode === "ERR_NO_ERROR";

  if (input.ok && !parsed) {
    return {
      status: "uncertain",
      error: input.rawBody
        ? `Broker returned an unparseable success response: ${
          input.rawBody.slice(0, 500)
        }`
        : "Broker returned an empty success response",
    };
  }

  if (
    input.ok &&
    !explicitError &&
    (explicitSuccessCode ||
      (input.confirmationMode !== "metaapi_trade" && !brokerCode))
  ) {
    const brokerOrderId = parsed?.orderId ||
      parsed?.positionId ||
      parsed?.orderFillTransaction?.id ||
      parsed?.orderFillTransaction?.tradeOpened?.tradeID ||
      parsed?.data?.orderFillTransaction?.id ||
      parsed?.data?.orderFillTransaction?.tradeOpened?.tradeID;
    return {
      status: "succeeded",
      brokerOrderId: brokerOrderId ? String(brokerOrderId) : undefined,
    };
  }

  if (
    input.ok &&
    input.confirmationMode === "metaapi_trade" &&
    !explicitError &&
    !brokerCode
  ) {
    return {
      status: "uncertain",
      error:
        "MetaAPI returned HTTP success without a recognized trade confirmation code",
    };
  }

  const message = String(
    explicitError ||
      parsed?.message ||
      brokerCode ||
      input.rawBody ||
      `HTTP ${statusCode || "error"}`,
  ).slice(0, 1000);
  const uncertain = statusCode === 0 ||
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500 ||
    parsed?.fallback === true;
  return {
    status: uncertain ? "uncertain" : "rejected",
    error: message,
  };
}

export interface BrokerExecutionSendResult {
  ok: boolean;
  httpStatus?: number;
  parsedBody?: any;
  rawBody?: string;
}

export async function executeBrokerOrderWithLedger(
  supabase: SupabaseRpcClient,
  input: ClaimBrokerExecutionInput,
  send: () => Promise<BrokerExecutionSendResult>,
): Promise<{
  sent: boolean;
  status: BrokerExecutionTerminalStatus | "already_claimed" | "claim_error";
  brokerOrderId?: string;
  error?: string;
  parsedBody?: any;
  rawBody?: string;
}> {
  const claim = await claimBrokerExecution(supabase, input);
  if (!claim.claimed) {
    return {
      sent: false,
      status: claim.code === "claim_error" ? "claim_error" : "already_claimed",
      error: claim.reason,
    };
  }

  try {
    const sendResult = await send();
    const outcome = classifyBrokerExecutionResponse(sendResult);
    await completeBrokerExecution(supabase, claim, {
      userId: input.userId,
      status: outcome.status,
      responsePayload: sendResult.parsedBody
        ? sendResult.parsedBody
        : sendResult.rawBody
        ? { raw: sendResult.rawBody.slice(0, 4000) }
        : null,
      brokerOrderId: outcome.brokerOrderId,
      lastError: outcome.error,
    });
    return {
      sent: true,
      ...outcome,
      parsedBody: sendResult.parsedBody,
      rawBody: sendResult.rawBody,
    };
  } catch (error: any) {
    const message = String(error?.message || error || "Broker request failed");
    await completeBrokerExecution(supabase, claim, {
      userId: input.userId,
      status: "uncertain",
      responsePayload: null,
      lastError: message,
    });
    return {
      sent: true,
      status: "uncertain",
      error: message,
    };
  }
}
