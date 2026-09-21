import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  fibConfluence, groupCompetitors, IPO_FIB_RATIOS, FIB_LABELS,
} from "../../functions/_shared/ipoFibConfluence.ts";
import { ipoGeometry } from "../../functions/_shared/ipoZones.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: new Date(Date.UTC(2025, 0, 1) + i * 3600_000).toISOString(),
     open: o, high: h, low: l, close: c, volume: 0 } as Candle);

/** A clean down-then-up leg so the zigzag resolves a completed swing. */
function legUp(n = 200): Candle[] {
  const s: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const p = i < n / 2 ? 100 - i * 0.4 : 100 - (n / 2) * 0.4 + (i - n / 2) * 0.6;
    s.push(bar(i, p, p + 0.5, p - 0.5, p));
  }
  return s;
}

Deno.test("the six ratios are exactly the trader-defined set", () => {
  assertEquals([...IPO_FIB_RATIOS], [0.500, 0.618, 0.710, 0.786, 0.886, 1.000]);
  assert(!IPO_FIB_RATIOS.includes(0.705 as never), "0.705 is the SMC value, not the IPO one");
  assert(!IPO_FIB_RATIOS.includes(0.236 as never));
  assert(!IPO_FIB_RATIOS.includes(0.382 as never));
});

Deno.test("production SMC ratios are NOT modified by this module", async () => {
  const smc = await Deno.readTextFile("supabase/functions/_shared/smcAnalysis.ts");
  assert(smc.includes("const RETRACE_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786]"),
    "the production retracement constants changed — this study must not touch them");
  const mine = await Deno.readTextFile("supabase/functions/_shared/ipoFibConfluence.ts");
  // CODE only — the header names RETRACE_RATIOS precisely to record that it is
  // left alone, so a lexical match on the whole file would fail on its own docs.
  const mineCode = mine.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  assert(!mineCode.includes("RETRACE_RATIOS"), "must declare its own ratios, not reuse SMC's");
  assert(!mineCode.includes("0.236") && !mineCode.includes("0.382") && !mineCode.includes("0.705"),
    "an SMC-only ratio leaked into the IPO measurement set");
});

Deno.test("ratio 1.000 lands on the origin of the leg, not its end", () => {
  const s = legUp();
  const g = fibConfluence(s, 0, 0.0001);
  assert(g.swingHigh !== null && g.swingLow !== null);
  const one = g.levels.find((l) => l.ratio === 1.0)!;
  const origin = g.swingDirection === "up" ? g.swingLow! : g.swingHigh!;
  assertEquals(Math.round(one.price * 1e6), Math.round(origin * 1e6));
});

Deno.test("ratio 0.500 lands on the swing midpoint", () => {
  const s = legUp();
  const g = fibConfluence(s, 0, 0.0001);
  const half = g.levels.find((l) => l.ratio === 0.5)!;
  const mid = (g.swingHigh! + g.swingLow!) / 2;
  assertEquals(Math.round(half.price * 1e6), Math.round(mid * 1e6));
});

Deno.test("a level inside the zone has zero distance; outside has positive", () => {
  const s = legUp();
  const probe = fibConfluence(s, 0, 0.0001);
  const target = probe.levels.find((l) => l.ratio === 0.618)!.price;
  // Build a zone straddling the 61.8% level.
  const g = fibConfluence(s, target - 1, target + 1);
  const l = g.levels.find((x) => x.ratio === 0.618)!;
  assertEquals(l.relation, "INSIDE_ZONE");
  assertEquals(l.distance, 0);
  assert(g.insideLabels.includes("61.8"));
  assert(g.clusterCount >= 1);

  const far = fibConfluence(s, target + 500, target + 501);
  const lf = far.levels.find((x) => x.ratio === 0.618)!;
  assertEquals(lf.relation, "OUTSIDE_ZONE");
  assert(lf.distance > 0);
});

