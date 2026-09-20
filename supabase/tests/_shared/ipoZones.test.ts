import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  barInRange,
  detectIPOZones,
  ipoGeometry,
  refineIPOToLowerTimeframe,
  selectIPOCandle,
  trackIPOLifecycle,
  assessConsolidation,
  detectIPOCandidates,
  traceDepartureOriginHypotheses,
  originHypothesisBackground,
  confirmedSwings,
  uniqueBreakEvents,
  findFirstRelevantConfirmation,
  traceEventLocalRecovery,
  buildIPOHierarchy,
  resolveParentLineage,
} from "../../functions/_shared/ipoZones.ts";
import { analyzeMarketStructureCanonical, calculateATR, detectLiquidityPools } from "../../functions/_shared/smcAnalysis.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * IPO zones — shadow only.
 *
 * These tests concentrate on the three semantic corrections, because each one
 * is a place where an existing function has the right NAME and the wrong
 * BEHAVIOUR, and reusing it would have been silently wrong:
 *
 *   1. invalidation   a SINGLE close fully beyond extent; wicks never
 *                     invalidate; no consecutive-close requirement
 *   2. test counting  one distinct VISIT, not one per bar inside. The existing
 *                     ob.touches increments per bar
 *                     (structuralOrderBlocks.ts:385)
 *   3. flip           gated on BROKEN. Legacy "mitigated" must not decide it
 */

let t = 0;
function candle(o: number, h: number, l: number, c: number): Candle {
  const dt = new Date(Date.UTC(2026, 0, 1 + t++)).toISOString().slice(0, 19);
  return { datetime: dt, open: o, high: h, low: l, close: c } as Candle;
}
const reset = () => { t = 0; };

// ─── geometry ────────────────────────────────────────────────────────────────

Deno.test("geometry is the frozen single-candle proximal half", () => {
  reset();
  const c = candle(10, 12, 8, 9);   // range 8..12, midpoint 10
  const d = ipoGeometry(c, "demand");
  assertEquals(d.proximal, 12, "demand proximal is the HIGH");
  assertEquals(d.extent, 8, "demand extent is the LOW");
  assertEquals(d.distal, 10, "distal is the midpoint of the full wick range");
  assertEquals([d.zoneLow, d.zoneHigh], [10, 12], "demand zone is [distal, proximal]");

  const s = ipoGeometry(c, "supply");
  assertEquals(s.proximal, 8, "supply proximal is the LOW");
  assertEquals(s.extent, 12, "supply extent is the HIGH");
  assertEquals([s.zoneLow, s.zoneHigh], [8, 10], "supply zone is [proximal, distal]");

  // extent is never a zone boundary — the zone is half the candle, not all of it
  assert(d.zoneLow > d.extent, "demand zone must not reach down to extent");
  assert(s.zoneHigh < s.extent, "supply zone must not reach up to extent");
});

Deno.test("barInRange is inclusive overlap, not containment", () => {
  reset();
  assert(barInRange(candle(5, 11, 4, 6), 10, 12), "a bar whose high pokes into the zone counts");
  assert(!barInRange(candle(5, 9, 4, 6), 10, 12), "a bar entirely below does not");
});

// ─── correction 1: invalidation ──────────────────────────────────────────────

Deno.test("a WICK through extent does not invalidate", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);
  const bars = [
    ipo,
    candle(9, 9.5, 7.0, 9.2),   // wick to 7.0, well below extent 8, closes back above
    candle(9.2, 10, 9, 9.8),
  ];
  const lc = trackIPOLifecycle(bars, 0, "demand", ipoGeometry(ipo, "demand"));
  assertEquals(lc.brokenAtIndex, null, "a wick below extent must not break the zone");
  assert(lc.status !== "BROKEN");
});

Deno.test("a SINGLE full close beyond extent invalidates immediately", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);
  const bars = [ipo, candle(9, 9.5, 7.2, 7.5), candle(7.5, 8, 7, 7.2)];
  const lc = trackIPOLifecycle(bars, 0, "demand", ipoGeometry(ipo, "demand"));
  assertEquals(lc.brokenAtIndex, 1, "one close below extent is enough");
  assertEquals(lc.status, "BROKEN");
  // The existing V2 rule requires TWO consecutive body closes. If this ever
  // starts needing a second bar, the wrong lifecycle has been wired in.
});

Deno.test("supply invalidates on a close above extent, not below", () => {
  reset();
  const ipo = candle(9, 12, 8, 11);          // supply: extent = 12
  const bars = [ipo, candle(11, 13, 10.5, 12.5)];
  const lc = trackIPOLifecycle(bars, 0, "supply", ipoGeometry(ipo, "supply"));
  assertEquals(lc.brokenAtIndex, 1);
  assertEquals(lc.status, "BROKEN");
});

// ─── correction 2: distinct-visit test counting ──────────────────────────────

Deno.test("three bars inside the zone is ONE test, not three", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);          // demand zone [10, 12]
  const bars = [
    ipo,
    candle(9, 13.5, 8.9, 13.2),              // DEPARTS upward, fully above zone
    candle(13.2, 14, 12.6, 13.6),            // still away (arms the zone)
    candle(13.6, 13.8, 10.9, 11.2),          // RETURNS — enters the zone
    candle(11.2, 11.5, 10.2, 11),            // still inside  (bar 2 of the visit)
    candle(11, 11.8, 10.4, 10.8),            // still inside  (bar 3)
    candle(10.8, 13.4, 12.5, 13.2),          // exits — FULLY above the zone
  ];
  const lc = trackIPOLifecycle(bars, 0, "demand", ipoGeometry(ipo, "demand"));
  assertEquals(lc.testCount, 1, "three consecutive bars inside is a single visit");
  assertEquals(lc.tests[0].barsInside, 3, "but the bar count is still reported");
  assertEquals(lc.status, "TESTED");
});

Deno.test("leaving and re-entering counts a second distinct test", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);
  const bars = [
    ipo,
    candle(9, 13.5, 8.9, 13.2),              // rallies away
    candle(13.2, 14, 12.6, 13.6),            // fully above -> ARMED
    candle(13.6, 13.8, 10.9, 11.1),          // visit 1 in
    candle(11.1, 13.4, 12.5, 13.2),          // out (fully above)
    candle(13.2, 13.5, 10.8, 11.0),          // visit 2 in
    candle(11.0, 13.3, 12.5, 13.1),          // out
  ];
  const lc = trackIPOLifecycle(bars, 0, "demand", ipoGeometry(ipo, "demand"));
  assertEquals(lc.testCount, 2);
  assert(lc.tests[0].entryIndex < lc.tests[1].entryIndex);
});

Deno.test("repeated tests do not invalidate the zone", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);
  const bars: Candle[] = [ipo];
  bars.push(candle(9, 13.5, 8.9, 13.2));        // rallies away
  bars.push(candle(13.2, 14, 12.6, 13.6));      // fully above -> ARMED
  for (let k = 0; k < 5; k++) {
    bars.push(candle(13.6, 13.8, 10.9, 11.1));  // inside
    bars.push(candle(11.1, 13.4, 12.5, 13.2));  // back out, fully above
  }
  const lc = trackIPOLifecycle(bars, 0, "demand", ipoGeometry(ipo, "demand"));
  assertEquals(lc.testCount, 5);
  assertEquals(lc.brokenAtIndex, null, "five tests must not break the zone");
  assertEquals(lc.status, "TESTED");
});

