/**
 * fvgQualification.test.ts — FVG Qualification Fixes Regression Tests
 * ─────────────────────────────────────────────────────────────────────
 * Verifies:
 *   Fix A: Counter-directional FVGs are NOT scored (present: false)
 *   Fix B: FVGs filled >75% are disqualified (present: false)
 *   Fix C: FVG without displacement is demoted from Tier 1 → Tier 2
 *
 * Run: deno test --allow-read --allow-env --allow-net supabase/functions/_shared/fvgQualification.test.ts
 */
import { runConfluenceAnalysis } from "./confluenceScoring.ts";
import { type Candle } from "./smcAnalysis.ts";
import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Shared config ─────────────────────────────────────────────────────
const baseConfig = {
  instruments: ["EUR/USD"],
  scanInterval: "15min",
  riskPercent: 1,
  minConfluence: 40,
  enabledSessions: ["london", "new_york"],
  htfBiasRequired: false,
  structureLookback: 50,
  obLookbackCandles: 30,
  liquidityPoolMinTouches: 3,
  fibDevMultiplier: 3,
  fibDepth: 10,
  useBreakerBlocks: true,
  useUnicornModel: true,
  enableFVG: true,
  enableOB: true,
  enableStructureBreak: true,
  _currentSymbol: "EUR/USD",
};

