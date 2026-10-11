import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import { baseScenario, build, ny, type Scenario } from "./helpers/scenario.ts";
import { P } from "./helpers/series.ts";
import { buildStore } from "../../functions/_shared/v2/barStore.ts";
import { buildStructure } from "../../functions/_shared/v2/v2Structure.ts";
import { selectTarget } from "../../functions/_shared/v2/v2Target.ts";
import type { Poi } from "../../functions/_shared/v2/v2Poi.ts";

function run(mod: (s: Scenario) => void = () => {}, extra: { alive?: Poi[]; unknown?: Poi[]; entry?: number; at?: number } = {}) {
  const sc = baseScenario(); mod(sc);
  const st = buildStore(build(sc));
  const s5 = st.series[sc.pair]["5m"], s1h = st.series[sc.pair]["1h"];
  const at = extra.at ?? ny(15, 3, 0);
  const k = st.index["5m"].get(at)!;
  const m = sc.mirror ? -1 : 1;
  return selectTarget({
    dir: sc.mirror ? "SHORT" : "LONG", entry: extra.entry ?? P(4.5 * m), t: at + 300_000, k, s5, s1h, ix1h: buildStructure(s1h),
    opposingAlive: extra.alive ?? [], opposingUnknown: extra.unknown ?? [],
  });
}
const poi = (low: number, high: number, dir: "LONG" | "SHORT" = "SHORT"): Poi => ({
  id: `opp${low}`, pair: "EUR/USD", dir, type: "OB", low: P(low), high: P(high), formationTime: 0, legId: "x", o: 0, b: 0, originTime: 0, bTime: 0, bClose: 0,
});

clause(["7.1", "7.2", "7.3", "7.5"], "scenario: j (10) swept by the spike, swing 20 valid, prev-day 30 valid, Asian 2.5 below entry → TP 20; mirror", () => {
  const r = run();
  assertEquals(r.selected, P(20));
  assertEquals(r.observabilityFail, null);
  const byPrice = Object.fromEntries(r.candidates.map((c) => [`${c.type}@${c.price}`, c.state]));
  assertEquals(byPrice[`SWING@${P(10)}`], "SWEPT");
  assertEquals(byPrice[`SWING@${P(20)}`], "VALID");
  assertEquals(byPrice[`PREV_DAY@${P(30)}`], "VALID");
  assert(!r.candidates.some((c) => c.type === "ASIAN"));       // Asian high 2.5 < entry 4.5
  assertEquals(run((s) => { s.mirror = true; }).selected, P(-20));
});

clause(["7.2", "7.3"], "unswept is strict: a 5m high equal to the level does not sweep it; nearest valid level selected", () => {
  const r = run((s) => { s.m5.set(ny(14, 16, 30), [2, 10, 1.5, 2]); });   // spike exactly to j (10)
  assertEquals(r.selected, P(10));
  const r2 = run((s) => { s.m5.set(ny(14, 16, 30), [2, 10.1, 1.5, 2]); });
  assertEquals(r2.selected, P(10.1));                          // j swept; the spike makes the previous-day high 10.1
});

clause(["7.1", "7.3"], "identical prices from independent types form one level, valid if one is valid", () => {
  // prev-day high set exactly to 20 (the swing level) via the spike; both valid → one level 20
  const r = run((s) => { s.m5.set(ny(14, 16, 30), [2, 20, 1.5, 2]); });
  assertEquals(r.selected, P(20));
  assertEquals(r.candidates.filter((c) => c.price === P(20)).length, 2);
});

clause(["7.4", "AM1"], "opposing POI near edge strictly between entry and S becomes S (nearest of several); edge = S does not", () => {
  assertEquals(run(() => {}, { alive: [poi(15, 18), poi(12, 14)] }).selected, P(12));
  assertEquals(run(() => {}, { alive: [poi(20, 22)] }).selected, P(20));
  assertEquals(run(() => {}, { alive: [poi(4.5, 6)] }).selected, P(20));     // edge = entry is not strictly between
  const m = run((s) => { s.mirror = true; }, { alive: [poi(-18, -15, "LONG")] });
  assertEquals(m.selected, P(-15));
});