// ─── correction 3: flip gated on BROKEN ──────────────────────────────────────

Deno.test("no flip retest is recorded before the zone is BROKEN", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);
  const bars = [
    ipo,
    candle(9, 13.5, 8.9, 13.2),              // rallies away
    candle(13.2, 14, 12.6, 13.6),            // fully above -> ARMED
    candle(13.6, 13.8, 10.9, 11.1),          // a normal test, zone still valid
    candle(11.1, 13.4, 12.5, 13.2),
  ];
  const lc = trackIPOLifecycle(bars, 0, "demand", ipoGeometry(ipo, "demand"));
  assertEquals(lc.flipRetestCount, 0, "a test of a live zone is not a flip retest");
  assertEquals(lc.testCount, 1);
});

Deno.test("after a full break, re-entry is a FLIP retest and not a test", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);          // demand, extent 8, zone [10,12]
  const bars = [
    ipo,
    candle(9, 9.5, 7.2, 7.5),                // closes below extent -> BROKEN
    candle(7.5, 8.5, 7.3, 8.2),              // still outside the zone
    candle(8.2, 11, 8.1, 10.6),              // re-enters the old zone from BELOW
    candle(10.6, 10.8, 9.4, 9.6),            // leaves again
  ];
  const lc = trackIPOLifecycle(bars, 0, "demand", ipoGeometry(ipo, "demand"));
  assertEquals(lc.brokenAtIndex, 1);
  assertEquals(lc.testCount, 0, "nothing entered the zone before it broke");
  assertEquals(lc.flipRetestCount, 1, "broken demand retested from below is a flip");
  assertEquals(lc.status, "FLIPPED");
});

// ─── candle selection ────────────────────────────────────────────────────────

Deno.test("selects the last opposite-coloured candle before the move", () => {
  reset();
  const bars = [
    candle(10, 10.5, 9.5, 10.2),   // 0 up
    candle(10.2, 10.4, 9.0, 9.2),  // 1 DOWN  <- expected demand IPO
    candle(9.2, 11, 9.1, 10.9),    // 2 up, the move begins
  ];
  const sel = selectIPOCandle(bars, 2, "demand");
  assert(sel, "a selection was made");
  assertEquals(sel!.index, 1);
  assertEquals(sel!.interveningSkipped, 0);
});

Deno.test("tolerates a bounded number of SMALL intervening candles", () => {
  reset();
  const bars = [
    candle(10, 10.5, 9.5, 10.2),
    candle(10.2, 10.4, 9.0, 9.2),   // 1 DOWN  <- the IPO
    candle(9.2, 9.3, 9.15, 9.25),   // 2 tiny up
    candle(9.25, 9.35, 9.2, 9.3),   // 3 tiny up
    candle(9.3, 12, 9.25, 11.8),    // 4 the move
  ];
  const sel = selectIPOCandle(bars, 4, "demand");
  assert(sel, "small intervening candles are skipped");
  assertEquals(sel!.index, 1);
  // the departure bar itself is exempt, so only the two tiny candles are charged
  assertEquals(sel!.interveningSkipped, 2);
});

Deno.test("a LARGE intervening candle terminates the walk", () => {
  reset();
  const bars = [
    candle(10, 10.5, 9.5, 10.2),
    candle(10.2, 10.4, 9.0, 9.2),   // would-be IPO
    candle(9.2, 9.4, 9.1, 9.3),
    candle(9.3, 9.5, 9.2, 9.4),
    candle(9.4, 9.6, 9.3, 9.5),
    candle(9.5, 9.7, 9.4, 9.6),
    candle(9.6, 14, 9.5, 13.8),     // a full-bodied move candle
    candle(13.8, 15, 13.7, 14.8),
  ];
  // Walking back from index 7, the big candle at 6 is in the move's own
  // direction and is not small, so the walk must stop rather than reach past it.
  const sel = selectIPOCandle(bars, 7, "demand", { maxIntervening: 2 });
  assertEquals(sel, null, "an unbounded walk would have claimed candle 1 as the IPO");
});

// ─── detector wiring ─────────────────────────────────────────────────────────

function trendingSeries(): Candle[] {
  reset();
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 30; i++) { out.push(candle(p, p + 0.6, p - 0.6, p + 0.1)); p += 0.1; }
  for (let i = 0; i < 6; i++) { const o = p; p -= 1.2; out.push(candle(o, o + 0.2, p - 0.2, p)); }
  out.push(candle(p, p + 0.2, p - 1.4, p - 1.2)); p -= 1.2;   // pronounced low
  for (let i = 0; i < 12; i++) { const o = p; p += 1.6; out.push(candle(o, p + 0.3, o - 0.3, p)); }
  for (let i = 0; i < 12; i++) { const o = p; p += 0.4; out.push(candle(o, p + 0.2, o - 0.2, p)); }
  return out;
}

Deno.test("detectIPOZones produces internally consistent zones", () => {
  const series = trendingSeries();
  const zones = detectIPOZones(series, { symbol: "TEST", timeframe: "1d" });
  for (const z of zones) {
    const c = series[z.candleIndex];
    // the IPO is opposite-coloured to its own direction
    const up = c.close >= c.open;
    assertEquals(up, z.direction === "supply", `${z.candleDatetime}: demand IPO must be a down candle`);
    // geometry matches the frozen rule recomputed independently
    assertEquals(z.geometry, ipoGeometry(c, z.direction));
    // structure confirmation is always AFTER the candle — never lookahead-free by accident
    assert(z.structure.confirmedByBreakIndex > z.candleIndex,
      "the confirming break must come after the IPO candle");
    assertEquals(z.structure.barsFromCandleToBreak, z.structure.confirmedByBreakIndex - z.candleIndex);
    // a zone can never be both live and flipped
    if (z.lifecycle.status === "FLIPPED") assert(z.lifecycle.brokenAtIndex !== null);
    if (z.lifecycle.flipRetestCount > 0) assert(z.lifecycle.brokenAtIndex !== null,
      "flip retests require a prior break");
  }
});

Deno.test("detectIPOZones emits at most one zone per (direction, candle)", () => {
  const series = trendingSeries();
  const zones = detectIPOZones(series, { symbol: "TEST", timeframe: "1d" });
  const keys = zones.map((z) => `${z.direction}|${z.candleIndex}`);
  assertEquals(keys.length, new Set(keys).size, "no duplicate zones");
});

