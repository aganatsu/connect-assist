/**
 * Candidate C shadow — EXECUTION tests. Runs bot-scanner's real
 * runScanForUser (management cycle and a full manual scan) against in-memory
 * tables and a stubbed provider, with the shadow flag off / on / drain and
 * with injected shadow faults, and compares everything A reads, writes, sends
 * and returns.
 *
 * Fixture: the frozen Baseline A config (bot_configs.config_json, hash
 * 1037e617…), two A orders and a touching A order, four C orders:
 *   C1 EUR/USD — A also has an order on EUR/USD; price touches C1's entry
 *   C2 USD/JPY — awaiting confirmation, A's USD/JPY order is too
 *   C3 NZD/CHF — no A order on the pair: nothing cached → shadow_no_data
 *   C4 GBP/USD — TTL already expired
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CallRecord, FakeDb, normalise, type Row, withEnv, withFakeClock, withStubbedNetwork } from "./scannerHarness.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const fx = JSON.parse(read("./fixtures/baseline_a_config.json"));

// Isolate-local environment (withEnv patches Deno.env.get; the process env is never written).
const ENV: Record<string, string | undefined> = {
  TWELVE_DATA_API_KEY: "test-key", SUPABASE_URL: "http://fake.local", SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  POLYGON_API_KEY: undefined,
};
const { runScanForUser } = await import("../../functions/bot-scanner/index.ts");

const U = "00000000-0000-0000-0000-0000000000aa";
const SHADOW = "smc_shadow_zonemid";
// A fixed Wednesday, London session: the scanner's market-hours logic sees the
// same weekday wherever and whenever CI runs (FX is closed at weekends).
const BASE = Date.parse("2026-10-07T10:12:00Z");
const LEVEL: Record<string, number> = { "EUR/USD": 1.1, "USD/JPY": 150, "GBP/USD": 1.3, "CHF/JPY": 180, "NZD/CAD": 0.82, "NZD/CHF": 0.48 };
const priceOf = (s: string) => LEVEL[s.includes("/") ? s : `${s.slice(0, 3)}/${s.slice(3)}`] ?? 1;
const iso = (min: number) => new Date(BASE + min * 60_000).toISOString();
const impulse = (high: number, low: number) => JSON.stringify({ impulseZone: { impulse: { high, low } } });
const order = (o: Row): Row => ({
  user_id: U, order_type: "limit", status: "pending", placed_at: iso(-30), expires_at: iso(400), dry_run: false,
  confirmation_arm_count: 0, confirmation_attempts: 0, confirmation_checks_count: 0, ...o,
});

function seed(): FakeDb {
  return new FakeDb({
    bot_configs: [{ id: "cfg1", user_id: U, connection_id: null, config_json: fx.config_json, config_version: fx.config_version }],
    paper_accounts: [{ user_id: U, bot_id: "smc", balance: "100000", is_paused: false, entries_locked: false, execution_mode: "paper", scan_count: 0, signal_count: 0, rejected_count: 0 }],
    user_settings: [{ user_id: U, preferences_json: { telegramChatIds: ["111"] } }],
    pending_orders: [
      order({ order_id: "aaaa0001", bot_id: "smc", symbol: "EUR/USD", direction: "long", entry_price: 1.095, stop_loss: 1.09, take_profit: 1.1005, entry_zone_low: 1.094, entry_zone_high: 1.096, signal_reason: impulse(1.11, 1.09) }),
      order({ order_id: "aaaa0002", bot_id: "smc", symbol: "USD/JPY", direction: "short", status: "awaiting_confirmation", entry_price: 150.0, stop_loss: 150.5, take_profit: 149.45, entry_zone_low: 149.9, entry_zone_high: 150.1, zone_touch_time: iso(-20), signal_reason: impulse(151, 149) }),
      order({ order_id: "aaaa0003", bot_id: "smc", symbol: "CHF/JPY", direction: "long", entry_price: 180.2, stop_loss: 179.5, take_profit: 180.97, entry_zone_low: 180.1, entry_zone_high: 180.3, signal_reason: impulse(181, 179) }),
      order({ order_id: "zm00000000c1", bot_id: SHADOW, dry_run: true, symbol: "EUR/USD", direction: "long", entry_price: 1.1003, stop_loss: 1.095, take_profit: 1.106, entry_zone_low: 1.099, entry_zone_high: 1.1016, signal_reason: impulse(1.11, 1.09), dry_run_context: { route2Stop: { floorPips: 10 } } }),
      order({ order_id: "zm00000000c2", bot_id: SHADOW, dry_run: true, symbol: "USD/JPY", direction: "short", status: "awaiting_confirmation", entry_price: 150.02, stop_loss: 150.5, take_profit: 149.5, entry_zone_low: 149.9, entry_zone_high: 150.1, zone_touch_time: iso(-20), signal_reason: impulse(151, 149) }),
      order({ order_id: "zm00000000c3", bot_id: SHADOW, dry_run: true, symbol: "NZD/CHF", direction: "long", entry_price: 0.47, stop_loss: 0.465, take_profit: 0.475, entry_zone_low: 0.469, entry_zone_high: 0.471, signal_reason: impulse(0.49, 0.46) }),
      order({ order_id: "zm00000000c4", bot_id: SHADOW, dry_run: true, symbol: "GBP/USD", direction: "long", entry_price: 1.29, stop_loss: 1.285, take_profit: 1.295, expires_at: iso(-1), signal_reason: impulse(1.31, 1.28) }),
    ],
  });
}

interface Run { db: FakeDb; calls: CallRecord[]; res: any }
async function run(mode: string, opts: { isManagementOnly?: boolean; isManualScan?: boolean }, prep?: (db: FakeDb) => void): Promise<Run> {
  const db = seed();
  prep?.(db);
  const calls: CallRecord[] = [];
  db.onRead = (t, f) => {
    if (t === "pending_orders" && f.includes(`bot_id=eq.${SHADOW}`) && f.some((x) => x.startsWith("status=in"))) db.phase = "shadow_hunt";
    if (t !== "pending_orders" && db.phase === "shadow_hunt") db.phase = "after_hunt";
  };
  const res = await withEnv({ ...ENV, SMC_SHADOW_ZONEMID: mode }, () =>
    withFakeClock(BASE, () => withStubbedNetwork(db, calls, BASE, priceOf, () => runScanForUser(db.client(), U, opts))));
  return { db, calls, res };
}

// ── What belongs to A ───────────────────────────────────────────────────────
const isShadowWrite = (w: { table: string; payload: any; filters: string[] }) =>
  w.filters.some((f) => f.startsWith("order_id=eq.zm") || f === `bot_id=eq.${SHADOW}`) ||
  (w.table === "route2_poll_log" && Array.isArray(w.payload) && w.payload.every((r: any) => r.poller_name === "bot-scanner:shadow-zonemid"));
const aWrites = (r: Run) => normalise(r.db.writes.filter((w) => !isShadowWrite(w)));
const aReads = (r: Run) => normalise(r.db.reads.filter((x) => !x.filters.includes(`bot_id=eq.${SHADOW}`)).map((x) => ({ t: x.table, f: x.filters })));
const aCalls = (r: Run) => r.calls.filter((c) => c.phase !== "shadow_hunt").map((c) => `${c.kind}:${c.url}`);
const aPolls = (r: Run) => normalise(r.db.rows("route2_poll_log").filter((p) => p.poller_name === "bot-scanner"));
const cPolls = (r: Run) => r.db.rows("route2_poll_log").filter((p) => p.poller_name === "bot-scanner:shadow-zonemid");
const aOrders = (r: Run) => normalise(r.db.rows("pending_orders").filter((o) => o.bot_id === "smc"));
const scanLogs = (r: Run) => normalise(r.db.rows("scan_logs"));

const MGMT = { isManagementOnly: true };
// Warm the provider stub's in-isolate cache so every compared run sees the
// same cache state (candleSource keeps a 90 s module-level cache).
await run("off", MGMT);
const OFF = await run("off", MGMT);
const OFF2 = await run("off", MGMT);
const ON = await run("on", MGMT);

Deno.test("harness is deterministic: two OFF runs are identical", () => {
  assertEquals(aWrites(OFF2), aWrites(OFF));
  assertEquals(aReads(OFF2), aReads(OFF));
  assertEquals(normalise(OFF2.res), normalise(OFF.res));
  assert(OFF.db.writes.length > 5, "the fixture exercises A's hunt");
  assertEquals(OFF.db.rows("route2_poll_log").filter((p) => p.poller_name === "bot-scanner").length, 3, "one poll row per A order");
});

Deno.test("A output equivalence, management cycle: OFF vs ON — writes, reads, calls, result, rows", () => {
  assertEquals(aWrites(ON), aWrites(OFF));
  assertEquals(aReads(ON), aReads(OFF));
  assertEquals(aCalls(ON), aCalls(OFF));
  assertEquals(normalise(ON.res), normalise(OFF.res));
  assertEquals(aOrders(ON), aOrders(OFF));
  assertEquals(aPolls(ON), aPolls(OFF));
  assertEquals(scanLogs(ON), scanLogs(OFF));
});

Deno.test("A counters and scan-log observations are not contaminated by C", () => {
  const counters = (r: Run) => r.res.pendingOrders;
  assertEquals(counters(ON), counters(OFF));
  const log = (r: Run) => (r.db.rows("scan_logs")[0]?.details_json ?? [])[0] ?? {};
  for (const k of ["thesisObservations", "touchChecks", "confirmationHunt", "pendingOrders"]) {
    assertEquals(normalise(log(ON)[k]), normalise(log(OFF)[k]), k);
  }
  const ids = JSON.stringify(log(ON));
  assertFalse(ids.includes("zm00000000"), "no C order in A's scan log");
});

Deno.test("flag OFF: zero shadow queries, zero shadow writes, shadow orders untouched", () => {
  for (const r of [OFF, OFF2]) {
    assertEquals(r.db.reads.filter((x) => x.filters.includes(`bot_id=eq.${SHADOW}`)).length, 0);
    assertEquals(r.db.reads.filter((x) => x.table === "trade_attribution").length, 0);
    assertEquals(r.db.writes.filter(isShadowWrite).length, 0);
    assertEquals(cPolls(r).length, 0);
    const c = r.db.rows("pending_orders").filter((o) => o.bot_id === SHADOW);
    assertEquals(normalise(c), normalise(seed().rows("pending_orders").filter((o) => o.bot_id === SHADOW)));
  }
});

Deno.test("flag ON: C runs the real hunt on cached data only — zero provider calls, zero credits", () => {
  const shadowCalls = ON.calls.filter((c) => c.phase === "shadow_hunt");
  assertEquals(shadowCalls, []);
  // NZD/CHF 5min was never fetched by anyone: a shadow fetch would have hit the stub.
  for (const r of [OFF, OFF2, ON]) assertFalse(r.calls.some((c) => c.url.includes("NZD%2FCHF") && c.url.includes("interval=5min")));
  const byOrder = new Map(cPolls(ON).map((p) => [p.pending_id, p]));
  assertEquals(byOrder.get("zm00000000c3")?.branch_taken, "shadow_no_data");
  assertEquals(byOrder.get("zm00000000c4")?.branch_taken, "ttl_expiry");
  assertEquals(byOrder.get("zm00000000c1")?.branch_taken, "zone_touched");
  assert(["awaiting_confirmation", "insufficient_candles", "watching_no_change"].includes(byOrder.get("zm00000000c2")?.branch_taken),
    `C2 hunted: ${byOrder.get("zm00000000c2")?.branch_taken}`);
  assertEquals(cPolls(ON).length, 4, "one shadow poll row per C order");
  // C1 used A's cached EUR/USD series: same price A recorded
  const c1 = ON.db.rows("pending_orders").find((o) => o.order_id === "zm00000000c1")!;
  const a1 = ON.db.rows("pending_orders").find((o) => o.order_id === "aaaa0001")!;
  assertEquals(c1.current_price, a1.current_price);
  assertEquals(c1.status, "awaiting_confirmation");
  assertEquals(ON.db.rows("pending_orders").find((o) => o.order_id === "zm00000000c3")!.status, "pending", "no-data order left untouched");
});

Deno.test("no Telegram for C: A's touch still notifies, C's touch does not", () => {
  const tg = (r: Run) => r.calls.filter((c) => c.kind === "telegram");
  assertEquals(tg(OFF).length, 1, "A3 touched → one A notification");
  assertEquals(tg(ON).length, 1);
  assertEquals(ON.calls.filter((c) => c.kind === "telegram" && c.phase === "shadow_hunt").length, 0);
});

Deno.test("C cannot create positions and never reaches the fill claim", () => {
  for (const r of [ON]) {
    assertEquals(r.db.writes.filter((w) => w.table === "paper_positions").length, 0);
    assertEquals(r.db.rpcs.filter((x) => x.name === "route2_claim_and_fill").length, 0);
    assertEquals(r.db.writes.filter((w) => w.table === "trade_reasonings").length, 0);
  }
});

Deno.test("flag DRAIN: the hunt still finishes C orders exactly as ON", async () => {
  const DRAIN = await run("drain", MGMT);
  assertEquals(aWrites(DRAIN), aWrites(OFF));
  assertEquals(normalise(cPolls(DRAIN)), normalise(cPolls(ON)));
});

Deno.test("shadow failures cannot affect A: load throws / errors, C writes throw, C poll insert fails", async () => {
  const faults: [string, FakeDb["fault"]][] = [
    ["shadow order load throws", (op, t, f) => (op === "read" && t === "pending_orders" && f.includes(`bot_id=eq.${SHADOW}`) ? "throw" : null)],
    ["shadow order load errors", (op, t, f) => (op === "read" && t === "pending_orders" && f.includes(`bot_id=eq.${SHADOW}`) ? "error" : null)],
    ["every C order write throws", (op, _t, f) => (op === "write" && f.some((x) => x.startsWith("order_id=eq.zm")) ? "throw" : null)],
    ["every C order write errors", (op, _t, f) => (op === "write" && f.some((x) => x.startsWith("order_id=eq.zm")) ? "error" : null)],
    ["C poll insert throws", (op, t, _f, p) => (op === "write" && t === "route2_poll_log" && Array.isArray(p) && (p as any[])[0]?.poller_name === "bot-scanner:shadow-zonemid" ? "throw" : null)],
  ];
  for (const [name, fault] of faults) {
    const r = await run("on", MGMT, (db) => { db.fault = fault; });
    assertEquals(aWrites(r), aWrites(OFF), name);
    assertEquals(normalise(r.res), normalise(OFF.res), name);
    assertEquals(aPolls(r), aPolls(OFF), name);
  }
});

// ── Full manual scan (placement path, decision capture, flush point) ────────

const FULL = { isManualScan: true };
await run("off", FULL);
const FOFF = await run("off", FULL);
const FON = await run("on", FULL);

Deno.test("A output equivalence, full scan: OFF vs ON", () => {
  assert(FOFF.db.writes.length > OFF.db.writes.length, "the full scan ran the pair loop");
  // every pair was analysed (not skipped for market hours): the decision rows reached the analysis stages
  const stages = FOFF.db.rows("smc_scan_decision").map((r) => r.reached_stage);
  assertEquals(stages.length, 6);
  assertFalse(stages.includes("market_closed"), stages.join(","));
  assertEquals(aWrites(FON), aWrites(FOFF));
  assertEquals(aReads(FON), aReads(FOFF));
  assertEquals(normalise(FON.res), normalise(FOFF.res));
  assertEquals(normalise(FON.db.rows("smc_scan_decision")), normalise(FOFF.db.rows("smc_scan_decision")));
  // C's own path on a full scan: no provider call during the shadow hunt
  assertEquals(FON.calls.filter((c) => c.phase === "shadow_hunt").length, 0);
});
