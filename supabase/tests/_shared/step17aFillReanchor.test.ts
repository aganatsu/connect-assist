/**
 * STEP 17-A — Route 2 fill-floor re-anchor, DRY RUN ONLY.
 *
 * Policy: fill → stop ≥ floor → unchanged; below → stop = fill ∓ floor,
 * target = fill ± floor × 1.1, re-sized at 0.5%. A re-anchor that would break
 * the stop cap or the order-geometry R:R gate (or cannot be sized) is rejected,
 * tagged, and the fill keeps its original geometry. Replays all 10 production
 * dry-run fills; pins that the live fill path is untouched.
 */
import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dryRunFillGeometry, reanchorFill, type ReanchorInput } from "../../functions/_shared/route2FillReanchor.ts";
import { MIN_SL_PIPS, SPECS } from "../../functions/_shared/smcAnalysis.ts";

const base = (o: Partial<ReanchorInput>): ReanchorInput => ({
  symbol: "GBP/USD", direction: "long", fillPrice: 1.3216, stop: 1.319745, target: 1.324995,
  floorPips: 25, capPips: 100.6, pipSize: 0.0001, tpRatio: 1.1, orderRRMin: 1.0, commissionPerLot: 0, ...o,
});

Deno.test("floors used are the pair floors: 25 GBP/USD, USD/JPY, CHF/JPY; 20 EUR/USD, NZD/CAD, NZD/CHF", () => {
  assertEquals(["GBP/USD", "USD/JPY", "CHF/JPY", "EUR/USD", "NZD/CAD", "NZD/CHF"].map((p) => MIN_SL_PIPS[p]), [25, 25, 25, 20, 20, 20]);
});

Deno.test("fill → stop ≥ floor: nothing changes (incl. exactly at the floor)", () => {
  const r = reanchorFill(base({ fillPrice: 1.322245 })); // 25.0 pips
  assertEquals(r.status, "not_needed");
  assertEquals(reanchorFill(base({ fillPrice: 1.3230 })).status, "not_needed");
});

Deno.test("long, non-JPY, inside the floor: stop = fill − 25p, target = fill + 27.5p; R:R checked", () => {
  const r = reanchorFill(base({}));
  assert(r.status === "reanchored");
  assertAlmostEquals(r.stop, 1.3191, 1e-9);
  assertAlmostEquals(r.target, 1.32435, 1e-9);
  assertAlmostEquals(r.fillToOriginalStopPips, 18.55, 1e-6);
  assertEquals([r.stopDistancePips, r.floorPips, r.originalStop, r.originalTarget], [25, 25, 1.319745, 1.324995]);
  assertAlmostEquals(r.effectiveRR, 1.04, 1e-9);
});

Deno.test("short, JPY, inside the floor: stop = fill + 25p (0.25), target = fill − 27.5p", () => {
  const r = reanchorFill(base({ symbol: "USD/JPY", direction: "short", fillPrice: 158.21184, stop: 158.45462, target: 157.92962, pipSize: 0.01, capPips: 61.8 }));
  assert(r.status === "reanchored");
  assertAlmostEquals(r.stop, 158.46184, 1e-9);
  assertAlmostEquals(r.target, 157.93684, 1e-9);
  assertAlmostEquals(r.fillToOriginalStopPips, 24.278, 1e-6);
  assertAlmostEquals(r.effectiveRR, 1.06, 1e-9);
});

Deno.test("20-pip pair (EUR/USD) re-anchors to 20 pips with 22p target", () => {
  const r = reanchorFill(base({ symbol: "EUR/USD", fillPrice: 1.1200, stop: 1.1182, target: 1.1224, floorPips: 20, capPips: 60 }));
  assert(r.status === "reanchored");
  assertAlmostEquals(r.stop, 1.1180, 1e-9);
  assertAlmostEquals(r.target, 1.1222, 1e-9);
  assertAlmostEquals(r.effectiveRR, 1.05, 1e-9);
});

Deno.test("rejections keep the original geometry and say why", () => {
  assertEquals((reanchorFill(base({ floorPips: null })) as any).reason, "floor_unknown");
  assertEquals((reanchorFill(base({ fillPrice: 1.3197 })) as any).reason, "fill_through_stop", "long fill below the stop");
  assertEquals((reanchorFill(base({ direction: "short", fillPrice: 1.3240, stop: 1.3235, target: 1.3200 })) as any).reason, "fill_through_stop");
  assertEquals((reanchorFill(base({ capPips: 24 })) as any).reason, "exceeds_stop_cap");
});