Deno.test("refineIPOToLowerTimeframe only returns overlapping, same-direction children", () => {
  const series = trendingSeries();
  const zones = detectIPOZones(series, { symbol: "TEST", timeframe: "1d" });
  if (!zones.length) return;
  const parent = zones[0];
  const children = refineIPOToLowerTimeframe(parent, series, { symbol: "TEST", timeframe: "LTF" });
  for (const ch of children) {
    assertEquals(ch.direction, parent.direction);
    assert(ch.geometry.zoneLow <= parent.geometry.zoneHigh &&
           ch.geometry.zoneHigh >= parent.geometry.zoneLow, "child zone overlaps the parent zone");
  }
});

Deno.test("SHADOW ONLY — nothing in production imports the IPO research modules", async () => {
  // The guarantee the whole design rests on. If a production module ever imports
  // one of these, that is a deliberate promotion and must be a conscious
  // decision, not a side effect of an import added for convenience.
  //
  // All three research modules are checked, not just ipoZones. ipoCorpusPlan
  // and ipoProvenance arrived later and would otherwise have been an unguarded
  // back door into exactly the same code.
  const SHADOW = ["ipoZones.ts", "ipoCorpusPlan.ts", "ipoProvenance.ts"];
  const allowed = [
    "supabase/functions/smc-analysis/index.ts",      // the single read-only diagnostic
    "supabase/functions/_shared/ipoZones.ts",        // shadow modules may import each other
    "supabase/functions/_shared/ipoCorpusPlan.ts",
    "supabase/functions/_shared/ipoProvenance.ts",
  ];
  const offenders: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) { await walk(p); continue; }
      if (!p.endsWith(".ts") || p.includes(".test.")) continue;
      if (allowed.some((a) => p.endsWith(a))) continue;
      const src = await Deno.readTextFile(p);
      for (const m of SHADOW) if (src.includes(m)) offenders.push(`${p} -> ${m}`);
    }
  };
  await walk("supabase/functions");
  assertEquals(offenders, [], `unexpected production import of an IPO research module:\n${offenders.join("\n")}`);
});

// ─── review fixes ────────────────────────────────────────────────────────────

Deno.test("consolidation uses buy-side/sell-side pools and is not always false", () => {
  // Regression. The first version filtered pools on type "high"/"low", but
  // LiquidityPool.type is "buy-side" | "sell-side", so nothing ever matched and
  // insideConsolidation was false for every candle — an always-false predicate
  // that would have read as a genuine finding. This fixture builds real equal
  // highs and equal lows so detectLiquidityPools produces pools on both sides.
  reset();
  // Equal highs and equal lows must be SWING points to become pools, and
  // detectSwingPoints needs `lookback` clear bars on each side. An alternating
  // high/low pattern therefore produces nothing — each spike sits inside the
  // next one's lookback window. Spacing them with filler bars is what makes
  // this fixture actually exercise the code.
  const base = () => candle(100, 100.5, 99.5, 100);
  const highSpike = () => candle(100, 102.0, 99.8, 100.4);   // equal highs @ 102.0
  const lowSpike = () => candle(100, 100.2, 98.0, 99.6);     // equal lows  @ 98.0
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 6; k++) bars.push(base());
  for (let rep = 0; rep < 3; rep++) {
    for (let k = 0; k < 3; k++) bars.push(base());
    bars.push(highSpike());
    for (let k = 0; k < 3; k++) bars.push(base());
    bars.push(lowSpike());
  }
  for (let k = 0; k < 3; k++) bars.push(base());
  bars.push(candle(99.8, 100.4, 99.2, 100.0));   // the candidate, boxed in
  const i = bars.length - 1;

  const pools = detectLiquidityPools(bars);
  assert(pools.length > 0, "the fixture must actually produce pools, or this proves nothing");
  assert(pools.some((p) => p.type === "buy-side"), "buy-side pool exists");
  assert(pools.some((p) => p.type === "sell-side"), "sell-side pool exists");

  const con = assessConsolidation(bars, i);
  assertEquals(con.insideConsolidation, true, "boxed in above and below");
  assert(con.rangeHigh !== null && con.rangeLow !== null);
  assert(con.rangeHigh! > con.rangeLow!);
  assert(con.equalHighPools > 0 && con.equalLowPools > 0);
});

Deno.test("research mode is unbounded: a structure event older than 50 bars still yields an IPO", () => {
  // Regression. detectIPOZones previously hard-coded maxEventAgeBars: 50. The
  // reference boxes are March-May 2026 dailies examined in September, all far
  // older than 50 bars, so the cap silently suppressed exactly the events the
  // detector exists to confirm.
  reset();
  const bars: Candle[] = [];
  let p = 100;
  for (let k = 0; k < 20; k++) { bars.push(candle(p, p + 0.5, p - 0.5, p + 0.05)); p += 0.05; }
  for (let k = 0; k < 5; k++) { const o = p; p -= 1.0; bars.push(candle(o, o + 0.2, p - 0.2, p)); }
  bars.push(candle(p, p + 0.2, p - 1.5, p - 1.3)); p -= 1.3;      // the IPO low
  for (let k = 0; k < 10; k++) { const o = p; p += 1.5; bars.push(candle(o, p + 0.3, o - 0.3, p)); }
  const ipoDate = bars[25].datetime;
  // Push the whole episode far into the past — well beyond a 50-bar cap.
  for (let k = 0; k < 140; k++) { const o = p; p += 0.05; bars.push(candle(o, p + 0.3, o - 0.3, p)); }

  const unbounded = detectIPOZones(bars, { symbol: "T", timeframe: "1d" });
  const capped = detectIPOZones(bars, { symbol: "T", timeframe: "1d", maxEventAgeBars: 50 });
  assert(unbounded.length > 0, "research mode must still find historical zones");
  assert(unbounded.length >= capped.length,
    "an unbounded cap can only ever find at least as many events as a 50-bar cap");
  assert(unbounded.some((z) => z.candleIndex < bars.length - 50),
    "at least one zone must come from a candle older than 50 bars");
  assert(ipoDate.length > 0);
});

Deno.test("HTF refinement requires CONTAINMENT, not mere overlap", () => {
  reset();
  const parentCandle = candle(10, 20, 0, 11);          // demand: zone [10, 20]
  const parent = {
    direction: "demand" as const,
    geometry: ipoGeometry(parentCandle, "demand"),
  };
  const contained = { zoneLow: 12, zoneHigh: 18 };
  const straddling = { zoneLow: 8, zoneHigh: 14 };     // overlaps but hangs below
  const outside = { zoneLow: 25, zoneHigh: 30 };

  const isContained = (z: { zoneLow: number; zoneHigh: number }) =>
    z.zoneLow >= parent.geometry.zoneLow && z.zoneHigh <= parent.geometry.zoneHigh;
  const overlaps = (z: { zoneLow: number; zoneHigh: number }) =>
    z.zoneLow <= parent.geometry.zoneHigh && z.zoneHigh >= parent.geometry.zoneLow;

  assert(isContained(contained), "a fully-inside child is accepted");
  assert(overlaps(straddling), "the straddling child DOES overlap...");
  assert(!isContained(straddling), "...but must be rejected, since part of it sits outside the HTF zone");
  assert(!overlaps(outside) && !isContained(outside));
});

