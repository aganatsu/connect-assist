/**
 * Market hours in the Route 2 hunt. EXECUTION tests: bot-scanner's real
 * runScanForUser on a management cycle, in-memory tables, stubbed provider,
 * fixed clocks around the FX close (EDT: Fri 21:00 UTC → Sun 21:00 UTC).
 *
 * Production evidence (order 4324c6b3, USD/JPY short): touched 2026-10-09
 * 23:50 UTC and confirmed + filled 23:51 UTC on post-close provider bars,
 * while the pair loop reported market_closed. The replica below is that order
 * (prices, refined zone, armed state) with a 5m series that produces a
 * close-based bearish CHoCH (tier 1). Same data, same code: open → it fills;
 * after the close → it must not.
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CallRecord, FakeDb, normalise, type Row, withEnv, withFakeClock, withStubbedNetwork } from "./scannerHarness.ts";
import { isFxClosedAt } from "../../functions/_shared/sessions.ts";
import { shadowCoverage } from "../../functions/_shared/shadowZoneMid.ts";
import { toNYTime } from "../../functions/_shared/sessions.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const fx = JSON.parse(read("./fixtures/baseline_a_config.json"));
const { runScanForUser } = await import("../../functions/bot-scanner/index.ts");

const U = "00000000-0000-0000-0000-0000000000bb";
const SHADOW = "smc_shadow_zonemid";
const ENV = { TWELVE_DATA_API_KEY: "test-key", SUPABASE_URL: "http://fake.local", SUPABASE_SERVICE_ROLE_KEY: "test-service-key", POLYGON_API_KEY: undefined };
const LEVEL: Record<string, number> = { "EUR/USD": 1.1, "USD/JPY": 158.3, "GBP/USD": 1.3, "CHF/JPY": 180, "NZD/CAD": 0.82, "NZD/CHF": 0.48, "ETH/USD": 2500 };
const priceOf = (s: string) => LEVEL[s.includes("/") ? s : `${s.slice(0, 3)}/${s.slice(3)}`] ?? 1;

// ── The 4324c6b3 replica: a 5m series whose bar 295 is a close-based bearish CHoCH ──
const ZL = 158.29711, ZH = 158.29909;
function chochSeries() {
  let s = 5;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  let p = 158.3;
  const bars: { open: number; high: number; low: number; close: number }[] = [];
  for (let i = 0; i < 300; i++) {
    const o = p; p += (r() - 0.5) * 0.04;
    bars.push({ open: o, high: Math.max(o, p) + r() * 0.01, low: Math.min(o, p) - r() * 0.01, close: p });
  }
  const k = 295, shift = (ZL + ZH) / 2 - (bars[k].high + bars[k].low) / 2;
  return bars.map((b) => ({ open: b.open + shift, high: b.high + shift, low: b.low + shift, close: b.close + shift }));
}
const CHOCH = chochSeries();
const override = (sym: string, iv: string) => (sym === "USD/JPY" && iv === "5min" ? CHOCH : null);

const OPEN_FRI = Date.parse("2026-10-09T20:51:01Z");   // 9 minutes before the close
const CLOSED_FRI = Date.parse("2026-10-09T23:51:01Z"); // the minute 4324c6b3 filled
const SATURDAY = Date.parse("2026-10-10T12:00:01Z");
const SUN_BEFORE = Date.parse("2026-10-11T20:59:01Z");
const SUN_AFTER = Date.parse("2026-10-11T21:01:01Z");
const WEDNESDAY = Date.parse("2026-10-07T10:12:01Z");

function seed(base: number, extra: Row[] = []): FakeDb {
  const iso = (min: number) => new Date(base + min * 60_000).toISOString();
  const bar5 = (i: number) => Math.floor(base / 300_000) * 300_000 - 300_000 - (299 - i) * 300_000; // bar i's open, as the stub stamps it
  const replica = (o: Row): Row => ({
    user_id: U, symbol: "USD/JPY", direction: "short", order_type: "limit", status: "awaiting_confirmation",
    entry_price: 158.29711, stop_loss: 158.54711, take_profit: 158.02211, size: 3.11,
    entry_zone_low: 158.18732, entry_zone_high: 158.347865, refined_zone_low: ZL, refined_zone_high: ZH,
    placed_at: iso(-266), expires_at: iso(214), zone_touch_time: new Date(bar5(292) + 60_000).toISOString(),
    confirmation_arm_count: 1, confirmation_attempts: 0, confirmation_checks_count: 0,
    confirmation_min_observation_until: iso(9), last_consumed_touch_id: "t1",
    signal_reason: JSON.stringify({ impulseZone: { impulse: { high: 158.9, low: 157.6 } } }), ...o,
  });
  const order = (o: Row): Row => ({
    user_id: U, order_type: "limit", status: "pending", placed_at: iso(-60), expires_at: iso(400), dry_run: false,
    confirmation_arm_count: 0, confirmation_attempts: 0, confirmation_checks_count: 0,
    signal_reason: JSON.stringify({ impulseZone: { impulse: { high: 9e9, low: 0 } } }), ...o,
  });
  return new FakeDb({
    bot_configs: [{ id: "cfg1", user_id: U, connection_id: null, config_json: fx.config_json, config_version: fx.config_version }],
    paper_accounts: [{ user_id: U, bot_id: "smc", balance: "100000", is_paused: false, entries_locked: false, execution_mode: "paper", scan_count: 0, signal_count: 0, rejected_count: 0 }],
    user_settings: [{ user_id: U, preferences_json: { telegramChatIds: ["111"] } }],
    pending_orders: [
      replica({ id: "row-a1", order_id: "a0000001", bot_id: "smc", dry_run: false }),
      // EUR/USD long whose entry sits above the last bar's low: touches whenever the hunt looks
      order({ id: "row-a2", order_id: "a0000002", bot_id: "smc", symbol: "EUR/USD", direction: "long", entry_price: 1.1012, stop_loss: 1.095, take_profit: 1.108, entry_zone_low: 1.1002, entry_zone_high: 1.1014 }),
      // pure time expiry, never touched / touched
      order({ id: "row-a3", order_id: "a0000003", bot_id: "smc", symbol: "GBP/USD", direction: "long", entry_price: 1.29, stop_loss: 1.285, take_profit: 1.295, expires_at: iso(-1) }),
      order({ id: "row-a4", order_id: "a0000004", bot_id: "smc", symbol: "NZD/CAD", direction: "short", status: "awaiting_confirmation", entry_price: 0.8205, stop_loss: 0.83, take_profit: 0.81, expires_at: iso(-2), zone_touch_time: iso(-30) }),
      // crypto trades through the weekend: must still be hunted
      order({ id: "row-a5", order_id: "a0000005", bot_id: "smc", symbol: "ETH/USD", direction: "long", entry_price: 2510, stop_loss: 2400, take_profit: 2600, entry_zone_low: 2505, entry_zone_high: 2512 }),
      ...extra,
    ],
  });
}

interface Run { db: FakeDb; calls: CallRecord[]; res: any; at: number }
async function run(at: number, opts: { shadow?: string; extra?: Row[] } = {}): Promise<Run> {
  const db = seed(at, opts.extra);
  db.rpcHandlers.set("route2_claim_and_fill", (a: any) => ({ outcome: "filled", pending_id: a.p_pending_row_id ?? a.p_pending_id ?? "x", position_row_id: "pos-row" }));
  const calls: CallRecord[] = [];
  const res = await withEnv({ ...ENV, SMC_SHADOW_ZONEMID: opts.shadow ?? "off" }, () =>
    withFakeClock(at, () => withStubbedNetwork(db, calls, at, priceOf, () => runScanForUser(db.client(), U, { isManagementOnly: true }), override)));
  return { db, calls, res, at };
}
const poll = (r: Run, id: string) => r.db.rows("route2_poll_log").filter((p) => p.pending_id === id).map((p) => p.branch_taken);
const orderOf = (r: Run, id: string) => r.db.rows("pending_orders").find((o) => o.order_id === id)!;
const writesFor = (r: Run, id: string) => r.db.writes.filter((w) => w.filters.some((f) => f === `order_id=eq.${id}` || f === `id=eq.row-${id.slice(-2) === "01" ? "a1" : ""}`));
const claims = (r: Run) => r.db.rpcs.filter((x) => x.name === "route2_claim_and_fill");
const fxFetches = (r: Run) => r.calls.filter((c) => c.kind === "provider" && !/ETH%2FUSD|BTC%2FUSD/.test(c.url) && /interval=(5min|15min|30min|1h|4h)/.test(c.url));

await run(OPEN_FRI); // warm the provider stub's module cache (candleSource keeps 90 s)
const OPEN = await run(OPEN_FRI);
const CLOSED = await run(CLOSED_FRI);

Deno.test("control: the replica and the touching order act while the market is open (old and new code alike)", () => {
  assertFalse(isFxClosedAt(OPEN_FRI));
  assertEquals(poll(OPEN, "a0000001").at(-1), "confirmed_fill", `replica: ${poll(OPEN, "a0000001")}`);
  assertEquals(claims(OPEN).length, 1, "one fill claim, for the replica");
  assertEquals(poll(OPEN, "a0000002"), ["zone_touched"]);
  assertEquals(orderOf(OPEN, "a0000002").status, "awaiting_confirmation");
});

Deno.test("1. Friday after the close: a pending order cannot newly touch", () => {
  assert(isFxClosedAt(CLOSED_FRI));
  assertEquals(poll(CLOSED, "a0000002"), ["market_closed_hold"]);
  const o = orderOf(CLOSED, "a0000002");
  assertEquals([o.status, o.zone_touch_time ?? null, o.confirmation_arm_count], ["pending", null, 0]);
  assertEquals(CLOSED.db.writes.filter((w) => w.filters.includes("order_id=eq.a0000002")).length, 0, "nothing written, not even current_price");
});

Deno.test("2 + 6. Friday after the close: the 4324c6b3 replica cannot confirm or fill (it does at 20:51 with the same data)", () => {
  assertEquals(poll(CLOSED, "a0000001"), ["market_closed_hold"]);
  assertEquals(claims(CLOSED).length, 0, "no fill claim");
  assertEquals(CLOSED.db.writes.filter((w) => w.table === "paper_positions" || w.table === "trade_reasonings").length, 0);
  const o = orderOf(CLOSED, "a0000001");
  assertEquals([o.status, o.confirmation_checks_count, o.filled_at ?? null], ["awaiting_confirmation", 0, null]);
  const w = CLOSED.db.writes.filter((w) => w.filters.includes("order_id=eq.a0000001") || w.filters.includes("id=eq.row-a1"));
  assertEquals(w.length, 0, JSON.stringify(w));
  // the only notification is the crypto order's touch (crypto keeps trading)
  assertEquals(CLOSED.calls.filter((c) => c.kind === "telegram").length, 1);
  assertEquals(CLOSED.db.rows("route2_poll_log").filter((p) => p.branch_taken === "zone_touched").map((p) => p.pending_id), ["a0000005"]);
});

Deno.test("3. weekend management cycle: no FX candle fetch for any pending order, no execution decision", async () => {
  const SAT = await run(SATURDAY);
  assertEquals(fxFetches(SAT).map((c) => c.url.replace(/&apikey=[^&]+/, "")), [], "no intraday FX series fetched");
  assertEquals(fxFetches(CLOSED).map((c) => c.url.replace(/&apikey=[^&]+/, "")), [], "nor after the Friday close");
  for (const id of ["a0000001", "a0000002"]) assertEquals(poll(SAT, id), ["market_closed_hold"], id);
  const fxWrites = SAT.db.writes.filter((w) => w.table === "pending_orders" && !w.filters.includes("order_id=eq.a0000005"));
  assertEquals(fxWrites.map((w) => w.filters.find((f) => f.startsWith("order_id"))), ["order_id=eq.a0000003", "order_id=eq.a0000004"], "only the two TTL expiries");
  assertEquals(claims(SAT).length, 0);
});

Deno.test("4. market open is unchanged: Wednesday and Sunday after 17:00 ET act exactly as Friday 20:51", async () => {
  for (const at of [WEDNESDAY, SUN_AFTER]) {
    assertFalse(isFxClosedAt(at));
    const r = await run(at);
    assertEquals(poll(r, "a0000002"), ["zone_touched"], new Date(at).toISOString());
    assertEquals(poll(r, "a0000001").at(-1), "confirmed_fill", new Date(at).toISOString());
    assertEquals(claims(r).length, 1);
    assertFalse(r.db.rows("route2_poll_log").some((p) => p.branch_taken === "market_closed_hold"));
  }
  const before = await run(SUN_BEFORE);
  assert(isFxClosedAt(SUN_BEFORE));
  assertEquals(poll(before, "a0000002"), ["market_closed_hold"], "Sunday 16:59 ET is still closed");
});

Deno.test("5. pure time expiry is unchanged while closed: same rows, same reasons, same writes", () => {
  for (const id of ["a0000003", "a0000004"]) {
    assertEquals(poll(CLOSED, id), ["ttl_expiry"]);
    assertEquals(poll(OPEN, id), ["ttl_expiry"]);
    const w = (r: Run) => normalise(r.db.writes.filter((x) => x.filters.includes(`order_id=eq.${id}`)));
    assertEquals(w(CLOSED), w(OPEN), id);
  }
  assertEquals([orderOf(CLOSED, "a0000003").terminal_reason, orderOf(CLOSED, "a0000004").terminal_reason],
    ["EXPIRED_NEVER_TOUCHED", "EXPIRED_AFTER_TOUCH_NO_CONFIRMATION"]);
  assertEquals(CLOSED.res.pendingOrders.expired, 2);
});

Deno.test("crypto is not FX: a crypto order is still hunted on Saturday", async () => {
  const SAT = await run(SATURDAY);
  assertEquals(poll(SAT, "a0000005"), ["zone_touched"]);
});

Deno.test("7. Candidate C inherits it: a shadow replica holds after the close and is not counted as a coverage gap", async () => {
  const c = { id: "row-c1", order_id: "zm00000000c1", bot_id: SHADOW, dry_run: true };
  const replicaC = { ...seed(CLOSED_FRI).rows("pending_orders")[0], ...c };
  const closed = await run(CLOSED_FRI, { shadow: "on", extra: [replicaC] });
  assertEquals(closed.db.rows("route2_poll_log").filter((p) => p.pending_id === "zm00000000c1").map((p) => [p.poller_name, p.branch_taken]),
    [["bot-scanner:shadow-zonemid", "market_closed_hold"]]);
  assertEquals(orderOf(closed, "zm00000000c1").status, "awaiting_confirmation");
  const cov = shadowCoverage([{ symbol: "USD/JPY", branch: "market_closed_hold" }, { symbol: "USD/JPY", branch: "awaiting_confirmation" }]);
  assertEquals([cov.polls, cov.overall], [1, 1], "closed-market minutes are outside the coverage measure");
  // open: C confirms and records its hypothetical fill (no claim — dry run)
  const open = await run(OPEN_FRI, { shadow: "on", extra: [{ ...seed(OPEN_FRI).rows("pending_orders")[0], ...c }] });
  // (a dry-run fill after a deferred-reset row adds no second poll row — the same as A's dry-run branch)
  const cOpen = orderOf(open, "zm00000000c1");
  assertEquals([cOpen.status, cOpen.terminal_reason, cOpen.confirmation_type], ["filled", "FILLED", "bearish_choch"]);
  assertEquals(claims(open).length, 1, "the only claim is A's");
});

Deno.test("8. the guard sits after TTL expiry and before every candle read; same rule as the pair loop", () => {
  const s = read("../../functions/bot-scanner/index.ts");
  const loop = s.slice(s.indexOf("for await (const pending of huntOrders())"), s.indexOf("// ── Flush the Route 2 poll log ──"));
  const expiry = loop.indexOf(`branchTaken: "ttl_expiry"`);
  const guard = loop.indexOf("if (fxClosedAtPoll && SPECS[pending.symbol]?.type !== \"crypto\") {");
  const firstRead = loop.indexOf("await huntFetch(");
  const shadowPeek = loop.indexOf("peekAll(");
  assert(expiry > 0 && guard > expiry && firstRead > guard && shadowPeek > guard, "expiry → guard → shadow precheck / fetch");
  assert(s.includes("const fxClosedAtPoll = isFxClosedAt(Date.parse(pollAt));"));
  // the pair loop's inline rule is unchanged and equals the shared one at every quarter hour of a year
  assert(s.includes("const fxIsClosed = (nyDay === 6) || (nyDay === 0 && nyHour < 17) || (nyDay === 5 && nyHour >= 17);"));
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 15 * 60_000) {
    const ny = toNYTime(new Date(t));
    const inline = (ny.nyDay === 6) || (ny.nyDay === 0 && ny.t < 17) || (ny.nyDay === 5 && ny.t >= 17);
    if (inline !== isFxClosedAt(t)) throw new Error(`rule mismatch at ${new Date(t).toISOString()}`);
  }
  const zcs = read("../../functions/zone-confirmation-scanner/index.ts");
  assert(zcs.includes(`import { isFxClosedAt } from "../_shared/sessions.ts";`));
  assert(zcs.includes(`(queriedOrders ?? []).filter((o: any) => !fxClosedNow || SPECS[o.symbol]?.type === "crypto")`), "the second poller holds FX orders too");
});