Deno.test("order R:R conflict: NZD/CAD (2.5p spread) and NZD/CHF (3.0p) on a 20-pip floor fall below 1.0 → rejected, not forced", () => {
  const nc = reanchorFill(base({ symbol: "NZD/CAD", fillPrice: 0.8030, stop: 0.80115, target: 0.80520, floorPips: 20, capPips: 60 }));
  assertEquals((nc as any).reason, "order_rr_below_min");
  assert((nc as any).detail.includes("0.9750"));
  const nf = reanchorFill(base({ symbol: "NZD/CHF", fillPrice: 0.4700, stop: 0.46815, target: 0.47220, floorPips: 20, capPips: 60 }));
  assertEquals((nf as any).reason, "order_rr_below_min");
  assertEquals([SPECS["NZD/CAD"].typicalSpread, SPECS["NZD/CHF"].typicalSpread], [2.5, 3.0]);
});

Deno.test("CHF/JPY (2.5p spread, 25p floor) sits on the R:R boundary: the same `< orderRRMin` test as placement decides it", () => {
  const r = reanchorFill(base({ symbol: "CHF/JPY", fillPrice: 190.20, stop: 189.97, target: 190.48, pipSize: 0.01, capPips: 66.7 }));
  // effective = 1.1 − 2.5/25 = 1.0 in exact arithmetic; whichever side floating point lands on, the outcome matches orderEffectiveRR + `<`
  assert(r.status === "reanchored" || (r.status === "rejected" && r.reason === "order_rr_below_min"));
  const withCommission = reanchorFill(base({ symbol: "CHF/JPY", fillPrice: 190.20, stop: 189.97, target: 190.48, pipSize: 0.01, capPips: 66.7, commissionPerLot: 7, rateMap: { "USD/JPY": 158, "USD/CHF": 0.8 } }));
  assertEquals((withCommission as any).reason, "order_rr_below_min", "any commission pushes it below");
});

Deno.test("dryRunFillGeometry: re-anchored → new stop/target, re-sized record with the full re-anchor; not-needed / rejected → original, tagged", () => {
  const resized = dryRunFillGeometry({
    input: base({}), baseSizing: { ok: true, lots: 2.69, stopDistance: 0.001855, stopDistancePips: 18.55, insideFloor: true, riskUsdActual: 499 },
    resize: (stop) => ({ ok: true, reason: null, lots: 2.0, stopDistance: Math.abs(1.3216 - stop), riskUsdActual: 499.9 }),
  });
  assertAlmostEquals(resized.stop, 1.3191, 1e-9);
  assertAlmostEquals(resized.sizing.stopDistancePips as number, 25, 1e-6);
  assertEquals([resized.sizing.lots, resized.sizing.insideFloor, resized.record.status, resized.record.riskUsd, resized.record.plannedStop], [2.0, true, "reanchored", 499.9, 1.319745]);

  const notNeeded = dryRunFillGeometry({ input: base({ fillPrice: 1.3230 }), baseSizing: { lots: 1.9 }, resize: () => { throw new Error("must not resize"); } });
  assertEquals([notNeeded.stop, notNeeded.target, notNeeded.sizing.lots, notNeeded.record.status], [1.319745, 1.324995, 1.9, "not_needed"]);

  const failed = dryRunFillGeometry({ input: base({}), baseSizing: { lots: 2.69 }, resize: () => ({ ok: false, reason: "missing FX rate" }) });
  assertEquals([failed.stop, failed.record.status, failed.record.reason, failed.sizing.lots], [1.319745, "rejected", "sizing_unavailable", 2.69]);

  const rr = dryRunFillGeometry({ input: base({ symbol: "NZD/CHF", fillPrice: 0.4700, stop: 0.46815, target: 0.47220, floorPips: 20, capPips: 60 }), baseSizing: { lots: 3 }, resize: () => null });
  assertEquals([rr.stop, rr.target, rr.record.reason], [0.46815, 0.47220, "order_rr_below_min"]);
});

