import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeDb } from "../scannerHarness.ts";
import { breakerEnabled, MAX_SCANS_PER_RUN, PAUSE_AFTER_MS, runBreakerShadow, zonesFromScan } from "../../../functions/_shared/breaker/breakerRun.ts";

/** The breaker runner against an in-memory store: the switch, zones read from scan details, the 5m lifecycle, re-runs, no trading writes. */

const M5 = 300_000, USER = "00000000-0000-0000-0000-000000000001", iso = (t: number) => new Date(t).toISOString();
const SNAP = JSON.parse(Deno.readTextFileSync(new URL("../../../../docs/step16/step16e_config_before.json", import.meta.url)));
const config = (on: boolean) => { const r = structuredClone(SNAP.config_json ?? SNAP); r.strategy = { ...(r.strategy ?? {}), breakerShadowEnabled: on }; return r; };
const T0 = Date.parse("2026-11-10T08:00:00Z");
/** EUR/USD 5m: flat at 1.1030 for a day, then down through the 1.1000–1.1010 buy zone, back up to 1.1000, then down to 1.0965. */
function m5Rows() {
  const rows: Record<string, unknown>[] = [];
  const push = (t: number, o: number, h: number, l: number, c: number) => rows.push({ symbol: "EUR/USD", bar_time: iso(t), open: o, high: h, low: l, close: c, observed_at: iso(t + M5 + 20 * 60_000) });
  let t = T0 - 24 * 3600_000;
  for (; t < T0; t += M5) push(t, 1.1030, 1.1032, 1.1028, 1.1030);
  const path: [number, number, number, number][] = [[1.1030, 1.1031, 1.1012, 1.1013], [1.1013, 1.1014, 1.0990, 1.0992], [1.0992, 1.0998, 1.0990, 1.0997],
    [1.0997, 1.1001, 1.0996, 1.0999], [1.0999, 1.0999, 1.0985, 1.0986], [1.0986, 1.0987, 1.0965, 1.0966]];
  for (const [o, h, l, c] of path) { push(t, o, h, l, c); t += M5; }
  for (let i = 0; i < 24; i++, t += M5) push(t, 1.0966, 1.0968, 1.0964, 1.0966);
  return rows;
}
const detail = (pair: string, low: number, high: number, direction: string) => ({ pair, unifiedZone: { hasZone: true, state: "watching", selectedTF: "1H", zone: { type: "FVG", low, high }, impulse: { direction } } });
function seed(on = true) {
  return new FakeDb({
    bot_configs: [{ user_id: USER, connection_id: null, config_json: config(on) }],
    scan_logs: [{ user_id: USER, created_at: iso(T0 - 10 * 60_000), details_json: [{ __meta: true }, detail("EUR/USD", 1.1000, 1.1010, "bullish"), { pair: "GBP/USD", unifiedZone: { hasZone: false } }] }],
    structure_bars_5m: m5Rows(),
  });
}
const NOW = T0 + 30 * M5 + 61 * 60_000 + 6 * 60_000;   // every bar above is settled (observed 20 min after close; window 60 min + grace)

Deno.test("switch: only config_json.strategy.breakerShadowEnabled === true counts", () => {
  assertEquals([breakerEnabled({ strategy: { breakerShadowEnabled: true } }), breakerEnabled({ strategy: {} }), breakerEnabled(null), breakerEnabled({ strategy: { breakerShadowEnabled: "true" } })], [true, false, false, false]);
});

Deno.test("zones from scan details: Unified zones with bounds and an impulse direction, per pair", () => {
  const z = zonesFromScan([{ __meta: true }, detail("EUR/USD", 1.1, 1.101, "bullish"), detail("USD/JPY", 157.6, 157.8, "bearish"), { pair: "GBP/USD", unifiedZone: { hasZone: false } }],
    T0, (p) => (p === "USD/JPY" ? 0.01 : 0.0001));
  assertEquals(z.map((x) => [x.id, x.dir, x.tf]), [["EUR/USD|long|11000.0|11010.0", "long", "1H"], ["USD/JPY|short|15760.0|15780.0", "short", "1H"]]);
});

Deno.test("zones from scan details: intact only when the scan's price is on the zone's side or inside it", () => {
  const withPrice = (price: number | undefined, dir: string) => ({ ...detail("USD/JPY", 157.653, 157.849, dir), unifiedZone: { ...detail("USD/JPY", 157.653, 157.849, dir).unifiedZone, price: price === undefined ? undefined : { currentPrice: price } } });
  const pipOf = () => 0.01;
  const intact = (d: unknown) => zonesFromScan([d], T0, pipOf)[0].intact;
  assertEquals([intact(withPrice(157.5, "bearish")), intact(withPrice(157.7, "bearish")), intact(withPrice(157.95, "bearish")), intact(withPrice(undefined, "bearish"))],
    [true, true, false, false], "sell zone: below or inside = intact; above (already broken, the 2026-11-03 case) or unknown = not");
});

Deno.test("switch off: nothing is read beyond the config and nothing is written", async () => {
  const db = seed(false);
  assertEquals(await runBreakerShadow(db.client(), NOW), []);
  assertEquals(db.writes.length, 0);
});

Deno.test("run: the zone is seen, flips on the close below it, the limit arm fills on the return and hits the 1.5R target", async () => {
  const db = seed();
  // first run within the pause window: start from a state 6h old is fresh; seed a state so the run covers the path
  db.rows("breaker_shadow_state").push({ user_id: USER, pair: "EUR/USD", seq: 1, as_of: iso(T0 - 20 * 60_000), last_scan_at: iso(T0 - 20 * 60_000), engine_version: "x",
    state: { last5mT: T0 - M5, zones: [], pos: { C: null, L: null }, known: {} } });
  await runBreakerShadow(db.client(), NOW);
  const ev = db.rows("breaker_shadow_events").filter((e) => e.pair === "EUR/USD");
  const kinds = ev.map((e) => `${e.type}:${e.arm}`);
  assert(kinds.includes("seen:-") && kinds.includes("flipped:-") && kinds.includes("filled:L") && kinds.includes("closed:L"), JSON.stringify(kinds));
  const closed = ev.find((e) => e.type === "closed" && e.arm === "L")!.payload as { result: string; gross: number };
  assertEquals([closed.result, closed.gross], ["TP", 1.5]);
  assert(ev.every((e) => e.user_id === USER && String(e.zone_id).startsWith("EUR/USD|long|")));
  assert(!db.writes.some((w) => !["breaker_shadow_events", "breaker_shadow_state"].includes(w.table)), "only breaker tables are written");
  // a repeat run adds nothing
  const n = db.rows("breaker_shadow_events").length;
  await runBreakerShadow(db.client(), NOW);
  assertEquals(db.rows("breaker_shadow_events").length, n);
});

Deno.test("a state older than the pause window starts fresh, and what it still held is closed out as paused", async () => {
  const db = seed();
  const stalePos = { zoneId: "EUR/USD|short|1.0|2.0", dir: "short", fill: 1.2, fillT: T0 - PAUSE_AFTER_MS - 3600_000, sl: 1.21, tp: 1.185, zl: 1.19, zh: 1.2, conf: null };
  db.rows("breaker_shadow_state").push({ user_id: USER, pair: "EUR/USD", seq: 4, as_of: iso(NOW - PAUSE_AFTER_MS - 60_000), last_scan_at: iso(NOW - PAUSE_AFTER_MS - 60_000), engine_version: "x",
    state: { last5mT: NOW - PAUSE_AFTER_MS - 6 * M5, zones: [], pos: { C: null, L: stalePos }, known: {} } });
  await runBreakerShadow(db.client(), NOW);
  const paused = db.rows("breaker_shadow_events").filter((e) => e.type === "cancelled" && (e.payload as { reason: string }).reason === "paused");
  assertEquals(paused.map((e) => [e.zone_id, e.arm]), [[stalePos.zoneId, "L"]]);
  const st = db.rows("breaker_shadow_state").filter((x) => x.pair === "EUR/USD").sort((a, b) => (b.seq as number) - (a.seq as number))[0];
  assertEquals([st.seq, (st.state as { pos: { L: unknown } }).pos.L], [5, null]);
});

Deno.test("scan backlog is capped per run", () => {
  assert(MAX_SCANS_PER_RUN >= 6 && MAX_SCANS_PER_RUN <= 100);
});