clause(["7.1", "7.6", "1.3"], "a MISSING 5m bar in a swing's sweep interval → UNKNOWN; between entry and S → DATA_GAP_ENTRY; beyond S → harmless", () => {
  // gap after swing 31 (01:00 NY) but before k: swing 20 UNKNOWN; prev-day 30 also crosses the gap → no valid level
  const r = run((s) => { s.missing.push({ tf: "5m", t: ny(15, 1, 30) }); });
  assertEquals(r.selected, null);
  assertMatch(r.observabilityFail!, /unknown SWING/);
  // GT: gap before swing 31's close; j (10) was swept by the spike BEFORE the gap → stays SWEPT; prev-day 30 UNKNOWN beyond S → passes
  const r2 = run((s) => { s.missing.push({ tf: "5m", t: ny(14, 18, 0) }); });
  assertEquals(r2.candidates.find((c) => c.price === P(10))!.state, "SWEPT");
  assertEquals([r2.selected, r2.observabilityFail], [P(20), null]);
  // GT: without the spike j is valid at the gap → UNKNOWN → between entry and S → fails
  const r2b = run((s) => { s.m5.delete(ny(14, 16, 30)); s.missing.push({ tf: "5m", t: ny(14, 18, 0) }); });
  assertMatch(r2b.observabilityFail!, /unknown SWING 1h@2026-09-14T19/);
  // GT: a trade-through observed after the gap makes the level SWEPT (a sweep is permanent)
  const r2c = run((s) => { s.m5.delete(ny(14, 16, 30)); s.missing.push({ tf: "5m", t: ny(14, 18, 0) }); s.m5.set(ny(14, 19, 0), [2, 11, 1.5, 2]); });
  assertEquals(r2c.candidates.find((c) => c.price === P(10))!.state, "SWEPT");
  // with entry 12 (above j): swing 20 KNOWN, prev-day 30 UNKNOWN but beyond S = 20 → harmless
  const r3 = run((s) => { s.missing.push({ tf: "5m", t: ny(14, 18, 0) }); }, { entry: P(12) });
  assertEquals([r3.selected, r3.observabilityFail], [P(20), null]);
});

clause(["7.6", "AM2", "GT"], "AM2+GT: after a 1H gap a valid pre-gap swing keeps its price, is UNKNOWN, never selected, blocks a jump; a swept one stays SWEPT", () => {
  // 1H gap (Tue 09:00 NY) → current 1H segment starts after it; decision at 10:30 NY; no CHoCH/TP bars so swing 20 is unswept at the gap
  const noTrade = (s: Scenario) => { s.m5.delete(ny(15, 3, 0)); s.m5.delete(ny(15, 3, 5)); };
  const r = run((s) => {
    noTrade(s);
    s.missing.push({ tf: "1h", t: Date.parse("2026-09-15T13:00:00Z") });
    s.m5.set(ny(15, 10, 30), [2, 3, 1.5, 2]);
  }, { at: ny(15, 10, 30) });
  assertEquals(r.candidates.find((c) => c.price === P(10))!.state, "SWEPT");     // j swept by the spike before the gap
  const sw20 = r.candidates.find((c) => c.price === P(20))!;
  assertEquals(sw20.state, "UNKNOWN");
  assertEquals(r.selected, P(30));                                // prev-day 30 is the only valid level
  assertMatch(r.observabilityFail!, /unknown SWING .* between entry and target/);
  // the same pre-gap swing traded through after the gap (09:30 NY high 21) → SWEPT, no longer an obstacle
  const r2 = run((s) => {
    noTrade(s);
    s.missing.push({ tf: "1h", t: Date.parse("2026-09-15T13:00:00Z") });
    s.m5.set(ny(15, 9, 30), [2, 21, 1.5, 2]);
  }, { at: ny(15, 10, 30) });
  assertEquals(r2.candidates.find((c) => c.price === P(20))!.state, "SWEPT");
});

clause(["7.1", "7.6"], "previous-day level with a MISSING defining bar has an unknown price → always DATA_GAP_ENTRY", () => {
  const r = run((s) => { s.missing.push({ tf: "5m", t: ny(14, 9, 0) }); });
  assertMatch(r.observabilityFail!, /PREV_DAY .* price unknown/);
});

clause(["7.6"], "unknown-state opposing POI containing entry or with its near edge between entry and S → DATA_GAP_ENTRY", () => {
  assertMatch(run(() => {}, { unknown: [poi(4, 6)] }).observabilityFail!, /unknown-state opposing/);
  assertMatch(run(() => {}, { unknown: [poi(12, 14)] }).observabilityFail!, /unknown-state opposing/);
  assertEquals(run(() => {}, { unknown: [poi(22, 24)] }).observabilityFail, null);
});

clause(["7.1", "7.6"], "no valid level: NO_TARGET path (selected null); an UNKNOWN level beyond entry with no S → DATA_GAP_ENTRY", () => {
  const r = run((s) => { s.m5.set(ny(15, 2, 55), [1, 31, -0.5, 1.5]); });   // sweeps 10, 20 and 30
  assertEquals([r.selected, r.observabilityFail], [null, null]);
});

clause(["7.1", "0.8"], "Asian level counts once 02:00 has passed (t ≥ 02:00 of the end date)", () => {
  // raise the Asian bars to 6 so the Asian high (6) is above entry 4.5 and valid
  const at = ny(15, 3, 0);
  const r = run((s) => { s.m5.set(ny(15, 1, 0), [2, 6, 1.5, 2]); }, { at });
  assertEquals(r.selected, P(6));
  const early = run((s) => { s.m5.set(ny(15, 1, 0), [2, 6, 1.5, 2]); }, { at: ny(15, 1, 50) });   // t = 01:55 < 02:00
  assert(!early.candidates.some((c) => c.type === "ASIAN"));
  const edge = run((s) => { s.m5.set(ny(15, 1, 0), [2, 6, 1.5, 2]); }, { at: ny(15, 1, 55) });    // t = 02:00 exactly
  assert(edge.candidates.some((c) => c.type === "ASIAN"));
});
