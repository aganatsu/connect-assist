/**
 * STEP 9 — fill-time 0.5% sizing. The function, its edge cases, and the wiring
 * in both pollers. Real case: CHF/JPY 2527bfa5 kept its placement-time 4.47
 * lots, filled at 190.31367 with the stop at 189.860209, and lost 1.21% of the
 * balance at −1R. Fill-time sizing gives the same trade exactly 0.5%.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fillTimeSize } from "../../functions/_shared/fillTimeSizing.ts";
import { LEGACY_SWITCHES, resolveSimplification } from "../../functions/_shared/simplification.ts";

const RATES = { "USD/JPY": 157.98027, "USD/CAD": 1.4246, "USD/CHF": 0.8314 };

Deno.test("EUR/USD: 20-pip stop at $100k → $500 risk = 2.50 lots, exactly 0.5%", () => {
  const s = fillTimeSize({ balance: 100000, riskPercent: 0.5, fillPrice: 1.10000, stop: 1.09800, symbol: "EUR/USD", rateMap: RATES });
  assert(s.ok);
  assertEquals(s.lots, 2.5);
  assert(Math.abs(s.riskPercentActual - 0.5) < 1e-9);
  assertEquals(s.capped, false);
});

Deno.test("the real CHF/JPY 2527bfa5 fill: 4.47 lots risked 1.21%; fill-time gives ≤ 0.5%", () => {
  const s = fillTimeSize({ balance: 105485.18, riskPercent: 0.5, fillPrice: 190.31367, stop: 189.860209, symbol: "CHF/JPY", rateMap: RATES });
  assert(s.ok, s.reason ?? "");
  const perLot = (190.31367 - 189.860209) * 100000 / 157.98027;
  assert(Math.abs(s.perLotRiskUsd - perLot) < 1e-6);
  assert(s.lots < 4.47 / 2, `re-sized to ${s.lots} lots`);
  assert(s.riskPercentActual <= 0.5 + 1e-9 && s.riskPercentActual > 0.49, `actual ${s.riskPercentActual}%`);
  const oldRiskPct = 4.47 * perLot / 105485.18 * 100;
  assert(oldRiskPct > 1.2, `the kept placement size risked ${oldRiskPct.toFixed(2)}%`);
});

Deno.test("rounding is always DOWN — risk never exceeds the target", () => {
  for (const stopPips of [7, 13, 19, 23, 31, 47]) {
    const s = fillTimeSize({ balance: 100000, riskPercent: 0.5, fillPrice: 1.1, stop: 1.1 - stopPips * 0.0001, symbol: "EUR/USD", rateMap: RATES });
    assert(s.ok && s.riskUsdActual <= 500 + 1e-6, `${stopPips} pips → $${s.riskUsdActual}`);
    assert(500 - s.riskUsdActual < s.perLotRiskUsd * 0.01 + 1e-6, "within one 0.01 lot of target");
  }
});

Deno.test("commission is part of the per-lot risk", () => {
  const a = fillTimeSize({ balance: 100000, riskPercent: 0.5, fillPrice: 1.1, stop: 1.098, symbol: "EUR/USD", rateMap: RATES });
  const b = fillTimeSize({ balance: 100000, riskPercent: 0.5, fillPrice: 1.1, stop: 1.098, symbol: "EUR/USD", rateMap: RATES, commissionPerLot: 7 });
  assert(b.lots < a.lots && b.riskUsdActual <= 500);
});

Deno.test("a missing FX rate refuses to size (no silent fallback)", () => {
  const s = fillTimeSize({ balance: 100000, riskPercent: 0.5, fillPrice: 190.3, stop: 189.9, symbol: "CHF/JPY", rateMap: {} });
  assertEquals(s.ok, false);
  assert(s.reason!.includes("USD/JPY"));
  // USD-quoted pairs need no rate.
  assert(fillTimeSize({ balance: 100000, riskPercent: 0.5, fillPrice: 1.33, stop: 1.335, symbol: "GBP/USD", rateMap: {} }).ok);
});

Deno.test("caps are a ceiling applied last and recorded — never hidden", () => {
  // 1-pip stop would need 50 lots; maxLotsPerTrade 20 binds.
  const s = fillTimeSize({ balance: 100000, riskPercent: 0.5, fillPrice: 1.1, stop: 1.0999, symbol: "EUR/USD", rateMap: RATES, maxLotsPerTrade: 20 });
  assert(s.ok && s.capped);
  assertEquals(s.lots, 9.09, "the 10× leverage cap (1M / 110k per lot) binds first");
  assertEquals(s.capReason, "10× notional leverage cap");
  assert(s.riskPercentActual < 0.5, "the record shows the real, lower risk");
  const t = fillTimeSize({ balance: 100000, riskPercent: 0.5, fillPrice: 1.1, stop: 1.0998, symbol: "EUR/USD", rateMap: RATES, maxLotsPerTrade: 5 });
  assertEquals(t.capReason, "maxLotsPerTrade 5");
  assertEquals(t.lots, 5);
});

Deno.test("degenerate inputs fail closed", () => {
  for (const bad of [
    { balance: 0, fillPrice: 1.1, stop: 1.09 }, { balance: 100000, fillPrice: 1.1, stop: 1.1 },
    { balance: 100000, fillPrice: 0, stop: 1.09 }, { balance: 100000, fillPrice: 1.1, stop: 1.09, riskPercent: 0 },
    { balance: 100000, fillPrice: 1.1, stop: 1.09, riskPercent: 9 },
  ]) {
    const s = fillTimeSize({ riskPercent: 0.5, symbol: "EUR/USD", rateMap: RATES, ...bad } as any);
    assertEquals(s.ok, false, JSON.stringify(bad));
    assertEquals(s.lots, 0);
  }
});

Deno.test("sizing switches: legacy by default; fill_time 0.5% only when configured", () => {
  assertEquals(resolveSimplification({}).sizingMode, "legacy");
  assertEquals(LEGACY_SWITCHES.riskPercent, 0.5);
  const s = resolveSimplification({ simplification: { sizingMode: "fill_time", riskPercent: 0.5, maxLotsPerTrade: 20 } });
  assertEquals([s.sizingMode, s.riskPercent, s.maxLotsPerTrade], ["fill_time", 0.5, 20]);
  assertEquals(resolveSimplification({ simplification: { sizingMode: "fill_time", riskPercent: 12 } }).riskPercent, 0.5, "out-of-range risk falls back");
});

// ─── wiring (source) ────────────────────────────────────────────────────────
const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const zcs = Deno.readTextFileSync(new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));

Deno.test("hunt: size computed at the actual fill, before the position row; refuses to fill if unavailable", () => {
  const f = scanner.indexOf("const fillSizing = simp.sizingMode === \"fill_time\"");
  const row = scanner.indexOf("const positionRow = {");
  const claim = scanner.indexOf("const claim = await claimRoute2Fill(supabase, {");
  assert(f > 0 && f < row && row < claim);
  assert(/fillPrice: actualFillPrice, stop: Number\(pending\.stop_loss\)/.test(scanner.slice(f, f + 600)));
  assert(/if \(fillSizing && !fillSizing\.ok\) \{[\s\S]{0,600}continue;/.test(scanner.slice(f, f + 1500)));
  assert(/size: \(fillSizing \? fillSizing\.lots : Number\(pending\.size\)\)\.toString\(\),/.test(scanner));
  assert(/\.\.\.\(fillSizing \? \{ fillSizing \} : \{\}\),/.test(scanner), "the trade records the sizing actually used");
});

Deno.test("dry-run fills record their fill-time sizing", () => {
  const d = scanner.indexOf("if ((pending as any).dry_run === true) {");
  assert(/dry_run_context: \{ \.\.\.\(\(pending as any\)\.dry_run_context \?\? \{\}\), fillSizing, fillPrice: actualFillPrice \}/.test(scanner.slice(d, d + 1500)));
});

Deno.test("placement: planned size under the same rule, no 0.5× cut; the record says planned", () => {
  const p = scanner.indexOf("if (simp.sizingMode === \"fill_time\") {\n            plannedSizing = fillTimeSize({");
  assert(p > 0);
  assert(/if \(plannedSizing\.ok\) limitSize = plannedSizing\.lots;/.test(scanner.slice(p, p + 600)));
  assert(/sizing: plannedSizing \? \{ mode: "fill_time_planned", \.\.\.plannedSizing \} : sizingProvenance/.test(scanner));
});

Deno.test("the fast poller never fills under fill-time sizing", () => {
  const z = zcs.indexOf('?.simplification?.sizingMode === "fill_time") continue;');
  assert(z > 0 && z < zcs.indexOf("claimRoute2Fill(supabase, {"));
});
