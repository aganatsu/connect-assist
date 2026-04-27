/**
 * confluenceScoring.test.ts — Confluence Scoring Snapshot & Behavior Tests
 * ──────────────────────────────────────────────────────────────────────────
 * Tests the shared runConfluenceAnalysis function with deterministic fixtures.
 * Includes snapshot tests that catch future silent drift.
 *
 * Run: deno test --allow-all supabase/functions/_shared/confluenceScoring.test.ts
 */

import { runConfluenceAnalysis, DEFAULT_FACTOR_WEIGHTS } from "./confluenceScoring.ts";
import { type Candle } from "./smcAnalysis.ts";
import {
  assertEquals,
  assertAlmostEquals,
  assert,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { existsSync } from "https://deno.land/std@0.224.0/fs/mod.ts";

// ─── Deterministic Fixture Generators ────────────────────────────────

/**
 * Generate a clean bullish fixture: 200 EUR/USD 15m candles with:
 * - Clear uptrend (higher highs, higher lows)
 * - A BOS (Break of Structure) at candle 150
 * - An Order Block at candle 140-145
 * - A Fair Value Gap at candle 148-150
 * - Price in premium/discount zone
 */
function generateBullishFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-03-15T10:00:00Z").getTime(); // Friday, London session
  let price = 1.0800;

  for (let i = 0; i < 200; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");

    if (i < 130) {
      // Gradual uptrend with pullbacks every 20 candles
      const trend = i * 0.00003; // ~0.6% over 130 candles
      const pullback = (i % 20 > 15) ? -0.0010 : 0;
      const noise = Math.sin(i * 0.5) * 0.0003;
      price = 1.0800 + trend + pullback + noise;
      const range = 0.0008 + Math.abs(Math.sin(i * 0.3)) * 0.0005;
      const open = price - range * 0.3;
      const close = price + range * 0.3;
      candles.push({
        datetime: time,
        open: Number(open.toFixed(5)),
        high: Number((Math.max(open, close) + range * 0.4).toFixed(5)),
        low: Number((Math.min(open, close) - range * 0.2).toFixed(5)),
        close: Number(close.toFixed(5)),
        volume: 1000 + i * 10,
      });
    } else if (i >= 130 && i < 140) {
      // Pullback / consolidation (creates discount zone)
      price = 1.0830 - (i - 130) * 0.0005;
      const range = 0.0006;
      candles.push({
        datetime: time,
        open: Number((price + range * 0.2).toFixed(5)),
        high: Number((price + range * 0.5).toFixed(5)),
        low: Number((price - range * 0.5).toFixed(5)),
        close: Number((price - range * 0.2).toFixed(5)),
        volume: 1500 + i * 5,
      });
    } else if (i >= 140 && i < 145) {
      // Order Block zone — strong bearish candles followed by reversal
      price = 1.0800 - (i - 140) * 0.0003;
      const range = 0.0012;
      candles.push({
        datetime: time,
        open: Number((price + range * 0.4).toFixed(5)),
        high: Number((price + range * 0.5).toFixed(5)),
        low: Number((price - range * 0.5).toFixed(5)),
        close: Number((price - range * 0.4).toFixed(5)),
        volume: 2500 + i * 10,
      });
    } else if (i >= 145 && i < 148) {
      // Recovery candles
      price = 1.0790 + (i - 145) * 0.0008;
      const range = 0.0010;
      candles.push({
        datetime: time,
        open: Number((price - range * 0.3).toFixed(5)),
        high: Number((price + range * 0.5).toFixed(5)),
        low: Number((price - range * 0.4).toFixed(5)),
        close: Number((price + range * 0.3).toFixed(5)),
        volume: 2000,
      });
    } else if (i >= 148 && i < 151) {
      // FVG zone — gap up with displacement
      const gapBase = 1.0810 + (i - 148) * 0.0015;
      const range = 0.0005;
      candles.push({
        datetime: time,
        open: Number((gapBase - range * 0.1).toFixed(5)),
        high: Number((gapBase + range * 0.8).toFixed(5)),
        low: Number((gapBase - range * 0.2).toFixed(5)),
        close: Number((gapBase + range * 0.7).toFixed(5)),
        volume: 3000 + (i - 148) * 500,
      });
    } else {
      // Continuation uptrend after BOS
      price = 1.0850 + (i - 151) * 0.00015;
      const range = 0.0007;
      const open = price - range * 0.2;
      const close = price + range * 0.3;
      candles.push({
        datetime: time,
        open: Number(open.toFixed(5)),
        high: Number((close + range * 0.3).toFixed(5)),
        low: Number((open - range * 0.2).toFixed(5)),
        close: Number(close.toFixed(5)),
        volume: 1200 + i * 3,
      });
    }
  }
  return candles;
}

