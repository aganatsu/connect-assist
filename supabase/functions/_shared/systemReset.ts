/**
 * SYSTEM RESET — readiness rules and the reset sequence.
 *
 * Pure logic, with every database action behind `ResetDeps`, so each failure
 * point is testable without touching production. The system-reset Edge
 * Function supplies the real deps.
 *
 * The reset never runs automatically. `runSystemReset` is reached only from
 * the admin card, after the server has verified an admin caller, the typed
 * confirmation, a matching readiness fingerprint and the execution switch.
 *
 * Any failed step STOPS the sequence, leaves the bot paused, and records the
 * step and reason on the permanent account_reset_runs row.
 */
import type { MonitorResult } from "./settlementMonitor.ts";
import { getQuoteToUSDRate, SPECS } from "./smcAnalysis.ts";
import { requiredRatePairs } from "./rateMapPolicy.ts";

export const RESET_AMOUNT = 100000;
export const CONFIRMATION_PHRASE = "RESET 100000";
export const MONITOR_WINDOW_HOURS = 24;
export const MONITOR_STALE_HOURS = 5;
export const MARKET_DATA_MAX_AGE_MIN = 10;

// ─── Readiness ──────────────────────────────────────────────────────────────

export interface OldPosition {
  id: string; position_id: string; symbol: string; direction: "long" | "short";
  size: number; entry_price: number; current_price: number | null;
  stop_loss: number | null; take_profit: number | null; open_time: string; created_at: string;
  unrealized_usd: number | null;
}
export interface OldOrder { id: string; order_id: string; symbol: string; direction: string; status: string; entry_price: number | null; placed_at: string; expires_at: string | null }
export interface OldSetup { id: string; symbol: string | null; direction: string | null; status: string; created_at: string | null }
export interface MonitorRunRow { id: number; run_at: string; mode: "periodic" | "final"; pass: boolean; failures: unknown; epoch_id: string | null }

export interface ReadinessInput {
  now: string;
  account: {
    id: string; balance: number; peak_balance: number | null; daily_pnl_base: number | null;
    is_paused: boolean; ledger_epoch_id: string | null; ledger_epoch_started_at: string | null; ledger_reset_at: string | null;
  };
  /** Every settlement_monitor_runs row since the epoch started, any epoch_id (errors have none). */
  monitorRuns: MonitorRunRow[];
  liveHealth: MonitorResult;
  /** paper_account_reconciliation.drift, verbatim. */
  reconDrift: number | null;
  guardMode: string | null;
  objectsPresent: Record<string, boolean>;
  openPositions: OldPosition[];
  livePending: OldOrder[];
  activeSetups: OldSetup[];
  marketData: { ok: boolean; detail: string };
  resetRunning: boolean;
  executeEnabled: boolean;
}

export interface Condition { key: string; label: string; pass: boolean; detail: string }

export interface Readiness {
  generated_at: string;
  ready: boolean;
  execute_enabled: boolean;
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
  fingerprint_basis: string;
}

const hours = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;

