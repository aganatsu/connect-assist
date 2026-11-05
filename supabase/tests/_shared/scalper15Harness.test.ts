/**
 * Scalper15 — EXECUTION tests on bot-scanner's real runScanForUser (in-memory tables, stubbed provider, fixed clock;
 * the harness of iov3OnHarness.test.ts):
 *   1. inert unless config_json.strategy.scalper15Enabled === true: absent / false / "true" produce byte-identical writes,
 *      reads, outbound calls and results;
 *   2. ON: the legacy strategy places nothing — every Route 2 order is Scalper15's, and every scanned pair reports why;
 *   3. hunt: a Scalper15 order whose 1H direction no longer holds is cancelled by the Scalper15 rule, and the legacy thesis
 *      checks never judge it.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CallRecord, FakeDb, normalise, type Row, withEnv, withFakeClock, withStubbedNetwork } from "./scannerHarness.ts";

const fx = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/baseline_a_config.json", import.meta.url)));
const ENV: Record<string, string | undefined> = { TWELVE_DATA_API_KEY: "test-key", SUPABASE_URL: "http://fake.local", SUPABASE_SERVICE_ROLE_KEY: "test-service-key", POLYGON_API_KEY: undefined };
const { runScanForUser } = await import("../../functions/bot-scanner/index.ts");

const U = "00000000-0000-0000-0000-0000000000ab";
const BASE = Date.parse("2026-10-07T10:12:00Z"); // a Wednesday, London
const LEVEL: Record<string, number> = { "EUR/USD": 1.1, "USD/JPY": 150, "GBP/USD": 1.3, "CHF/JPY": 180, "NZD/CAD": 0.82, "NZD/CHF": 0.48 };
const priceOf = (s: string) => LEVEL[s.includes("/") ? s : `${s.slice(0, 3)}/${s.slice(3)}`] ?? 1;
const iso = (min: number) => new Date(BASE + min * 60_000).toISOString();

type Variant = "absent" | "false" | "string" | "on";
const withSwitch = (v: Variant) => {
  if (v === "absent") return fx.config_json;
  const val = v === "false" ? false : v === "string" ? "true" : true;
  return { ...fx.config_json, strategy: { ...(fx.config_json.strategy ?? {}), scalper15Enabled: val } };
};
const order = (o: Row): Row => ({ user_id: U, bot_id: "smc", order_type: "limit", status: "pending", placed_at: iso(-30), expires_at: iso(400), dry_run: false,
  confirmation_arm_count: 0, confirmation_attempts: 0, confirmation_checks_count: 0, ...o });

function seed(v: Variant): FakeDb {
  const db = new FakeDb({
    bot_configs: [{ id: "cfg1", user_id: U, connection_id: null, config_json: withSwitch(v), config_version: fx.config_version }],
    paper_accounts: [{ user_id: U, bot_id: "smc", balance: "100000", is_paused: false, entries_locked: false, execution_mode: "paper", scan_count: 0, signal_count: 0, rejected_count: 0 }],
    user_settings: [{ user_id: U, preferences_json: { telegramChatIds: [] } }],
    pending_orders: [
      order({ order_id: "aaaa0001", symbol: "EUR/USD", direction: "long", entry_price: 1.095, stop_loss: 1.09, take_profit: 1.1005, entry_zone_low: 1.094, entry_zone_high: 1.096, entry_zone_type: "IZ-OB",
        signal_reason: JSON.stringify({ impulseZone: { impulse: { high: 1.11, low: 1.08 } } }) }),
      // a Scalper15 order: its thesis is the 1H direction, judged by the Scalper15 rule only
      order({ order_id: "s15gbp01", symbol: "GBP/USD", direction: "long", entry_price: 1.2995, stop_loss: 1.2989, take_profit: 1.3060, entry_zone_low: 1.299, entry_zone_high: 1.300, entry_zone_type: "S15-OB",
        signal_reason: JSON.stringify({ impulseZone: { impulse: { high: 1.305, low: 1.295 } } }) }),
    ],
  });
  db.rpcHandlers.set("route2_place_order", (a: any) => {
    const sup = (a.p_supersede ?? []).map((x: any) => x.order_id);
    for (const o of db.rows("pending_orders")) if (sup.includes(o.order_id) && ["pending", "awaiting_confirmation"].includes(o.status)) { o.status = "cancelled"; o.terminal_reason = "CANCELLED_SUPERSEDED"; }
    db.rows("pending_orders").push({ id: crypto.randomUUID(), ...a.p_order, signal_id: "sig-" + a.p_order.order_id });
    db.rows("trade_attribution").push(a.p_attribution);
    return { outcome: "placed", signal_id: "sig-" + a.p_order.order_id, superseded: sup };
  });
  return db;
}
interface Run { db: FakeDb; calls: CallRecord[]; res: any }
async function run(v: Variant): Promise<Run> {
  const db = seed(v), calls: CallRecord[] = [];
  const res = await withEnv(ENV, () => withFakeClock(BASE, () => withStubbedNetwork(db, calls, BASE, priceOf, () => runScanForUser(db.client(), U, { isManualScan: true }))));
  return { db, calls, res };
}
/**
 * The variants store different config_json (the switch key itself), so anything that is the config or a hash over it
 * differs by construction. Strip exactly that — the key and the config-derived hashes — and compare everything else.
 */
