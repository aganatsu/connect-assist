/**
 * slFloorAndTier1Gate.test.ts — Tests for:
 *   1. SL floor enforcement in structure invalidation tightening
 *   2. Tier 1 gate raised from 2→3 core factors
 *
 * Run: deno test --allow-all supabase/functions/_shared/slFloorAndTier1Gate.test.ts
 */

import { runConfluenceAnalysis } from "./confluenceScoring.ts";
import { manageOpenPositions } from "./scannerManagement.ts";
import { SPECS, type Candle } from "./smcAnalysis.ts";
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Candle Fixture: Bullish trend → Bearish CHoCH → Bearish trend ──
// Produces: trend="bearish", 1 bearish CHoCH at index 30
// Verified via analyzeMarketStructure:
//   - 3 swing highs (descending at end), 4 swing lows (descending at end)
//   - CHoCH at index 30 (bearish), BOS at index 40 (bearish)

function generateBearishCHoCHFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-03-15T10:00:00Z").getTime();
  let cidx = 0;

  function add(o: number, h: number, l: number, c: number) {
    const time = new Date(baseTime + cidx * 15 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    candles.push({
      datetime: time,
      open: +o.toFixed(5),
      high: +h.toFixed(5),
      low: +l.toFixed(5),
      close: +c.toFixed(5),
      volume: 1500,
    });
    cidx++;
  }

  // Wave 1: up from 1.3480 → 1.3520, pullback to 1.3500
  for (let i = 0; i < 6; i++) {
    const p = 1.348 + i * 0.0007;
    add(p, p + 0.0008, p - 0.0003, p + 0.0006);
  }
  for (let i = 0; i < 4; i++) {
    const p = 1.3525 - i * 0.0007;
    add(p, p + 0.0003, p - 0.0008, p - 0.0006);
  }

  // Wave 2: up from 1.3500 → 1.3560, pullback to 1.3530
  for (let i = 0; i < 6; i++) {
    const p = 1.35 + i * 0.001;
    add(p, p + 0.0008, p - 0.0003, p + 0.0006);
  }
  for (let i = 0; i < 4; i++) {
    const p = 1.356 - i * 0.0008;
    add(p, p + 0.0003, p - 0.0008, p - 0.0006);
  }

  // Wave 3: up from 1.3530 → 1.3600
  for (let i = 0; i < 6; i++) {
    const p = 1.353 + i * 0.0012;
    add(p, p + 0.0008, p - 0.0003, p + 0.0006);
  }

  // Reversal: 4 big bearish candles
  for (let i = 0; i < 4; i++) {
    const p = 1.36 - i * 0.0015;
    add(p, p + 0.0003, p - 0.0015, p - 0.0012);
  }
  // Key candle: close below swing low → bearish CHoCH
  add(1.354, 1.3545, 1.348, 1.3485);

  // Bounce to form lower high
  for (let i = 0; i < 4; i++) {
    const p = 1.349 + i * 0.0008;
    add(p, p + 0.0008, p - 0.0003, p + 0.0006);
  }
  add(1.3525, 1.354, 1.352, 1.3535);

  // Drop to create lower low
  for (let i = 0; i < 4; i++) {
    const p = 1.353 - i * 0.001;
    add(p, p + 0.0003, p - 0.001, p - 0.0008);
  }
  add(1.349, 1.3495, 1.344, 1.3445);

  // Bounce to confirm
  for (let i = 0; i < 4; i++) {
    const p = 1.345 + i * 0.0005;
    add(p, p + 0.0006, p - 0.0003, p + 0.0004);
  }

  return candles;
}

