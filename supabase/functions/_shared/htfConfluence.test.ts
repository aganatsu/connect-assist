/**
 * Unit tests for checkHTFConfluence() — HTF Confluence Scoring
 *
 * Tests cover:
 *   1. Empty zones → returns empty array
 *   2. No HTF data overlaps → htfConfluenceScore = 0, htfLayers = []
 *   3. 4H OB overlap → +1 score, "4H_OB" layer
 *   4. 4H FVG overlap → +1 score, "4H_FVG" layer
 *   5. 4H Breaker overlap → +1 score, "4H_BREAKER" layer
 *   6. HTF Fib 61.8% inside zone → +1.5 score
 *   7. HTF Fib 50% inside zone → +0.5 score
 *   8. P/D alignment (discount for longs) → +0.5 score
 *   9. P/D alignment (premium for shorts) → +0.5 score
 * 10. Full confluence: all layers overlap → max 5.0 scoree
 *  11. Direction filtering: bearish OB ignored for bullish direction
 *  12. Broken/mitigated OBs are excluded
 *  13. Filled FVGs are excluded
 *  14. Inactive/broken breakers are excluded
 *  15. Best Fib wins: 61.8% beats 50% when both overlap
 *  16. totalScore includes htfConfluenceScore after checkHTFConfluence
 *  17. Regression: zones without HTF data keep htfConfluenceScore = 0
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { OrderBlock, FairValueGap, BreakerBlock, FibLevel, FibLevels } from "./smcAnalysis.ts";
import {
  checkHTFConfluence,
  type RankedPOI,
  type HTFConfluenceData,
  type ImpulsePOI,
} from "./impulseZoneEngine.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a minimal RankedPOI for testing */
function makeZone(low: number, high: number, opts?: Partial<RankedPOI>): RankedPOI {
  return {
    poi: {
      type: "fvg",
      high,
      low,
      candleIndex: 10,
      direction: "bullish",
    },
    fibLevel: 0.618,
    fibDepth: 0.618,
    fibScore: 2,
    srConfirmed: false,
    ltfRefined: false,
    htfConfluenceScore: 0,
    htfLayers: [],
    totalScore: 2,
    ...opts,
  };
}

/** Create a minimal OrderBlock */
function makeOB(low: number, high: number, type: "bullish" | "bearish", state: "fresh" | "tested" | "mitigated" | "broken" = "fresh"): OrderBlock {
  return {
    index: 5,
    high,
    low,
    type,
    datetime: "2025-01-01T00:00:00Z",
    mitigated: state === "mitigated" || state === "broken",
    mitigatedPercent: state === "mitigated" ? 60 : 0,
    state,
    testedCount: state === "tested" ? 1 : 0,
  } as OrderBlock;
}

/** Create a minimal FairValueGap */
function makeFVG(low: number, high: number, type: "bullish" | "bearish", state: "open" | "filled" = "open"): FairValueGap {
  return {
    index: 5,
    high,
    low,
    type,
    datetime: "2025-01-01T00:00:00Z",
    mitigated: state === "filled",
    state,
    fillPercent: state === "filled" ? 100 : 0,
    respectedCount: 0,
  } as FairValueGap;
}

/** Create a minimal BreakerBlock */
function makeBreaker(low: number, high: number, type: "bullish_breaker" | "bearish_breaker", isActive: boolean, state: "active" | "broken" = "active"): BreakerBlock {
  return {
    type,
    subtype: "breaker",
    high,
    low,
    mitigatedAt: 3,
    originalOBType: type === "bullish_breaker" ? "bearish" : "bullish",
    isActive,
    state,
    testedCount: 0,
  } as BreakerBlock;
}

