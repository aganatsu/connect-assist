/**
 * V3.2c PR2 — scanner decision-equivalence for the canonical 1H structure-bar writer.
 *
 * Runs the REAL bot-scanner runScanForUser (full manual scan, Baseline A config fixture) against in-memory tables and a
 * stubbed provider, with the writer OFF and ON, and requires everything Baseline A produces — every write, read,
 * outbound call, the scan result, decision rows and scan logs — to be identical. The writer may only add rows to its own
 * tables, makes zero provider calls, and its failures (throws / errors) cannot change anything Baseline A produces.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CallRecord, FakeDb, normalise, type Row, withEnv, withFakeClock, withStubbedNetwork } from "./scannerHarness.ts";

const fx = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/baseline_a_config.json", import.meta.url)));
const ENV: Record<string, string | undefined> = {
  TWELVE_DATA_API_KEY: "test-key", SUPABASE_URL: "http://fake.local", SUPABASE_SERVICE_ROLE_KEY: "test-service-key", POLYGON_API_KEY: undefined,
};
const { runScanForUser } = await import("../../functions/bot-scanner/index.ts");

const U = "00000000-0000-0000-0000-0000000000bb";
// A Wednesday London session AFTER the live release floor, so the ON run really writes canonical bars.
const BASE = Date.parse("2026-11-04T10:12:00Z");
const RELEASE = "2026-10-25T21:00:00Z";
const LEVEL: Record<string, number> = { "EUR/USD": 1.1, "USD/JPY": 150, "GBP/USD": 1.3, "CHF/JPY": 180, "NZD/CAD": 0.82, "NZD/CHF": 0.48 };
const priceOf = (s: string) => LEVEL[s.includes("/") ? s : `${s.slice(0, 3)}/${s.slice(3)}`] ?? 1;
const STRUCTURE_TABLES = new Set(["structure_bars_1h", "structure_bar_revisions", "structure_bar_rejections"]);

function seed(): FakeDb {
  return new FakeDb({
    bot_configs: [{ id: "cfg1", user_id: U, connection_id: null, config_json: fx.config_json, config_version: fx.config_version }],
    paper_accounts: [{ user_id: U, bot_id: "smc", balance: "100000", is_paused: false, entries_locked: false, execution_mode: "paper", scan_count: 0, signal_count: 0, rejected_count: 0 }],
    user_settings: [{ user_id: U, preferences_json: { telegramChatIds: ["111"] } }],
  });
}
interface Run { db: FakeDb; calls: CallRecord[]; res: unknown }
async function run(write: "off" | "on", prep?: (db: FakeDb) => void): Promise<Run> {
  const db = seed(); prep?.(db);
  const calls: CallRecord[] = [];
  const env = write === "on" ? { ...ENV, STRUCTURE_BARS_LIVE_WRITE: "on", STRUCTURE_BARS_RELEASE_AT: RELEASE } : { ...ENV, STRUCTURE_BARS_LIVE_WRITE: undefined, STRUCTURE_BARS_RELEASE_AT: undefined };
  const res = await withEnv(env, () => withFakeClock(BASE, () => withStubbedNetwork(db, calls, BASE, priceOf, () => runScanForUser(db.client(), U, { isManualScan: true }))));
  return { db, calls, res };
}
const aWrites = (r: Run) => normalise(r.db.writes.filter((w) => !STRUCTURE_TABLES.has(w.table)));
const aReads = (r: Run) => normalise(r.db.reads.filter((x) => !STRUCTURE_TABLES.has(x.table)).map((x) => ({ t: x.table, f: x.filters })));
const allCalls = (r: Run) => r.calls.map((c) => `${c.kind}:${c.url}`);
const rows = (r: Run, t: string): Row[] => normalise(r.db.rows(t)) as Row[];

await run("off"); // warm the provider stub's in-isolate candle cache so every compared run sees the same cache state
const OFF = await run("off");
const OFF2 = await run("off");
const ON = await run("on");

Deno.test("harness is deterministic: two OFF runs are identical, and the scan ran the pair loop on all six pairs", () => {
  assertEquals(aWrites(OFF2), aWrites(OFF));
  assertEquals(normalise(OFF2.res), normalise(OFF.res));
  assertEquals(OFF.db.rows("smc_scan_decision").length, 6);
});

Deno.test("writer OFF: zero structure-table reads or writes", () => {
  assertEquals(OFF.db.writes.filter((w) => STRUCTURE_TABLES.has(w.table)).length, 0);
  assertEquals(OFF.db.reads.filter((x) => STRUCTURE_TABLES.has(x.table)).length, 0);
});

Deno.test("decision-equivalence OFF vs ON: Baseline A writes, reads, outbound calls, result, decision rows, scan logs identical", () => {
  assertEquals(aWrites(ON), aWrites(OFF));
  assertEquals(aReads(ON), aReads(OFF));
  assertEquals(allCalls(ON), allCalls(OFF), "the writer makes zero provider / network calls");
  assertEquals(normalise(ON.res), normalise(OFF.res));
  assertEquals(rows(ON, "smc_scan_decision"), rows(OFF, "smc_scan_decision"));
  assertEquals(rows(ON, "scan_logs"), rows(OFF, "scan_logs"));
  assertEquals(rows(ON, "pending_orders"), rows(OFF, "pending_orders"));
});

Deno.test("writer ON: canonical bars written for all six pairs, only settled bars at/after the release, scanner_live provenance", () => {
  const bars = ON.db.rows("structure_bars_1h");
  assertEquals(new Set(bars.map((b) => b.symbol)).size, 6);
  assert(bars.every((b) => b.source === "scanner_live" && Date.parse(b.bar_time) >= Date.parse(RELEASE)));
  assert(bars.every((b) => Date.parse(b.observed_at) >= Date.parse(b.bar_time) + 75 * 60_000));
  assert(ON.db.writes.filter((w) => STRUCTURE_TABLES.has(w.table)).length <= 6 * 3, "batched: at most 3 writes per pair");
});

Deno.test("writer failures cannot affect Baseline A: structure reads / writes that throw or error", async () => {
  const faults: [string, FakeDb["fault"]][] = [
    ["structure read throws", (op, t) => (op === "read" && STRUCTURE_TABLES.has(t) ? "throw" : null)],
    ["structure read errors", (op, t) => (op === "read" && STRUCTURE_TABLES.has(t) ? "error" : null)],
    ["structure writes throw", (op, t) => (op === "write" && STRUCTURE_TABLES.has(t) ? "throw" : null)],
    ["structure writes error", (op, t) => (op === "write" && STRUCTURE_TABLES.has(t) ? "error" : null)],
  ];
  for (const [name, fault] of faults) {
    const r = await run("on", (db) => { db.fault = fault; });
    assertEquals(aWrites(r), aWrites(OFF), name);
    assertEquals(normalise(r.res), normalise(OFF.res), name);
    assertEquals(rows(r, "smc_scan_decision"), rows(OFF, "smc_scan_decision"), name);
  }
});