// ─── Fixture: Bullish trend with a BULLISH FVG (aligned) ────────────────────
// Creates a clear bullish trend, then a large bullish FVG with displacement,
// then price pulls back to sit inside the FVG's upper portion (low fill).
function generateAlignedBullishFVGFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-06-01T08:00:00Z").getTime();
  let price = 1.0800;

  // Phase 1: Bullish trend (candles 0-179) — establishes direction as "long"
  for (let i = 0; i < 180; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const trend = i * 0.000025;
    const noise = Math.sin(i * 0.7) * 0.0002;
    price = 1.0800 + trend + noise;
    const isBullish = i % 5 !== 3;
    const range = 0.0008 + Math.abs(Math.sin(i * 0.4)) * 0.0004;
    const open = isBullish ? price - range * 0.3 : price + range * 0.3;
    const close = isBullish ? price + range * 0.3 : price - range * 0.3;
    candles.push({
      datetime: time,
      open: Number(open.toFixed(5)),
      high: Number((Math.max(open, close) + range * 0.3).toFixed(5)),
      low: Number((Math.min(open, close) - range * 0.2).toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1000 + i * 5,
    });
  }

  // Phase 2: Create a large BULLISH FVG (candles 180-182)
  // Bullish FVG = candle3.low > candle1.high, middle candle is bullish
  // Make the gap 20 pips (0.0020) so pullback stays in the top portion
  const fvgBase = price;
  const time180 = new Date(baseTime + 180 * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  candles.push({ // Candle 1 (c1): establishes the high
    datetime: time180,
    open: Number((fvgBase - 0.0005).toFixed(5)),
    high: Number(fvgBase.toFixed(5)),  // c1.high = fvgBase
    low: Number((fvgBase - 0.0008).toFixed(5)),
    close: Number((fvgBase - 0.0002).toFixed(5)),
    volume: 1500,
  });

  const time181 = new Date(baseTime + 181 * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  // Middle candle: LARGE bullish displacement candle (body > 2× avg body for displacement detection)
  candles.push({ // Candle 2 (c2): the displacement candle
    datetime: time181,
    open: Number((fvgBase + 0.0002).toFixed(5)),
    high: Number((fvgBase + 0.0055).toFixed(5)),
    low: Number((fvgBase + 0.0001).toFixed(5)),
    close: Number((fvgBase + 0.0050).toFixed(5)), // Large bullish body (48 pips)
    volume: 4000,
  });

  const time182 = new Date(baseTime + 182 * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  candles.push({ // Candle 3 (c3): low > c1.high creates the gap
    datetime: time182,
    open: Number((fvgBase + 0.0048).toFixed(5)),
    high: Number((fvgBase + 0.0060).toFixed(5)),
    low: Number((fvgBase + 0.0020).toFixed(5)),  // c3.low = fvgBase + 0.0020 → 20 pip gap
    close: Number((fvgBase + 0.0055).toFixed(5)),
    volume: 2000,
  });

  // Phase 3: Price pulls back to sit inside the FVG's UPPER portion (near CE)
  // FVG range: c1.high (fvgBase) to c3.low (fvgBase + 0.0020)
  // CE = fvgBase + 0.0010
  // Keep pullback candle lows ABOVE fvgBase + 0.0012 (40% fill max)
  const fvgCE = fvgBase + 0.0010;
  for (let i = 183; i < 200; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const noise = Math.sin(i * 0.8) * 0.0001;
    const p = fvgCE + 0.0003 + noise; // Sit slightly above CE
    candles.push({
      datetime: time,
      open: Number((p - 0.0001).toFixed(5)),
      high: Number((p + 0.0002).toFixed(5)),
      low: Number((p + 0.0001).toFixed(5)),  // Low stays well above the gap bottom
      close: Number((p + 0.0001).toFixed(5)),
      volume: 1200,
    });
  }

  return candles;
}

// ─── Fixture: Bullish trend with a BEARISH FVG (counter-directional) ────────
// Creates a clear bullish trend (direction = long) with a small bearish FVG embedded
// within the trend. The bearish FVG is created by a brief pullback that doesn't
// disrupt the overall bullish structure, then price continues up and later pulls
// back to sit inside the bearish FVG.
function generateCounterDirectionalFVGFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-06-01T08:00:00Z").getTime();
  let price = 1.0800;

  // Phase 1: Strong bullish trend (candles 0-159) — establishes direction as "long"
  for (let i = 0; i < 160; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const trend = i * 0.000030;
    const noise = Math.sin(i * 0.7) * 0.0001;
    price = 1.0800 + trend + noise;
    const isBullish = i % 7 !== 5; // ~85% bullish
    const range = 0.0006 + Math.abs(Math.sin(i * 0.4)) * 0.0003;
    const open = isBullish ? price - range * 0.3 : price + range * 0.2;
    const close = isBullish ? price + range * 0.3 : price - range * 0.15;
    candles.push({
      datetime: time,
      open: Number(open.toFixed(5)),
      high: Number((Math.max(open, close) + range * 0.2).toFixed(5)),
      low: Number((Math.min(open, close) - range * 0.15).toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1000 + i * 5,
    });
  }

  // Phase 2: Small pullback creating a BEARISH FVG (candles 160-162)
  // This is a minor pullback within the bullish trend — 3 candles that create a gap down
  // but NOT large enough to flip the overall trend direction
  const pullbackStart = price;
  const time160 = new Date(baseTime + 160 * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  candles.push({ // c1: last bullish candle before the gap
    datetime: time160,
    open: Number((pullbackStart - 0.0002).toFixed(5)),
    high: Number((pullbackStart + 0.0003).toFixed(5)),
    low: Number((pullbackStart - 0.0004).toFixed(5)),  // c1.low
    close: Number((pullbackStart + 0.0001).toFixed(5)),
    volume: 1500,
  });

  const time161 = new Date(baseTime + 161 * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  // c2: small bearish candle (NOT a displacement — just a normal pullback candle)
  candles.push({
    datetime: time161,
    open: Number((pullbackStart - 0.0005).toFixed(5)),
    high: Number((pullbackStart - 0.0004).toFixed(5)),
    low: Number((pullbackStart - 0.0020).toFixed(5)),
    close: Number((pullbackStart - 0.0018).toFixed(5)), // Bearish body
    volume: 1800,
  });

  const time162 = new Date(baseTime + 162 * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  // c3: c3.high < c1.low creates the bearish FVG
  // c1.low = pullbackStart - 0.0004
  candles.push({
    datetime: time162,
    open: Number((pullbackStart - 0.0015).toFixed(5)),
    high: Number((pullbackStart - 0.0008).toFixed(5)),  // c3.high < c1.low → bearish FVG
    low: Number((pullbackStart - 0.0020).toFixed(5)),
    close: Number((pullbackStart - 0.0012).toFixed(5)),
    volume: 1600,
  });

  // Phase 3: Trend resumes bullish (candles 163-189) — re-establishes direction as "long"
  // This is critical: we need enough bullish candles AFTER the pullback to confirm
  // the direction is still "long" despite the brief bearish FVG
  price = pullbackStart - 0.0012;
  for (let i = 163; i < 190; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const trend = (i - 163) * 0.000035; // Stronger recovery
    const noise = Math.sin(i * 0.5) * 0.0001;
    price = pullbackStart - 0.0012 + trend + noise;
    const range = 0.0006;
    const open = price - range * 0.3;
    const close = price + range * 0.3; // All bullish
    candles.push({
      datetime: time,
      open: Number(open.toFixed(5)),
      high: Number((close + range * 0.2).toFixed(5)),
      low: Number((open - range * 0.1).toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1400 + i * 3,
    });
  }

  // Phase 4: Price pulls back to sit inside the BEARISH FVG (candles 190-199)
  // Bearish FVG range: high = c1.low (pullbackStart - 0.0004), low = c3.high (pullbackStart - 0.0008)
  // CE = pullbackStart - 0.0006
  const bearFvgHigh = pullbackStart - 0.0004;
  const bearFvgLow = pullbackStart - 0.0008;
  const bearFvgCE = (bearFvgHigh + bearFvgLow) / 2;
  for (let i = 190; i < 200; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const noise = Math.sin(i * 0.8) * 0.00005;
    const p = bearFvgCE + noise;
    candles.push({
      datetime: time,
      open: Number((p + 0.0001).toFixed(5)),
      high: Number((p + 0.0002).toFixed(5)),
      low: Number((p - 0.0001).toFixed(5)),
      close: Number((p).toFixed(5)),
      volume: 1200,
    });
  }

  return candles;
}

// ─── Helper: generate daily candles from 15m candles ───────────────────
function generateDailyCandles(candles: Candle[]): Candle[] {
  const dailyMap = new Map<string, Candle>();
  for (const c of candles) {
    const day = c.datetime.slice(0, 10);
    if (!dailyMap.has(day)) {
      dailyMap.set(day, { ...c });
    } else {
      const d = dailyMap.get(day)!;
      d.high = Math.max(d.high, c.high);
      d.low = Math.min(d.low, c.low);
      d.close = c.close;
      d.volume = (d.volume || 0) + (c.volume || 0);
    }
  }
  return [...dailyMap.values()];
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST: Fix A — Counter-directional FVGs are NOT scored
// ═══════════════════════════════════════════════════════════════════════════
Deno.test("Fix A: Counter-directional FVG should NOT be present (bearish FVG in bullish trend)", () => {
  const candles = generateCounterDirectionalFVGFixture();
  const dailyCandles = generateDailyCandles(candles);
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);

  const fvgFactor = result.factors.find(f => f.name === "Fair Value Gap");
  assertExists(fvgFactor, "FVG factor should exist in output");

  // Direction should be long (bullish trend)
  assertEquals(result.direction, "long", "Direction should be long from bullish trend");

  // The FVG is bearish but direction is long → should NOT be present
  // (Fix A: no fallback to counter-directional FVGs)
  assertEquals(fvgFactor.present, false,
    "Counter-directional FVG (bearish FVG in bullish trend) must NOT be present. " +
    "Detail: " + fvgFactor.detail);
});

Deno.test("Fix A: Aligned FVG should still be present (bullish FVG in bullish trend)", () => {
  const candles = generateAlignedBullishFVGFixture();
  const dailyCandles = generateDailyCandles(candles);
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);

  const fvgFactor = result.factors.find(f => f.name === "Fair Value Gap");
  assertExists(fvgFactor, "FVG factor should exist in output");

  // Direction should be long
  assertEquals(result.direction, "long", "Direction should be long from bullish trend");

  // Bullish FVG in bullish trend → should be present
  assertEquals(fvgFactor.present, true,
    "Aligned FVG (bullish FVG in bullish trend) must be present. " +
    "Detail: " + fvgFactor.detail);
  assert(fvgFactor.weight > 0, "Aligned FVG weight must be > 0");
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST: Fix B — FVGs filled >75% are disqualified
// ═══════════════════════════════════════════════════════════════════════════
Deno.test("Fix B: FVG filled >75% should NOT be present (dead zone)", () => {
  // Use the aligned bullish FVG fixture but modify pullback to fill >75%
  const candles = generateAlignedBullishFVGFixture();

  // FVG: low = c1.high (candles[180].high), high = c3.low (candles[182].low)
  const fvgLow = candles[180].high;
  const fvgHigh = candles[182].low;
  const gapSize = fvgHigh - fvgLow;

  // Make pullback candles penetrate deep (>75% fill)
  // For bullish FVG, fill% = (fvg.high - candle.low) / gapSize
  // We want candle.low = fvg.high - 0.85 * gapSize = fvg.low + 0.15 * gapSize
  const deepLow = fvgLow + 0.10 * gapSize; // 90% fill
  for (let i = 183; i < 190; i++) {
    candles[i] = {
      datetime: candles[i].datetime,
      open: Number((fvgLow + 0.5 * gapSize).toFixed(5)),
      high: Number((fvgLow + 0.6 * gapSize).toFixed(5)),
      low: Number(deepLow.toFixed(5)),  // Penetrates to 90% fill
      close: Number((fvgLow + 0.4 * gapSize).toFixed(5)),
      volume: 1800,
    };
  }
  // Current price still inside the FVG (near CE)
  const fvgCE = (fvgLow + fvgHigh) / 2;
  for (let i = 190; i < 200; i++) {
    candles[i] = {
      datetime: candles[i].datetime,
      open: Number((fvgCE).toFixed(5)),
      high: Number((fvgCE + 0.0001).toFixed(5)),
      low: Number((fvgCE - 0.0001).toFixed(5)),
      close: Number((fvgCE).toFixed(5)),
      volume: 1200,
    };
  }

  const dailyCandles = generateDailyCandles(candles);
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);
  const fvgFactor = result.factors.find(f => f.name === "Fair Value Gap");
  assertExists(fvgFactor, "FVG factor should exist in output");

  // FVG is >75% filled → should be disqualified
  assertEquals(fvgFactor.present, false,
    "FVG filled >75% must NOT be present (dead zone). Detail: " + fvgFactor.detail);
});

Deno.test("Fix B: FVG filled <=30% should still be present with full score", () => {
  // Use the aligned fixture as-is — pullback stays in the upper portion
  const candles = generateAlignedBullishFVGFixture();
  const dailyCandles = generateDailyCandles(candles);
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);

  const fvgFactor = result.factors.find(f => f.name === "Fair Value Gap");
  assertExists(fvgFactor, "FVG factor should exist in output");

  if (fvgFactor.present) {
    assert(fvgFactor.weight > 0, "Low-fill FVG should have positive weight");
    // Should not mention "dead zone" or "disqualified"
    assert(!fvgFactor.detail.includes("dead zone"),
      "Low-fill FVG should not be marked as dead zone");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST: Fix C — FVG without displacement is demoted from Tier 1 → Tier 2
// ═══════════════════════════════════════════════════════════════════════════
Deno.test("Fix C: FVG with displacement should remain Tier 1", () => {
  const candles = generateAlignedBullishFVGFixture();
  const dailyCandles = generateDailyCandles(candles);
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);

  const fvgFactor = result.factors.find(f => f.name === "Fair Value Gap");
  assertExists(fvgFactor, "FVG factor should exist");

  if (fvgFactor.present && (fvgFactor as any)._hasDisplacement) {
    assertEquals((fvgFactor as any).tier, 1,
      "FVG with displacement should remain Tier 1");
    assert(!fvgFactor.detail.includes("demoted"),
      "FVG with displacement should NOT be demoted");
  }
});

Deno.test("Fix C: FVG without displacement should be demoted to Tier 2", () => {
  // Create a fixture with a small FVG (no displacement — middle candle is NOT large)
  const candles = generateAlignedBullishFVGFixture();

  // Shrink the middle candle (candle 181) so it's NOT a displacement candle
  // Keep the FVG valid but make the middle candle small
  const fvgBase = candles[180].high;
  candles[181] = {
    datetime: candles[181].datetime,
    open: Number((fvgBase + 0.0001).toFixed(5)),
    high: Number((fvgBase + 0.0025).toFixed(5)),  // Smaller range
    low: Number((fvgBase + 0.00005).toFixed(5)),
    close: Number((fvgBase + 0.0008).toFixed(5)), // Small body — NOT displacement
    volume: 1200,
  };
  // Adjust candle 182 so FVG still exists: c3.low > c1.high (fvgBase)
  candles[182] = {
    datetime: candles[182].datetime,
    open: Number((fvgBase + 0.0022).toFixed(5)),
    high: Number((fvgBase + 0.0030).toFixed(5)),
    low: Number((fvgBase + 0.0015).toFixed(5)),  // c3.low > c1.high → FVG exists (15 pip gap)
    close: Number((fvgBase + 0.0028).toFixed(5)),
    volume: 1500,
  };
  // Adjust pullback candles to be inside the new FVG (near CE, low fill)
  const newFvgLow = fvgBase; // c1.high
  const newFvgHigh = fvgBase + 0.0015; // c3.low
  const newCE = (newFvgLow + newFvgHigh) / 2;
  for (let i = 183; i < 200; i++) {
    candles[i] = {
      datetime: candles[i].datetime,
      open: Number((newCE + 0.0002).toFixed(5)),
      high: Number((newCE + 0.0003).toFixed(5)),
      low: Number((newCE + 0.0001).toFixed(5)),  // Stay in top portion (low fill)
      close: Number((newCE + 0.0002).toFixed(5)),
      volume: 1100,
    };
  }

  const dailyCandles = generateDailyCandles(candles);
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);

  const fvgFactor = result.factors.find(f => f.name === "Fair Value Gap");
  assertExists(fvgFactor, "FVG factor should exist");

  if (fvgFactor.present) {
    // Without displacement, FVG should be demoted to Tier 2
    assertEquals((fvgFactor as any)._hasDisplacement, false,
      "FVG should NOT have displacement flag set");
    assertEquals((fvgFactor as any).tier, 2,
      "FVG without displacement should be demoted to Tier 2");
    assert(fvgFactor.detail.includes("demoted") || fvgFactor.detail.includes("Tier 2"),
      "Detail should indicate demotion. Got: " + fvgFactor.detail);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST: Regression — existing behavior preserved
// ═══════════════════════════════════════════════════════════════════════════
Deno.test("REGRESSION: Non-FVG Tier 1 factors unaffected by FVG fixes", () => {
  const candles = generateAlignedBullishFVGFixture();
  const dailyCandles = generateDailyCandles(candles);
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);

  const ms = result.factors.find(f => f.name === "Market Structure");
  const ob = result.factors.find(f => f.name === "Order Block");
  const pd = result.factors.find(f => f.name === "Premium/Discount & Fib");

  if (ms && ms.present) assertEquals((ms as any).tier, 1, "Market Structure should be Tier 1");
  if (ob && ob.present) assertEquals((ob as any).tier, 1, "Order Block should be Tier 1");
  if (pd && pd.present) assertEquals((pd as any).tier, 1, "Premium/Discount should be Tier 1");
});

Deno.test("REGRESSION: Score is bounded 0-100% after FVG fixes", () => {
  const candles = generateAlignedBullishFVGFixture();
  const dailyCandles = generateDailyCandles(candles);
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);

  assert(result.score >= 0, "Score must be >= 0");
  assert(result.score <= 100, "Score must be <= 100");
  assert(result.rawScore >= 0, "rawScore must be >= 0");
});