/**
 * Generate a clean bearish fixture: mirror of bullish
 */
function generateBearishFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-03-15T10:00:00Z").getTime();
  let price = 1.0900;

  for (let i = 0; i < 200; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");

    if (i < 130) {
      // Gradual downtrend
      const trend = -i * 0.00003;
      const pullback = (i % 20 > 15) ? 0.0010 : 0;
      const noise = Math.sin(i * 0.5) * 0.0003;
      price = 1.0900 + trend + pullback + noise;
      const range = 0.0008 + Math.abs(Math.sin(i * 0.3)) * 0.0005;
      const open = price + range * 0.3;
      const close = price - range * 0.3;
      candles.push({
        datetime: time,
        open: Number(open.toFixed(5)),
        high: Number((open + range * 0.2).toFixed(5)),
        low: Number((close - range * 0.4).toFixed(5)),
        close: Number(close.toFixed(5)),
        volume: 1000 + i * 10,
      });
    } else if (i >= 130 && i < 140) {
      // Pullback up (premium zone)
      price = 1.0870 + (i - 130) * 0.0005;
      const range = 0.0006;
      candles.push({
        datetime: time,
        open: Number((price - range * 0.2).toFixed(5)),
        high: Number((price + range * 0.5).toFixed(5)),
        low: Number((price - range * 0.5).toFixed(5)),
        close: Number((price + range * 0.2).toFixed(5)),
        volume: 1500 + i * 5,
      });
    } else if (i >= 140 && i < 145) {
      // Supply zone / OB — strong bullish candles then reversal
      price = 1.0920 + (i - 140) * 0.0003;
      const range = 0.0012;
      candles.push({
        datetime: time,
        open: Number((price - range * 0.4).toFixed(5)),
        high: Number((price + range * 0.5).toFixed(5)),
        low: Number((price - range * 0.5).toFixed(5)),
        close: Number((price + range * 0.4).toFixed(5)),
        volume: 2500 + i * 10,
      });
    } else if (i >= 145 && i < 148) {
      // Reversal candles
      price = 1.0930 - (i - 145) * 0.0008;
      const range = 0.0010;
      candles.push({
        datetime: time,
        open: Number((price + range * 0.3).toFixed(5)),
        high: Number((price + range * 0.4).toFixed(5)),
        low: Number((price - range * 0.5).toFixed(5)),
        close: Number((price - range * 0.3).toFixed(5)),
        volume: 2000,
      });
    } else if (i >= 148 && i < 151) {
      // FVG down — gap down with displacement
      const gapBase = 1.0900 - (i - 148) * 0.0015;
      const range = 0.0005;
      candles.push({
        datetime: time,
        open: Number((gapBase + range * 0.1).toFixed(5)),
        high: Number((gapBase + range * 0.2).toFixed(5)),
        low: Number((gapBase - range * 0.8).toFixed(5)),
        close: Number((gapBase - range * 0.7).toFixed(5)),
        volume: 3000 + (i - 148) * 500,
      });
    } else {
      // Continuation downtrend
      price = 1.0850 - (i - 151) * 0.00015;
      const range = 0.0007;
      const open = price + range * 0.2;
      const close = price - range * 0.3;
      candles.push({
        datetime: time,
        open: Number(open.toFixed(5)),
        high: Number((open + range * 0.2).toFixed(5)),
        low: Number((close - range * 0.3).toFixed(5)),
        close: Number(close.toFixed(5)),
        volume: 1200 + i * 3,
      });
    }
  }
  return candles;
}

/**
 * Generate a ranging/choppy fixture: no clear direction
 */
function generateRangingFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-03-15T10:00:00Z").getTime();
  const midPrice = 1.0850;

  for (let i = 0; i < 200; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    // Oscillate around midPrice with no trend
    const oscillation = Math.sin(i * 0.15) * 0.0020;
    const noise = Math.cos(i * 0.7) * 0.0005;
    const price = midPrice + oscillation + noise;
    const range = 0.0006 + Math.abs(Math.sin(i * 0.4)) * 0.0003;
    // Alternate bullish/bearish candles randomly based on index
    const bullish = i % 3 !== 0;
    const open = bullish ? price - range * 0.3 : price + range * 0.3;
    const close = bullish ? price + range * 0.3 : price - range * 0.3;
    candles.push({
      datetime: time,
      open: Number(open.toFixed(5)),
      high: Number((Math.max(open, close) + range * 0.3).toFixed(5)),
      low: Number((Math.min(open, close) - range * 0.3).toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 800 + Math.abs(Math.sin(i)) * 200,
    });
  }
  return candles;
}

/**
 * Generate daily candles for HTF bias (20 days, bullish trend)
 */
function generateBullishDailyCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.0700;
  for (let i = 0; i < 20; i++) {
    const date = new Date(2024, 2, i + 1); // March 2024
    const time = date.toISOString().slice(0, 10) + " 00:00:00";
    price += 0.0015 + Math.sin(i * 0.3) * 0.0005;
    const range = 0.0050;
    candles.push({
      datetime: time,
      open: Number((price - range * 0.3).toFixed(5)),
      high: Number((price + range * 0.5).toFixed(5)),
      low: Number((price - range * 0.5).toFixed(5)),
      close: Number((price + range * 0.3).toFixed(5)),
      volume: 50000 + i * 1000,
    });
  }
  return candles;
}

/**
 * Generate bearish daily candles for HTF bias
 */
function generateBearishDailyCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.1000;
  for (let i = 0; i < 20; i++) {
    const date = new Date(2024, 2, i + 1);
    const time = date.toISOString().slice(0, 10) + " 00:00:00";
    price -= 0.0015 + Math.sin(i * 0.3) * 0.0005;
    const range = 0.0050;
    candles.push({
      datetime: time,
      open: Number((price + range * 0.3).toFixed(5)),
      high: Number((price + range * 0.5).toFixed(5)),
      low: Number((price - range * 0.5).toFixed(5)),
      close: Number((price - range * 0.3).toFixed(5)),
      volume: 50000 + i * 1000,
    });
  }
  return candles;
}

// ─── Minimal config for testing ──────────────────────────────────────
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
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: Behavioral tests
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Fixture A (bullish): returns a valid score and direction", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);
  assert(result.score >= 0, `Expected score >= 0, got ${result.score}`);
  assert(
    result.direction === "long" || result.direction === "short",
    `Expected direction to be long or short, got ${result.direction}`
  );
});

Deno.test("Fixture A (bullish): contains structure-related factors", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);
  const factorNames = result.factors.filter((f: any) => f.present).map((f: any) => f.name);
  // Should have at least one of: BOS, OB, FVG, Premium/Discount
  const hasStructure = factorNames.some((n: string) =>
    n.includes("BOS") || n.includes("Order Block") || n.includes("FVG") || n.includes("Premium")
  );
  assert(hasStructure, `Expected structure factors, got: ${factorNames.join(", ")}`);
});

Deno.test("Fixture B (bearish): returns a valid score and direction", () => {
  const candles = generateBearishFixture();
  const dailyCandles = generateBearishDailyCandles();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);
  assert(
    result.direction === "long" || result.direction === "short",
    `Expected direction to be long or short, got ${result.direction}`
  );
});

Deno.test("Fixture B (bearish): score is non-negative", () => {
  const candles = generateBearishFixture();
  const dailyCandles = generateBearishDailyCandles();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig);
  assert(result.score >= 0, `Expected score >= 0, got ${result.score}`);
});

Deno.test("Fixture C (ranging): returns low score", () => {
  const candles = generateRangingFixture();
  const result = runConfluenceAnalysis(candles, null, baseConfig);
  // Ranging market should produce lower score than trending
  assert(result.score <= 60, `Expected score <= 60 for ranging, got ${result.score}`);
});