Deno.test("refineIPOToLowerTimeframe returns only contained children", () => {
  const series = trendingSeries();
  const zones = detectIPOZones(series, { symbol: "TEST", timeframe: "1d" });
  if (!zones.length) return;
  for (const parent of zones) {
    for (const ch of refineIPOToLowerTimeframe(parent, series, { symbol: "TEST", timeframe: "LTF" })) {
      assert(ch.geometry.zoneLow >= parent.geometry.zoneLow, "child low inside parent");
      assert(ch.geometry.zoneHigh <= parent.geometry.zoneHigh, "child high inside parent");
    }
  }
});

Deno.test("ATR is true range and reacts to a gap that high-low ignores", () => {
  // Regression. The first version averaged high-low range and called it ATR,
  // which ignores gaps entirely — and crypto, which is in the reference set,
  // gaps. Two series identical in high-low terms but one containing a large
  // gap must NOT produce the same ATR.
  reset();
  const flat: Candle[] = [];
  for (let k = 0; k < 20; k++) flat.push(candle(100, 101, 99, 100));

  reset();
  const gapped: Candle[] = [];
  for (let k = 0; k < 19; k++) gapped.push(candle(100, 101, 99, 100));
  gapped.push(candle(130, 131, 129, 130));   // same 2.0 high-low range, huge gap

  const hlAvg = (cs: Candle[]) =>
    cs.slice(-14).reduce((a, c) => a + (c.high - c.low), 0) / 14;
  assertEquals(
    Math.round(hlAvg(flat) * 100), Math.round(hlAvg(gapped) * 100),
    "high-low average cannot tell these apart — which is exactly the bug",
  );

  const atrFlat = calculateATR(flat, 14);
  const atrGapped = calculateATR(gapped, 14);
  assert(atrGapped > atrFlat * 1.5,
    `true range must register the gap: flat=${atrFlat.toFixed(3)} gapped=${atrGapped.toFixed(3)}`);
});

// ─── final semantic corrections ──────────────────────────────────────────────

Deno.test("consolidation is CAUSAL — future pools cannot change a past verdict", () => {
  // Pools formed after the candidate must be invisible to it. The previous
  // version passed the whole series to detectLiquidityPools, so a range that
  // formed months later could classify a historical IPO.
  reset();
  const base = () => candle(100, 100.5, 99.5, 100);
  const highSpike = () => candle(100, 102.0, 99.8, 100.4);
  const lowSpike = () => candle(100, 100.2, 98.0, 99.6);
  const prefix: Candle[] = [];
  for (let k = 0; k < 6; k++) prefix.push(base());
  for (let rep = 0; rep < 3; rep++) {
    for (let k = 0; k < 3; k++) prefix.push(base());
    prefix.push(highSpike());
    for (let k = 0; k < 3; k++) prefix.push(base());
    prefix.push(lowSpike());
  }
  for (let k = 0; k < 3; k++) prefix.push(base());
  prefix.push(candle(99.8, 100.4, 99.2, 100.0));      // the candidate
  const i = prefix.length - 1;

  const verdictThen = assessConsolidation(prefix, i);

  // Now append a lot of future structure that would create new pools.
  const withFuture = [...prefix];
  for (let rep = 0; rep < 4; rep++) {
    for (let k = 0; k < 3; k++) withFuture.push(candle(110, 110.5, 109.5, 110));
    withFuture.push(candle(110, 115.0, 109.8, 110.4));
    for (let k = 0; k < 3; k++) withFuture.push(candle(110, 110.5, 109.5, 110));
    withFuture.push(candle(110, 110.2, 105.0, 109.6));
  }
  const verdictNow = assessConsolidation(withFuture, i);

  assertEquals(verdictNow.insideConsolidation, verdictThen.insideConsolidation);
  assertEquals(verdictNow.rangeHigh, verdictThen.rangeHigh);
  assertEquals(verdictNow.rangeLow, verdictThen.rangeLow);
  assertEquals(verdictNow.equalHighPools, verdictThen.equalHighPools);
});

Deno.test("consolidation is UNRESOLVED and vetoes nothing; the rejection channel stays intact", () => {
  reset();
  const c = candle(100, 101, 99, 99.5);
  // Direct check of the contract the detector relies on.
  const zone = {
    valid: false, rejectionReason: "INSIDE_CONSOLIDATION" as const,
    geometry: ipoGeometry(c, "demand"),
  };
  assertEquals(zone.valid, false);
  assertEquals(zone.rejectionReason, "INSIDE_CONSOLIDATION");

  // And through the real API: valid and rejected are disjoint, and every
  // rejected candidate carries a reason. A rejected candidate must never be
  // counted as a detection, but it must still be readable.
  const series = trendingSeries();
  const { valid, rejected } = detectIPOCandidates(series, { symbol: "T", timeframe: "1d" });
  for (const z of valid) {
    assertEquals(z.valid, true);
    assertEquals(z.rejectionReason, null);
    assertEquals(z.consolidationInterpretation, "UNRESOLVED",
      "consolidation is measured but must not veto while its definition is unresolved");
  }
  for (const z of rejected) {
    assertEquals(z.valid, false);
    assert(z.rejectionReason !== null, "every rejection carries a reason");
    assert(z.candleDatetime.length > 0, "and remains fully inspectable");
  }
  const validKeys = new Set(valid.map((z) => z.id));
  assert(!rejected.some((z) => validKeys.has(z.id)), "valid and rejected are disjoint");
  // detectIPOZones exposes ONLY the valid ones.
  assertEquals(detectIPOZones(series, { symbol: "T", timeframe: "1d" }).length, valid.length);
});

Deno.test("confirmation comes from the factual ledger, not only policy BOS/CHoCH", () => {
  // The canonical policy view files 39-47% of factual close-throughs under
  // alsoBrokenLevels rather than emitting an event. Gating on bos/choch would
  // discard those. This asserts the detector evaluates ledger-only
  // confirmations — zones whose structure has no matching policy event.
  const series = trendingSeries();
  const all = detectIPOCandidates(series, { symbol: "T", timeframe: "1d" });
  const zones = [...all.valid, ...all.rejected];
  if (!zones.length) return;

  const canon = analyzeMarketStructureCanonical(series, {
    policy: "latest_unbroken_structural", maxEventAgeBars: null,
  });
  const policyKeys = new Set(
    [...canon.bos, ...canon.choch].map((e: any) => `${e.index}|${e.type}`),
  );
  const ledgerKeys = new Set(
    (canon.swingLevelBreaks as any[]).map((l) => `${l.index}|${l.direction}`),
  );
  assert(ledgerKeys.size >= policyKeys.size,
    "the ledger is a superset of the policy view, by construction");

  for (const z of zones) {
    const k = `${z.structure.confirmedByBreakIndex}|${z.structure.breakType}`;
    assert(ledgerKeys.has(k), "every confirmation must exist in the factual ledger");
    // hasPolicyEvent records enrichment, and must agree with the policy view
    assertEquals(z.structure.hasPolicyEvent, policyKeys.has(k));
    if (!z.structure.hasPolicyEvent) assertEquals(z.structure.kind, null);
  }
});