export function evaluateResetReadiness(i: ReadinessInput): Readiness {
  const epoch = i.account.ledger_epoch_started_at;
  const epochRuns = i.monitorRuns.filter((r) => r.epoch_id === i.account.ledger_epoch_id);
  const periodic = epochRuns.filter((r) => r.mode === "periodic").sort((a, b) => Date.parse(a.run_at) - Date.parse(b.run_at));
  const finalRun = epochRuns.find((r) => r.mode === "final") ?? null;
  const allRuns = [...i.monitorRuns].sort((a, b) => Date.parse(a.run_at) - Date.parse(b.run_at));
  const lastRun = allRuns[allRuns.length - 1] ?? null;
  const lastPass = [...allRuns].reverse().find((r) => r.pass) ?? null;
  const failedPeriodic = periodic.filter((r) => !r.pass);
  const recentFailures = allRuns.filter((r) => !r.pass && hours(r.run_at, i.now) <= 24);

  const completesAt = epoch ? new Date(Date.parse(epoch) + MONITOR_WINDOW_HOURS * 3_600_000).toISOString() : null;
  const windowComplete = !!finalRun && !!completesAt && Date.parse(i.now) >= Date.parse(completesAt);

  const byName = (n: string) => i.liveHealth.checks.find((c) => c.name === n);
  const unledgered = (byName("no_unledgered_writes")?.evidence as unknown[] | undefined)?.length ?? 0;
  const unsettledEv = byName("every_close_settled")?.evidence as { historyUnsettled?: unknown[]; auditUnsettled?: unknown[] } | undefined;
  const unsettled = (unsettledEv?.historyUnsettled?.length ?? 0) + (unsettledEv?.auditUnsettled?.length ?? 0);
  const dups = (byName("no_duplicate_keys")?.evidence as unknown[] | undefined)?.length ?? 0;
  const unrealized = i.openPositions.length === 0 ? 0
    : i.openPositions.some((p) => p.unrealized_usd === null) ? null
    : i.openPositions.reduce((s, p) => s + (p.unrealized_usd as number), 0);
  const guard = i.guardMode === "enforce" ? "BLOCKING" : i.guardMode === "observe" ? "RECORDING" : "UNKNOWN";
  const missingObjects = Object.entries(i.objectsPresent).filter(([, v]) => !v).map(([k]) => k);

  const c = (key: string, label: string, pass: boolean, detail: string): Condition => ({ key, label, pass, detail });
  const conditions: Condition[] = [
    c("monitoring_window_complete", "24-hour monitoring period completed", windowComplete,
      windowComplete ? `final verdict recorded ${finalRun!.run_at}`
        : finalRun ? `final verdict recorded but window ends ${completesAt}` : `in progress — completes ${completesAt ?? "unknown"}`),
    c("monitoring_checks_passed", "All monitoring checks passed",
      !!finalRun && finalRun.pass && periodic.length > 0 && failedPeriodic.length === 0 && !!lastRun && lastRun.pass
        && hours(lastRun.run_at, i.now) <= MONITOR_STALE_HOURS,
      `${periodic.length} periodic run(s), ${failedPeriodic.length} failed; final ${finalRun ? (finalRun.pass ? "PASS" : "FAIL") : "not yet"}; last run ${lastRun ? `${hours(lastRun.run_at, i.now).toFixed(1)}h ago` : "never"}`),
    c("drift_zero", "Reconciliation drift = $0", byName("drift_zero")?.pass === true, byName("drift_zero")?.detail ?? "no data"),
    c("no_unledgered_writes", "Unledgered writes = 0", byName("no_unledgered_writes")?.pass === true, byName("no_unledgered_writes")?.detail ?? "no data"),
    c("no_unsettled_closes", "Unsettled closed trades = 0", byName("every_close_settled")?.pass === true, byName("every_close_settled")?.detail ?? "no data"),
    c("settlement_ledger_healthy", "Settlement ledger healthy", i.liveHealth.pass,
      i.liveHealth.pass ? "all 6 ledger checks pass" : `failing: ${i.liveHealth.failures.map((f) => f.name).join(", ")}`),
    c("guard_blocking", "Direct-write protection is BLOCKING", guard === "BLOCKING", `guard mode ${guard}`),
    c("accounting_migrations_present", "Accounting migrations present", missingObjects.length === 0,
      missingObjects.length === 0 ? "ledger, settlement, reset, guard, monitor and timestamptz objects present" : `missing: ${missingObjects.join(", ")}`),
    c("no_active_settlement_error", "No active settlement error",
      recentFailures.length === 0 && !i.resetRunning,
      i.resetRunning ? "a reset is already running" : recentFailures.length ? `${recentFailures.length} failed monitor run(s) in the last 24h` : "none in the last 24h"),
    c("market_data_fresh", "Prices and FX rates fresh (needed to close old positions at market)",
      i.openPositions.length === 0 || i.marketData.ok,
      i.openPositions.length === 0 ? "no open positions to close" : i.marketData.detail),
  ];
  const blocking = conditions.filter((x) => !x.pass);
  const sortIds = <T extends { id: string }>(xs: T[]) => xs.map((x) => x.id).sort();

  return {
    generated_at: i.now,
    ready: blocking.length === 0,
    execute_enabled: i.executeEnabled,
    conditions,
    blocking,
    monitor: {
      status: lastRun ? (lastRun.pass ? "PASS" : "FAIL") : "NO DATA",
      last_run_at: lastRun?.run_at ?? null,
      last_pass_at: lastPass?.run_at ?? null,
      runs_this_window: periodic.length,
      failed_runs_this_window: failedPeriodic.length,
    },
    window: {
      status: windowComplete ? "Complete" : "In Progress",
      started_at: epoch, completes_at: completesAt,
      final_run_at: finalRun?.run_at ?? null, final_pass: finalRun ? finalRun.pass : null,
    },
    metrics: {
      drift: i.reconDrift,
      unledgered_writes: unledgered,
      unsettled_closes: unsettled,
      duplicate_settlements: dups,
      balance: i.account.balance,
      equity: unrealized === null ? null : Number((i.account.balance + unrealized).toFixed(2)),
      unrealized_pnl: unrealized === null ? null : Number(unrealized.toFixed(2)),
      open_positions: i.openPositions.length,
      pending_orders: i.livePending.length,
      active_setups: i.activeSetups.length,
      guard_mode: guard,
      is_paused: i.account.is_paused,
    },
    old_period: { positions: i.openPositions, pending: i.livePending, setups: i.activeSetups },
    fingerprint_basis: JSON.stringify({
      balance: i.account.balance, epoch: i.account.ledger_epoch_id, guard,
      positions: sortIds(i.openPositions), pending: sortIds(i.livePending), setups: sortIds(i.activeSetups),
      final: finalRun?.id ?? null,
    }),
  };
}