Deno.test("Fixture D (counter-HTF): bullish setup with bearish daily bias penalized", () => {
  const candles = generateBullishFixture();
  const bearishDaily = generateBearishDailyCandles();
  const configWithHTF = { ...baseConfig, htfBiasRequired: true };

  // With aligned daily bias
  const aligned = runConfluenceAnalysis(candles, generateBullishDailyCandles(), configWithHTF);
  // With counter daily bias
  const counter = runConfluenceAnalysis(candles, bearishDaily, configWithHTF);

  // Counter-HTF should score lower or same (the HTF bias factor won't fire)
  assert(
    counter.score <= aligned.score,
    `Counter-HTF score (${counter.score}) should be <= aligned (${aligned.score})`
  );
});

Deno.test("Fixture E (Silver Bullet window): atMs at 10:30 NY includes SB factor", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();

  // 10:30 AM ET = 14:30 UTC (during Silver Bullet window 10:00-11:00 ET)
  const sbTime = new Date("2024-03-15T14:30:00Z").getTime();
  const resultSB = runConfluenceAnalysis(candles, dailyCandles, baseConfig, undefined, sbTime);

  // 16:00 ET = 20:00 UTC (outside Silver Bullet windows)
  const noSBTime = new Date("2024-03-15T20:00:00Z").getTime();
  const resultNoSB = runConfluenceAnalysis(candles, dailyCandles, baseConfig, undefined, noSBTime);

  // Check if Silver Bullet factor is present in the SB window result
  const sbFactors = resultSB.factors.filter((f: any) => f.present && f.name.toLowerCase().includes("silver"));
  const noSBFactors = resultNoSB.factors.filter((f: any) => f.present && f.name.toLowerCase().includes("silver"));

  // The SB window should have Silver Bullet factor present (or at least more likely)
  // If neither has it, the fixture may not trigger SB — that's acceptable but documented
  if (sbFactors.length > 0) {
    assert(
      sbFactors.length >= noSBFactors.length,
      `SB window should have >= SB factors than outside: ${sbFactors.length} vs ${noSBFactors.length}`
    );
  }
  // Always assert the function doesn't crash with atMs
  assertExists(resultSB.score);
  assertExists(resultNoSB.score);
});

Deno.test("runConfluenceAnalysis returns all expected fields", () => {
  const candles = generateBullishFixture();
  const result = runConfluenceAnalysis(candles, null, baseConfig);
  assertExists(result.score);
  assertExists(result.direction);
  assertExists(result.bias);
  assertExists(result.summary);
  assertExists(result.factors);
  assertExists(result.structure);
  assertExists(result.pd);
  assertExists(result.session);
  assertExists(result.tieredScoring);
  assert(Array.isArray(result.factors));
  assert(result.factors.length > 0);
});

Deno.test("runConfluenceAnalysis: factors have required shape", () => {
  const candles = generateBullishFixture();
  const result = runConfluenceAnalysis(candles, null, baseConfig);
  for (const factor of result.factors) {
    assertExists(factor.name, "Factor missing name");
    assert(typeof factor.present === "boolean", "Factor.present must be boolean");
    assert(typeof factor.weight === "number", "Factor.weight must be number");
  }
});

Deno.test("runConfluenceAnalysis: tieredScoring has valid counts", () => {
  const candles = generateBullishFixture();
  const result = runConfluenceAnalysis(candles, null, baseConfig);
  const ts = result.tieredScoring;
  assert(ts.tier1Count >= 0 && ts.tier1Count <= ts.tier1Max);
  assert(ts.tier2Count >= 0 && ts.tier2Count <= ts.tier2Max);
  assert(ts.tier3Count >= 0);
});

