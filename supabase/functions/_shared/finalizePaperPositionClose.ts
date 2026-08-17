export interface FinalizePaperPositionCloseInput {
  positionRowId: string;
  userId: string;
  botId: string;
  exitPrice: number;
  pnl: number;
  pnlPips: number | null;
  closeReason: string;
  closedAt?: string;
}

export interface FinalizePaperPositionCloseResult {
  closed: boolean;
  code:
    | "closed"
    | "already_resolved"
    | "account_missing"
    | "invalid_close"
    | "forbidden";
  reason?: string;
  history_id?: string;
  balance?: number;
  peak_balance?: number;
}

/**
 * The database row lock owns final-close idempotency. Callers may evaluate an
 * exit independently, but only the caller receiving `closed: true` may emit
 * post-mortems, audit events, or notifications. Broker reconciliation may be a prerequisite for live mirrored positions.
 */
export async function finalizePaperPositionClose(
  supabase: any,
  input: FinalizePaperPositionCloseInput,
): Promise<FinalizePaperPositionCloseResult> {
  if (!input.positionRowId || !input.userId || !input.botId) {
    throw new Error("Paper close requires position, user, and bot identity");
  }
  if (!Number.isFinite(input.exitPrice) || input.exitPrice <= 0) {
    throw new Error("Paper close exit price must be positive");
  }
  if (!Number.isFinite(input.pnl)) {
    throw new Error("Paper close P&L must be finite");
  }
  if (input.pnlPips !== null && !Number.isFinite(input.pnlPips)) {
    throw new Error("Paper close pip P&L must be finite when provided");
  }
  if (!input.closeReason.trim()) {
    throw new Error("Paper close reason is required");
  }

  const { data, error } = await supabase.rpc("finalize_paper_position_close", {
    p_position_row_id: input.positionRowId,
    p_user_id: input.userId,
    p_bot_id: input.botId,
    p_exit_price: input.exitPrice,
    p_pnl: input.pnl,
    p_pnl_pips: input.pnlPips,
    p_close_reason: input.closeReason,
    p_closed_at: input.closedAt ?? new Date().toISOString(),
  });

  if (error) throw error;
  if (
    !data || typeof data.closed !== "boolean" || typeof data.code !== "string"
  ) {
    throw new Error("Paper close finalizer returned an invalid response");
  }
  return data as FinalizePaperPositionCloseResult;
}
