/**
 * Loads the rows evaluateSettlementHealth needs. Shared by settlement-monitor
 * (scheduled) and system-reset (readiness + post-reset verification), so the
 * admin card and the monitor judge the ledger from exactly the same reads.
 * Read-only.
 */
import type { MonitorInput } from "./settlementMonitor.ts";

export const SMC_BOT_ID = "smc";

async function must<T>(label: string, q: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await q;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data as T;
}

export interface LoadedLedgerState {
  input: MonitorInput;
  account: Record<string, any>;
  recon: Record<string, any>;
}

export async function loadMonitorInput(supabase: any, now = new Date().toISOString()): Promise<LoadedLedgerState> {
  const account = await must<any>("paper_accounts", supabase.from("paper_accounts")
    .select("id, user_id, bot_id, balance, peak_balance, daily_pnl_base, daily_pnl_base_date, is_paused, is_running, kill_switch_active, ledger_epoch_id, ledger_epoch_started_at, ledger_reset_at")
    .eq("bot_id", SMC_BOT_ID).single());
  const epoch = account.ledger_epoch_started_at as string;
  const [recon, ledger, unledgered, history, audit] = await Promise.all([
    must<any>("paper_account_reconciliation", supabase.from("paper_account_reconciliation")
      .select("drift, ledger_balance, history_rows_without_settlement_this_epoch, realized_pnl_this_epoch, unledgered_writes_this_epoch, pre_epoch_settlements_this_epoch")
      .eq("account_id", account.id).single()),
    must<any[]>("paper_account_ledger", supabase.from("paper_account_ledger")
      .select("seq, kind, amount, balance_before, balance_after, settlement_key, position_id, history_id, source, detail, created_at")
      .eq("account_id", account.id).order("seq", { ascending: true }).limit(10000)),
    must<any[]>("paper_balance_unledgered_writes", supabase.from("paper_balance_unledgered_writes")
      .select("id, old_balance, new_balance, request_role, created_at").eq("account_id", account.id).order("id", { ascending: true })),
    must<any[]>("paper_trade_history", supabase.from("paper_trade_history")
      .select("id, position_id, close_reason, pnl, closed_at, bot_id").eq("user_id", account.user_id).gte("closed_at", epoch)),
    must<any[]>("close_audit_log", supabase.from("close_audit_log")
      .select("position_id, close_source, pnl, created_at").eq("user_id", account.user_id).gte("created_at", epoch)),
  ]);
  const historyIds = [...new Set(ledger.map((e) => e.history_id).filter(Boolean))] as string[];
  const linked = historyIds.length
    ? await must<any[]>("linked history", supabase.from("paper_trade_history").select("id, closed_at").in("id", historyIds))
    : [];
  return {
    account,
    recon,
    input: {
      now,
      account: {
        id: account.id, balance: Number(account.balance), ledger_epoch_id: account.ledger_epoch_id,
        ledger_epoch_started_at: epoch, ledger_reset_at: account.ledger_reset_at,
      },
      reconciliation: {
        drift: recon.drift === null ? null : Number(recon.drift),
        ledger_balance: recon.ledger_balance === null ? null : Number(recon.ledger_balance),
        history_rows_without_settlement_this_epoch: Number(recon.history_rows_without_settlement_this_epoch),
      },
      ledger: ledger.map((e) => ({ ...e, amount: Number(e.amount), balance_before: Number(e.balance_before), balance_after: Number(e.balance_after) })),
      unledgeredWrites: unledgered,
      historySinceEpoch: history,
      auditSinceEpoch: audit,
      linkedHistoryClosedAt: Object.fromEntries(linked.map((h) => [h.id, h.closed_at])),
    },
  };
}