Deno.test("the departure itself is not a test — testCount stays 0 until price leaves and returns", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);          // demand zone [10, 12]
  const bars = [
    ipo,
    candle(9, 11.0, 8.9, 10.8),              // departure bar 1 — OVERLAPS the zone
    candle(10.8, 11.6, 10.4, 11.4),          // departure bar 2 — still inside
    candle(11.4, 11.9, 10.8, 11.8),          // departure bar 3 — still inside
  ];
  const during = trackIPOLifecycle(bars, 0, "demand", ipoGeometry(ipo, "demand"));
  assertEquals(during.testCount, 0,
    "the move that created the zone must not test it — this was counted as test #1 before");
  assertEquals(during.status, "UNARMED_FOR_RETEST");
  assertEquals(during.armedForRetestAtIndex, null);

  // Now let price clear the zone entirely, then come back.
  const full = [
    ...bars,
    candle(11.8, 13.5, 12.4, 13.2),          // FULLY above -> armed
    candle(13.2, 13.6, 10.9, 11.1),          // returns -> test #1
    candle(11.1, 13.4, 12.5, 13.2),          // leaves again
  ];
  const after = trackIPOLifecycle(full, 0, "demand", ipoGeometry(ipo, "demand"));
  assertEquals(after.armedForRetestAtIndex, 4);
  assertEquals(after.testCount, 1, "only the RETURN counts");
  assertEquals(after.status, "TESTED");
});

Deno.test("far-edge invalidation stays live while UNARMED", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);
  const bars = [
    ipo,
    candle(9, 10.5, 8.9, 10.2),              // still overlapping, never armed
    candle(10.2, 10.4, 7.1, 7.4),            // closes below extent 8
  ];
  const lc = trackIPOLifecycle(bars, 0, "demand", ipoGeometry(ipo, "demand"));
  assertEquals(lc.armedForRetestAtIndex, null, "never armed");
  assertEquals(lc.brokenAtIndex, 2, "but invalidation still applies");
  assertEquals(lc.status, "BROKEN");
});

Deno.test("supply arms by leaving DOWNWARD, not upward", () => {
  reset();
  const ipo = candle(9, 12, 8, 11);          // supply: proximal 8, distal 10, zone [8,10]
  const up = [ipo, candle(11, 11.5, 10.6, 11.2)];   // above the zone — wrong side
  assertEquals(trackIPOLifecycle(up, 0, "supply", ipoGeometry(ipo, "supply")).armedForRetestAtIndex,
    null, "leaving on the extent side must not arm a supply zone");

  reset();
  const ipo2 = candle(9, 12, 8, 11);
  const down = [
    ipo2,
    candle(11, 11.2, 7.9, 8.1),              // pushing down through the zone
    candle(8.1, 7.8, 6.5, 6.8),              // FULLY below -> armed
    candle(6.8, 9.4, 6.7, 9.2),              // returns into [8,10] -> test #1
    candle(9.2, 9.4, 6.6, 6.9),              // leaves again
  ];
  const lc = trackIPOLifecycle(down, 0, "supply", ipoGeometry(ipo2, "supply"));
  assertEquals(lc.armedForRetestAtIndex, 2);
  assertEquals(lc.testCount, 1);
});

// ─── origin-hypothesis diagnostic regressions ────────────────────────────────

/** A long series with many alternating swings, so there are plenty of breaks. */
function manyBreakSeries(): Candle[] {
  reset();
  const out: Candle[] = [];
  let p = 100;
  for (let cycle = 0; cycle < 14; cycle++) {
    for (let k = 0; k < 6; k++) { const o = p; p -= 0.9; out.push(candle(o, o + 0.25, p - 0.25, p)); }
    out.push(candle(p, p + 0.2, p - 1.1, p - 0.9)); p -= 0.9;
    for (let k = 0; k < 8; k++) { const o = p; p += 1.1; out.push(candle(o, p + 0.3, o - 0.3, p)); }
    out.push(candle(p, p + 1.0, p - 0.2, p + 0.8)); p += 0.8;
  }
  return out;
}

Deno.test("a display cap cannot change the conclusion — statistics span ALL breaks", () => {
  // Regression. The loop was capped at 8 breaks, so a known candle recovered by
  // break #50 would have been reported NOT recovered. BTC known candles have
  // 195-228 compatible breaks, so the cap was load-bearing on exactly the cases
  // that mattered. Only the RETURNED detail may be capped now.
  const series = manyBreakSeries();
  const known = series[Math.floor(series.length * 0.25)].datetime.slice(0, 10);

  const tight = traceDepartureOriginHypotheses(series, known, "demand", { detailCap: 1 }) as any;
  const wide = traceDepartureOriginHypotheses(series, known, "demand", { detailCap: 1000 }) as any;
  if (tight.error) return;

  assert(tight.directionalBreaksTotal > 1, "the fixture must produce more breaks than the cap");
  assertEquals(tight.detailedBreaksReturned, 1, "detail is capped");
  assert(wide.detailedBreaksReturned > tight.detailedBreaksReturned, "and the wide run returns more");

  // Every statistic must be identical regardless of the display cap.
  assertEquals(tight.directionalBreaksTotal, wide.directionalBreaksTotal);
  assertEquals(tight.recovery.knownRecovered, wide.recovery.knownRecovered);
  assertEquals(tight.recovery.knownUniquelyRecovered, wide.recovery.knownUniquelyRecovered);
  assertEquals(tight.recovery.uniqueCandlesSelectedTotal, wide.recovery.uniqueCandlesSelectedTotal);
  assertEquals(tight.recovery.recoveredBy.sort(), wide.recovery.recoveredBy.sort());
  assertEquals(tight.multiplicity, wide.multiplicity);
});

Deno.test("a pivot in BOTH swing scales stays available to both hypotheses", () => {
  // Regression. Promoting a dual pivot to "external" removed it from the
  // internal set, so the two hypotheses were not comparable and genuine
  // convergence looked like the internal anchor finding nothing.
  const series = manyBreakSeries();
  const { internal, external } = confirmedSwings(series);
  const key = (s: { type: string; index: number }) => `${s.type}_${s.index}`;
  const intKeys = new Set(internal.map(key));
  const shared = external.filter((e) => intKeys.has(key(e)));

  assert(shared.length > 0, "the fixture must contain at least one dual-scale pivot");
  for (const e of shared) {
    const i = internal.find((x) => key(x) === key(e))!;
    assertEquals(i.confirmedAt, i.index + 3, "internal membership confirms at +3");
    assertEquals(e.confirmedAt, e.index + 7, "external membership confirms at +7");
    assert(i.confirmedAt < e.confirmedAt, "the same pivot is knowable earlier as internal");
  }
});