// ── replay: all 10 production dry-run fills (2026-10-06 → 10-08) ───────────
const FILLS: [string, string, "long" | "short", number, number, number, number, number][] = [
  // order, pair, direction, fill, planned stop, planned target, floor, cap
  ["2dee2910", "USD/JPY", "short", 158.21184, 158.45462, 157.92962, 25, 61.8],
  ["77134ab8", "CHF/JPY", "long", 190.1643, 189.892885, 190.417885, 25, 66.7],
  ["02eb7948", "CHF/JPY", "long", 190.18044, 189.821945, 190.346945, 25, 66.7],
  ["bcf0216f", "CHF/JPY", "short", 190.02263, 190.3788776, 189.61221464, 25, 102.6],
  ["4d8eab45", "GBP/USD", "long", 1.32175, 1.319745, 1.324995, 25, 100.6],
  ["896572f4", "GBP/USD", "long", 1.32206, 1.319745, 1.324995, 25, 100.6],
  ["3758fd3a", "GBP/USD", "long", 1.3216, 1.319745, 1.324995, 25, 100.6],
  ["68a11a83", "GBP/USD", "long", 1.32201, 1.31967, 1.3250775, 25, 100.6],
  ["12d67535", "CHF/JPY", "short", 189.97047, 190.4129706, 189.48443334, 25, 134.6],
  ["99d453eb", "USD/JPY", "short", 158.17168, 158.444305, 157.919305, 25, 92.2],
];

Deno.test("replay of the 10 production dry-run fills: 5 re-anchored (+0.72 / 4.95 / 1.85 / 6.45 / 1.60 pips), 5 unchanged, 0 rejected", () => {
  const out: Record<string, string> = {};
  for (const [id, sym, dir, fill, stop, target, floor, cap] of FILLS) {
    const r = reanchorFill({ symbol: sym, direction: dir, fillPrice: fill, stop, target, floorPips: floor, capPips: cap,
      pipSize: SPECS[sym].pipSize, tpRatio: 1.1, orderRRMin: 1.0, commissionPerLot: 0 });
    out[id] = r.status === "reanchored" ? `+${(r.stopDistancePips - r.fillToOriginalStopPips).toFixed(2)}` : r.status;
  }
  assertEquals(out, {
    "2dee2910": "+0.72", "77134ab8": "not_needed", "02eb7948": "not_needed", "bcf0216f": "not_needed",
    "4d8eab45": "+4.95", "896572f4": "+1.85", "3758fd3a": "+6.45", "68a11a83": "+1.60", "12d67535": "not_needed", "99d453eb": "not_needed",
  });
});

// ── wiring ──────────────────────────────────────────────────────────────────
const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const dryBranch = (() => {
  const i = scanner.indexOf("if ((pending as any).dry_run === true) {\n            // Step 17-A");
  return scanner.slice(i, scanner.indexOf("continue;", i));
})();

Deno.test("wiring: the DRY-RUN branch re-anchors and records stop, target, sizing and the re-anchor record", () => {
  assert(dryBranch.length > 0);
  assert(dryBranch.includes("dryRunFillGeometry({"));
  assert(/stop_loss: dryGeo\.stop,\s*take_profit: dryGeo\.target,\s*fill_sizing: dryGeo\.sizing,/.test(dryBranch));
  assert(dryBranch.includes("fillReanchor: dryGeo.record"));
  assert(/floorPips: Number\.isFinite\(fillFloorPips\) \? fillFloorPips : null/.test(dryBranch), "floor from the order's recorded route2Stop.floorPips");
  assert(/tpRatio: config\.tpRatio, orderRRMin: simp\.orderRRMin/.test(dryBranch), "1.1R and the same R:R minimum as placement");
});

Deno.test("wiring: the LIVE fill path is untouched — no re-anchor after the dry-run branch", () => {
  const live = scanner.slice(scanner.indexOf("// Post-reset lock: no fills at all"), scanner.indexOf("// ── ATOMIC FILL (route2_claim_and_fill) ──") > -1 ? scanner.length : scanner.length);
  const claim = live.slice(0, live.indexOf("const claim = await claimRoute2Fill(supabase, {") + 400);
  assert(!/dryGeo|dryRunFillGeometry|reanchorFill/.test(live), "no re-anchor on the live path");
  assert(claim.includes("claimRoute2Fill(supabase, {"));
  assertEquals((scanner.match(/dryRunFillGeometry\(/g) ?? []).length, 1, "called exactly once, in the dry-run branch");
});
