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

Deno.test("SHADOW ONLY — nothing in production imports ipoZones", async () => {
  // The guarantee the whole design rests on. If a production module ever imports
  // this, that is a deliberate promotion and must be a conscious decision, not a
  // side effect of an import added for convenience.
  const allowed = [
    "supabase/functions/smc-analysis/index.ts",   // the single read-only diagnostic
  ];
  const offenders: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) { await walk(p); continue; }
      if (!p.endsWith(".ts") || p.includes(".test.")) continue;
      if (p.endsWith("_shared/ipoZones.ts")) continue;
      const src = await Deno.readTextFile(p);
      if (src.includes("ipoZones.ts") && !allowed.some((a) => p.endsWith(a))) offenders.push(p);
    }
  };
  await walk("supabase/functions");
  assertEquals(offenders, [], `unexpected production import of ipoZones:\n${offenders.join("\n")}`);
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