export async function fingerprint(basis: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Market close P&L ───────────────────────────────────────────────────────

/** Same formula as the scanner breach close: diff × lot units × size × quote→USD. */
export function flattenPnl(
  pos: { symbol: string; direction: string; entry_price: number; size: number },
  exitPrice: number,
  rateMap: Record<string, number>,
): { pnl: number; pnlPips: number; missingRate: string | null } {
  const needed = requiredRatePairs([pos.symbol]);
  const missing = needed.find((p) => !(rateMap[p] > 0)) ?? null;
  const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
  const diff = pos.direction === "long" ? exitPrice - pos.entry_price : pos.entry_price - exitPrice;
  const pnl = diff * spec.lotUnits * pos.size * getQuoteToUSDRate(pos.symbol, rateMap);
  return { pnl: Number(pnl.toFixed(2)), pnlPips: Number((diff / spec.pipSize).toFixed(1)), missingRate: missing };
}

// ─── The reset sequence ─────────────────────────────────────────────────────

export interface SettleOutcome { outcome: string; amount?: number; balance?: number | null; detail?: string }

export interface ResetDeps {
  now(): string;
  /** Re-reads everything and evaluates readiness from scratch. */
  readiness(): Promise<Readiness & { fingerprint: string }>;
  insertRun(row: Record<string, unknown>): Promise<string>;
  updateRun(resetId: string, patch: Record<string, unknown>): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  cancelOldPending(boundary: string): Promise<OldOrder[]>;
  cancelOldSetups(boundary: string): Promise<OldSetup[]>;
  openPositions(): Promise<OldPosition[]>;
  livePending(): Promise<OldOrder[]>;
  rates(): Promise<{ ok: boolean; rateMap: Record<string, number>; detail: string }>;
  settleFlatten(pos: OldPosition, exitPrice: number, pnl: number, pnlPips: number, resetId: string): Promise<SettleOutcome>;
  ledgerHealth(): Promise<{ health: MonitorResult; balance: number; realizedThisEpoch: number }>;
  takeSnapshot(resetId: string, data: Record<string, unknown>): Promise<number>;
  resetAccount(amount: number, reason: string): Promise<{ reset: boolean; code?: string; epoch_id?: string; epoch_started_at?: string }>;
  clearActiveState(): Promise<Record<string, unknown>>;
  postResetState(): Promise<PostResetState>;
}

export interface PostResetState {
  balance: number; peak_balance: number; daily_pnl_base: number; equity: number;
  realized_pnl_this_epoch: number; unrealized_pnl: number;
  open_positions: number; positions_opened_before_reset: number; pending_orders: number; active_setups: number;
  daily_pnl: number; drift: number | null; unledgered_writes_this_epoch: number;
  last_ledger_kind: string | null; ledger_reset_at: string | null;
}

export function verifyPostReset(s: PostResetState): Condition[] {
  const c = (key: string, label: string, pass: boolean, detail: string): Condition => ({ key, label, pass, detail });
  const eq = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);
  return [
    c("balance", "Balance = $100,000.00", eq(s.balance, RESET_AMOUNT), `${s.balance}`),
    c("equity", "Equity = $100,000.00", eq(s.equity, RESET_AMOUNT), `${s.equity}`),
    c("realized", "Realized P/L = $0", eq(s.realized_pnl_this_epoch, 0), `${s.realized_pnl_this_epoch}`),
    c("unrealized", "Unrealized P/L = $0", eq(s.unrealized_pnl, 0), `${s.unrealized_pnl}`),
    c("positions", "Open positions = 0", s.open_positions === 0, `${s.open_positions}`),
    c("pending", "Pending orders = 0", s.pending_orders === 0, `${s.pending_orders}`),
    c("setups", "Old watched/armed setups = 0", s.active_setups === 0, `${s.active_setups}`),
    c("daily_pnl", "Daily P/L = $0 (daily base $100,000)", eq(s.daily_pnl, 0) && eq(s.daily_pnl_base, RESET_AMOUNT), `daily ${s.daily_pnl}, base ${s.daily_pnl_base}`),
    c("drawdown", "Drawdown baseline = $100,000", eq(s.peak_balance, RESET_AMOUNT), `peak ${s.peak_balance}`),
    c("old_positions", "No old position can affect the new balance",
      s.positions_opened_before_reset === 0 && !!s.ledger_reset_at, `${s.positions_opened_before_reset} pre-reset positions; reset boundary ${s.ledger_reset_at}`),
    c("old_backfill", "No old backfill can affect the new balance", s.last_ledger_kind === "reset",
      `latest ledger entry: ${s.last_ledger_kind} (backfill never posts to the ledger; a pre-reset position settles for 0)`),
    c("drift", "Ledger reconciliation drift = $0", s.drift === 0, `${s.drift}`),
    c("unledgered", "No unledgered writes", s.unledgered_writes_this_epoch === 0, `${s.unledgered_writes_this_epoch}`),
  ];
}

