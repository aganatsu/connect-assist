/**
 * PAPER SETTLEMENT — the only way a paper trade moves the account balance.
 *
 * Wraps `settle_paper_position` / `settle_paper_partial` (migration
 * 20261006010000). Each RPC locks the account and the position, writes or
 * links the history row, posts one entry to paper_account_ledger under a
 * unique settlement key, moves the balance and deletes the position — in one
 * transaction. A second settlement of the same trade finds the key taken and
 * moves nothing.
 *
 *   settled          this caller booked the trade; carry on (post-mortem,
 *                    audit log, broker mirror, notifications)
 *   already_settled  another caller booked it first — do NOTHING further
 *   rejected         the RPC refused (missing account/position, invalid
 *                    close, forbidden); nothing committed
 *   failed           transport or SQL error; nothing committed, the position
 *                    is still open, the next cycle retries
 *
 * THE FAILURE IT REPLACES: delete position, insert history, read-modify-write
 * balance as three requests. On 2026-09-16 two scan cycles closed USD/JPY
 * 0e76555c and both credited 871.19.
 */

export type SettlementOutcome =
  | {
    outcome: "settled";
    historyId: string | null;
    ledgerId: string | null;
    amount: number;
    balance: number | null;
    preEpoch: boolean;
    linkedExistingHistory: boolean;
    historyFallbackError: string | null;
  }
  | { outcome: "already_settled"; ledgerId: string | null }
  | { outcome: "rejected"; code: string; reason: string | null }
  | { outcome: "failed"; error: string };

/** Minimal client surface — lets tests supply a fake without Supabase. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Interpret the RPC reply. Pure; anything unrecognised is a failure. */
export function interpretSettlement(data: unknown, error: { message: string } | null): SettlementOutcome {
  if (error) return { outcome: "failed", error: error.message };
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.settled === true) {
    const amount = num(d.amount);
    if (amount === null) return { outcome: "failed", error: "settled reply without amount" };
    return {
      outcome: "settled",
      historyId: (d.history_id as string) ?? null,
      ledgerId: (d.ledger_id as string) ?? null,
      amount,
      balance: num(d.balance),
      preEpoch: d.code === "settled_pre_epoch",
      linkedExistingHistory: d.linked_existing_history === true,
      historyFallbackError: (d.history_fallback_error as string) ?? null,
    };
  }
  if (d.settled === false && d.code === "already_settled") {
    return { outcome: "already_settled", ledgerId: (d.ledger_id as string) ?? null };
  }
  if (d.settled === false && typeof d.code === "string") {
    return { outcome: "rejected", code: d.code, reason: (d.reason as string) ?? null };
  }
  return { outcome: "failed", error: `unrecognised settlement reply: ${JSON.stringify(data)?.slice(0, 200)}` };
}

export interface SettleArgs {
  /** paper_positions.id (uuid primary key) — NOT the 8-char position_id. */
  positionRowId: string;
  userId: string;
  botId: string;
  /**
   * The close as computed by the caller: exit_price, pnl, close_reason are
   * required; pnl_pips, closed_at and telemetry columns optional. Identity
   * (user, bot, position_id, source_position_row_id) is forced server-side.
   * The ledger amount is `pnl`.
   */
  history: Record<string, unknown>;
  /** Which code path settled, recorded on the ledger entry. */
  source: string;
}

/**
 * Settle a final close. Never throws: a transport error becomes `failed`,
 * which is safe because the RPC commits nothing unless it returns settled.
 */
export async function settlePaperPosition(client: RpcClient, a: SettleArgs): Promise<SettlementOutcome> {
  if (!a.positionRowId || !a.userId) {
    return { outcome: "failed", error: "missing position row id or user id" };
  }
  try {
    const { data, error } = await client.rpc("settle_paper_position", {
      p_position_row_id: a.positionRowId,
      p_user_id: a.userId,
      p_bot_id: a.botId,
      p_history: a.history,
      p_source: a.source,
    });
    return interpretSettlement(data, error);
  } catch (e) {
    return { outcome: "failed", error: (e as Error)?.message ?? String(e) };
  }
}

export interface SettlePartialArgs extends SettleArgs {
  /** Size left open after the partial. */
  remainingSize: number;
  /** New paper_positions.signal_reason (exit flags), written with the claim. */
  positionSignalReason: string | null;
}

/** Claim and book a position's single partial TP. Never throws. */
export async function settlePaperPartial(client: RpcClient, a: SettlePartialArgs): Promise<SettlementOutcome> {
  if (!a.positionRowId || !a.userId) {
    return { outcome: "failed", error: "missing position row id or user id" };
  }
  try {
    const { data, error } = await client.rpc("settle_paper_partial", {
      p_position_row_id: a.positionRowId,
      p_user_id: a.userId,
      p_bot_id: a.botId,
      p_remaining_size: a.remainingSize,
      p_position_signal_reason: a.positionSignalReason,
      p_history: a.history,
      p_source: a.source,
    });
    return interpretSettlement(data, error);
  } catch (e) {
    return { outcome: "failed", error: (e as Error)?.message ?? String(e) };
  }
}

/** One log line per non-settled outcome, so a skipped close is never silent. */
export function describeSettlementMiss(o: Exclude<SettlementOutcome, { outcome: "settled" }>): string {
  switch (o.outcome) {
    case "already_settled":
      return `already settled by another caller — no second credit (ledger ${o.ledgerId ?? "?"})`;
    case "rejected":
      return `settlement refused (${o.code})${o.reason ? `: ${o.reason}` : ""} — nothing committed`;
    case "failed":
      return `settlement FAILED, nothing committed, position still open: ${o.error}`;
  }
}
