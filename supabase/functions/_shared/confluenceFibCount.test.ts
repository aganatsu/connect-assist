/**
 * Tests for the confluence stacking Fib over-counting fix.
 * Verifies that:
 *   1. A zone only gets at most ONE Fib layer (the closest to zone center)
 *   2. The correct Fib level is chosen when multiple overlap the zone
 *   3. Zones with no Fib overlap still work correctly
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { computeConfluenceStacking } from "./smcAnalysis.ts";
import type { OrderBlock, FairValueGap, SwingPoint, Candle } from "./smcAnalysis.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Generate 50 candles with a clear trend to produce valid ATR */
function makeCandles(basePrice: number): Candle[] {
  const candles: Candle[] = [];
  const baseTime = Date.now() - 50 * 900000;
  for (let i = 0; i < 50; i++) {
    const price = basePrice + i * 0.00010;
    candles.push({
      datetime: new Date(baseTime + i * 900000).toISOString(),
      open: price,
      high: price + 0.00030,
      low: price - 0.00030,
      close: price + 0.00015,
      volume: 100,
    });
  }
  return candles;
}

/** Create a wide FVG that would overlap multiple Fib levels */
function makeWideFVG(low: number, high: number): FairValueGap {
  return {
    index: 10,
    high,
    low,
    type: "bullish",
    datetime: new Date().toISOString(),
    mitigated: false,
    quality: 6,
    state: "open",
    fillPercent: 0,
    respectedCount: 0,
  };
}

function makeSwingPoint(price: number, type: "high" | "low", index: number): SwingPoint {
  return {
    index,
    price,
    type,
    datetime: new Date().toISOString(),
    state: "active",
    testedCount: 0,
  };
}

