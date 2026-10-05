/**
 * SYSTEM RESET — readiness rules and the reset sequence, against a fake
 * backend that records every call. The real SQL objects (audit immutability,
 * admin check, append-only snapshot) are proven in paperSettlementLedger.test.ts.
 *
 * Fixture: production as of 2026-10-05 after the ledger went live — stored
 * balance 105,879.62, GBP/USD short + CHF/JPY long open, USD/JPY + BTC/USD
 * pending, guard RECORDING, monitoring window in progress.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateSettlementHealth, type MonitorResult } from "../../functions/_shared/settlementMonitor.ts";
import {
  CONFIRMATION_PHRASE, evaluateResetReadiness, fingerprint, flattenPnl, runSystemReset, verifyPostReset,
  type OldOrder, type OldPosition, type PostResetState, type ReadinessInput, type ResetDeps,
} from "../../functions/_shared/systemReset.ts";

const EPOCH = "2026-10-05T17:20:36.756Z";
const NOW_LIVE = "2026-10-05T21:30:00Z";
const NOW_DONE = "2026-10-06T18:00:00Z";
const healthy: MonitorResult = evaluateSettlementHealth({
  now: NOW_LIVE,
  account: { id: "a", balance: 105879.62, ledger_epoch_id: "e1", ledger_epoch_started_at: EPOCH, ledger_reset_at: null },
  reconciliation: { drift: 0, ledger_balance: 105879.62, history_rows_without_settlement_this_epoch: 0 },
  ledger: [{ seq: 1, kind: "opening", amount: 105879.62, balance_before: 0, balance_after: 105879.62, settlement_key: "opening:e1",
    position_id: null, history_id: null, source: "migration:20261006010000", detail: {}, created_at: EPOCH }],
  unledgeredWrites: [], historySinceEpoch: [], auditSinceEpoch: [], linkedHistoryClosedAt: {},
});
const gbp: OldPosition = { id: "6bf40147", position_id: "3f39df7b", symbol: "GBP/USD", direction: "short", size: 2.46, entry_price: 1.32125,
  current_price: 1.32112, stop_loss: 1.3251992, take_profit: 1.31617088, open_time: "2026-10-05T16:27:06Z", created_at: "2026-10-05T16:27:06Z", unrealized_usd: 31.98 };
const chf: OldPosition = { id: "82541e09", position_id: "2527bfa5", symbol: "CHF/JPY", direction: "long", size: 4.47, entry_price: 190.31367,
  current_price: 190.11012, stop_loss: 189.860209, take_profit: 190.64615658, open_time: "2026-10-05T11:04:02Z", created_at: "2026-10-05T11:04:02Z", unrealized_usd: -575.94 };
const usdjpy: OldOrder = { id: "92e4d8d1", order_id: "ed07f20a", symbol: "USD/JPY", direction: "short", status: "awaiting_confirmation", entry_price: 158.04, placed_at: "2026-10-05T14:50:11Z", expires_at: "2026-10-05T22:50:11Z" };
const btc: OldOrder = { id: "ee809be7x", order_id: "ee809be7", symbol: "BTC/USD", direction: "long", status: "awaiting_confirmation", entry_price: 85366.3, placed_at: "2026-10-05T17:10:03Z", expires_at: "2026-10-06T01:10:03Z" };

const periodicRuns = (n: number, pass = true) => Array.from({ length: n }, (_, k) => ({
  id: k + 1, run_at: new Date(Date.parse(EPOCH) + (0.5 + 4 * k) * 3_600_000).toISOString(), mode: "periodic" as const, pass, failures: [], epoch_id: "e1",
}));
const finalRun = { id: 99, run_at: "2026-10-06T17:25:00Z", mode: "final" as const, pass: true, failures: [], epoch_id: "e1" };

function live(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    now: NOW_LIVE,
    account: { id: "a", balance: 105879.62, peak_balance: 105879.62, daily_pnl_base: 105485.18, is_paused: false,
      ledger_epoch_id: "e1", ledger_epoch_started_at: EPOCH, ledger_reset_at: null },
    monitorRuns: periodicRuns(2),
    liveHealth: healthy, reconDrift: 0, guardMode: "observe",
    objectsPresent: { paper_account_ledger: true, settle_paper_position: true, reset_paper_account: true, closed_at_timestamptz: true },
    openPositions: [gbp, chf], livePending: [usdjpy, btc], activeSetups: [],
    marketData: { ok: true, detail: "USD/JPY fresh; prices refreshed 0.4min ago" },
    resetRunning: false, executeEnabled: false,
    ...over,
  };
}
const greenAt24h = (over: Partial<ReadinessInput> = {}) =>
  live({ now: NOW_DONE, monitorRuns: [...periodicRuns(6), finalRun], guardMode: "enforce", executeEnabled: true, ...over });

// ─── readiness ──────────────────────────────────────────────────────────────

Deno.test("today's production state is NOT READY, and says exactly why", () => {
  const r = evaluateResetReadiness(live());
  assertEquals(r.ready, false);
  assertEquals(r.blocking.map((b) => b.key), ["monitoring_window_complete", "monitoring_checks_passed", "guard_blocking"]);
  assertEquals(r.window.status, "In Progress");
  assertEquals(r.window.completes_at, "2026-10-06T17:20:36.756Z");
  assertEquals(r.metrics.guard_mode, "RECORDING");
  assertEquals(r.metrics.equity, Number((105879.62 + 31.98 - 575.94).toFixed(2)));
  assertEquals(r.metrics.open_positions, 2);
  assertEquals(r.metrics.pending_orders, 2);
  assertEquals(r.old_period.positions.map((p) => p.symbol), ["GBP/USD", "CHF/JPY"]);
});

Deno.test("all green after a clean 24h window with blocking on → READY", () => {
  const r = evaluateResetReadiness(greenAt24h());
  assertEquals(r.ready, true, JSON.stringify(r.blocking));
  assertEquals(r.window.status, "Complete");
  assertEquals(r.monitor.status, "PASS");
});

Deno.test("each prerequisite on its own blocks the reset", () => {
  const cases: [string, Partial<ReadinessInput>][] = [
    ["monitoring_window_complete", { monitorRuns: periodicRuns(6) }],
    ["monitoring_checks_passed", { monitorRuns: [...periodicRuns(5), { ...periodicRuns(6)[5], pass: false }, finalRun] }],
    ["monitoring_checks_passed", { now: "2026-10-07T03:00:00Z" }], // last run > 5h ago: monitor dead
    ["drift_zero", { liveHealth: { ...healthy, pass: false, checks: healthy.checks.map((c) => c.name === "drift_zero" ? { ...c, pass: false, detail: "drift 871.19" } : c), failures: [] }, reconDrift: 871.19 }],
    ["no_unledgered_writes", { liveHealth: { ...healthy, pass: false, checks: healthy.checks.map((c) => c.name === "no_unledgered_writes" ? { ...c, pass: false, evidence: [{ id: 1 }] } : c), failures: [] } }],
    ["no_unsettled_closes", { liveHealth: { ...healthy, pass: false, checks: healthy.checks.map((c) => c.name === "every_close_settled" ? { ...c, pass: false } : c), failures: [] } }],
    ["settlement_ledger_healthy", { liveHealth: { ...healthy, pass: false, failures: [{ name: "no_duplicate_keys", pass: false, detail: "1 dup" }] } }],
    ["guard_blocking", { guardMode: "observe" }],
    ["accounting_migrations_present", { objectsPresent: { paper_account_ledger: true, settle_paper_position: false } }],
    ["no_active_settlement_error", { resetRunning: true }],
    ["market_data_fresh", { marketData: { ok: false, detail: "USD/JPY 34min old" } }],
  ];
  for (const [key, over] of cases) {
    const r = evaluateResetReadiness(greenAt24h(over));
    assertEquals(r.ready, false, key);
    assert(r.blocking.some((b) => b.key === key), `${key} should block; got ${r.blocking.map((b) => b.key)}`);
  }
});

Deno.test("market data only matters while positions are open", () => {
  const r = evaluateResetReadiness(greenAt24h({ openPositions: [], marketData: { ok: false, detail: "stale" } }));
  assertEquals(r.ready, true);
});

Deno.test("equity is unknown (not guessed) when a rate is missing", () => {
  const r = evaluateResetReadiness(live({ openPositions: [gbp, { ...chf, unrealized_usd: null }] }));
  assertEquals(r.metrics.equity, null);
});

Deno.test("the fingerprint changes when an old order fills or a balance moves", async () => {
  const a = await fingerprint(evaluateResetReadiness(greenAt24h()).fingerprint_basis);
  const filled = await fingerprint(evaluateResetReadiness(greenAt24h({ livePending: [btc], openPositions: [gbp, chf, { ...gbp, id: "new", position_id: "ed07f20a" }] })).fingerprint_basis);
  const moved = await fingerprint(evaluateResetReadiness(greenAt24h({ account: { ...greenAt24h().account, balance: 105000 } })).fingerprint_basis);
  assert(a !== filled && a !== moved);
});

Deno.test("flatten P&L uses the scanner formula and refuses a missing FX rate", () => {
  // CHF/JPY long 4.47 lots, 190.31367 → 190.11012 at USD/JPY 157.98027
  const f = flattenPnl(chf, 190.11012, { "USD/JPY": 157.98027 });
  assertEquals(f.missingRate, null);
  assertEquals(f.pnl, Number(((190.11012 - 190.31367) * 100000 * 4.47 / 157.98027).toFixed(2)));
  assertEquals(flattenPnl(chf, 190.11012, {}).missingRate, "USD/JPY");
  assertEquals(flattenPnl(gbp, 1.32112, {}).missingRate, null, "USD-quoted needs no rate");
});

// ─── the sequence, against a recording fake ─────────────────────────────────

const postOk: PostResetState = {
  balance: 100000, peak_balance: 100000, daily_pnl_base: 100000, equity: 100000, realized_pnl_this_epoch: 0, unrealized_pnl: 0,
  open_positions: 0, positions_opened_before_reset: 0, pending_orders: 0, active_setups: 0, daily_pnl: 0, drift: 0,
  unledgered_writes_this_epoch: 0, last_ledger_kind: "reset", ledger_reset_at: "2026-10-06T18:00:05Z",
};

class Fake implements ResetDeps {
  calls: string[] = [];
  runs = new Map<string, Record<string, any>>();
  paused = false;
  positions: OldPosition[] = [gbp, chf];
  pending: OldOrder[] = [usdjpy, btc];
  ready = evaluateResetReadiness(greenAt24h());
  fp = "";
  settleFails: string | null = null;
  ratesOk = true;
  post: PostResetState = postOk;
  throwIn: string | null = null;
  fillDuringReset: OldPosition | null = null;
  t = 0;
  now() { return new Date(Date.parse("2026-10-06T18:00:00Z") + (this.t++) * 1000).toISOString(); }
  async readiness() { this.calls.push("readiness"); this.fp = await fingerprint(this.ready.fingerprint_basis); return { ...this.ready, fingerprint: this.fp }; }
  async insertRun(row: Record<string, unknown>) { const id = `r${this.runs.size + 1}`; this.runs.set(id, { ...row }); this.calls.push(`insertRun:${row.status}`); return id; }
  async updateRun(id: string, patch: Record<string, unknown>) { Object.assign(this.runs.get(id)!, patch); }
  async setPaused(p: boolean) { this.paused = p; this.calls.push(`paused:${p}`); }
  async cancelOldPending() {
    this.calls.push("cancelPending");
    const c = this.pending; this.pending = [];
    if (this.fillDuringReset) { this.positions = [...this.positions, this.fillDuringReset]; this.fillDuringReset = null; }
    return c;
  }
  async cancelOldSetups() { this.calls.push("cancelSetups"); return []; }
  async openPositions() { return this.positions; }
  async livePending() { return this.pending; }
  async rates() { return { ok: this.ratesOk, rateMap: { "USD/JPY": 157.98027 }, detail: this.ratesOk ? "fresh" : "USD/JPY 34min old" }; }
  async settleFlatten(pos: OldPosition, _x: number, pnl: number) {
    this.calls.push(`settle:${pos.symbol}`);
    if (this.settleFails === pos.symbol) return { outcome: "failed", detail: "network down" };
    this.positions = this.positions.filter((p) => p.id !== pos.id);
    return { outcome: "settled", amount: pnl, balance: 0 };
  }
  async ledgerHealth() { this.calls.push("ledgerHealth"); return { health: healthy, balance: 105335.66, realizedThisEpoch: -543.96 }; }
  async takeSnapshot() { this.calls.push("snapshot"); if (this.throwIn === "snapshot") throw new Error("disk full"); return 7; }
  async resetAccount() { this.calls.push("resetAccount"); return { reset: true, epoch_id: "e2" }; }
  async clearActiveState() { this.calls.push("clearActiveState"); return { counters_reset: true }; }
  async postResetState() { this.calls.push("postResetState"); return this.post; }
}
const request = async (f: Fake, over: Partial<{ confirmation: string; fingerprint: string }> = {}) => {
  const fp = await fingerprint(f.ready.fingerprint_basis);
  return runSystemReset(f, { requestedBy: "57c79dee", requestedAt: "2026-10-06T17:59:30Z", confirmation: CONFIRMATION_PHRASE, fingerprint: fp, accountId: "a", ...over });
};
const mutations = (f: Fake) => f.calls.filter((c) => !["readiness"].includes(c) && !c.startsWith("insertRun"));

Deno.test("wrong phrase, execution disabled, not ready, or changed state → aborted, recorded, nothing touched", async () => {
  const cases: [string, (f: Fake) => void, Partial<{ confirmation: string; fingerprint: string }>][] = [
    ["confirmation phrase", () => {}, { confirmation: "reset 100000" }],
    ["execution is disabled", (f) => { f.ready = evaluateResetReadiness(greenAt24h({ executeEnabled: false })); }, {}],
    ["not ready", (f) => { f.ready = evaluateResetReadiness(greenAt24h({ guardMode: "observe" })); }, {}],
    ["fingerprint mismatch", () => {}, { fingerprint: "stale-dialog" }],
  ];
  for (const [why, setup, over] of cases) {
    const f = new Fake(); setup(f);
    const r = await request(f, over);
    assertEquals(r.status, "aborted", why);
    assert(r.reason!.includes(why), `${why}: ${r.reason}`);
    assertEquals(mutations(f), [], `${why}: no trading state touched`);
    assertEquals([...f.runs.values()][0].status, "aborted", "the attempt is still recorded");
  }
});

Deno.test("happy path: cancel orders first, flatten through the ledger, snapshot, reset, verify, resume", async () => {
  const f = new Fake();
  const r = await request(f);
  assertEquals(r.status, "succeeded", r.reason);
  assertEquals(mutations(f), [
    "paused:true", "cancelPending", "cancelSetups", "settle:GBP/USD", "settle:CHF/JPY",
    "ledgerHealth", "snapshot", "resetAccount", "clearActiveState", "postResetState", "paused:false",
  ]);
  const run = f.runs.get(r.resetId!)!;
  assertEquals(run.status, "succeeded");
  assertEquals(run.success, true);
  assertEquals(run.positions_closed.map((p: any) => p.symbol), ["GBP/USD", "CHF/JPY"]);
  assertEquals(run.orders_cancelled.map((o: any) => o.order_id), ["ed07f20a", "ee809be7"]);
  assertEquals(run.snapshot_id, 7);
  assertEquals(run.old_period_realized_pnl, 5335.66);
  assertEquals(run.pre_reset_balance, 105879.62);
  assertEquals(run.post_reset_balance, 100000);
  assert(run.verification.every((v: any) => v.pass));
  assertEquals(f.paused, false, "trading resumes only after verification");
});

Deno.test("an old order that fills during the reset is closed as an old-period position", async () => {
  const f = new Fake();
  f.fillDuringReset = { ...gbp, id: "filled1", position_id: "ed07f20a", symbol: "USD/JPY", entry_price: 158.04, current_price: 158.0, created_at: "2026-10-05T23:00:00Z" };
  const r = await request(f);
  assertEquals(r.status, "succeeded", r.reason);
  assert(f.calls.includes("settle:USD/JPY"));
});

Deno.test("a failed settlement STOPS before any reset; the bot stays paused; the step is recorded", async () => {
  const f = new Fake(); f.settleFails = "CHF/JPY";
  const r = await request(f);
  assertEquals(r.status, "failed");
  assertEquals(r.failedStep, "close_old_positions");
  assert(!f.calls.includes("resetAccount") && !f.calls.includes("snapshot"));
  assertEquals(f.paused, true);
  const run = f.runs.get(r.resetId!)!;
  assertEquals(run.status, "failed");
  assertEquals(run.positions_closed.map((p: any) => p.symbol), ["GBP/USD"], "what DID close is on the record");
});

Deno.test("stale FX rates STOP before closing anything", async () => {
  const f = new Fake(); f.ratesOk = false;
  const r = await request(f);
  assertEquals(r.status, "failed");
  assert(r.reason!.includes("FX rates not fresh"));
  assert(!f.calls.some((c) => c.startsWith("settle:")));
  assertEquals(f.paused, true);
});

Deno.test("an exception mid-sequence STOPS and records where", async () => {
  const f = new Fake(); f.throwIn = "snapshot";
  const r = await request(f);
  assertEquals(r.status, "failed");
  assertEquals(r.failedStep, "after:verify_old_period_settled");
  assert(!f.calls.includes("resetAccount"));
  assertEquals(f.paused, true);
});

Deno.test("post-reset verification failure leaves the bot paused and the run failed", async () => {
  const f = new Fake(); f.post = { ...postOk, balance: 100000.01, peak_balance: 105879.62 };
  const r = await request(f);
  assertEquals(r.status, "failed");
  assertEquals(r.failedStep, "verify_post_reset");
  assert(r.reason!.includes("Balance = $100,000.00") && r.reason!.includes("Drawdown baseline"));
  assertEquals(f.paused, true);
  assert(!f.calls.includes("paused:false"));
});

Deno.test("verifyPostReset: the full required list", () => {
  const v = verifyPostReset(postOk);
  assertEquals(v.length, 13);
  assert(v.every((x) => x.pass));
  const labels = v.map((x) => x.label).join(" | ");
  for (const need of ["Balance = $100,000.00", "Equity = $100,000.00", "Realized P/L = $0", "Unrealized P/L = $0", "Open positions = 0",
    "Pending orders = 0", "Old watched/armed setups = 0", "Daily P/L = $0", "Drawdown baseline = $100,000",
    "No old position can affect", "No old backfill can affect", "drift = $0", "No unledgered writes"]) {
    assert(labels.includes(need), need);
  }
});

Deno.test("the reset function refuses service-role and non-admin callers (source)", () => {
  const src = Deno.readTextFileSync(new URL("../../functions/system-reset/index.ts", import.meta.url));
  assert(/if \(!token \|\| token === serviceKey\) return respond\(\{ error: "admin user session required" \}, 403\)/.test(src));
  assert(/db\.auth\.getUser\(token\)/.test(src), "the session is verified server-side");
  assert(/db\.rpc\("is_app_admin", \{ p_user_id: userId \}\)/.test(src), "admin is checked server-side");
  assert(/if \(adminErr \|\| isAdmin !== true\) return respond\(\{ error: "admin only" \}, 403\)/.test(src));
  // Admin check precedes any action.
  assert(src.indexOf("is_app_admin") < src.indexOf('body.action === "readiness"'));
});