Deno.test("several levels breaking on one bar+direction count as ONE background event", () => {
  const ledger = [
    { index: 10, direction: "bullish", level: 5, significance: "internal" },
    { index: 10, direction: "bullish", level: 7, significance: "external" },
    { index: 10, direction: "bullish", level: 9, significance: "internal" },
    { index: 10, direction: "bearish", level: 3, significance: "internal" },
    { index: 12, direction: "bullish", level: 4, significance: "internal" },
  ];
  const uniq = uniqueBreakEvents(ledger);
  assertEquals(uniq.length, 3, "two directions on bar 10 plus bar 12");
  const bar10bull = uniq.find((u) => u.index === 10 && u.direction === "bullish")!;
  assertEquals(bar10bull.significance, "external",
    "the representative prefers EXTERNAL, matching the detector's own rule");
  assertEquals(bar10bull.level, 7);

  // And the background denominator uses unique events, not raw levels.
  const series = manyBreakSeries();
  const bg = originHypothesisBackground(series) as any;
  assert(bg.uniqueBreakEvents <= bg.ledgerLevelBreaks, "unique events cannot exceed raw levels");
  assertEquals(bg.breaksUsedAsDenominator, bg.uniqueBreakEvents,
    "ratios must be computed against unique events");
  const u = bg.uniqueCandidatesPerBreak;
  assertEquals(u.breaksWithZeroUnique + u.breaksWithExactlyOneUnique + u.breaksWithMoreThanOneUnique,
    bg.uniqueBreakEvents, "the three buckets must partition the unique events exactly");
});

Deno.test("background passes caller options through to selectIPOCandle", () => {
  // Regression. selectIPOCandle was called with a hardcoded {}, so the
  // background silently measured DEFAULT behaviour while reporting the
  // caller's settings — the results would have looked valid and been wrong.
  const series = manyBreakSeries();
  const loose = originHypothesisBackground(series, { maxLookback: 12, maxIntervening: 2 }) as any;
  // maxLookback 0 means the walk inspects ONLY the launch bar, so a candidate
  // can be found only where the launch bar is itself IPO-coloured. If options
  // were still hardcoded to {}, this would be identical to the loose run.
  const strict = originHypothesisBackground(series, { maxLookback: 0 }) as any;

  assertEquals(loose.uniqueBreakEvents, strict.uniqueBreakEvents, "same breaks either way");
  const total = (b: any) =>
    Object.values(b.byAnchor).reduce((a: number, v: any) => a + v.distinctIPOCandidates, 0);
  assert(total(strict) < total(loose),
    `a lookback of 1 must find strictly fewer candidates: strict=${total(strict)} loose=${total(loose)}`);
});

// ─── event-local uniqueness and parent/child refinement ──────────────────────

Deno.test("first relevant confirmation requires departure, then a close-through, with extent intact", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);                  // demand, extent 8, zone [10,12]
  const bars = [
    ipo,
    candle(9, 11.0, 8.9, 10.8),                      // still inside — not a departure
    candle(10.8, 13.5, 10.6, 13.2),                  // rallies
    candle(13.2, 14, 12.6, 13.6),                    // FULLY above -> departed
    candle(13.6, 15, 13.4, 14.8),                    // the close-through bar
  ];
  const ledger = [
    { index: 1, direction: "bullish", level: 10.5, significance: "internal" },  // before departure
    { index: 4, direction: "bullish", level: 14.0, significance: "external" },
  ];
  const conf = findFirstRelevantConfirmation(bars, 0, "demand", ledger);
  assertEquals(conf.found, true);
  assertEquals(conf.breakIndex, 4,
    "a close-through while price is still inside the zone is not that zone's confirming move");
  assertEquals(conf.departedAtIndex, 3);
  assertEquals(conf.significance, "external");
});

Deno.test("extent invalidation ends the episode with no confirmation", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);
  const bars = [ipo, candle(9, 9.4, 7.2, 7.5), candle(7.5, 15, 7.4, 14.8)];
  const ledger = [{ index: 2, direction: "bullish", level: 14, significance: "external" }];
  const conf = findFirstRelevantConfirmation(bars, 0, "demand", ledger);
  assertEquals(conf.found, false);
  assertEquals(conf.invalidatedAtIndex, 1);
  assert(conf.reason.includes("extent invalidated"));
});

Deno.test("candidates from OTHER events are coexisting IPOs, not competitors", () => {
  const series = manyBreakSeries();
  const known = series[Math.floor(series.length * 0.3)].datetime.slice(0, 10);
  const r = traceEventLocalRecovery(series, known, "demand") as any;
  if (r.error || !r.firstRelevantConfirmation.found) return;

  // Event-local count must be far smaller than the global pool, and every
  // event candidate is labelled as belonging to THIS event.
  assert(r.eventUniqueCandidateCount >= 1);
  for (const c of r.eventCandidates) assertEquals(c.relation, "IPO_CANDIDATE_FOR_EVENT");
  assertEquals(r.otherEventCandidates.relation, "OTHER_IPO_OTHER_EVENT");
  assert(r.eventUniqueCandidateCount <= r.otherEventCandidates.count + r.eventUniqueCandidateCount,
    "other-event candidates are reported separately, never folded into the event count");

  const global = traceDepartureOriginHypotheses(series, known, "demand", { detailCap: 1 }) as any;
  assert(r.eventUniqueCandidateCount <= global.recovery.uniqueCandlesSelectedTotal,
    "event-local can never exceed the retired global pool");
});

/**
 * Three timeframes over ONE self-similar price path, with candle amplitude
 * shrinking as the timeframe drops. Each level therefore produces genuinely
 * NARROWER zones than the level above at the same moment, which is what
 * refinement means — as opposed to feeding the same series three times, where
 * containment holds only because the zones are identical.
 */
function refinementLevels() {
  const series = (amp: number): Candle[] => {
    reset();
    const out: Candle[] = [];
    let p = 100;
    for (let cycle = 0; cycle < 14; cycle++) {
      for (let k = 0; k < 6; k++) { const o = p; p -= 0.9; out.push(candle(o, o + 0.25 * amp, p - 0.25 * amp, p)); }
      out.push(candle(p, p + 0.2 * amp, p - 1.1 * amp, p - 0.9)); p -= 0.9;
      for (let k = 0; k < 8; k++) { const o = p; p += 1.1; out.push(candle(o, p + 0.3 * amp, o - 0.3 * amp, p)); }
      out.push(candle(p, p + 1.0 * amp, p - 0.2 * amp, p + 0.8)); p += 0.8;
    }
    return out;
  };
  return [
    { timeframe: "W", candles: series(1.0) },
    { timeframe: "D", candles: series(0.5) },
    { timeframe: "H4", candles: series(0.25) },
  ];
}