/** Create FibLevels with specific retracement levels */
function makeFibLevels(retracements: { ratio: number; price: number }[]): FibLevels {
  return {
    swingHigh: 1.1000,
    swingLow: 1.0000,
    direction: "up" as const,
    retracements: retracements.map(r => ({
      ratio: r.ratio,
      price: r.price,
      label: `${(r.ratio * 100).toFixed(1)}%`,
      type: "retracement" as const,
    })),
    extensions: [],
    pivotHigh: { price: 1.1000, index: 0, type: "high" } as any,
    pivotLow: { price: 1.0000, index: 5, type: "low" } as any,
  };
}

/** Create base HTF data with no overlapping elements */
function makeEmptyHTFData(direction: "bullish" | "bearish" = "bullish"): HTFConfluenceData {
  return {
    h4OBs: [],
    h4FVGs: [],
    h4Breakers: [],
    htfFibLevels: null,
    htfPD: null,
    direction,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("checkHTFConfluence — empty zones returns empty array", () => {
  const result = checkHTFConfluence([], makeEmptyHTFData());
  assertEquals(result.length, 0);
});

Deno.test("checkHTFConfluence — no overlapping HTF data → score 0", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  // OBs far away from zone
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData(),
    h4OBs: [makeOB(1.0500, 1.0520, "bullish")],
    h4FVGs: [makeFVG(1.0600, 1.0620, "bullish")],
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0);
  assertEquals(result[0].htfLayers.length, 0);
});

Deno.test("checkHTFConfluence — 4H OB overlaps zone → +1 score", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4OBs: [makeOB(1.0210, 1.0230, "bullish")], // Overlaps zone
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 1);
  assert(result[0].htfLayers.includes("4H_OB"));
});

Deno.test("checkHTFConfluence — 4H FVG overlaps zone → +1 score", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4FVGs: [makeFVG(1.0190, 1.0210, "bullish")], // Overlaps zone
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 1);
  assert(result[0].htfLayers.includes("4H_FVG"));
});

Deno.test("checkHTFConfluence — 4H Breaker overlaps zone → +1 score", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4Breakers: [makeBreaker(1.0195, 1.0215, "bullish_breaker", true)],
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 1);
  assert(result[0].htfLayers.includes("4H_BREAKER"));
});

Deno.test("checkHTFConfluence — HTF Fib 61.8% inside zone → +1.5 score", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    htfFibLevels: makeFibLevels([
      { ratio: 0.618, price: 1.0210 }, // Inside zone
    ]),
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 1.5);
  assert(result[0].htfLayers.some(l => l.includes("FIB_61.8")));
});

Deno.test("checkHTFConfluence — HTF Fib 71% inside zone → +1.5 score", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    htfFibLevels: makeFibLevels([
      { ratio: 0.71, price: 1.0205 },
    ]),
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 1.5);
  assert(result[0].htfLayers.some(l => l.includes("FIB_71.0")));
});

Deno.test("checkHTFConfluence — HTF Fib 78.6% inside zone → +1.5 score", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    htfFibLevels: makeFibLevels([
      { ratio: 0.786, price: 1.0215 },
    ]),
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 1.5);
  assert(result[0].htfLayers.some(l => l.includes("FIB_78.6")));
});

Deno.test("checkHTFConfluence — HTF Fib 50% inside zone → +0.5 score", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    htfFibLevels: makeFibLevels([
      { ratio: 0.5, price: 1.0210 },
    ]),
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0.5);
  assert(result[0].htfLayers.some(l => l.includes("FIB_50.0")));
});

Deno.test("checkHTFConfluence — P/D discount for bullish → +0.5 score", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    htfPD: { currentZone: "discount", zonePercent: 30, oteZone: true },
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0.5);
  assert(result[0].htfLayers.includes("PD_ALIGNED"));
});

Deno.test("checkHTFConfluence — P/D premium for bearish → +0.5 score", () => {
  const zones = [makeZone(1.0200, 1.0220, {
    poi: { type: "fvg", high: 1.0220, low: 1.0200, candleIndex: 10, direction: "bearish" },
  })];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bearish"),
    htfPD: { currentZone: "premium", zonePercent: 70, oteZone: true },
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0.5);
  assert(result[0].htfLayers.includes("PD_ALIGNED"));
});