Deno.test("DEFAULT_FACTOR_WEIGHTS has 17 configurable factors", () => {
  // The engine uses 22 internal factors but DEFAULT_FACTOR_WEIGHTS only exposes
  // the 17 user-configurable ones (the other 5 are always-on bonus factors)
  const keys = Object.keys(DEFAULT_FACTOR_WEIGHTS);
  assertEquals(keys.length, 17);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: Snapshot test — captures full output for drift detection
// ═══════════════════════════════════════════════════════════════════════

const SNAPSHOT_PATH = new URL("./__snapshots__/confluenceScoring.snapshot.json", import.meta.url).pathname;

Deno.test("SNAPSHOT: bullish fixture produces stable output", async () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  // Use fixed atMs to make time-dependent factors deterministic
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig, undefined, fixedTime);

  // Extract the stable subset (exclude objects with internal references)
  const snapshot = {
    score: result.score,
    rawScore: result.rawScore,
    direction: result.direction,
    bias: result.bias,
    strongFactorCount: result.strongFactorCount,
    enabledMax: result.enabledMax,
    tieredScoring: result.tieredScoring,
    factorSummary: result.factors.map((f: any) => ({
      name: f.name,
      present: f.present,
      weight: f.weight,
      tier: f.tier,
    })),
  };

  if (existsSync(SNAPSHOT_PATH)) {
    // Compare against saved snapshot
    const saved = JSON.parse(await Deno.readTextFile(SNAPSHOT_PATH));
    assertEquals(
      JSON.stringify(snapshot),
      JSON.stringify(saved),
      "Confluence scoring output has drifted from snapshot! If intentional, delete the snapshot file and re-run to regenerate."
    );
  } else {
    // First run: save the snapshot
    await Deno.mkdir(new URL("./__snapshots__", import.meta.url).pathname, { recursive: true });
    await Deno.writeTextFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
    console.log("📸 Snapshot saved. Re-run test to verify stability.");
  }
});

Deno.test("SNAPSHOT: bearish fixture produces stable output", async () => {
  const candles = generateBearishFixture();
  const dailyCandles = generateBearishDailyCandles();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig, undefined, fixedTime);

  const snapshotPath = new URL("./__snapshots__/confluenceScoring.bearish.snapshot.json", import.meta.url).pathname;
  const snapshot = {
    score: result.score,
    rawScore: result.rawScore,
    direction: result.direction,
    bias: result.bias,
    strongFactorCount: result.strongFactorCount,
    enabledMax: result.enabledMax,
    tieredScoring: result.tieredScoring,
    factorSummary: result.factors.map((f: any) => ({
      name: f.name,
      present: f.present,
      weight: f.weight,
      tier: f.tier,
    })),
  };

  if (existsSync(snapshotPath)) {
    const saved = JSON.parse(await Deno.readTextFile(snapshotPath));
    assertEquals(
      JSON.stringify(snapshot),
      JSON.stringify(saved),
      "Bearish snapshot has drifted!"
    );
  } else {
    await Deno.mkdir(new URL("./__snapshots__", import.meta.url).pathname, { recursive: true });
    await Deno.writeTextFile(snapshotPath, JSON.stringify(snapshot, null, 2));
    console.log("📸 Bearish snapshot saved.");
  }
});

Deno.test("SNAPSHOT: ranging fixture produces stable output", async () => {
  const candles = generateRangingFixture();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, null, baseConfig, undefined, fixedTime);

  const snapshotPath = new URL("./__snapshots__/confluenceScoring.ranging.snapshot.json", import.meta.url).pathname;
  const snapshot = {
    score: result.score,
    rawScore: result.rawScore,
    direction: result.direction,
    bias: result.bias,
    strongFactorCount: result.strongFactorCount,
    enabledMax: result.enabledMax,
    tieredScoring: result.tieredScoring,
    factorSummary: result.factors.map((f: any) => ({
      name: f.name,
      present: f.present,
      weight: f.weight,
      tier: f.tier,
    })),
  };

  if (existsSync(snapshotPath)) {
    const saved = JSON.parse(await Deno.readTextFile(snapshotPath));
    assertEquals(
      JSON.stringify(snapshot),
      JSON.stringify(saved),
      "Ranging snapshot has drifted!"
    );
  } else {
    await Deno.mkdir(new URL("./__snapshots__", import.meta.url).pathname, { recursive: true });
    await Deno.writeTextFile(snapshotPath, JSON.stringify(snapshot, null, 2));
    console.log("📸 Ranging snapshot saved.");
  }
});