Deno.test("a parent IPO is NOT invalidated by finding a child", () => {
  const [w, d] = refinementLevels();
  const nodes = buildIPOHierarchy([w, d], { symbol: "T" });

  const parents = nodes.filter((n) => n.childIds.length > 0);
  // NON-VACUOUS. Without this the loop below passes on an empty hierarchy and
  // asserts nothing at all.
  assert(parents.length > 0, "the fixture must actually produce a parent with a child");
  assert(nodes.some((n) => n.refinementDepth === 1),
    "and an actual child, not just roots");

  for (const p of parents) {
    assertEquals(p.role, "CONTEXT", "a refined parent stays valid as context");
    assert(p.childTimeframe !== null);
    for (const cid of p.childIds) {
      const child = nodes.find((n) => n.id === cid)!;
      assertEquals(child.parentIPOId, p.id);
      assertEquals(child.parentTimeframe, p.timeframe);
      assertEquals(child.containedWithinParent, true);
      assert(child.geometry.zoneLow >= p.geometry.zoneLow &&
             child.geometry.zoneHigh <= p.geometry.zoneHigh,
        "containment is full, not overlap");
      assert(child.refinementDepth > p.refinementDepth);
    }
  }
  // Leaves are execution zones; a childless parent is EXECUTION at its own TF.
  for (const n of nodes.filter((x) => x.childIds.length === 0)) {
    assertEquals(n.role, "EXECUTION");
  }
});

Deno.test("refinement recurses beyond one HTF->LTF step", () => {
  const nodes = buildIPOHierarchy(refinementLevels(), { symbol: "T" });
  const depths = new Set(nodes.map((n) => n.refinementDepth));
  assert(depths.has(0), "top level exists");

  // NON-VACUOUS. A hierarchy that stops at depth 1 would make every assertion
  // below unreachable while the test still reported green.
  const grandchildren = nodes.filter((n) => n.refinementDepth === 2);
  assert(grandchildren.length > 0, "the fixture must reach a third level");
  assert(grandchildren.some((g) => g.parentIPOId !== null),
    "and at least one grandchild must have decidable lineage to walk back through");

  let walked = 0;
  for (const g of grandchildren) {
    if (!g.parentIPOId) continue;             // ambiguous lineage is not a chain to walk
    const parent = nodes.find((n) => n.id === g.parentIPOId)!;
    assertEquals(parent.refinementDepth, 1);
    if (!parent.parentIPOId) continue;
    const grandparent = nodes.find((n) => n.id === parent.parentIPOId)!;
    assertEquals(grandparent.refinementDepth, 0);
    assertEquals(grandparent.role, "CONTEXT", "a grandparent stays valid context");
    walked++;
  }
  assert(walked > 0, "at least one full grandchild -> parent -> grandparent chain was checked");

  assert(nodes.every((n) => n.refinementDepth === 0 || n.containedWithinParent),
    "every non-root node is contained within some parent");
});

// ─── same-bar departure, sample caps, ambiguous lineage ──────────────────────

Deno.test("a same-bar departure and break is KEPT but labelled unverifiable", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);                  // demand, zone [10,12], extent 8
  const bars = [
    ipo,
    candle(9, 11.5, 8.5, 11.0),                      // inside the zone
    // One bar that both leaves the zone entirely (low 12.4 > zoneHigh 12) AND
    // closes through 14. OHLC cannot say which happened first.
    candle(11.0, 15, 12.4, 14.8),
  ];
  const ledger = [{ index: 2, direction: "bullish", level: 14, significance: "external" }];
  const conf = findFirstRelevantConfirmation(bars, 0, "demand", ledger);

  assertEquals(conf.found, true, "the case is preserved, not discarded");
  assertEquals(conf.breakIndex, 2);
  assertEquals(conf.departedAtIndex, 2);
  assertEquals(conf.departureBreakOrdering, "SAME_BAR_UNVERIFIABLE");
  assert(!conf.reason.includes("after departure"),
    "the reason must not claim a chronological departure -> break it cannot prove");
});

Deno.test("a departure on an earlier bar than the break is labelled strict", () => {
  reset();
  const ipo = candle(10, 12, 8, 9);
  const bars = [
    ipo,
    candle(9, 13, 12.3, 12.8),                       // fully above the zone -> departed
    candle(12.8, 15, 12.6, 14.8),                    // the close-through, one bar later
  ];
  const ledger = [{ index: 2, direction: "bullish", level: 14, significance: "external" }];
  const conf = findFirstRelevantConfirmation(bars, 0, "demand", ledger);
  assertEquals(conf.departedAtIndex, 1);
  assertEquals(conf.breakIndex, 2);
  assertEquals(conf.departureBreakOrdering, "DEPARTURE_BEFORE_BREAK");
});

/** manyBreakSeries with an arbitrary cycle count, to get past 120 events. */
function longBreakSeries(cycles: number): Candle[] {
  reset();
  const out: Candle[] = [];
  let p = 100;
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (let k = 0; k < 6; k++) { const o = p; p -= 0.9; out.push(candle(o, o + 0.25, p - 0.25, p)); }
    out.push(candle(p, p + 0.2, p - 1.1, p - 0.9)); p -= 0.9;
    for (let k = 0; k < 8; k++) { const o = p; p += 1.1; out.push(candle(o, p + 0.3, o - 0.3, p)); }
    out.push(candle(p, p + 1.0, p - 0.2, p + 0.8)); p += 0.8;
  }
  return out;
}

Deno.test("the other-event SAMPLE cap cannot change the other-event COUNT", () => {
  // Regression. otherEvents was sliced to 120 before the candidates were even
  // computed, so `count` measured how many events happened to come first
  // rather than the series — the same defect as the retired 8-break cap. Only
  // the returned sample may be capped now.
  //
  // The fixture is deliberately long enough to produce MORE than 120 other
  // events, so the deleted cap would actually bite here; a 14-cycle series
  // yields 12 and would have passed either way.
  const series = longBreakSeries(150);
  const known = series[Math.floor(series.length * 0.25)].datetime.slice(0, 10);

  const small = traceEventLocalRecovery(series, known, "demand", { detailCap: 1 }) as any;
  const big = traceEventLocalRecovery(series, known, "demand", { detailCap: 500 }) as any;
  if (small.error || !small.firstRelevantConfirmation.found) {
    throw new Error("fixture must produce a confirmation for this test to mean anything");
  }
  assert(small.otherEventCandidates.otherEventsEvaluated > 120,
    `the fixture must exceed the old cap: got ${small.otherEventCandidates.otherEventsEvaluated}`);

  // Independent recount straight from the ledger — nothing here is capped.
  const canon = analyzeMarketStructureCanonical(series, {
    policy: "latest_unbroken_structural",
    maxEventAgeBars: null,
  }) as any;
  const expected = uniqueBreakEvents(canon.swingLevelBreaks)
    .filter((l: any) => l.index !== small.firstRelevantConfirmation.breakIndex).length;
  assertEquals(small.otherEventCandidates.otherEventsEvaluated, expected,
    "EVERY other event is evaluated, not the first N");

  assertEquals(small.otherEventCandidates.count, big.otherEventCandidates.count,
    "the count is computed over all other events regardless of sample size");
  assertEquals(
    small.otherEventCandidates.otherEventsEvaluated,
    big.otherEventCandidates.otherEventsEvaluated,
  );
  assertEquals(small.otherEventCandidates.sample.length, 1, "the sample IS capped");
  assert(big.otherEventCandidates.sample.length > small.otherEventCandidates.sample.length);
  assertEquals(small.eventUniqueCandidateCount, big.eventUniqueCandidateCount,
    "and the event-local count is untouched by display settings");
});

