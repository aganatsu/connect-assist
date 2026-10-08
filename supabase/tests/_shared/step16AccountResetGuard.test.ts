/**
 * STEP 16-D — real-exposure guard on the paper balance resets.
 *
 * Unit: classification (real position, real pending / armed order, dry-run
 * only, flat, mixed, terminal orders ignored, NULL dry_run = real), the exact
 * queries the guard issues, fail-closed on a read error.
 * Wiring: all three actions (set_balance, reset_balance_only, reset_account)
 * reset only through resetPaperAccount, whose guard runs before any write;
 * a refusal returns before the RPC and before any update; reset_account no
 * longer deletes positions; nothing cancels dry-run orders.
 * The end-to-end defect test (real position → a reset would post its close
 * as $0) runs on real Postgres in paperSettlementLedger.test.ts.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACTIVE_ORDER_STATUSES, checkResetAllowed, exposureFromRows, isActiveRealOrder, readExposure, resetRefusal,
} from "../../functions/_shared/accountResetGuard.ts";

const o = (status: string, dry_run: boolean | null) => ({ status, dry_run });

Deno.test("definition: active = pending | awaiting_confirmation | triggered; real = dry_run IS NOT TRUE", () => {
  // Step 17-C: 'triggered' added (status CHECK allows it; system-reset treats it as live)
  assertEquals([...ACTIVE_ORDER_STATUSES], ["pending", "awaiting_confirmation", "triggered"]);
  assertEquals(isActiveRealOrder(o("triggered", false)), true);
  assertEquals(isActiveRealOrder(o("pending", false)), true);
  assertEquals(isActiveRealOrder(o("awaiting_confirmation", false)), true);
  assertEquals(isActiveRealOrder(o("pending", null)), true, "NULL dry_run counts as real (fails safe)");
  assertEquals(isActiveRealOrder(o("pending", true)), false, "dry-run");
  for (const s of ["filled", "cancelled", "expired", "invalidated"]) assertEquals(isActiveRealOrder(o(s, false)), false, `${s} is terminal`);
  const idx = Deno.readTextFileSync(new URL("../../migrations/20260914000000_baseline_schema.sql", import.meta.url));
  assert(/idx_pending_orders_unique_active ON public\.pending_orders .* WHERE \(status = ANY \(ARRAY\['pending'::text, 'awaiting_confirmation'::text\]\)\)/.test(idx), "the unique-active index set is a subset");
  const sysReset = Deno.readTextFileSync(new URL("../../functions/system-reset/index.ts", import.meta.url));
  assert(sysReset.includes('const LIVE_PENDING = ["pending", "awaiting_confirmation", "triggered"];'), "system-reset's live set — the guard matches it");
});

Deno.test("flat account → allowed (no refusal)", () => {
  const e = exposureFromRows([], [o("filled", false), o("cancelled", true)]);
  assertEquals(e, { openPositions: 0, activeRealOrders: 0, activeDryRunOrders: 0 });
  assertEquals(resetRefusal(e), null);
});

Deno.test("real open position → refused", () => {
  const r = resetRefusal(exposureFromRows([{ id: "p1" }], []));
  assertEquals(r?.code, "reset_refused_real_exposure");
  assertEquals(r?.exposure, { openPositions: 1, activeRealOrders: 0, activeDryRunOrders: 0 });
  assert(r!.error.includes("1 open position(s)"));
});

Deno.test("active real order (pending or armed) → refused", () => {
  for (const s of ["pending", "awaiting_confirmation"]) {
    const r = resetRefusal(exposureFromRows([], [o(s, false)]));
    assertEquals(r?.code, "reset_refused_real_exposure", s);
    assertEquals(r?.exposure?.activeRealOrders, 1);
  }
});

Deno.test("dry-run orders only → allowed, and their count is reported", () => {
  const e = exposureFromRows([], [o("pending", true), o("awaiting_confirmation", true), o("filled", true)]);
  assertEquals(e, { openPositions: 0, activeRealOrders: 0, activeDryRunOrders: 2 });
  assertEquals(resetRefusal(e), null, "dry-run orders alone never block");
});

Deno.test("mixed real + dry-run exposure → refused, both counts reported", () => {
  const e = exposureFromRows([{ id: "p1" }], [o("pending", false), o("pending", true), o("awaiting_confirmation", true)]);
  assertEquals(e, { openPositions: 1, activeRealOrders: 1, activeDryRunOrders: 2 });
  assertEquals(resetRefusal(e)?.code, "reset_refused_real_exposure");
  assertEquals(resetRefusal(exposureFromRows([], [o("awaiting_confirmation", false), o("pending", true)]))?.exposure,
    { openPositions: 0, activeRealOrders: 1, activeDryRunOrders: 1 });
});

// a recording fake of the supabase query builder
function fakeDb(rows: Record<string, any[]>, failOn?: string) {
  const calls: { table: string; select: string; filters: [string, string, unknown][] }[] = [];
  return {
    calls,
    from(table: string) {
      const c = { table, select: "", filters: [] as [string, string, unknown][] };
      calls.push(c);
      const q: any = {
        select: (s: string) => { c.select = s; return q; },
        eq: (k: string, v: unknown) => { c.filters.push(["eq", k, v]); return q; },
        in: (k: string, v: unknown) => { c.filters.push(["in", k, v]); return q; },
        then: (res: (x: unknown) => void) => res(failOn === table ? { data: null, error: { message: "boom" } } : { data: rows[table] ?? [], error: null }),
      };
      return q;
    },
  };
}

Deno.test("queries: every position row of the user; only active-status orders of the user (classified real / dry-run in code)", async () => {
  const db = fakeDb({ paper_positions: [{ id: "p" }], pending_orders: [o("pending", true)] });
  const r = await readExposure(db, "u1");
  assertEquals(r, { ok: true, exposure: { openPositions: 1, activeRealOrders: 0, activeDryRunOrders: 1 } });
  const pos = db.calls.find((c) => c.table === "paper_positions")!, ord = db.calls.find((c) => c.table === "pending_orders")!;
  assertEquals(pos.filters, [["eq", "user_id", "u1"]], "no status filter on positions: every row is exposure");
  assertEquals(ord.filters, [["eq", "user_id", "u1"], ["in", "status", ["pending", "awaiting_confirmation", "triggered"]]]);
  assert(ord.select.includes("dry_run") && ord.select.includes("status"));
});

Deno.test("a read error fails closed (reset_refused_exposure_unknown)", async () => {
  for (const t of ["paper_positions", "pending_orders"]) {
    const r = await checkResetAllowed(fakeDb({}, t), "u1");
    assertEquals(r.allowed, false, t);
    if (!r.allowed) assertEquals(r.refusal.code, "reset_refused_exposure_unknown");
  }
  const ok = await checkResetAllowed(fakeDb({ pending_orders: [o("pending", true)] }), "u1");
  assertEquals(ok.allowed, true);
});

// ── wiring in paper-trading ─────────────────────────────────────────────────

const src = Deno.readTextFileSync(new URL("../../functions/paper-trading/index.ts", import.meta.url));
const helper = src.slice(src.indexOf("async function resetPaperAccount("), src.indexOf("const resetRefused ="));
const block = (action: string) => {
  const i = src.indexOf(`if (action === "${action}") {`);
  return src.slice(i, src.indexOf("return respond({ success: true", i));
};

Deno.test("wiring: the guard runs first in resetPaperAccount — before the account read and the reset RPC — and a refusal returns before them", () => {
  const g = helper.indexOf("await checkResetAllowed(supabase, user.id)");
  const refuse = helper.indexOf("if (!guard.allowed) {");
  const ret = helper.indexOf("return { ok: false, error: guard.refusal.error, refusal: guard.refusal };");
  const rpc = helper.indexOf('supabase.rpc("reset_paper_account_if_flat"'); // Step 17-C: the guarded database reset
  assert(g > -1 && g < refuse && refuse < ret && ret < rpc, "guard → refuse/return → (only then) RPC");
  assert(helper.indexOf('from("paper_accounts")') > ret, "no read of the account before the guard decides");
  assertEquals((src.match(/rpc\("reset_paper_account_if_flat"/g) ?? []).length, 1, "resetPaperAccount is the only reset call in paper-trading");
  assertEquals((src.match(/rpc\("reset_paper_account"/g) ?? []).length, 0, "Step 17-C: paper-trading never calls the unguarded reset");
});

Deno.test("wiring: all three actions reset through resetPaperAccount and return on refusal BEFORE any write (zero partial changes)", () => {
  for (const a of ["set_balance", "reset_balance_only", "reset_account"]) {
    const b = block(a);
    const call = b.indexOf("await resetPaperAccount(");
    const refusal = b.indexOf("if (!reset.ok) return resetRefused(reset);");
    const firstWrite = b.search(/\.(update|insert|delete|upsert)\(/);
    assert(call > -1 && refusal > call, `${a}: guarded reset then refusal return`);
    assert(firstWrite === -1 || firstWrite > refusal, `${a}: no write before the refusal return`);
    assert(!/from\("pending_orders"\)/.test(b), `${a}: never touches pending_orders (dry-run orders are not cancelled)`);
  }
});

Deno.test("reset_account no longer deletes positions; no reset path deletes or settles positions", () => {
  for (const a of ["set_balance", "reset_balance_only", "reset_account"]) {
    const b = block(a);
    assert(!/from\("paper_positions"\)\.delete\(\)/.test(b), `${a} must not delete positions`);
    assert(!/settlePaperPosition|settle_paper_position/.test(b), `${a} must not invent a settlement`);
  }
  assert(!/from\("paper_positions"\)\.delete\(\)/.test(helper));
});

Deno.test("flat path unchanged: same RPC arguments, same follow-up updates; the success responses add only active_dry_run_orders", () => {
  assert(/p_user_id: user\.id, p_bot_id: acct\?\.bot_id \|\| "smc", p_new_balance: amount, p_reason: reason,/.test(helper));
  assert(/kill_switch_active: false \}\)\.eq\("user_id", user\.id\);\s*return respond\(\{ success: true, balance: balStr, active_dry_run_orders: reset\.activeDryRunOrders \}\);/.test(src));
  assert(/scan_count: 0, signal_count: 0, rejected_count: 0, kill_switch_active: false,\s*\}\)\.eq\("user_id", user\.id\);\s*return respond\(\{ success: true, startingBalance: startBal, active_dry_run_orders/.test(src));
  assert(/is_running: false, is_paused: true,\s*scan_count: 0, signal_count: 0, rejected_count: 0,\s*kill_switch_active: false, execution_mode: "paper",/.test(src));
  assert(/return respond\(\{ success: true, startingBalance: startBal, paused: true, active_dry_run_orders: reset\.activeDryRunOrders \}\);/.test(src));
});
