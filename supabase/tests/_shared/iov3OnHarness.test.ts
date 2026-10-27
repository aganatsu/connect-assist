/**
 * Impulse-on-V3 ON (step 4b) — EXECUTION tests on bot-scanner's real runScanForUser (in-memory tables, stubbed provider, fixed
 * clock; harness of shadowZoneMidHarness.test.ts):
 *   1. inert unless BOTH the switch is ON and the config marks structure.owner = v3: no row / SHADOW / ON-without-marker produce
 *      byte-identical writes, reads, outbound calls and results;
 *   2. ON places the SHADOW'S decision as a real Route 2 order through route2_place_order (entry / stop / target = the plan,
 *      tagged V3A-…, the V3 leg in the impulse-broken slot) and supersedes the live orders on that pair;
 *   3. a risk gate still blocks under ON; 4. the hunt cancels a V3 order when the V3 trend flips, and leaves legacy orders alone.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CallRecord, FakeDb, normalise, type Row, withEnv, withFakeClock, withStubbedNetwork } from "./scannerHarness.ts";
import { resolveShadowParams } from "../../functions/_shared/iov3/params.ts";
import { route2StopFromLimit } from "../../functions/_shared/route2StopGeometry.ts";
import { V3_ENGINE_VERSION } from "../../functions/_shared/iov3/onMode.ts";

const fx = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/baseline_a_config.json", import.meta.url)));
const ENV: Record<string, string | undefined> = { TWELVE_DATA_API_KEY: "test-key", SUPABASE_URL: "http://fake.local", SUPABASE_SERVICE_ROLE_KEY: "test-service-key", POLYGON_API_KEY: undefined };
const { runScanForUser } = await import("../../functions/bot-scanner/index.ts");

const U = "00000000-0000-0000-0000-0000000000aa";
const BASE = Date.parse("2026-10-07T10:12:00Z"); // a Wednesday, London
const LEVEL: Record<string, number> = { "EUR/USD": 1.1, "USD/JPY": 150, "GBP/USD": 1.3, "CHF/JPY": 180, "NZD/CAD": 0.82, "NZD/CHF": 0.48 };
const priceOf = (s: string) => LEVEL[s.includes("/") ? s : `${s.slice(0, 3)}/${s.slice(3)}`] ?? 1;
const iso = (min: number) => new Date(BASE + min * 60_000).toISOString();

// the shadow's EUR/USD decision at the 10:00 close: bullish V3 leg 1.0960 → 1.1040, OB 1.0997–1.1003, refined entry 1.1000
// (within the 1.5 × H1-ATR distance guard of the stub's quiet synthetic market)
const params = (pair: string) => { const r = resolveShadowParams(fx.config_json, pair); if (!r.ok) throw new Error(r.reason); return r.params; };
const EUP = params("EUR/USD");
const LEG = { origin: 1.0960, extreme: 1.1040 };
const ENTRY = 1.1000;
const legRange = LEG.extreme - LEG.origin, buf = Math.max(EUP.slBufferPips * EUP.pip, legRange * EUP.legBufferPct);
const GEO = route2StopFromLimit({ direction: "long", limit: ENTRY, swingSL: null, impulseSL: LEG.origin - buf,
  impulseCapPips: Math.max(EUP.minSlPips * EUP.capMultiplier, (EUP.legCapMultiple * legRange) / EUP.pip), minSlPips: EUP.minSlPips, pipSize: EUP.pip, tpRatio: EUP.tpRatio });
const DECISION = {
  cohort_id: "coh1", arm: "A", pair: "EUR/USD", t: iso(-12), user_id: U, dir: "long", reason: "placed", price: 1.1,
  leg: { trend: "bull", swing_time: iso(-3000), swing_price: LEG.origin, extreme_time: iso(-600), extreme_price: LEG.extreme },
  zone: { type: "ob", low: 1.0997, high: 1.1003, refinedEntry: ENTRY, fibLevel: 0.5, fibDepth: 0.5, score: 3 },
  order_plan: { entry: ENTRY, sl: GEO.sl, tp: GEO.tp, riskPips: GEO.riskPips, stopSource: GEO.source },
};

const order = (o: Row): Row => ({ user_id: U, bot_id: "smc", order_type: "limit", status: "pending", placed_at: iso(-30), expires_at: iso(400), dry_run: false,
  confirmation_arm_count: 0, confirmation_attempts: 0, confirmation_checks_count: 0, ...o });
function seed(variant: "none" | "shadow" | "on_no_marker" | "on", extra?: (db: FakeDb) => void): FakeDb {
  const cfg = variant === "on" ? { ...fx.config_json, structure: { owner: "v3", arm: "A" } } : fx.config_json;
  const db = new FakeDb({
    bot_configs: [{ id: "cfg1", user_id: U, connection_id: null, config_json: cfg, config_version: fx.config_version }],
    paper_accounts: [{ user_id: U, bot_id: "smc", balance: "100000", is_paused: false, entries_locked: false, execution_mode: "paper", scan_count: 0, signal_count: 0, rejected_count: 0 }],
    user_settings: [{ user_id: U, preferences_json: { telegramChatIds: [] } }],
    pending_orders: [
      order({ order_id: "aaaa0001", symbol: "EUR/USD", direction: "long", entry_price: 1.095, stop_loss: 1.09, take_profit: 1.1005, entry_zone_low: 1.094, entry_zone_high: 1.096, entry_zone_type: "IZ-OB",
        signal_reason: JSON.stringify({ impulseZone: { impulse: { high: 1.11, low: 1.08 } } }) }),
      order({ order_id: "v3nzdcad", symbol: "NZD/CAD", direction: "short", entry_price: 0.8205, stop_loss: 0.825, take_profit: 0.8138, entry_zone_low: 0.82, entry_zone_high: 0.821, entry_zone_type: "V3A-FVG",
        signal_reason: JSON.stringify({ impulseZone: { impulse: { high: 0.825, low: 0.81 } } }) }),
    ],
    structure_mode: variant === "none" ? [] : [{ user_id: U, bot_id: "smc", mode: variant === "shadow" ? "SHADOW" : "ON", arm: variant === "shadow" ? null : "A", on_since: iso(-1440), set_at: iso(-1440) }],
    iov3_shadow_cohorts: [{ id: "coh1", user_id: U, bot_id: "smc", started_at: iso(-2000), params: Object.fromEntries(["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"].map((p) => [p, params(p)])) }],
    iov3_shadow_decisions: [DECISION],
    structure_v3_snapshots: [{ symbol: "NZD/CAD", tf: "1H", known_at: iso(-12), trend: "bull", engine_version: V3_ENGINE_VERSION }],
  });
  db.rpcHandlers.set("route2_place_order", (a: any) => {
    const sup = (a.p_supersede ?? []).map((x: any) => x.order_id);
    for (const o of db.rows("pending_orders")) if (sup.includes(o.order_id) && ["pending", "awaiting_confirmation"].includes(o.status)) { o.status = "cancelled"; o.terminal_reason = "CANCELLED_SUPERSEDED"; }
    db.rows("pending_orders").push({ id: crypto.randomUUID(), ...a.p_order, signal_id: "sig-" + a.p_order.order_id });
    db.rows("trade_attribution").push(a.p_attribution);
    return { outcome: "placed", signal_id: "sig-" + a.p_order.order_id, superseded: sup };
  });
  extra?.(db);
  return db;
}
interface Run { db: FakeDb; calls: CallRecord[]; res: any }
async function run(variant: Parameters<typeof seed>[0], extra?: (db: FakeDb) => void): Promise<Run> {
  const db = seed(variant, extra), calls: CallRecord[] = [];
  const res = await withEnv(ENV, () => withFakeClock(BASE, () => withStubbedNetwork(db, calls, BASE, priceOf, () => runScanForUser(db.client(), U, { isManualScan: true }))));
  return { db, calls, res };
}
const writes = (r: Run) => normalise(r.db.writes);
const reads = (r: Run) => normalise(r.db.reads.map((x) => ({ t: x.table, f: x.filters })));
const calls = (r: Run) => r.calls.map((c) => `${c.kind}:${c.url}`);

await run("none"); // warm the provider stub's in-isolate cache so every compared run sees the same cache state
const NONE = await run("none"), SHADOW = await run("shadow"), NOMARK = await run("on_no_marker"), ON = await run("on");

Deno.test("ON is inert unless switch ON AND config marker: no row / SHADOW / ON-without-marker are byte-identical", () => {
  assertEquals(writes(SHADOW), writes(NONE));
  assertEquals(writes(NOMARK), writes(NONE));
  assertEquals(reads(SHADOW), reads(NONE));
  assertEquals(reads(NOMARK), reads(NONE));
  assertEquals(calls(SHADOW), calls(NONE));
  assertEquals(calls(NOMARK), calls(NONE));
  assertEquals(normalise(SHADOW.res), normalise(NONE.res));
  assertEquals(normalise(NOMARK.res), normalise(NONE.res));
  for (const r of [NONE, SHADOW, NOMARK]) {
    assertEquals(r.db.reads.filter((x) => x.table.startsWith("iov3_")).length, 0, "no shadow-decision reads unless ON");
    assertEquals(r.db.rpcs.filter((x) => x.name === "route2_place_order" && (x.args as any).p_order?.entry_zone_type?.startsWith("V3")).length, 0);
  }
  assert(NONE.db.writes.length > 3, "the fixture exercises the hunt");
});

Deno.test("ON places the shadow's decision as a real Route 2 order: plan geometry, V3 tag, V3 leg, supersedes the pair's live order", () => {
  const v3 = ON.db.rpcs.filter((x) => x.name === "route2_place_order").map((x) => (x.args as any).p_order).filter((o) => o.entry_zone_type?.startsWith("V3"));
  assertEquals(v3.length, 1, JSON.stringify((ON.res?.details ?? ON.res?.scanDetails ?? []).filter?.((d: any) => d.pair === "EUR/USD")));
  const o = v3[0];
  assertEquals([o.symbol, o.direction, o.entry_price, o.entry_zone_type, o.bot_id, o.dry_run], ["EUR/USD", "long", ENTRY, "V3A-OB", "smc", false]);
  assertEquals([+Number(o.stop_loss).toFixed(8), +Number(o.take_profit).toFixed(8)], [+GEO.sl.toFixed(8), +GEO.tp.toFixed(8)]);
  assertEquals(JSON.parse(o.signal_reason).impulseZone.impulse, { high: LEG.extreme, low: LEG.origin });
  assert(Number(o.size) > 0);
  const sup = ON.db.rpcs.find((x) => x.name === "route2_place_order")!.args as any;
  assertEquals(sup.p_supersede.map((x: any) => x.order_id), ["aaaa0001"], "ON owns the V3 pair: the legacy EUR/USD order is superseded");
});

Deno.test("ON: a risk gate still blocks (position cap reached) — no V3 order", async () => {
  const full = await run("on", (db) => {
    for (const [i, s] of ["GBP/USD", "USD/JPY", "CHF/JPY"].entries()) db.rows("paper_positions").push({ user_id: U, bot_id: "smc", position_id: `p${i}`, symbol: s, direction: "long", position_status: "open",
      entry_price: LEVEL[s], size: 0.1, stop_loss: LEVEL[s] * 0.99, take_profit: LEVEL[s] * 1.01, open_time: iso(-60), order_id: `o${i}`, signal_score: "0" });
  });
  const v3 = full.db.rpcs.filter((x) => x.name === "route2_place_order" && (x.args as any).p_order?.entry_zone_type?.startsWith("V3"));
  assertEquals(v3.length, 0);
});

Deno.test("hunt: a V3 order is cancelled when the V3 trend flips; the legacy thesis checks never judge it", () => {
  for (const r of [NONE, ON]) {
    const v = r.db.rows("pending_orders").find((o) => o.order_id === "v3nzdcad")!;
    assertEquals([v.status, v.terminal_reason], ["cancelled", "CANCELLED_DIRECTION_FLIP"]);
    assert(String(v.cancel_reason).startsWith("V3 trend flipped"));
  }
});