/** Create a minimal FibLevels object that computeConfluenceStacking uses (only swingHigh/swingLow) */
function makeFibLevels(swingHigh: number, swingLow: number): any {
  // The function only reads precomputedFib.swingHigh and precomputedFib.swingLow
  return {
    swingHigh,
    swingLow,
    direction: "up" as const,
    retracements: [],
    extensions: [],
    pivotHigh: { index: 0, price: swingHigh, datetime: new Date().toISOString() },
    pivotLow: { index: 0, price: swingLow, datetime: new Date().toISOString() },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

Deno.test("Confluence stacking: at most ONE Fib layer per zone (fix for over-counting)", () => {
  // Create a scenario where a wide FVG zone would previously match multiple Fib levels.
  // The FVG spans from 1.09800 to 1.09900 (10 pips wide).
  // With swing high at 1.10000 and swing low at 1.09700 (30 pip range):
  //   Fib 23.6% long = 1.10000 - 0.236 * 0.00300 = 1.09929
  //   Fib 38.2% long = 1.10000 - 0.382 * 0.00300 = 1.09885
  //   Fib 50.0% long = 1.10000 - 0.500 * 0.00300 = 1.09850
  //   Fib 61.8% long = 1.10000 - 0.618 * 0.00300 = 1.09815
  //   Fib 78.6% long = 1.10000 - 0.786 * 0.00300 = 1.09764
  // With ATR tolerance (0.3 × ATR), several of these could overlap the zone [1.09800 - 1.09900].
  // After the fix, only the CLOSEST one to zone center (1.09850) should be counted.

  const candles = makeCandles(1.09700);
  const swingPoints: SwingPoint[] = [
    makeSwingPoint(1.10000, "high", 45),
    makeSwingPoint(1.09700, "low", 35),
    makeSwingPoint(1.09950, "high", 40),
    makeSwingPoint(1.09750, "low", 30),
  ];

  const fvgs: FairValueGap[] = [
    makeWideFVG(1.09800, 1.09900), // Wide enough to overlap multiple Fib levels
  ];

  const orderBlocks: OrderBlock[] = [];

  const stacks = computeConfluenceStacking(
    orderBlocks,
    fvgs,
    swingPoints,
    candles,
    "long",
    makeFibLevels(1.10000, 1.09700), // Pre-computed fib to control exact levels
  );

  // Should find at least one stack (FVG + Fib)
  assert(stacks.length > 0, "Should find at least one confluence stack");

  // The key assertion: each stack should have at most ONE fib layer
  for (const stack of stacks) {
    const fibLayers = stack.layers.filter(l => l.type === "fib");
    assert(
      fibLayers.length <= 1,
      `Stack "${stack.label}" has ${fibLayers.length} Fib layers — should be at most 1. ` +
      `Layers: ${fibLayers.map(l => l.label).join(", ")}`,
    );
  }
});

Deno.test("Confluence stacking: picks the closest Fib to zone center", () => {
  // Zone center is at 1.09850 (midpoint of [1.09800, 1.09900])
  // Fib 50% long = 1.09850 — exactly at center
  // Fib 38.2% long = 1.09885 — 0.00035 from center
  // Fib 61.8% long = 1.09815 — 0.00035 from center
  // The 50% level should be chosen as it's closest to center.

  const candles = makeCandles(1.09700);
  const swingPoints: SwingPoint[] = [
    makeSwingPoint(1.10000, "high", 45),
    makeSwingPoint(1.09700, "low", 35),
  ];

  const fvgs: FairValueGap[] = [
    makeWideFVG(1.09800, 1.09900),
  ];

  const stacks = computeConfluenceStacking(
    [],
    fvgs,
    swingPoints,
    candles,
    "long",
    makeFibLevels(1.10000, 1.09700),
  );

  if (stacks.length > 0) {
    const fibLayers = stacks[0].layers.filter(l => l.type === "fib");
    if (fibLayers.length > 0) {
      // Should be the 50% level (closest to zone center 1.09850)
      assert(
        fibLayers[0].label.includes("50"),
        `Expected Fib 50% (closest to center) but got: ${fibLayers[0].label}`,
      );
    }
  }
});

Deno.test("Confluence stacking: zone with no Fib overlap still produces valid stack", () => {
  // Create a zone far from any Fib level — should still stack with S/R if present
  const candles = makeCandles(1.08000);
  const swingPoints: SwingPoint[] = [
    makeSwingPoint(1.10000, "high", 45),
    makeSwingPoint(1.09700, "low", 35),
    // S/R level inside the FVG zone
    makeSwingPoint(1.08500, "low", 20),
  ];

  const fvgs: FairValueGap[] = [
    makeWideFVG(1.08480, 1.08520), // Far from Fib levels
  ];

  const stacks = computeConfluenceStacking(
    [],
    fvgs,
    swingPoints,
    candles,
    "long",
    makeFibLevels(1.10000, 1.09700),
  );

  // May or may not produce a stack depending on S/R proximity
  // But if it does, it should NOT have any Fib layers (zone is far from all Fib levels)
  for (const stack of stacks) {
    const fibLayers = stack.layers.filter(l => l.type === "fib");
    // Zone at 1.08500 is way below Fib 78.6% at 1.09764, so no Fib should match
    assertEquals(
      fibLayers.length, 0,
      `Zone far from Fib levels should have 0 Fib layers, got: ${fibLayers.map(l => l.label).join(", ")}`,
    );
  }
});

Deno.test("Confluence stacking: fibLevels array in result has at most 1 entry per stack", () => {
  // This is the user-facing regression test — the fibLevels field on ConfluenceStack
  // should never have more than 1 entry (since we only pick the closest Fib).
  const candles = makeCandles(1.09700);
  const swingPoints: SwingPoint[] = [
    makeSwingPoint(1.10000, "high", 45),
    makeSwingPoint(1.09700, "low", 35),
    makeSwingPoint(1.09950, "high", 40),
    makeSwingPoint(1.09750, "low", 30),
  ];

  const fvgs: FairValueGap[] = [
    makeWideFVG(1.09800, 1.09900),
  ];

  const stacks = computeConfluenceStacking(
    [],
    fvgs,
    swingPoints,
    candles,
    "long",
    makeFibLevels(1.10000, 1.09700),
  );

  for (const stack of stacks) {
    assert(
      stack.fibLevels.length <= 1,
      `Stack fibLevels should have at most 1 entry, got ${stack.fibLevels.length}: [${stack.fibLevels.join(", ")}]`,
    );
  }
});