const CONFIG_HASHES = new Set(["config_hash", "confluence_hash"]);
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "scalper15Enabled") continue;
      out[k] = CONFIG_HASHES.has(k) ? "<config hash>" : scrub(x);
    }
    return out;
  }
  return v;
}
const writes = (r: Run) => scrub(normalise(r.db.writes));
const reads = (r: Run) => scrub(normalise(r.db.reads.map((x) => ({ t: x.table, f: x.filters }))));
const callsOf = (r: Run) => r.calls.map((c) => `${c.kind}:${c.url}`);
const details = (r: Run): any[] => r.res?.details ?? r.res?.scanDetails ?? [];

await run("absent"); // warm the provider stub's in-isolate cache so every compared run sees the same cache state
const ABSENT = await run("absent"), FALSE = await run("false"), STRING = await run("string"), ON = await run("on");

Deno.test("inert unless scalper15Enabled === true: absent / false / \"true\" are byte-identical", () => {
  for (const r of [FALSE, STRING]) {
    assertEquals(writes(r), writes(ABSENT));
    assertEquals(reads(r), reads(ABSENT));
    assertEquals(callsOf(r), callsOf(ABSENT));
    assertEquals(scrub(normalise(r.res)), scrub(normalise(ABSENT.res)));
  }
  for (const r of [ABSENT, FALSE, STRING]) {
    assertEquals(details(r).filter((d) => String(d.status ?? "").startsWith("scalper15_")).length, 0);
    assertEquals(r.db.rpcs.filter((x) => x.name === "route2_place_order" && String((x.args as any).p_order?.entry_zone_type ?? "").startsWith("S15-")).length, 0);
  }
  assert(ABSENT.db.writes.length > 3, "the fixture exercises the hunt");
});

Deno.test("ON: the legacy strategy places nothing; every scanned pair reports a Scalper15 outcome", () => {
  const placed = ON.db.rpcs.filter((x) => x.name === "route2_place_order").map((x) => (x.args as any).p_order);
  for (const o of placed) assert(String(o.entry_zone_type).startsWith("S15-"), `non-Scalper15 order placed under ON: ${o.entry_zone_type}`);
  const reached = details(ON).filter((d) => d.scalper15 !== undefined);
  assert(reached.length > 0, `no pair reached Scalper15: ${JSON.stringify(details(ON).map((d) => [d.pair, d.status, d.reason ?? d.skipReason]))}`);
  for (const d of reached) assert(/^(scalper15_|paused|zone_setup_rejected|attribution_invalid)/.test(String(d.status)), `${d.pair}: ${d.status}`);
});

Deno.test("hunt: a Scalper15 order is judged only by the Scalper15 1H rule (both switch states)", () => {
  for (const r of [ABSENT, ON]) {
    const o = r.db.rows("pending_orders").find((x) => x.order_id === "s15gbp01")!;
    // The stub's quiet market sets no 1H direction, so the long's thesis no longer holds.
    assertEquals([o.status, o.terminal_reason], ["cancelled", "CANCELLED_DIRECTION_FLIP"]);
    assert(String(o.cancel_reason).startsWith("Scalper15:"), String(o.cancel_reason));
  }
});
