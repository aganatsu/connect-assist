/**
 * SETTLEMENT MONITOR — the checks, the 24h verdict, and the read-only rule.
 *
 * Fixtures are the live ledger as it stood after PR #627's migrations were
 * applied (2026-10-05 17:20:36 UTC): one opening entry at 105,879.62.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateSettlementHealth,
  evaluateWindow,
  formatAlert,
  isServiceRole,
  type LedgerEntry,
  type MonitorInput,
} from "../../functions/_shared/settlementMonitor.ts";

const EPOCH = "2026-10-05T17:20:36.756Z";
const opening: LedgerEntry = {
  seq: 1, kind: "opening", amount: 105879.62, balance_before: 0, balance_after: 105879.62,
  settlement_key: "opening:0bf85345-7ecc-4f67-a925-f00ab1745f4a", position_id: null, history_id: null,
  source: "migration:20261006010000", detail: {}, created_at: EPOCH,
};
const close = (seq: number, before: number, amount: number, pid: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  seq, kind: "close", amount, balance_before: before, balance_after: before + amount,
  settlement_key: `close:smc:${pid}`, position_id: pid, history_id: `h-${pid}`,
  source: "scanner_breach_check", detail: { position_created_at: "2026-10-05T16:27:06Z" },
  created_at: "2026-10-05T19:00:00Z", ...over,
});

function input(over: Partial<MonitorInput> = {}): MonitorInput {
  return {
    now: "2026-10-05T21:17:00Z",
    account: { id: "3e4b5dcb", balance: 105879.62, ledger_epoch_id: "0bf85345", ledger_epoch_started_at: EPOCH, ledger_reset_at: null },
    reconciliation: { drift: 0, ledger_balance: 105879.62, history_rows_without_settlement_this_epoch: 0 },
    ledger: [opening],
    unledgeredWrites: [],
    historySinceEpoch: [],
    auditSinceEpoch: [],
    linkedHistoryClosedAt: {},
    ...over,
  };
}
const failed = (r: ReturnType<typeof evaluateSettlementHealth>) => r.failures.map((f) => f.name);

Deno.test("the live post-migration state passes every check", () => {
  const r = evaluateSettlementHealth(input());
  assertEquals(r.pass, true, JSON.stringify(r.failures));
  assertEquals(r.checks.length, 6);
});

Deno.test("a natural GBP/USD stop-out settled through the ledger passes", () => {
  const c = close(2, 105879.62, -1000, "3f39df7b");
  const r = evaluateSettlementHealth(input({
    account: { ...input().account, balance: 104879.62 },
    reconciliation: { drift: 0, ledger_balance: 104879.62, history_rows_without_settlement_this_epoch: 0 },
    ledger: [opening, c],
    historySinceEpoch: [{ id: "h-3f39df7b", position_id: "3f39df7b", close_reason: "sl_hit", pnl: -1000, closed_at: "2026-10-05T19:00:00Z", bot_id: "smc" }],
    auditSinceEpoch: [{ position_id: "3f39df7b", close_source: "scanner_breach_check", pnl: "-1000.00", created_at: "2026-10-05T19:00:00Z" }],
    linkedHistoryClosedAt: { "h-3f39df7b": "2026-10-05T19:00:00Z" },
  }));
  assertEquals(r.pass, true, JSON.stringify(r.failures));
});

Deno.test("drift is caught, to the cent", () => {
  assertEquals(failed(evaluateSettlementHealth(input({ reconciliation: { drift: 0.01, ledger_balance: 105879.61, history_rows_without_settlement_this_epoch: 0 } }))), ["drift_zero"]);
  assertEquals(failed(evaluateSettlementHealth(input({ reconciliation: { drift: null, ledger_balance: null, history_rows_without_settlement_this_epoch: 0 } }))), ["drift_zero"]);
});

Deno.test("a direct balance write is caught and named", () => {
  const r = evaluateSettlementHealth(input({
    unledgeredWrites: [{ id: 1, old_balance: 105879.62, new_balance: 106750.81, request_role: "service_role", created_at: "2026-10-05T18:20:03Z" }],
  }));
  assert(failed(r).includes("no_unledgered_writes"));
  assert(formatAlert("periodic", r).includes("no_unledgered_writes"));
});

Deno.test("a close with no settlement is caught — in history and in the audit log", () => {
  const r = evaluateSettlementHealth(input({
    historySinceEpoch: [{ id: "h1", position_id: "2527bfa5", close_reason: "sl_hit", pnl: -2000, closed_at: "2026-10-05T19:00:00Z", bot_id: "smc" }],
    auditSinceEpoch: [{ position_id: "2527bfa5", close_source: "scanner_breach_check", pnl: "-2000", created_at: "2026-10-05T19:00:00Z" }],
  }));
  assertEquals(failed(r), ["every_close_settled"]);
  const ev = r.failures[0].evidence as { historyUnsettled: unknown[]; auditUnsettled: string[] };
  assertEquals(ev.auditUnsettled, ["2527bfa5"]);
});

Deno.test("a partial TP row is matched to its partial key", () => {
  const partial: LedgerEntry = { ...close(2, 105879.62, 100, "39c5161f"), kind: "partial", settlement_key: "partial:smc:39c5161f:1", source: "paper_trading_partial_tp" };
  const r = evaluateSettlementHealth(input({
    account: { ...input().account, balance: 105979.62 },
    ledger: [opening, partial],
    historySinceEpoch: [{ id: "h", position_id: "39c5161f_partial", close_reason: "partial_tp", pnl: 100, closed_at: "2026-10-05T19:00:00Z", bot_id: "smc" }],
  }));
  assertEquals(r.pass, true, JSON.stringify(r.failures));
});

Deno.test("a duplicate settlement key is caught (the USD/JPY shape)", () => {
  const a = close(2, 105879.62, 871.19, "0e76555c");
  const b = close(3, 106750.81, 871.19, "0e76555c");
  const r = evaluateSettlementHealth(input({ account: { ...input().account, balance: 107622.00 }, ledger: [opening, a, b] }));
  assert(failed(r).includes("no_duplicate_keys"));
});

Deno.test("ledger vs account: mismatch, chain break and arithmetic error are all caught", () => {
  assert(failed(evaluateSettlementHealth(input({ account: { ...input().account, balance: 106750.81 } }))).includes("ledger_matches_account"));
  const broken = close(2, 100000, 50, "x1"); // balance_before does not follow 105879.62
  assert(failed(evaluateSettlementHealth(input({ ledger: [opening, broken], account: { ...input().account, balance: 100050 } }))).includes("ledger_matches_account"));
  const bad = { ...close(2, 105879.62, 50, "x2"), balance_after: 105999 };
  assert(failed(evaluateSettlementHealth(input({ ledger: [opening, bad], account: { ...input().account, balance: 105999 } }))).includes("ledger_matches_account"));
});

Deno.test("after a reset: money for a position opened before it is caught", () => {
  const resetEntry: LedgerEntry = {
    seq: 2, kind: "reset", amount: 100000 - 105879.62, balance_before: 105879.62, balance_after: 100000,
    settlement_key: "reset:e2", position_id: null, history_id: null, source: "reset_paper_account", detail: {}, created_at: "2026-10-07T12:00:00Z",
  };
  const sneaky = close(3, 100000, 500, "old1", { detail: { position_created_at: "2026-10-05T11:04:02Z" }, created_at: "2026-10-07T13:00:00Z" });
  const r = evaluateSettlementHealth(input({
    account: { ...input().account, balance: 100500, ledger_reset_at: "2026-10-07T12:00:00Z" },
    reconciliation: { drift: 0, ledger_balance: 100500, history_rows_without_settlement_this_epoch: 0 },
    ledger: [opening, resetEntry, sneaky],
  }));
  assertEquals(failed(r), ["no_pre_reset_or_backfill_movement"]);
  // A zero-amount pre-epoch settlement is the correct handling and passes.
  const ok: LedgerEntry = { ...sneaky, kind: "pre_epoch_close", amount: 0, balance_after: 100000 };
  assertEquals(evaluateSettlementHealth(input({
    account: { ...input().account, balance: 100000, ledger_reset_at: "2026-10-07T12:00:00Z" },
    reconciliation: { drift: 0, ledger_balance: 100000, history_rows_without_settlement_this_epoch: 0 },
    ledger: [opening, resetEntry, ok],
  })).pass, true);
});

Deno.test("money linked to a trade closed before the ledger existed is caught (backfill shape)", () => {
  const c = close(2, 105879.62, 871.19, "0e76555c", { history_id: "d582c8b5" });
  const r = evaluateSettlementHealth(input({
    account: { ...input().account, balance: 106750.81 },
    reconciliation: { drift: 0, ledger_balance: 106750.81, history_rows_without_settlement_this_epoch: 0 },
    ledger: [opening, c],
    linkedHistoryClosedAt: { d582c8b5: "2026-09-16T18:20:02.533Z" },
  }));
  assertEquals(failed(r), ["no_pre_reset_or_backfill_movement"]);
});

Deno.test("an unknown writer source is caught", () => {
  const c = close(2, 105879.62, 10, "z", { source: "manual_sql" });
  assert(failed(evaluateSettlementHealth(input({ ledger: [opening, c], account: { ...input().account, balance: 105889.62 } })))
    .includes("no_pre_reset_or_backfill_movement"));
});

// ─── the 24h verdict ────────────────────────────────────────────────────────

const pass = evaluateSettlementHealth(input());
const runsEvery4h = (n: number, startH = 0.5) =>
  Array.from({ length: n }, (_, k) => ({ run_at: new Date(Date.parse(EPOCH) + (startH + 4 * k) * 3_600_000).toISOString(), pass: true }));
const win = (runs: { run_at: string; pass: boolean }[], nowH = 24.1, finalCheck = pass) => evaluateWindow({
  epochStartedAt: EPOCH, now: new Date(Date.parse(EPOCH) + nowH * 3_600_000).toISOString(),
  windowHours: 24, minRuns: 5, maxGapHours: 5, runs, finalCheck,
});

Deno.test("window: six clean runs over 24h passes", () => {
  const w = win(runsEvery4h(6));
  assertEquals(w.pass, true, w.reasons.join("; "));
  assert(formatAlert("final", pass, w).includes("No production change has been made"));
});

Deno.test("window: a single failed run fails the window even if the final check passes", () => {
  const runs = runsEvery4h(6); runs[2].pass = false;
  const w = win(runs);
  assertEquals(w.pass, false);
  assert(w.reasons.some((r) => r.includes("FAILED")));
});

Deno.test("window: an unwatched gap fails it — the monitor must actually have run", () => {
  const runs = runsEvery4h(6).filter((_, k) => k !== 3); // one missing fire → 8h gap
  const w = win(runs);
  assertEquals(w.pass, false);
  assert(w.reasons.some((r) => r.includes("unwatched gap")));
});

Deno.test("window: too early, too few runs, or a failing final check all fail", () => {
  assertEquals(win(runsEvery4h(6), 20).pass, false);
  assertEquals(win(runsEvery4h(3)).pass, false);
  const bad = evaluateSettlementHealth(input({ reconciliation: { drift: 1, ledger_balance: 0, history_rows_without_settlement_this_epoch: 0 } }));
  const w = win(runsEvery4h(6), 24.1, bad);
  assertEquals(w.pass, false);
  assert(formatAlert("final", bad, w).includes("Do NOT enable blocking"));
});

// ─── read-only rule, from the function source ───────────────────────────────

Deno.test("the function writes nothing but its own results table", () => {
  const src = Deno.readTextFileSync(new URL("../../functions/settlement-monitor/index.ts", import.meta.url));
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  assert(!/\.(update|upsert|delete)\(/.test(code), "no update/upsert/delete anywhere");
  assert(!/\.rpc\(/.test(code), "no RPC calls (settle/reset/backfill are writers)");
  const inserts = [...code.matchAll(/from\("([a-z_]+)"\)\.insert\(/g)].map((m) => m[1]);
  assert(inserts.length >= 1);
  assert(inserts.every((t) => t === "settlement_monitor_runs"), `inserts only into settlement_monitor_runs, got ${inserts}`);
  assert(/if \(!isServiceRole\(req\.headers\.get\("Authorization"\), serviceKey\)\) return respond\(\{ error: "Unauthorized" \}, 401\)/.test(code), "service-role callers only");
});

Deno.test("the final job never enables blocking or resets", () => {
  const src = Deno.readTextFileSync(new URL("../../functions/settlement-monitor/index.ts", import.meta.url));
  assert(!/paper_ledger_guard/.test(src.replace(/^\s*\/\/.*$/gm, "")), "does not read or write the guard");
  assert(!/reset_paper_account/.test(src.replace(/^\s*\/\/.*$/gm, "")));
  const cron = Deno.readTextFileSync(new URL("../../cron/settlement_monitor_cron.sql", import.meta.url));
  assert(/'settlement-monitor-4h'/.test(cron) && /'settlement-monitor-final'/.test(cron));
  assert(!/paper_ledger_guard|reset_paper_account|update public\./i.test(cron.replace(/^--.*$/gm, "")), "the cron SQL changes no trading state");
});

Deno.test("isServiceRole: the exact key or a service_role JWT; nothing else", () => {
  const jwt = (role: string) => `x.${btoa(JSON.stringify({ role })).replace(/=+$/, "")}.y`;
  assertEquals(isServiceRole("Bearer secret", "secret"), true);
  assertEquals(isServiceRole(`Bearer ${jwt("service_role")}`, "other"), true);
  assertEquals(isServiceRole(`Bearer ${jwt("authenticated")}`, "other"), false);
  assertEquals(isServiceRole(`Bearer ${jwt("anon")}`, "other"), false);
  assertEquals(isServiceRole(null, "secret"), false);
  assertEquals(isServiceRole("Bearer garbage", "secret"), false);
});

Deno.test("after a reset: the reset's own old-period flatten closes (settled before the boundary) pass", () => {
  const flatten = close(2, 105879.62, -800, "2527bfa5", {
    source: "account_reset_flatten", detail: { position_created_at: "2026-10-05T11:04:02Z" }, created_at: "2026-10-07T11:59:00Z",
  });
  const resetEntry: LedgerEntry = {
    seq: 3, kind: "reset", amount: 100000 - 105079.62, balance_before: 105079.62, balance_after: 100000,
    settlement_key: "reset:e2", position_id: null, history_id: null, source: "reset_paper_account", detail: {}, created_at: "2026-10-07T12:00:00Z",
  };
  const r = evaluateSettlementHealth(input({
    account: { ...input().account, balance: 100000, ledger_reset_at: "2026-10-07T12:00:00Z", ledger_epoch_started_at: "2026-10-07T12:00:00Z" },
    reconciliation: { drift: 0, ledger_balance: 100000, history_rows_without_settlement_this_epoch: 0 },
    ledger: [opening, flatten, resetEntry],
  }));
  assertEquals(r.pass, true, JSON.stringify(r.failures));
});