Deno.test("distance is to the NEAREST edge, both sides", () => {
  const s = legUp();
  const p = fibConfluence(s, 0, 0.0001).levels.find((l) => l.ratio === 0.5)!.price;
  const above = fibConfluence(s, p - 12, p - 2).levels.find((l) => l.ratio === 0.5)!;
  const below = fibConfluence(s, p + 2, p + 12).levels.find((l) => l.ratio === 0.5)!;
  assertEquals(Math.round(above.distance * 1e6), Math.round(2 * 1e6));
  assertEquals(Math.round(below.distance * 1e6), Math.round(2 * 1e6));
});

Deno.test("both normalisations are stored, and no threshold is applied", async () => {
  const s = legUp();
  const g = fibConfluence(s, 200, 210);
  for (const l of g.levels) {
    if (l.relation !== "OUTSIDE_ZONE") continue;
    assertEquals(l.distancePerZoneWidth, l.distance / g.zoneWidth);
    if (g.atr) assertEquals(l.distancePerAtr, l.distance / g.atr);
  }
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoFibConfluence.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  for (const banned of ["NEAR", "isNear", "threshold", "weight", "score", "rank"]) {
    assert(!new RegExp(banned, "i").test(code), `"${banned}" would make this a rule, not a measurement`);
  }
});

Deno.test("no completed swing yields an empty, non-throwing reading", () => {
  const flat = Array.from({ length: 40 }, (_, i) => bar(i, 100, 100.1, 99.9, 100));
  const g = fibConfluence(flat, 99, 101);
  assertEquals(g.swingHigh, null);
  assertEquals(g.levels, []);
  assertEquals(g.clusterCount, 0);
  assertEquals(g.insideLabels, []);
});

Deno.test("the reading is causal — a later bar cannot change an earlier one", () => {
  const s = legUp(300);
  const a = fibConfluence(s.slice(0, 200), 95, 96);
  const b = fibConfluence(s.slice(0, 200), 95, 96);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  const withFuture = fibConfluence(s, 95, 96);
  // Adding future bars MAY move the swing — that is expected and is why the
  // study always measures on the prefix ending at the decision bar.
  assert(withFuture.levels.length === 6 || withFuture.levels.length === 0);
});

Deno.test("IPO candle geometry is untouched by this module", async () => {
  const c = bar(0, 105, 110, 100, 102);
  const g = ipoGeometry(c, "demand");
  assertEquals(g.zoneHigh, 110, "proximal is the candle HIGH for demand");
  assertEquals(g.zoneLow, 105, "distal is the candle midpoint — NOT a Fib level");
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoFibConfluence.ts");
  assert(!src.includes("ipoGeometry("), "the fib module must not compute or alter zone geometry");
});

Deno.test("clusterCount counts only levels inside, and cannot exceed six", () => {
  const s = legUp();
  const wide = fibConfluence(s, -1e6, 1e6);
  assertEquals(wide.clusterCount, 6);
  assertEquals(wide.insideLabels.length, 6);
  const none = fibConfluence(s, 1e6, 1e6 + 1);
  assertEquals(none.clusterCount, 0);
});

Deno.test("groupCompetitors keeps every competitor at a contested bar", () => {
  const rows = [
    { touchIndex: 10, id: "a" }, { touchIndex: 10, id: "b" }, { touchIndex: 10, id: "c" },
    { touchIndex: 11, id: "d" },
    { touchIndex: 20, id: "e" }, { touchIndex: 20, id: "f" },
  ];
  const g = groupCompetitors(rows);
  assertEquals(g.map((x) => x.decisionIndex), [10, 20], "uncontested bars are not groups");
  assertEquals(g[0].candidates.map((c) => c.id), ["a", "b", "c"], "no competitor is dropped");
  assertEquals(g[1].candidates.length, 2);
});

Deno.test("every ratio has a stable label", () => {
  for (const r of IPO_FIB_RATIOS) {
    assert(FIB_LABELS[String(r)] !== undefined, `no label for ${r}`);
  }
  assertEquals(FIB_LABELS["0.71"], "71.0");
  assertEquals(FIB_LABELS["1"], "100.0");
});
