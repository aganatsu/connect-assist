/**
 * SETTLEMENT MONITOR — pure checks over the paper settlement ledger.
 *
 * Fed rows read by the settlement-monitor Edge Function (read-only against
 * trading state). Every check returns PASS/FAIL with the exact evidence, so a
 * failure message names the row, not just the rule.
 *
 *   drift_zero                 paper_account_reconciliation.drift is exactly 0
 *   no_unledgered_writes       paper_balance_unledgered_writes is empty — no
 *                              writer moved the balance outside the ledger
 *   every_close_settled        every final close since the epoch — in history
 *                              and in close_audit_log — has a ledger settlement
 *   no_duplicate_keys          no settlement_key appears twice for an account
 *   ledger_matches_account     latest balance_after == account balance; the
 *                              chain is continuous; amounts sum to the balance
 *   no_pre_reset_or_backfill_movement
 *                              pre-epoch settlements moved 0; no money entry
 *                              for a position opened before the last reset; no
 *                              money entry for a trade closed before the ledger
 *                              existed; every entry came from a known writer
 */

export interface LedgerEntry {
  seq: number;
  kind: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  settlement_key: string;
  position_id: string | null;
  history_id: string | null;
  source: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface MonitorInput {
  now: string;
  account: { id: string; balance: number; ledger_epoch_id: string | null; ledger_epoch_started_at: string | null; ledger_reset_at: string | null };
  reconciliation: { drift: number | null; ledger_balance: number | null; history_rows_without_settlement_this_epoch: number };
  ledger: LedgerEntry[];
  unledgeredWrites: { id: number; old_balance: number | null; new_balance: number | null; request_role: string | null; created_at: string }[];
  /** paper_trade_history rows with closed_at >= epoch start. */
  historySinceEpoch: { id: string; position_id: string; close_reason: string; pnl: number | null; closed_at: string; bot_id: string | null }[];
  /** close_audit_log rows with created_at >= epoch start. */
  auditSinceEpoch: { position_id: string; close_source: string; pnl: string | null; created_at: string }[];
  /** closed_at of every history row a ledger entry links to (history_id -> closed_at). */
  linkedHistoryClosedAt: Record<string, string>;
}

export interface CheckResult { name: string; pass: boolean; detail: string; evidence?: unknown }
export interface MonitorResult { pass: boolean; checks: CheckResult[]; failures: CheckResult[]; summary: Record<string, unknown> }

/** Sources settle_paper_* / reset / account insert write, per the PR #627 code. */
export const KNOWN_LEDGER_SOURCES = new Set([
  "migration:20261006010000", "account_insert", "reset_paper_account",
  "scanner_breach_check", "scanner_reverse_signal",
  "paper_trading_auto", "paper_trading_manual", "paper_trading_partial_tp", "kill_switch",
  "prop_firm_emergency", "finalize_paper_position_close", "account_reset_flatten",
]);

const cents = (n: number) => Math.round(n * 100);
const t = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

export function evaluateSettlementHealth(i: MonitorInput): MonitorResult {
  const checks: CheckResult[] = [];
  const ledger = [...i.ledger].sort((a, b) => a.seq - b.seq);
  const last = ledger[ledger.length - 1];
  const opening = ledger.find((e) => e.kind === "opening");
  const ledgerIntroducedAt = opening ? t(opening.created_at) : NaN;

  // 1. drift
  const drift = i.reconciliation.drift;
  checks.push({
    name: "drift_zero",
    pass: drift !== null && Number(drift) === 0,
    detail: drift === null ? "reconciliation returned no drift (no ledger entry?)" : `drift ${drift}`,
  });

  // 2. unledgered writes
  checks.push({
    name: "no_unledgered_writes",
    pass: i.unledgeredWrites.length === 0,
    detail: i.unledgeredWrites.length === 0
      ? "0 direct balance writes recorded"
      : `${i.unledgeredWrites.length} direct balance write(s) bypassed the ledger`,
    evidence: i.unledgeredWrites.slice(0, 10),
  });

  // 3. every close settled
  const keys = new Set(ledger.map((e) => e.settlement_key));
  const settledPositions = new Set(ledger.filter((e) => e.kind === "close" || e.kind === "pre_epoch_close").map((e) => e.position_id));
  const historyUnsettled = i.historySinceEpoch.filter((h) => {
    const bot = h.bot_id ?? "smc";
    const key = h.close_reason === "partial_tp"
      ? `partial:${bot}:${h.position_id.replace(/_partial$/, "")}:1`
      : `close:${bot}:${h.position_id}`;
    return !keys.has(key);
  });
  const auditUnsettled = [...new Set(i.auditSinceEpoch.map((a) => a.position_id))].filter((p) => !settledPositions.has(p));
  const viewUnsettled = i.reconciliation.history_rows_without_settlement_this_epoch;
  checks.push({
    name: "every_close_settled",
    pass: historyUnsettled.length === 0 && auditUnsettled.length === 0 && viewUnsettled === 0,
    detail: `history closes without settlement: ${historyUnsettled.length} (view: ${viewUnsettled}); audited closes without settlement: ${auditUnsettled.length}`,
    evidence: { historyUnsettled: historyUnsettled.slice(0, 10), auditUnsettled: auditUnsettled.slice(0, 10) },
  });

  // 4. duplicate keys
  const seen = new Map<string, number>();
  for (const e of ledger) seen.set(e.settlement_key, (seen.get(e.settlement_key) ?? 0) + 1);
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  checks.push({
    name: "no_duplicate_keys",
    pass: dups.length === 0,
    detail: dups.length === 0 ? `${ledger.length} entries, all keys unique` : `${dups.length} duplicated settlement key(s)`,
    evidence: dups.slice(0, 10),
  });

  // 5. ledger matches account, chain continuous, amounts sum
  const chainBreaks: { seq: number; balance_before: number; previous_after: number }[] = [];
  for (let k = 1; k < ledger.length; k++) {
    if (cents(ledger[k].balance_before) !== cents(ledger[k - 1].balance_after)) {
      chainBreaks.push({ seq: ledger[k].seq, balance_before: ledger[k].balance_before, previous_after: ledger[k - 1].balance_after });
    }
  }
  const arithmetic = ledger.filter((e) => cents(e.balance_before + e.amount) !== cents(e.balance_after)).map((e) => e.seq);
  const sum = ledger.reduce((s, e) => s + e.amount, 0);
  const firstBefore = ledger.length ? ledger[0].balance_before : 0;
  const matches = !!last && cents(last.balance_after) === cents(i.account.balance)
    && cents(firstBefore + sum) === cents(i.account.balance)
    && chainBreaks.length === 0 && arithmetic.length === 0;
  checks.push({
    name: "ledger_matches_account",
    pass: matches,
    detail: last
      ? `account ${i.account.balance}, ledger ${last.balance_after}, opening+sum ${(firstBefore + sum).toFixed(2)}, chain breaks ${chainBreaks.length}, arithmetic errors ${arithmetic.length}`
      : "ledger is empty",
    evidence: { chainBreaks: chainBreaks.slice(0, 10), arithmetic: arithmetic.slice(0, 10) },
  });

  // 6. pre-reset / backfill / unknown-writer movement
  const resetAt = t(i.account.ledger_reset_at);
  const preEpochMoved = ledger.filter((e) => e.kind.startsWith("pre_epoch") && cents(e.amount) !== 0).map((e) => e.seq);
  const openedBeforeReset = Number.isNaN(resetAt) ? [] : ledger.filter((e) => {
    // Only settlements made AFTER the reset. The reset's own flatten closes
    // settle old-period positions BEFORE the boundary, legitimately.
    if (e.kind !== "close" || cents(e.amount) === 0 || t(e.created_at) < resetAt) return false;
    const opened = t((e.detail?.position_created_at as string) ?? null);
    return !Number.isNaN(opened) && opened < resetAt;
  }).map((e) => e.seq);
  const oldTradeMoney = ledger.filter((e) => {
    if ((e.kind !== "close" && e.kind !== "partial") || cents(e.amount) === 0 || !e.history_id) return false;
    const closed = t(i.linkedHistoryClosedAt[e.history_id]);
    return !Number.isNaN(closed) && !Number.isNaN(ledgerIntroducedAt) && closed < ledgerIntroducedAt;
  }).map((e) => e.seq);
  const unknownSources = ledger.filter((e) => !KNOWN_LEDGER_SOURCES.has(e.source)).map((e) => ({ seq: e.seq, source: e.source }));
  checks.push({
    name: "no_pre_reset_or_backfill_movement",
    pass: preEpochMoved.length === 0 && openedBeforeReset.length === 0 && oldTradeMoney.length === 0 && unknownSources.length === 0,
    detail: `pre-epoch entries that moved money: ${preEpochMoved.length}; money for positions opened before reset: ${openedBeforeReset.length}; money for trades closed before the ledger: ${oldTradeMoney.length}; unknown writers: ${unknownSources.length}`,
    evidence: { preEpochMoved, openedBeforeReset, oldTradeMoney, unknownSources },
  });

  const failures = checks.filter((c) => !c.pass);
  return {
    pass: failures.length === 0,
    checks,
    failures,
    summary: {
      now: i.now,
      account_balance: i.account.balance,
      ledger_balance: last?.balance_after ?? null,
      ledger_entries: ledger.length,
      closes_settled_since_epoch: ledger.filter((e) => e.kind === "close" && t(e.created_at) >= t(i.account.ledger_epoch_started_at)).length,
      history_closes_since_epoch: i.historySinceEpoch.length,
      epoch_started_at: i.account.ledger_epoch_started_at,
      ledger_reset_at: i.account.ledger_reset_at,
    },
  };
}

/**
 * The 24h verdict: the window is clean only if it was actually watched — at
 * least `minRuns` periodic runs, no gap longer than `maxGapHours` (including
 * from the epoch start to the first run and from the last run to now), and
 * every run PASS — AND the final check itself passes.
 */
export function evaluateWindow(opts: {
  epochStartedAt: string;
  now: string;
  windowHours: number;
  minRuns: number;
  maxGapHours: number;
  runs: { run_at: string; pass: boolean }[];
  finalCheck: MonitorResult;
}): { pass: boolean; reasons: string[]; runs: number; failedRuns: number; maxGapHours: number } {
  const reasons: string[] = [];
  const start = t(opts.epochStartedAt);
  const now = t(opts.now);
  const runs = opts.runs.filter((r) => t(r.run_at) >= start).sort((a, b) => t(a.run_at) - t(b.run_at));
  const elapsedH = (now - start) / 3_600_000;
  if (elapsedH < opts.windowHours) reasons.push(`window not complete: ${elapsedH.toFixed(1)}h of ${opts.windowHours}h`);
  if (runs.length < opts.minRuns) reasons.push(`only ${runs.length} periodic run(s), need ${opts.minRuns}`);
  const failed = runs.filter((r) => !r.pass);
  if (failed.length) reasons.push(`${failed.length} periodic run(s) FAILED (first at ${failed[0].run_at})`);
  const points = [start, ...runs.map((r) => t(r.run_at)), now];
  let maxGap = 0;
  for (let k = 1; k < points.length; k++) maxGap = Math.max(maxGap, (points[k] - points[k - 1]) / 3_600_000);
  if (maxGap > opts.maxGapHours) reasons.push(`unwatched gap of ${maxGap.toFixed(1)}h (max ${opts.maxGapHours}h)`);
  if (!opts.finalCheck.pass) reasons.push(`final check FAILED: ${opts.finalCheck.failures.map((f) => f.name).join(", ")}`);
  return { pass: reasons.length === 0, reasons, runs: runs.length, failedRuns: failed.length, maxGapHours: Number(maxGap.toFixed(2)) };
}

/** Telegram text for a result. Plain text; the notify function sends it as-is. */
export function formatAlert(mode: "periodic" | "final", r: MonitorResult, window?: ReturnType<typeof evaluateWindow>): string {
  if (mode === "final") {
    if (window?.pass) {
      return `✅ SETTLEMENT LEDGER — 24h MONITORING PASSED\n\n${window.runs} periodic runs, all PASS, max unwatched gap ${window.maxGapHours}h.\n` +
        `Balance ${r.summary.account_balance} = ledger ${r.summary.ledger_balance}, drift 0, no direct balance writes.\n\n` +
        `No production change has been made. Blocking mode and the reset await your approval.`;
    }
    return `🚨 SETTLEMENT LEDGER — 24h MONITORING DID NOT PASS\n\n${(window?.reasons ?? []).map((x) => `• ${x}`).join("\n")}\n\n` +
      `Do NOT enable blocking or reset. Investigate first.`;
  }
  return `🚨 SETTLEMENT MONITOR FAILED\n\n${r.failures.map((f) => `• ${f.name}: ${f.detail}`).join("\n")}\n\n` +
    `Balance ${r.summary.account_balance}, ledger ${r.summary.ledger_balance}. Details: settlement_monitor_runs.`;
}

/** True for the service-role key itself or a gateway-verified JWT whose role claim is service_role. */
export function isServiceRole(authHeader: string | null, serviceKey: string): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (token === serviceKey) return true;
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}
