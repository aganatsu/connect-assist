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
  try {
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
  } catch {
    return false;
  }
}

export type BrokerExecutionConfirmationMode =
  | "default"
  | "metaapi_trade"
  | "metaapi_position_open"
  | "oanda_order_fill"
  | "oanda_trade_open"
  | "oanda_trade_orders";

export type OandaDependentOrderTransaction =
  | "stopLossOrderTransaction"
  | "takeProfitOrderTransaction";

export function classifyBrokerExecutionResponse(input: {
  ok: boolean;
  httpStatus?: number;
  parsedBody?: any;
  rawBody?: string;
  confirmationMode?: BrokerExecutionConfirmationMode;
  requiredOandaTransactions?: readonly OandaDependentOrderTransaction[];
}): {
  status: BrokerExecutionTerminalStatus;
  brokerOrderId?: string;
  error?: string;
} {
  const statusCode = input.httpStatus || 0;
  const parsed = input.parsedBody;
  const payload = parsed?.data && typeof parsed.data === "object"
    ? parsed.data
    : parsed;
  const brokerCode = parsed?.stringCode || parsed?.errorCode;
  const explicitError = parsed?.error || parsed?.errorMessage ||
    payload?.orderRejectTransaction?.rejectReason ||
    payload?.stopLossOrderRejectTransaction?.rejectReason ||
    payload?.takeProfitOrderRejectTransaction?.rejectReason;
  const explicitSuccessCode = brokerCode === "TRADE_RETCODE_DONE" ||
    brokerCode === "ERR_NO_ERROR";
  const extractBrokerOrderId = (): string | undefined => {
    const brokerOrderId = parsed?.brokerOrderId ||
      parsed?.positionId ||
      payload?.orderFillTransaction?.tradeOpened?.tradeID ||
      parsed?.orderId ||
      payload?.orderFillTransaction?.id ||
      payload?.stopLossOrderTransaction?.id ||
      payload?.takeProfitOrderTransaction?.id;
    return brokerOrderId ? String(brokerOrderId) : undefined;
  };

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
    parsed?.brokerExecutionStatus === "rejected" ||
    parsed?.brokerExecutionStatus === "uncertain"
  ) {
    return {
      status: parsed.brokerExecutionStatus,
      error: String(
        explicitError || parsed?.message ||
          "Broker mutation did not return a confirmed success",
      ).slice(0, 1000),
    };
  }

  if (input.ok && input.confirmationMode === "metaapi_position_open") {
    if (!explicitError && explicitSuccessCode && parsed?.positionId) {
      return {
        status: "succeeded",
        brokerOrderId: String(parsed.positionId),
      };
    }
    if (!explicitError && explicitSuccessCode) {
      return {
        status: "uncertain",
        error:
          "MetaAPI confirmed the order but did not return the opened position ID",
      };
    }
  }

  if (input.ok && input.confirmationMode === "oanda_trade_open") {
    const fill = payload?.orderFillTransaction;
    const cancellation = payload?.orderCancelTransaction;
    const changedExistingExposure = Boolean(
      fill?.tradeReduced ||
        (Array.isArray(fill?.tradesClosed) && fill.tradesClosed.length > 0),
    );
    if (fill && cancellation) {
      return {
        status: "uncertain",
        error:
          "OANDA returned both fill and cancellation transactions; reconcile broker state",
      };
    }
    if (cancellation) {
      return {
        status: "rejected",
        error: String(
          cancellation.reason || "OANDA cancelled the market order",
        ).slice(0, 1000),
      };
    }
    if (
      !explicitError &&
      fill?.tradeOpened?.tradeID &&
      !changedExistingExposure
    ) {
      return {
        status: "succeeded",
        brokerOrderId: String(fill.tradeOpened.tradeID),
      };
    }
    if (!explicitError && fill) {
      return {
        status: "uncertain",
        error:
          changedExistingExposure
            ? "OANDA filled the open request but also changed existing exposure; reconcile broker state"
            : "OANDA filled the open request without confirming a newly opened trade; reconcile broker state",
      };
    }
    if (!explicitError) {
      return {
        status: "uncertain",
        error: "OANDA returned HTTP success without an order fill confirmation",
      };
    }
  }

  if (input.ok && input.confirmationMode === "oanda_order_fill") {
    const fill = payload?.orderFillTransaction;
    const cancellation = payload?.orderCancelTransaction;
    if (fill && cancellation) {
      return {
        status: "uncertain",
        error:
          "OANDA returned both fill and cancellation transactions; reconcile broker state",
      };
    }
    if (cancellation) {
      return {
        status: "rejected",
        error: String(
          cancellation.reason || "OANDA cancelled the market order",
        ).slice(0, 1000),
      };
    }
    if (!explicitError && fill) {
      return {
        status: "succeeded",
        brokerOrderId: extractBrokerOrderId(),
      };
    }
    if (!explicitError) {
      return {
        status: "uncertain",
        error: "OANDA returned HTTP success without an order fill confirmation",
      };
    }
  }

  if (input.ok && input.confirmationMode === "oanda_trade_orders") {
    const required = input.requiredOandaTransactions || [];
    const confirmed = required.length > 0 &&
      required.every((key) => Boolean(payload?.[key]));
    if (!explicitError && confirmed) {
      return {
        status: "succeeded",
        brokerOrderId: extractBrokerOrderId(),
      };
    }
    if (!explicitError) {
      return {
        status: "uncertain",
        error:
          "OANDA returned HTTP success without all requested dependent-order confirmations",
      };
    }
  }

  if (
    input.ok &&
    !explicitError &&
    (explicitSuccessCode ||
      (parsed?.ok === true &&
        parsed?.brokerExecutionStatus === "succeeded"))
  ) {
    return {
      status: "succeeded",
      brokerOrderId: extractBrokerOrderId(),
    };
  }

  if (
    input.ok &&
    !explicitError &&
    !brokerCode
  ) {
    return {
      status: "uncertain",
      error: input.confirmationMode === "metaapi_trade"
        ? "MetaAPI returned HTTP success without a recognized trade confirmation code"
        : "Broker returned HTTP success without a recognized mutation confirmation",
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

export function classifyBrokerMutationHttpResponse(
  response: { ok: boolean; status: number },
  rawBody: string,
  confirmationMode: BrokerExecutionConfirmationMode,
  requiredOandaTransactions?: readonly OandaDependentOrderTransaction[],
): {
  status: BrokerExecutionTerminalStatus;
  brokerOrderId?: string;
  error?: string;
  parsedBody: any;
  rawBody: string;
} {
  let parsedBody: any = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    // The classifier deliberately marks malformed successful responses uncertain.
  }
  return {
    ...classifyBrokerExecutionResponse({
      ok: response.ok,
      httpStatus: response.status,
      parsedBody,
      rawBody,
      confirmationMode,
      requiredOandaTransactions,
    }),
    parsedBody,
    rawBody,
  };
}

export interface BrokerExecutionSendResult {
  ok: boolean;
  httpStatus?: number;
  parsedBody?: any;
  rawBody?: string;
  confirmationMode?: BrokerExecutionConfirmationMode;
  requiredOandaTransactions?: readonly OandaDependentOrderTransaction[];
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
    const completed = await completeBrokerExecution(supabase, claim, {
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
    if (!completed) {
      return {
        sent: true,
        status: "uncertain",
        brokerOrderId: outcome.brokerOrderId,
        error:
          "Broker mutation response was received but ledger completion was not persisted; reconcile broker state",
        parsedBody: sendResult.parsedBody,
        rawBody: sendResult.rawBody,
      };
    }
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