export interface ResetRequest { requestedBy: string; requestedAt: string; confirmation: string; fingerprint: string; accountId: string }
export interface ResetResult { status: "succeeded" | "failed" | "aborted"; resetId: string | null; failedStep?: string; reason?: string; verification?: Condition[] }

export async function runSystemReset(deps: ResetDeps, req: ResetRequest): Promise<ResetResult> {
  const approvedAt = deps.now();

  // 1-2. Re-check everything now; abort on any change. Aborts are recorded too.
  const ready = await deps.readiness();
  const abortReason = req.confirmation !== CONFIRMATION_PHRASE ? "confirmation phrase did not match"
    : !ready.execute_enabled ? "execution is disabled server-side (system_reset_controls)"
    : !ready.ready ? `not ready: ${ready.blocking.map((b) => b.key).join(", ")}`
    : ready.fingerprint !== req.fingerprint ? "state changed since the confirmation dialog opened (fingerprint mismatch)"
    : null;
  if (abortReason) {
    const resetId = await deps.insertRun({
      account_id: req.accountId, requested_by: req.requestedBy, requested_at: req.requestedAt, approved_at: approvedAt,
      status: "aborted", failed_step: "readiness_recheck", failure_reason: abortReason, readiness: ready,
      completed_at: deps.now(), success: false,
    });
    return { status: "aborted", resetId, failedStep: "readiness_recheck", reason: abortReason };
  }

  // 3. Start, with a unique id. The unique index allows one running reset.
  const startedAt = deps.now();
  const resetId = await deps.insertRun({
    account_id: req.accountId, requested_by: req.requestedBy, requested_at: req.requestedAt, approved_at: approvedAt,
    started_at: startedAt, status: "running", readiness: ready,
    pre_reset_balance: ready.metrics.balance, pre_reset_equity: ready.metrics.equity,
  });
  const steps: { step: string; at: string; ok: boolean; detail?: unknown }[] = [];
  const record = async (step: string, ok: boolean, detail?: unknown, patch: Record<string, unknown> = {}) => {
    steps.push({ step, at: deps.now(), ok, detail });
    await deps.updateRun(resetId, { ...patch, steps });
  };
  const fail = async (step: string, reason: string, extra: Record<string, unknown> = {}): Promise<ResetResult> => {
    try { await deps.setPaused(true); } catch { /* recorded below regardless */ }
    steps.push({ step, at: deps.now(), ok: false, detail: reason });
    await deps.updateRun(resetId, {
      ...extra, status: "failed", failed_step: step, failure_reason: reason, success: false, completed_at: deps.now(), steps,
    });
    return { status: "failed", resetId, failedStep: step, reason };
  };

  const boundary = startedAt;
  const closed: Record<string, unknown>[] = [];
  let cancelledOrders: OldOrder[] = [];
  let cancelledSetups: OldSetup[] = [];

  try {
    // 4. No new entries while resetting.
    await deps.setPaused(true);
    await record("pause_entries", true);

    // 6 before 5 on purpose: cancelling pending orders first stops an old
    // order from filling into a position mid-flatten. An order a filler had
    // already claimed becomes a position, which the flatten loop closes.
    cancelledOrders = await deps.cancelOldPending(boundary);
    await record("cancel_old_pending", true, { count: cancelledOrders.length }, { orders_cancelled: cancelledOrders });

    // 7. Old watched / armed setups.
    cancelledSetups = await deps.cancelOldSetups(boundary);
    await record("cancel_old_setups", true, { count: cancelledSetups.length }, { setups_cancelled: cancelledSetups });

    // 5. Close every old-period position at market through the ledger.
    for (let pass = 1; pass <= 3; pass++) {
      const open = await deps.openPositions();
      const stragglers = await deps.livePending();
      if (stragglers.length) {
        const more = await deps.cancelOldPending(boundary);
        cancelledOrders = [...cancelledOrders, ...more];
      }
      if (open.length === 0 && stragglers.length === 0) break;
      if (open.length) {
        const r = await deps.rates();
        if (!r.ok) return await fail("close_old_positions", `FX rates not fresh: ${r.detail}`, { positions_closed: closed, orders_cancelled: cancelledOrders });
        for (const pos of open) {
          if (Date.parse(pos.created_at) >= Date.parse(boundary)) {
            return await fail("close_old_positions", `position ${pos.position_id} was created after the reset started`, { positions_closed: closed });
          }
          if (!(pos.current_price && pos.current_price > 0)) {
            return await fail("close_old_positions", `no market price for ${pos.symbol} ${pos.position_id}`, { positions_closed: closed });
          }
          const { pnl, pnlPips, missingRate } = flattenPnl(pos, pos.current_price, r.rateMap);
          if (missingRate) return await fail("close_old_positions", `missing FX rate ${missingRate} for ${pos.symbol}`, { positions_closed: closed });
          const s = await deps.settleFlatten(pos, pos.current_price, pnl, pnlPips, resetId);
          if (s.outcome !== "settled" && s.outcome !== "already_settled") {
            return await fail("close_old_positions", `settlement of ${pos.symbol} ${pos.position_id} ${s.outcome}: ${s.detail ?? ""}`, { positions_closed: closed });
          }
          closed.push({ position_id: pos.position_id, row_id: pos.id, symbol: pos.symbol, direction: pos.direction, size: pos.size,
            entry: pos.entry_price, exit: pos.current_price, pnl: s.outcome === "settled" ? s.amount ?? pnl : 0, outcome: s.outcome });
        }
      }
      if (pass === 3) {
        const left = await deps.openPositions();
        const leftPending = await deps.livePending();
        if (left.length || leftPending.length) {
          return await fail("close_old_positions", `${left.length} position(s) / ${leftPending.length} order(s) still open after 3 passes`, { positions_closed: closed, orders_cancelled: cancelledOrders });
        }
      }
    }
    await record("close_old_positions", true, { closed: closed.length }, { positions_closed: closed, orders_cancelled: cancelledOrders });

    // 8. Every old-period settlement complete and the ledger clean.
    const pre = await deps.ledgerHealth();
    if (!pre.health.pass) {
      return await fail("verify_old_period_settled", `ledger not clean: ${pre.health.failures.map((f) => `${f.name} (${f.detail})`).join("; ")}`);
    }
    const oldPeriodPnl = Number((pre.balance - RESET_AMOUNT).toFixed(2));
    await record("verify_old_period_settled", true, { balance: pre.balance, realized_this_ledger_epoch: pre.realizedThisEpoch },
      { old_period_realized_pnl: oldPeriodPnl, reconciliation: pre.health.summary });

    // 9-10. Final pre-reset snapshot, kept permanently.
    const snapshotId = await deps.takeSnapshot(resetId, {
      closed_positions: closed, cancelled_orders: cancelledOrders, cancelled_setups: cancelledSetups,
    });
    await record("snapshot", true, { snapshot_id: snapshotId }, { snapshot_id: snapshotId });

    // 11. Reset through the ledger.
    const reset = await deps.resetAccount(RESET_AMOUNT, `system reset ${resetId}`);
    if (!reset.reset) return await fail("reset_account", `reset_paper_account refused: ${reset.code ?? "unknown"}`);
    await record("reset_account", true, reset);

    // 12. Only active trading state.
    const cleared = await deps.clearActiveState();
    await record("clear_active_state", true, cleared);

    // 13. Verify.
    const post = await deps.postResetState();
    const verification = verifyPostReset(post);
    const bad = verification.filter((v) => !v.pass);
    if (bad.length) {
      return await fail("verify_post_reset", bad.map((b) => `${b.label}: ${b.detail}`).join("; "),
        { verification, post_reset_balance: post.balance });
    }
    await record("verify_post_reset", true, { checks: verification.length }, { verification, post_reset_balance: post.balance });

    // 14. Resume only after successful verification.
    await deps.setPaused(false);
    steps.push({ step: "resume_trading", at: deps.now(), ok: true });
    await deps.updateRun(resetId, { status: "succeeded", success: true, completed_at: deps.now(), steps });
    return { status: "succeeded", resetId, verification };
  } catch (e) {
    const last = steps[steps.length - 1]?.step ?? "start";
    return await fail(`after:${last}`, (e as Error)?.message ?? String(e), { positions_closed: closed, orders_cancelled: cancelledOrders });
  }
}
