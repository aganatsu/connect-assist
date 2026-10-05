/**
 * Types and client rules for the System Reset & Ledger Health card.
 *
 * The server (supabase/functions/system-reset, _shared/systemReset.ts) is the
 * authority: it recomputes readiness, checks the admin, the phrase, the
 * fingerprint and the execution switch on every execute. These client rules
 * only decide what the screen enables — they are not the security boundary.
 */
export const CONFIRMATION_PHRASE = "RESET 100000";

export interface Condition { key: string; label: string; pass: boolean; detail: string }
export interface OldPosition {
  id: string; position_id: string; symbol: string; direction: string; size: number; entry_price: number;
  current_price: number | null; stop_loss: number | null; take_profit: number | null; open_time: string; created_at: string;
  unrealized_usd: number | null;
}
export interface OldOrder { id: string; order_id: string; symbol: string; direction: string; status: string; entry_price: number | null; placed_at: string; expires_at: string | null }
export interface OldSetup { id: string; symbol: string | null; direction: string | null; status: string; created_at: string | null }
export interface ResetRunSummary {
  reset_id: string; status: string; requested_at: string; started_at: string | null; completed_at: string | null;
  failed_step: string | null; failure_reason: string | null; pre_reset_balance: number | null; post_reset_balance: number | null; success: boolean | null;
}

export interface Readiness {
  generated_at: string;
  ready: boolean;
  execute_enabled: boolean;
  fingerprint: string;
  conditions: Condition[];
  blocking: Condition[];
  monitor: { status: "PASS" | "FAIL" | "NO DATA"; last_run_at: string | null; last_pass_at: string | null; runs_this_window: number; failed_runs_this_window: number };
  window: { status: "In Progress" | "Complete"; started_at: string | null; completes_at: string | null; final_run_at: string | null; final_pass: boolean | null };
  metrics: {
    drift: number | null; unledgered_writes: number; unsettled_closes: number; duplicate_settlements: number;
    balance: number; equity: number | null; unrealized_pnl: number | null;
    open_positions: number; pending_orders: number; active_setups: number;
    guard_mode: "RECORDING" | "BLOCKING" | "UNKNOWN"; is_paused: boolean;
  };
  old_period: { positions: OldPosition[]; pending: OldOrder[]; setups: OldSetup[] };
  recent_runs?: ResetRunSummary[];
}

export interface ResetResult {
  status: "succeeded" | "failed" | "aborted"; resetId: string | null; failedStep?: string; reason?: string;
  verification?: Condition[]; error?: string;
}

/** The approve button is enabled only when the server says READY and execution is switched on. */
export const canApprove = (r: Readiness | null | undefined): boolean => !!r && r.ready && r.execute_enabled;

/** The final button: the phrase, exactly — no trimming, no case folding. */
export const phraseMatches = (typed: string): boolean => typed === CONFIRMATION_PHRASE;

export const usd = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });
