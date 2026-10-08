/**
 * STEP 16-C — Route 2 same-level detection with a pip-space tolerance.
 *
 * Replays all 31 superseded orders recorded in production (cancel_reason
 * "entry <new> vs old <old>", 2026-09-28 → 10-07): 14 float-noise cases must
 * now be SAME (refresh in place), 17 genuine moves must stay MOVED (supersede).
 * Plus long/short, JPY/non-JPY, threshold edges, and the scanner wiring:
 * the same-level path keeps the order_id / signal_id, does not touch status,
 * expiry or the hunt state, and moved orders still supersede atomically
 * through route2_place_order.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isSameLevel, isSameLevelPips, levelDistancePips, ROUTE2_SAME_LEVEL_TOLERANCE_PIPS, splitByLevel,
} from "../../functions/_shared/route2SameLevel.ts";
import { SPECS } from "../../functions/_shared/smcAnalysis.ts";

// [order_id, symbol, created_at, old entry, new entry] — verbatim from production cancel_reason.
const HISTORY: [string, string, string, string, string][] = [
  ["a19e5654", "ETH/USD", "2026-09-28T01:25", "2691.72", "2691.7200000000003"],
  ["2dd15a3b", "NZD/CAD", "2026-09-28T09:05", "0.8029075", "0.8029074999999999"],
  ["e37d0c95", "NZD/CAD", "2026-09-28T09:15", "0.8029075", "0.8029074999999999"],
  ["960d8950", "NZD/CAD", "2026-09-28T09:25", "0.8029075", "0.8029074999999999"],
  ["65327f16", "NZD/CAD", "2026-09-28T09:35", "0.8029075", "0.8029074999999999"],
  ["b64d4d7b", "NZD/CAD", "2026-09-29T21:16", "0.80129", "0.8020575"],
  ["46b23c49", "NZD/CAD", "2026-09-30T00:36", "0.8020575", "0.80165"],
  ["0756f0ce", "GBP/USD", "2026-10-02T15:10", "1.3255765", "1.3254750000000002"],
  ["673fe912", "GBP/USD", "2026-10-02T15:20", "1.325475", "1.324615"],
  ["355db575", "GBP/USD", "2026-10-02T15:30", "1.324615", "1.3254750000000002"],
  ["06b2e9a0", "ETH/USD", "2026-10-04T13:10", "2689.75", "2686.75"],
  ["d96bbe72", "CHF/JPY", "2026-10-05T00:10", "190.0661275", "190.13662"],
  ["bf59d8df", "ETH/USD", "2026-10-05T02:20", "2723.62", "2710.74"],
  ["3953e19f", "USD/JPY", "2026-10-05T02:41", "158.040745", "158.04074500000002"],
  ["40a1d013", "ETH/USD", "2026-10-05T05:30", "2704.9375", "2706.47"],
  ["61a4c071", "CHF/JPY", "2026-10-05T05:51", "190.13662", "190.08862"],
  ["cf790940", "CHF/JPY", "2026-10-05T08:00", "190.08862", "190.23446975000002"],
  ["4961b60d", "CHF/JPY", "2026-10-05T08:41", "190.23446975", "190.23446975000002"],
  ["4edc5a15", "CHF/JPY", "2026-10-05T08:51", "190.23446975", "190.23446975000002"],
  ["d2f3a817", "CHF/JPY", "2026-10-05T09:11", "190.23446975", "190.23446975000002"],
  ["02053dd6", "CHF/JPY", "2026-10-05T09:51", "190.23446975", "190.23446975000002"],
  ["32f771a5", "CHF/JPY", "2026-10-05T10:11", "190.23446975", "190.23446975000002"],
  ["84933d58", "CHF/JPY", "2026-10-05T10:41", "190.23446975", "190.23446975000002"],
  ["049b24a8", "GBP/USD", "2026-10-05T13:20", "1.321785", "1.3217850000000002"],
  ["ce5d223c", "GBP/USD", "2026-10-05T13:30", "1.321785", "1.3209"],
  ["963ba45a", "ETH/USD", "2026-10-05T21:50", "2704.63325", "2705"],
  ["f2c84349", "ETH/USD", "2026-10-06T01:40", "2705", "2704.9375"],
  ["51ac38ad", "EUR/USD", "2026-10-06T14:20", "1.12577", "1.12594"],
  ["8d774ccc", "BTC/USD", "2026-10-06T15:50", "86189.64725", "86118.17"],
  ["d11627e7", "CHF/JPY", "2026-10-06T23:50", "190.099305", "190.09930500000002"],
  ["b25f637f", "CHF/JPY", "2026-10-07T00:00", "190.099305", "190.142885"],
];
const NOISE = new Set(["a19e5654", "2dd15a3b", "e37d0c95", "960d8950", "65327f16", "3953e19f", "4961b60d", "4edc5a15",
  "d2f3a817", "02053dd6", "32f771a5", "84933d58", "049b24a8", "d11627e7"]);
const pip = (s: string) => SPECS[s].pipSize;

Deno.test("history: all 31 production supersedes replay — 14 float-noise → same level, 17 genuine → moved", () => {
  assertEquals(HISTORY.length, 31);
  assertEquals(NOISE.size, 14);
  const wrong: string[] = [];
  for (const [id, sym, , oldP, newP] of HISTORY) {
    const same = isSameLevel(Number(oldP), Number(newP), pip(sym));
    if (same !== NOISE.has(id)) wrong.push(`${id} ${sym} ${oldP}→${newP} same=${same}`);
  }
  assertEquals(wrong, []);
  // the old exact comparison called every one of the 31 "moved"
  assertEquals(HISTORY.filter(([, , , o, n]) => Number(o) === Number(n)).length, 0);
});

Deno.test("history: noise ≤ 4.5e-13 in price; smallest genuine move 1.015 pips sits ≥ 1000× above the tolerance", () => {
  const noise = HISTORY.filter(([id]) => NOISE.has(id)).map(([, s, , o, n]) => ({ abs: Math.abs(Number(o) - Number(n)), pips: levelDistancePips(Number(o), Number(n), pip(s)) }));
  const real = HISTORY.filter(([id]) => !NOISE.has(id)).map(([id, s, , o, n]) => ({ id, pips: levelDistancePips(Number(o), Number(n), pip(s)) }));
  assert(Math.max(...noise.map((x) => x.abs)) <= 4.6e-13, "noise in price units");
  assert(Math.max(...noise.map((x) => x.pips)) < ROUTE2_SAME_LEVEL_TOLERANCE_PIPS / 1e4, "noise ≥ 4 orders of magnitude below the tolerance");
  const smallest = real.reduce((a, b) => (b.pips < a.pips ? b : a));
  assertEquals(smallest.id, "0756f0ce");
  assertEquals(Math.round(smallest.pips * 1000) / 1000, 1.015);
  assert(smallest.pips >= ROUTE2_SAME_LEVEL_TOLERANCE_PIPS * 1000, "smallest genuine move ≥ 1000× the tolerance");
  assertEquals(ROUTE2_SAME_LEVEL_TOLERANCE_PIPS, 0.001);
});

Deno.test("threshold edges in pip space: just below and exactly at → same; just above → moved", () => {
  assertEquals(isSameLevelPips(0.000999), true);
  assertEquals(isSameLevelPips(0.001), true, "inclusive at the tolerance");
  assertEquals(isSameLevelPips(0.001001), false);
  assertEquals(isSameLevelPips(0), true);
});

Deno.test("threshold edges in price space — non-JPY (pip 0.0001) and JPY (pip 0.01), both directions of move", () => {
  for (const [sym, base] of [["EUR/USD", 1.12577], ["GBP/USD", 1.32175], ["USD/JPY", 158.04074], ["CHF/JPY", 190.23447]] as const) {
    const p = pip(sym);
    for (const sign of [1, -1]) {
      assertEquals(isSameLevel(base, base + sign * 0.0009 * p, p), true, `${sym} 0.0009 pip ${sign > 0 ? "up" : "down"}`);
      assertEquals(isSameLevel(base, base + sign * 0.0011 * p, p), false, `${sym} 0.0011 pip ${sign > 0 ? "up" : "down"}`);
      assertEquals(isSameLevel(base, base + sign * 0.1 * p, p), false, `${sym} 0.1 pip`);
      assertEquals(isSameLevel(base, base + sign * 1 * p, p), false, `${sym} 1 pip`);
    }
  }
  // the same price gap is 100× more pips on a non-JPY pair: compared in PIP space, not price units
  assertEquals(isSameLevel(150, 150.000005, 0.01), true, "JPY: 0.0005 pip");
  assertEquals(isSameLevel(1.5, 1.500005, 0.0001), false, "non-JPY: 0.05 pip");
});

Deno.test("long and short orders split the same way (the level comparison is direction-independent)", () => {
  for (const direction of ["long", "short"] as const) {
    const orders = [
      { order_id: "n", direction, entry_price: "0.8029075" },             // stored NUMERIC comes back as a string
      { order_id: "m", direction, entry_price: 0.80129 },
    ];
    const r = splitByLevel(orders, 0.8029074999999999, pip("NZD/CAD"));
    assertEquals(r.same.map((o) => o.order_id), ["n"], direction);
    assertEquals(r.moved.map((o) => o.order_id), ["m"], direction);
  }
});

Deno.test("invalid inputs never count as the same level (fail toward supersede, the old behaviour)", () => {
  assertEquals(isSameLevel(NaN, 1.1, 0.0001), false);
  assertEquals(isSameLevel(1.1, 1.1, 0), false);
  assertEquals(isSameLevel(1.1, Infinity, 0.0001), false);
  assertEquals(splitByLevel([{ entry_price: null }], 1.1, 0.0001).moved.length, 1);
});

// ── scanner wiring ──────────────────────────────────────────────────────────

const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const sameBlock = (() => {
  const i = scanner.indexOf("if (samePriceOrders.length > 0) {");
  return scanner.slice(i, scanner.indexOf("// Superseded orders are cancelled INSIDE route2_place_order", i));
})();
const code = (s: string) => s.replace(/\/\/.*$/gm, "");

Deno.test("wiring: the scanner uses splitByLevel with the pair's pip size; no exact price equality remains", () => {
  assert(scanner.includes('import { splitByLevel } from "../_shared/route2SameLevel.ts";'));
  assert(/const \{ same: samePriceOrders, moved: movedOrders \} =\s*splitByLevel<any>\(stalePending \?\? \[\], limitEntry\.price, spec\.pipSize\);/.test(scanner));
  assert(!/Number\(s\.entry_price\) [!=]== Number\(limitEntry\.price\)/.test(scanner), "the exact comparison is gone");
});

Deno.test("same level: refreshed in place — same order_id and signal_id, no status/expiry/hunt-state change, no insert", () => {
  const c = code(sameBlock);
  assert(/\.update\(\{\s*signal_score: analysis\.score,\s*current_price: analysis\.lastPrice,\s*stop_loss: limitSL,\s*take_profit: limitTP,\s*size: limitSize,\s*\}\)/.test(c),
    "the refresh writes exactly score, price, stop, target, size");
  assert(/\.in\("order_id", samePriceOrders\.map/.test(c), "updates the existing order_id(s)");
  const payload = c.slice(c.indexOf(".update({"), c.indexOf("})", c.indexOf(".update({")) + 2);
  for (const f of ["expires_at", "status", "signal_id", "order_id", "confirmation_", "zone_touch_time", "reset_reason", "placed_at", "entry_price"]) {
    assert(!payload.includes(f), `the refresh payload must not write ${f}`);
  }
  assert(!/\.insert\(|\.rpc\(|placeRoute2Order\(/.test(c), "the same-level block places nothing");
  assert(/cap\.signal_id = samePriceOrders\[0\]\?\.signal_id \?\? null;/.test(c), "the decision links to the EXISTING signal_id (none minted)");
  const after = scanner.slice(scanner.indexOf('action: "refreshed_in_place"'), scanner.indexOf("await placeRoute2Order(supabase,"));
  assert(/continue;/.test(after), "no placement (no new order, no new signal_id) on the same-level path");
});

Deno.test("moved level: still superseded atomically inside route2_place_order (same transaction as the new order)", () => {
  assert(/const supersede = movedOrders\.map\(\(s: any\) => \(\{\s*order_id: s\.order_id as string,/.test(scanner));
  assert(scanner.includes("placeRoute2Order(supabase, { attribution: route2Attribution, order: route2OrderRow, supersede })"));
  const sql = Deno.readTextFileSync(new URL("../../migrations/20261008010000_step15_pr2_attribution_lifecycle.sql", import.meta.url));
  assert(/SET status = 'cancelled', terminal_reason = 'CANCELLED_SUPERSEDED', resolved_at = now\(\)/.test(sql), "cancel inside the RPC");
});