Deno.test("checkHTFConfluence — P/D discount for bearish → NO score (wrong alignment)", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bearish"),
    htfPD: { currentZone: "discount", zonePercent: 30, oteZone: true },
  };
  const result = checkHTFConfluence(zones, htfData);
  // P/D should NOT add score for bearish in discount
  assert(!result[0].htfLayers.includes("PD_ALIGNED"));
});

Deno.test("checkHTFConfluence — full confluence: all layers → max 5.0 score", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4OBs: [makeOB(1.0195, 1.0215, "bullish")],       // +1
    h4FVGs: [makeFVG(1.0205, 1.0225, "bullish")],      // +1
    h4Breakers: [makeBreaker(1.0190, 1.0210, "bullish_breaker", true)], // +1
    htfFibLevels: makeFibLevels([
      { ratio: 0.618, price: 1.0210 },                  // +1.5
    ]),
    htfPD: { currentZone: "discount", zonePercent: 30, oteZone: true }, // +0.5
  };
  // Total: 1+1+1+1.5+0.5 = 5.0
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 5);
  assertEquals(result[0].htfLayers.length, 5);
  assert(result[0].htfLayers.includes("4H_OB"));
  assert(result[0].htfLayers.includes("4H_FVG"));
  assert(result[0].htfLayers.includes("4H_BREAKER"));
  assert(result[0].htfLayers.some(l => l.includes("FIB_61.8")));
  assert(result[0].htfLayers.includes("PD_ALIGNED"));
});

Deno.test("checkHTFConfluence — bearish OB ignored for bullish direction", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4OBs: [makeOB(1.0195, 1.0215, "bearish")], // Wrong direction
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0);
  assert(!result[0].htfLayers.includes("4H_OB"));
});

Deno.test("checkHTFConfluence — broken OB excluded", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4OBs: [makeOB(1.0195, 1.0215, "bullish", "broken")],
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0);
});

Deno.test("checkHTFConfluence — mitigated OB excluded", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4OBs: [makeOB(1.0195, 1.0215, "bullish", "mitigated")],
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0);
});

Deno.test("checkHTFConfluence — filled FVG excluded", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4FVGs: [makeFVG(1.0195, 1.0215, "bullish", "filled")],
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0);
});

Deno.test("checkHTFConfluence — inactive breaker excluded", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4Breakers: [makeBreaker(1.0195, 1.0215, "bullish_breaker", false)],
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0);
});

Deno.test("checkHTFConfluence — broken breaker excluded", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4Breakers: [makeBreaker(1.0195, 1.0215, "bullish_breaker", true, "broken")],
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0);
});

Deno.test("checkHTFConfluence — best Fib wins: 61.8% beats 50% when both overlap", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    htfFibLevels: makeFibLevels([
      { ratio: 0.5, price: 1.0205 },   // +0.5
      { ratio: 0.618, price: 1.0210 }, // +1.5 (should win)
    ]),
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 1.5);
  // Should only have one Fib layer (the best one)
  const fibLayers = result[0].htfLayers.filter(l => l.includes("FIB"));
  assertEquals(fibLayers.length, 1);
  assert(fibLayers[0].includes("61.8"));
});

Deno.test("checkHTFConfluence — totalScore includes htfConfluenceScore", () => {
  const zones = [makeZone(1.0200, 1.0220, { fibScore: 3, srConfirmed: true })];
  // Zone starts with fibScore=3, srConfirmed=true
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4OBs: [makeOB(1.0195, 1.0215, "bullish")], // +1
  };
  const result = checkHTFConfluence(zones, htfData);
  // totalScore = fibScore(3) + htfConfluence(1) + sr(1) = 5
  assertEquals(result[0].htfConfluenceScore, 1);
  assertEquals(result[0].totalScore, 5);
});

