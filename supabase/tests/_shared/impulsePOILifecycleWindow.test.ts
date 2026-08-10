/**
 * impulsePOILifecycleWindow.test.ts — POIs must be invalidated by the retracement.
 *
 * mapImpulsePOIs used to slice its detection window at `impulse.endIndex + 1`,
 * so detectFVGs / detectOrderBlocks evaluated each POI's lifecycle only against
 * bars up to the structural break. Everything that happened afterwards — the
 * retracement, which is precisely the period we plan to trade into — was
 * invisible. A gap or order block that price had since torn straight through was
 * still published as a tradeable POI, and nothing downstream could catch it:
 * the directional guard treats "price below a demand zone" as the correct side,
 * which is indistinguishable from "price already blew through it".
 *
 * The fix widens the detection window to the last candle while keeping POI
 * *formation* bounded to the impulse. Each detector keeps its own invalidation
 * rule — FVG = wick fill, OB = 50% penetration / close-through — so this changes
 * the window only, never the policy.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapImpulsePOIs } from "../../functions/_shared/impulseZoneEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

let clock = Date.UTC(2026, 0, 1);
function bar(open: number, high: number, low: number, close: number): Candle {
  const c = { open, high, low, close, volume: 100, datetime: new Date(clock).toISOString() };
  clock += 3_600_000;
  return c;
}

const IMPULSE_END = 6;

/** Bullish impulse containing a 1.10200–1.10600 fair value gap. */
function impulseBars(): Candle[] {
  clock = Date.UTC(2026, 0, 1);
  return [
    bar(1.0960, 1.0975, 1.0950, 1.0970), // 0 origin
    bar(1.0970, 1.0990, 1.0965, 1.0985), // 1
    bar(1.0985, 1.1020, 1.0980, 1.1015), // 2  A: high 1.1020
    bar(1.1015, 1.1120, 1.1010, 1.1115), // 3  B: displacement
    bar(1.1115, 1.1180, 1.1060, 1.1170), // 4  C: low 1.1060 → FVG 1.1020–1.1060
    bar(1.1170, 1.1210, 1.1160, 1.1200), // 5
    bar(1.1200, 1.1250, 1.1190, 1.1240), // 6  BOS
  ];
}

const IMPULSE = {
  high: 1.1250, low: 1.0950, direction: "bullish" as const,
  startIndex: 0, endIndex: IMPULSE_END, isValid: true,
  bosPrice: 1.1240, breakType: "bos" as const,
};

/** Retracement that closes below the gap floor, fully consuming it. */
function retracementBars(): Candle[] {
  return [
    bar(1.1240, 1.1245, 1.1150, 1.1160),
    bar(1.1160, 1.1165, 1.1050, 1.1060),
    bar(1.1060, 1.1065, 1.0995, 1.1005), // low 1.0995 — through the 1.1020 floor
    bar(1.1005, 1.1035, 1.1000, 1.1030),
  ];
}

const isTheGap = (p: { type: string; low: number; high: number }) =>
  p.type === "fvg" && p.low >= 1.1015 && p.high <= 1.1065;

Deno.test("mapImpulsePOIs — the gap is offered before price retraces into it", () => {
  const pois = mapImpulsePOIs(impulseBars(), IMPULSE as any);
  assert(pois.some(isTheGap), "FVG 1.10200-1.10600 should be a live POI before the retracement");
});

Deno.test("mapImpulsePOIs — a gap consumed by the retracement is withdrawn", () => {
  const bars = [...impulseBars(), ...retracementBars()];
  const pois = mapImpulsePOIs(bars, IMPULSE as any);
  assertEquals(
    pois.filter(isTheGap).length,
    0,
    "price traded to 1.09950, clean through the 1.10200 floor — the gap must not be tradeable",
  );
});

Deno.test("mapImpulsePOIs — untouched gaps survive the retracement", () => {
  const bars = [...impulseBars(), ...retracementBars()];
  const pois = mapImpulsePOIs(bars, IMPULSE as any);
  // Price bottomed at 1.09950, so the 1.09750–1.09800 gap was never reached.
  assert(
    pois.some((p) => p.type === "fvg" && p.low >= 1.0970 && p.high <= 1.0985),
    "a gap price never reached must remain tradeable — the fix must not withdraw everything",
  );
  assert(pois.length > 0, "retracement must not wipe out every POI");
});

Deno.test("mapImpulsePOIs — POI formation stays bounded to the impulse", () => {
  // The widened window must not start harvesting POIs created AFTER the break.
  const bars = [
    ...impulseBars(),
    ...retracementBars(),
    // a fresh bullish gap well after the impulse: 1.1030 → 1.1080
    bar(1.1030, 1.1035, 1.1025, 1.1032),
    bar(1.1032, 1.1090, 1.1030, 1.1085),
    bar(1.1085, 1.1120, 1.1080, 1.1110),
  ];
  const pois = mapImpulsePOIs(bars, IMPULSE as any);
  for (const poi of pois) {
    assert(
      poi.candleIndex <= IMPULSE.endIndex,
      `POI at index ${poi.candleIndex} formed after the impulse ended (${IMPULSE.endIndex}) and must not be mapped`,
    );
    assert(poi.candleIndex >= 0, "POI index must be a valid full-candle index");
  }
});

Deno.test("mapImpulsePOIs — POI indices address the full candle array", () => {
  const bars = [...impulseBars(), ...retracementBars()];
  const pois = mapImpulsePOIs(bars, IMPULSE as any);
  assert(pois.length > 0);
  for (const poi of pois) {
    const source = bars[poi.candleIndex];
    assert(source, `candleIndex ${poi.candleIndex} must resolve against the full array`);
    // The POI's bounds must be consistent with bars around its source candle.
    assert(poi.high > poi.low, "POI bounds must be ordered");
  }
});

Deno.test("mapImpulsePOIs — an invalid impulse yields no POIs", () => {
  const pois = mapImpulsePOIs(impulseBars(), { ...IMPULSE, isValid: false } as any);
  assertEquals(pois.length, 0);
});