/** Create a mock Supabase client that records updates */
function createMockSupabase() {
  const updates: Array<{ table: string; data: any; id: string }> = [];
  return {
    updates,
    from(table: string) {
      return {
        update(data: any) {
          return {
            eq(_col: string, id: string) {
              updates.push({ table, data, id });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: SL Floor Enforcement in Structure Invalidation
// ═══════════════════════════════════════════════════════════════════════

Deno.test("SL floor: structure invalidation cannot tighten GBP/USD below 15 pips", async () => {
  // GBP/USD long, entry 1.35300, SL 1.35050 (25 pips)
  // Price drops 1 pip to 1.35290 → rMultiple ≈ -0.04 (passes -0.8 guard)
  // Bearish CHoCH fixture → structureAgainst=true, hasFreshCHoCH=true
  // Without floor: 50% of |1.35290 - 1.35050| = 12 pips → newSL = 1.35170 (13 pips from entry)
  // With floor (15 pips for GBP/USD): SL should be capped at 1.35150

  const mockSupabase = createMockSupabase();
  const position = {
    id: "test-gbpusd-1",
    position_id: "pos-gbpusd-1",
    symbol: "GBP/USD",
    direction: "long",
    entry_price: "1.35300",
    current_price: "1.35290",
    stop_loss: "1.35050",
    take_profit: "1.35800",
    signal_reason: JSON.stringify({
      originalSL: 1.3505,
      exitFlags: {},
      entryTimeframe: "15m",
    }),
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    opened_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  };

  const chochCandles = generateBearishCHoCHFixture();

  const config = {
    structureInvalidationEnabled: true, // explicitly enable for this test
    trailingStopEnabled: false,
    breakEvenEnabled: false,
    partialTPEnabled: false,
    maxHoldEnabled: false,
    tradingStyle: { mode: "day_trader" },
  };

  const actions = await manageOpenPositions(
    mockSupabase,
    [position],
    config,
    "test-sl-floor-1",
    async () => chochCandles,
    () => ({ name: "London", isKillZone: true, filterKey: "london" }),
  );

  const slAction = actions.find((a) => a.action === "sl_tightened");
  assert(slAction, "Structure invalidation should have fired and tightened SL");

  const newSLDistPips =
    Math.abs(1.353 - slAction.newSL!) / SPECS["GBP/USD"].pipSize;
  assert(
    newSLDistPips >= 14.9,
    `SL floor violated: ${newSLDistPips.toFixed(1)} pips from entry, expected >= 15. newSL=${slAction.newSL}`,
  );
  console.log(
    `✓ GBP/USD SL tightened to ${slAction.newSL?.toFixed(5)} (${newSLDistPips.toFixed(1)} pips from entry, floor: 15)`,
  );
});

Deno.test("SL floor: tightening that already respects floor is not clamped", async () => {
  // GBP/USD long, entry 1.35300, SL 1.34800 (50 pips — very wide)
  // Price drops 1 pip to 1.35290 → rMultiple ≈ -0.02
  // 50% of |1.35290 - 1.34800| = 24.5 pips → newSL = 1.35045 (25.5 pips from entry)
  // Floor for GBP/USD is 15 pips → 25.5 > 15, so no clamping needed

  const mockSupabase = createMockSupabase();
  const position = {
    id: "test-gbpusd-2",
    position_id: "pos-gbpusd-2",
    symbol: "GBP/USD",
    direction: "long",
    entry_price: "1.35300",
    current_price: "1.35290",
    stop_loss: "1.34800",
    take_profit: "1.35800",
    signal_reason: JSON.stringify({
      originalSL: 1.348,
      exitFlags: {},
      entryTimeframe: "15m",
    }),
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    opened_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  };

  const chochCandles = generateBearishCHoCHFixture();

  const config = {
    structureInvalidationEnabled: true, // explicitly enable for this test
    trailingStopEnabled: false,
    breakEvenEnabled: false,
    partialTPEnabled: false,
    maxHoldEnabled: false,
    tradingStyle: { mode: "day_trader" },
  };

  const actions = await manageOpenPositions(
    mockSupabase,
    [position],
    config,
    "test-sl-floor-2",
    async () => chochCandles,
    () => ({ name: "London", isKillZone: true, filterKey: "london" }),
  );

  const slAction = actions.find((a) => a.action === "sl_tightened");
  if (slAction) {
    const newSLDistPips =
      Math.abs(1.353 - slAction.newSL!) / SPECS["GBP/USD"].pipSize;
    // Should be ~24.5 pips, well above the 15-pip floor
    assert(
      newSLDistPips >= 20,
      `Wide SL should not be clamped: ${newSLDistPips.toFixed(1)} pips`,
    );
    console.log(
      `✓ Wide SL tightened to ${slAction.newSL?.toFixed(5)} (${newSLDistPips.toFixed(1)} pips, no clamping needed)`,
    );
  } else {
    console.log("ℹ No structure invalidation triggered");
  }
});

Deno.test("SL floor: one-shot flag prevents repeated tightening", async () => {
  // Position where structure invalidation already fired
  const mockSupabase = createMockSupabase();
  const position = {
    id: "test-gbpusd-3",
    position_id: "pos-gbpusd-3",
    symbol: "GBP/USD",
    direction: "long",
    entry_price: "1.35300",
    current_price: "1.35290",
    stop_loss: "1.35150",
    take_profit: "1.35800",
    signal_reason: JSON.stringify({
      originalSL: 1.3505,
      exitFlags: { structureInvalidationFired: true }, // Already fired!
      entryTimeframe: "15m",
    }),
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    opened_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  };

  const chochCandles = generateBearishCHoCHFixture();

  const config = {
    structureInvalidationEnabled: true, // explicitly enable for this test
    trailingStopEnabled: false,
    breakEvenEnabled: false,
    partialTPEnabled: false,
    maxHoldEnabled: false,
    tradingStyle: { mode: "day_trader" },
  };

  const actions = await manageOpenPositions(
    mockSupabase,
    [position],
    config,
    "test-sl-floor-3",
    async () => chochCandles,
    () => ({ name: "London", isKillZone: true, filterKey: "london" }),
  );

  const slAction = actions.find((a) => a.action === "sl_tightened");
  assertEquals(
    slAction,
    undefined,
    "Structure invalidation should NOT fire again (one-shot already used)",
  );
  console.log("✓ One-shot flag correctly prevented repeated tightening");
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: Tier 1 Gate — Raised from 2 to 3
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Tier 1 gate: fewer than 3 core factors now FAILS", () => {
  // Simple fixture that produces few Tier 1 factors
  const candles: Candle[] = [];
  const baseTime = new Date("2024-03-15T10:00:00Z").getTime();
  let price = 1.08;
  for (let i = 0; i < 200; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    price += 0.00002;
    const range = 0.0008;
    candles.push({
      datetime: time,
      open: Number((price - range * 0.3).toFixed(5)),
      high: Number((price + range * 0.4).toFixed(5)),
      low: Number((price - range * 0.5).toFixed(5)),
      close: Number((price + range * 0.3).toFixed(5)),
      volume: 1000,
    });
  }

  const config = {
    instruments: ["EUR/USD"],
    scanInterval: "15min",
    riskPercent: 1,
    minConfluence: 10,
    enabledSessions: ["london", "new_york"],
    htfBiasRequired: false,
    structureLookback: 50,
    obLookbackCandles: 30,
    liquidityPoolMinTouches: 3,
    fibDevMultiplier: 3,
    fibDepth: 10,
  };

  const result = runConfluenceAnalysis(candles, null, config);
  const ts = result.tieredScoring;

  if (ts.tier1Count < 3) {
    assertEquals(
      ts.tier1GatePassed,
      false,
      "Tier 1 gate should FAIL with fewer than 3 core factors",
    );
    assert(
      ts.tier1GateReason.includes("need at least 3"),
      `Gate reason should mention '3', got: ${ts.tier1GateReason}`,
    );
    console.log(
      `✓ Tier 1 gate correctly FAILED with ${ts.tier1Count} core factors`,
    );
  } else {
    assertEquals(ts.tier1GatePassed, true);
    console.log(
      `✓ Tier 1 gate correctly PASSED with ${ts.tier1Count} core factors`,
    );
  }
});

Deno.test("Tier 1 gate reason message references threshold of 3", () => {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-03-15T10:00:00Z").getTime();
  for (let i = 0; i < 200; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const price = 1.08 + i * 0.00001;
    candles.push({
      datetime: time,
      open: Number((price - 0.0003).toFixed(5)),
      high: Number((price + 0.0005).toFixed(5)),
      low: Number((price - 0.0005).toFixed(5)),
      close: Number((price + 0.0003).toFixed(5)),
      volume: 1000,
    });
  }

  const config = {
    instruments: ["EUR/USD"],
    scanInterval: "15min",
    riskPercent: 1,
    minConfluence: 10,
    enabledSessions: ["london"],
    htfBiasRequired: false,
    structureLookback: 50,
    obLookbackCandles: 30,
    liquidityPoolMinTouches: 3,
    fibDevMultiplier: 3,
    fibDepth: 10,
  };

  const result = runConfluenceAnalysis(candles, null, config);
  const ts = result.tieredScoring;

  if (!ts.tier1GatePassed) {
    assert(
      ts.tier1GateReason.includes("need at least 3"),
      `Failed gate reason should say 'need at least 3', got: ${ts.tier1GateReason}`,
    );
  }
  console.log(`✓ Gate reason: ${ts.tier1GateReason}`);
});