// Minimal hand-built nodes: only the fields lineage resolution reads.
function pnode(id: string, lo: number, hi: number, dt: string): any {
  return {
    id, timeframe: "W", direction: "demand" as const, candleDatetime: dt,
    geometry: { proximal: hi, distal: lo, extent: lo - 1, zoneLow: lo, zoneHigh: hi },
    parentIPOId: null, parentTimeframe: null, possibleParentIPOIds: [],
    lineageAmbiguous: false, lineageResolvedBy: "ROOT", childTimeframe: null,
    refinementDepth: 0, role: "EXECUTION", containedWithinParent: false,
    childIds: [], possibleChildIds: [],
  };
}
const kid = (lo: number, hi: number, dt: string) => ({
  direction: "demand" as const, candleDatetime: dt,
  geometry: { proximal: hi, distal: lo, extent: lo - 1, zoneLow: lo, zoneHigh: hi },
});

Deno.test("two OVERLAPPING HTF parents leave lineage ambiguous, in either array order", () => {
  // A and B overlap on [50,60]; the child sits inside both.
  const A = pnode("A", 40, 60, "2026-01-01T00:00:00");
  const B = pnode("B", 50, 70, "2026-01-02T00:00:00");
  const child = kid(52, 58, "2026-02-01T00:00:00");

  const fwd = resolveParentLineage(child, [A, B]);
  const rev = resolveParentLineage(child, [B, A]);

  assertEquals(fwd.lineageAmbiguous, true);
  assertEquals(fwd.parentIPOId, null, "no parent is chosen when two qualify");
  assertEquals(fwd.lineageResolvedBy, "AMBIGUOUS_MULTIPLE_PARENTS");
  assertEquals([...fwd.possibleParentIPOIds].sort(), ["A", "B"]);
  // The old .find() made this depend entirely on emission order.
  assertEquals(rev.parentIPOId, fwd.parentIPOId);
  assertEquals([...rev.possibleParentIPOIds].sort(), [...fwd.possibleParentIPOIds].sort());
});

Deno.test("NESTED HTF parents stay ambiguous — no narrowest-parent tiebreak is invented", () => {
  const OUTER = pnode("OUTER", 40, 80, "2026-01-01T00:00:00");
  const INNER = pnode("INNER", 50, 60, "2026-01-02T00:00:00");
  const child = kid(52, 58, "2026-02-01T00:00:00");

  const r = resolveParentLineage(child, [OUTER, INNER]);
  assertEquals(r.lineageAmbiguous, true,
    "narrowest-parent is plausible but untaught, so it must not be assumed");
  assertEquals(r.parentIPOId, null);
  assertEquals([...r.possibleParentIPOIds].sort(), ["INNER", "OUTER"]);

  // An explicit context supplied by the caller — not guessed by the code — settles it.
  const withCtx = resolveParentLineage(child, [OUTER, INNER], "OUTER");
  assertEquals(withCtx.parentIPOId, "OUTER");
  assertEquals(withCtx.lineageAmbiguous, false);
  assertEquals(withCtx.lineageResolvedBy, "EXPLICIT_PARENT_CONTEXT");
  // A context that does not actually contain the child cannot rescue it.
  assertEquals(resolveParentLineage(child, [OUTER, INNER], "NOPE").parentIPOId, null);
});

Deno.test("a child cannot predate its parent, however neatly it nests", () => {
  const LATE = pnode("LATE", 40, 80, "2026-03-01T00:00:00");
  const EARLY = pnode("EARLY", 40, 80, "2026-01-01T00:00:00");
  const child = kid(52, 58, "2026-02-01T00:00:00");

  const r = resolveParentLineage(child, [LATE, EARLY]);
  assertEquals(r.possibleParentIPOIds, ["EARLY"],
    "the zone that formed after the child is not a parent of it");
  assertEquals(r.parentIPOId, "EARLY");
  assertEquals(r.lineageResolvedBy, "SINGLE_VALID_PARENT");

  // Equal timestamps are allowed: same-bar refinement is containment, not time travel.
  const sameTime = resolveParentLineage(kid(52, 58, "2026-01-01T00:00:00"), [EARLY]);
  assertEquals(sameTime.parentIPOId, "EARLY");
});

/**
 * Wide HTF candles and very narrow LTF ones, so HTF zones OVERLAP each other
 * and a single child genuinely falls inside more than one of them. This is the
 * case the old .find() resolved by array position.
 */
function overlappingParentLevels() {
  const series = (amp: number): Candle[] => {
    reset();
    const out: Candle[] = [];
    let p = 100;
    for (let cycle = 0; cycle < 14; cycle++) {
      for (let k = 0; k < 6; k++) { const o = p; p -= 0.9; out.push(candle(o, o + 0.25 * amp, p - 0.25 * amp, p)); }
      out.push(candle(p, p + 0.2 * amp, p - 1.1 * amp, p - 0.9)); p -= 0.9;
      for (let k = 0; k < 8; k++) { const o = p; p += 1.1; out.push(candle(o, p + 0.3 * amp, o - 0.3 * amp, p)); }
      out.push(candle(p, p + 1.0 * amp, p - 0.2 * amp, p + 0.8)); p += 0.8;
    }
    return out;
  };
  return [
    { timeframe: "W", candles: series(20) },
    { timeframe: "D", candles: series(0.02) },
  ];
}

Deno.test("an ambiguous child promotes NO parent to CONTEXT but is recorded as possible", () => {
  const nodes = buildIPOHierarchy(overlappingParentLevels(), { symbol: "T" });

  const ambiguous = nodes.filter((n) => n.lineageAmbiguous);
  assert(ambiguous.length > 0,
    "the fixture must actually produce overlapping parents, or this asserts nothing");

  for (const n of nodes) {
    if (n.lineageAmbiguous) {
      assertEquals(n.parentIPOId, null);
      assert(n.possibleParentIPOIds.length > 1);
      for (const pid of n.possibleParentIPOIds) {
        const p = nodes.find((x) => x.id === pid)!;
        assert(p.possibleChildIds.includes(n.id),
          "every candidate parent records the possibility");
        assert(!p.childIds.includes(n.id),
          "and none of them claims it as a settled child");
      }
    }
  }
  // Roles follow settled children only.
  for (const n of nodes) {
    assertEquals(n.role, n.childIds.length > 0 ? "CONTEXT" : "EXECUTION");
  }

  // An explicit parent context supplied by the caller settles the children that
  // fall inside it, and leaves the rest ambiguous rather than guessing.
  const ctxId = ambiguous[0].possibleParentIPOIds[0];
  const withCtx = buildIPOHierarchy(overlappingParentLevels(), { symbol: "T", parentContextId: ctxId });
  const resolved = withCtx.filter((n) => n.lineageResolvedBy === "EXPLICIT_PARENT_CONTEXT");
  assert(resolved.length > 0, "the supplied context must resolve at least one child");
  for (const r of resolved) assertEquals(r.parentIPOId, ctxId);
  assert(withCtx.filter((n) => n.lineageAmbiguous).length < ambiguous.length,
    "and strictly fewer children remain ambiguous than without it");
});