Deno.test("checkHTFConfluence — multiple zones scored independently", () => {
  const zones = [
    makeZone(1.0200, 1.0220), // Zone 1: will overlap OB
    makeZone(1.0300, 1.0320), // Zone 2: no overlap
  ];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4OBs: [makeOB(1.0195, 1.0215, "bullish")], // Only overlaps zone 1
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 1);
  assertEquals(result[1].htfConfluenceScore, 0);
});

Deno.test("checkHTFConfluence — OB counts at most once even with multiple overlapping OBs", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4OBs: [
      makeOB(1.0195, 1.0215, "bullish"),
      makeOB(1.0200, 1.0225, "bullish"),
    ],
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 1); // Not 2
  assertEquals(result[0].htfLayers.filter(l => l === "4H_OB").length, 1);
});

Deno.test("checkHTFConfluence — Fib outside zone → no score", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    htfFibLevels: makeFibLevels([
      { ratio: 0.618, price: 1.0300 }, // Outside zone
    ]),
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 0);
});

Deno.test("checkHTFConfluence — bearish direction with correct layers", () => {
  const zones = [makeZone(1.0200, 1.0220, {
    poi: { type: "ob", high: 1.0220, low: 1.0200, candleIndex: 10, direction: "bearish" },
  })];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bearish"),
    h4OBs: [makeOB(1.0195, 1.0215, "bearish")],
    h4FVGs: [makeFVG(1.0205, 1.0225, "bearish")],
    h4Breakers: [makeBreaker(1.0190, 1.0210, "bearish_breaker", true)],
    htfPD: { currentZone: "premium", zonePercent: 70, oteZone: true },
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 3.5); // OB(1) + FVG(1) + Breaker(1) + PD(0.5)
  assert(result[0].htfLayers.includes("4H_OB"));
  assert(result[0].htfLayers.includes("4H_FVG"));
  assert(result[0].htfLayers.includes("4H_BREAKER"));
  assert(result[0].htfLayers.includes("PD_ALIGNED"));
});

Deno.test("checkHTFConfluence — daily Fib levels also checked", () => {
  const zones = [makeZone(1.0200, 1.0220)];
  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    htfFibLevels: null, // No 4H Fib
    dailyFibLevels: makeFibLevels([
      { ratio: 0.786, price: 1.0215 },
    ]),
  };
  const result = checkHTFConfluence(zones, htfData);
  assertEquals(result[0].htfConfluenceScore, 1.5);
  assert(result[0].htfLayers.some(l => l.includes("D1_FIB_78.6")));
});

// ─── Regression: zone ranking with HTF confluence ─────────────────────────────

Deno.test("REGRESSION — zone at 61.8% with HTF confluence beats naked 78.6%", () => {
  // This is the core user requirement: a zone at 61.8% with 4H OB + FVG + HTF Fib
  // should beat a naked zone at 78.6%
  const zone618 = makeZone(1.0200, 1.0220, {
    fibLevel: 0.618,
    fibDepth: 0.618,
    fibScore: 2,
    totalScore: 2,
  });
  const zone786 = makeZone(1.0100, 1.0120, {
    fibLevel: 0.786,
    fibDepth: 0.786,
    fibScore: 4,
    totalScore: 4,
  });

  const htfData: HTFConfluenceData = {
    ...makeEmptyHTFData("bullish"),
    h4OBs: [makeOB(1.0195, 1.0215, "bullish")],       // Overlaps 61.8% zone only
    h4FVGs: [makeFVG(1.0205, 1.0225, "bullish")],      // Overlaps 61.8% zone only
    htfFibLevels: makeFibLevels([
      { ratio: 0.618, price: 1.0210 },                  // Inside 61.8% zone
    ]),
  };

  const result = checkHTFConfluence([zone618, zone786], htfData);

  // 61.8% zone: fibScore(2) + htf(1+1+1.5=3.5) + sr(0) = 5.5
  // 78.6% zone: fibScore(4) + htf(0) + sr(0) = 4
  assert(result[0].totalScore > result[1].totalScore,
    `61.8% zone (score ${result[0].totalScore}) should beat 78.6% zone (score ${result[1].totalScore})`);
});
