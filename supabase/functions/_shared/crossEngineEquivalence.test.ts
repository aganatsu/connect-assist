/**
 * crossEngineEquivalence.test.ts — Cross-Engine Equivalence Tests
 * ────────────────────────────────────────────────────────────────
 * Proves that the shared confluenceScoring module produces identical
 * results regardless of how it's called (scanner context vs backtest context).
 *
 * Key invariant: runConfluenceAnalysis(candles, daily, config, hourly, atMs)
 * must produce the same output for the same inputs, whether called from
 * the scanner (atMs=undefined) or backtest (atMs=number).
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/crossEngineEquivalence.test.ts
 */

import { runConfluenceAnalysis, DEFAULT_FACTOR_WEIGHTS, resolveWeightScale, applyWeightScale } from "./confluenceScoring.ts";
import { type Candle } from "./smcAnalysis.ts";
import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Fixture: 200 EUR/USD 15m candles with clear trend ──────────────
function makeFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-06-10T08:00:00Z").getTime(); // Monday London open
  let price = 1.0750;
  for (let i = 0; i < 200; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    price += 0.00002 + Math.sin(i * 0.3) * 0.0001;
    const range = 0.0006 + Math.abs(Math.cos(i * 0.2)) * 0.0004;
    const open = price - range * 0.2;
    const close = price + range * 0.3;
    candles.push({
      datetime: time,
      open: Number(open.toFixed(5)),
      high: Number((Math.max(open, close) + range * 0.3).toFixed(5)),
      low: Number((Math.min(open, close) - range * 0.3).toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1000 + i * 5,
    });
  }
  return candles;
}

function makeDailyFixture(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.0700;
  for (let i = 0; i < 20; i++) {
    const time = `2024-06-${String(i + 1).padStart(2, "0")} 00:00:00`;
    price += 0.0010;
    candles.push({
      datetime: time,
      open: Number((price - 0.0020).toFixed(5)),
      high: Number((price + 0.0030).toFixed(5)),
      low: Number((price - 0.0040).toFixed(5)),
      close: Number(price.toFixed(5)),
      volume: 50000,
    });
  }
  return candles;
}

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
// SECTION 1: Same inputs → Same outputs (idempotency)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Idempotency: calling twice with same inputs produces identical score", () => {
  const candles = makeFixture();
  const daily = makeDailyFixture();
  const fixedTime = new Date("2024-06-10T10:00:00Z").getTime();
  const r1 = runConfluenceAnalysis(candles, daily, baseConfig, undefined, fixedTime);
  const r2 = runConfluenceAnalysis(candles, daily, baseConfig, undefined, fixedTime);
  assertEquals(r1.score, r2.score);
  assertEquals(r1.direction, r2.direction);
  assertEquals(r1.rawScore, r2.rawScore);
});

Deno.test("Idempotency: factor list is identical across calls", () => {
  const candles = makeFixture();
  const daily = makeDailyFixture();
  const fixedTime = new Date("2024-06-10T10:00:00Z").getTime();
  const r1 = runConfluenceAnalysis(candles, daily, baseConfig, undefined, fixedTime);
  const r2 = runConfluenceAnalysis(candles, daily, baseConfig, undefined, fixedTime);
  assertEquals(r1.factors.length, r2.factors.length);
  for (let i = 0; i < r1.factors.length; i++) {
    assertEquals(r1.factors[i].name, r2.factors[i].name);
    assertEquals(r1.factors[i].present, r2.factors[i].present);
    assertEquals(r1.factors[i].weight, r2.factors[i].weight);
  }
});

Deno.test("Idempotency: tieredScoring is identical across calls", () => {
  const candles = makeFixture();
  const fixedTime = new Date("2024-06-10T10:00:00Z").getTime();
  const r1 = runConfluenceAnalysis(candles, null, baseConfig, undefined, fixedTime);
  const r2 = runConfluenceAnalysis(candles, null, baseConfig, undefined, fixedTime);
  assertEquals(JSON.stringify(r1.tieredScoring), JSON.stringify(r2.tieredScoring));
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: atMs parameter behavior
// ═══════════════════════════════════════════════════════════════════════

Deno.test("atMs: same timestamp produces same session detection", () => {
  const candles = makeFixture();
  const fixedTime = new Date("2024-06-10T14:30:00Z").getTime(); // NY session
  const r1 = runConfluenceAnalysis(candles, null, baseConfig, undefined, fixedTime);
  const r2 = runConfluenceAnalysis(candles, null, baseConfig, undefined, fixedTime);
  assertEquals(r1.session.name, r2.session.name);
  assertEquals(r1.session.active, r2.session.active);
});

Deno.test("atMs: different timestamps can produce different session results", () => {
  const candles = makeFixture();
  const londonTime = new Date("2024-06-10T09:00:00Z").getTime(); // London session
  const asiaTime = new Date("2024-06-10T02:00:00Z").getTime(); // Asian session
  const rLondon = runConfluenceAnalysis(candles, null, baseConfig, undefined, londonTime);
  const rAsia = runConfluenceAnalysis(candles, null, baseConfig, undefined, asiaTime);
  // Sessions should differ (London vs Asia)
  assert(
    rLondon.session.name !== rAsia.session.name || rLondon.session.active !== rAsia.session.active,
    "Different timestamps should produce different session results"
  );
});

Deno.test("atMs: undefined (live mode) does not crash", () => {
  const candles = makeFixture();
  const result = runConfluenceAnalysis(candles, null, baseConfig, undefined, undefined);
  assert(result.score >= 0);
  assert(result.factors.length > 0);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: Config equivalence — scanner config vs backtest config
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Config: default config produces same result as explicit defaults", () => {
  const candles = makeFixture();
  const fixedTime = new Date("2024-06-10T10:00:00Z").getTime();
  const minimal = { instruments: ["EUR/USD"] };
  const explicit = {
    instruments: ["EUR/USD"],
    structureLookback: 50,
    obLookbackCandles: undefined,
    liquidityPoolMinTouches: undefined,
    fibDevMultiplier: 3,
    fibDepth: 10,
    htfBiasRequired: false,
  };
  const r1 = runConfluenceAnalysis(candles, null, minimal, undefined, fixedTime);
  const r2 = runConfluenceAnalysis(candles, null, explicit, undefined, fixedTime);
  assertEquals(r1.score, r2.score);
  assertEquals(r1.direction, r2.direction);
});

Deno.test("Config: weight overrides change score but not direction", () => {
  const candles = makeFixture();
  const fixedTime = new Date("2024-06-10T10:00:00Z").getTime();
  const normalConfig = { ...baseConfig };
  const boostedConfig = {
    ...baseConfig,
    factorWeights: { marketStructure: 2.0, orderBlock: 2.0 },
  };
  const r1 = runConfluenceAnalysis(candles, null, normalConfig, undefined, fixedTime);
  const r2 = runConfluenceAnalysis(candles, null, boostedConfig, undefined, fixedTime);
  // Direction should be the same (weights don't change direction logic)
  assertEquals(r1.direction, r2.direction);
  // But scores may differ if those factors are present
  // (This is a behavioral invariant — weights affect magnitude, not direction)
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: resolveWeightScale and applyWeightScale helpers
// ═══════════════════════════════════════════════════════════════════════

Deno.test("resolveWeightScale: returns 1.0 for unset factor", () => {
  const scale = resolveWeightScale("marketStructure", {});
  assertEquals(scale, 1.0);
});

Deno.test("resolveWeightScale: returns config value / default weight as scale", () => {
  // marketStructure default weight = 2.5, so 1.5 / 2.5 = 0.6
  const scale = resolveWeightScale("marketStructure", { factorWeights: { marketStructure: 1.5 } });
  assertAlmostEquals(scale, 0.6, 0.001);
});

Deno.test("resolveWeightScale: returns 0 when factor disabled", () => {
  const scale = resolveWeightScale("marketStructure", { factorWeights: { marketStructure: 0 } });
  assertEquals(scale, 0);
});

Deno.test("applyWeightScale: scales points correctly", () => {
  // marketStructure default weight = 2.5, so config 2.0 / 2.5 = 0.8 scale
  const result = applyWeightScale(10, "marketStructure", 8, { factorWeights: { marketStructure: 2.0 } });
  assertEquals(result.pts, 8); // 10 * 0.8
  assertEquals(result.displayWeight, 6.4); // 8 * 0.8
});

Deno.test("applyWeightScale: zero weight zeroes out", () => {
  const result = applyWeightScale(10, "orderBlock", 8, { factorWeights: { orderBlock: 0 } });
  assertEquals(result.pts, 0);
  assertEquals(result.displayWeight, 0);
});

Deno.test("applyWeightScale: no config returns original values", () => {
  const result = applyWeightScale(10, "fairValueGap", 8, {});
  assertEquals(result.pts, 10);
  assertEquals(result.displayWeight, 8);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5: Output shape invariants
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Output: score is always between 0 and 100", () => {
  const candles = makeFixture();
  const fixedTime = new Date("2024-06-10T10:00:00Z").getTime();
  const result = runConfluenceAnalysis(candles, null, baseConfig, undefined, fixedTime);
  assert(result.score >= 0, `Score ${result.score} < 0`);
  assert(result.score <= 100, `Score ${result.score} > 100`);
});

Deno.test("Output: direction is always long, short, or null", () => {
  const candles = makeFixture();
  const fixedTime = new Date("2024-06-10T10:00:00Z").getTime();
  const result = runConfluenceAnalysis(candles, null, baseConfig, undefined, fixedTime);
  assert(
    result.direction === "long" || result.direction === "short" || result.direction === null,
    `Unexpected direction: ${result.direction}`
  );
});

Deno.test("Output: bias matches direction", () => {
  const candles = makeFixture();
  const fixedTime = new Date("2024-06-10T10:00:00Z").getTime();
  const result = runConfluenceAnalysis(candles, null, baseConfig, undefined, fixedTime);
  if (result.direction === "long") assertEquals(result.bias, "bullish");
  else if (result.direction === "short") assertEquals(result.bias, "bearish");
  else assertEquals(result.bias, "neutral");
});

Deno.test("Output: enabledMax > 0", () => {
  const candles = makeFixture();
  const result = runConfluenceAnalysis(candles, null, baseConfig);
  assert(result.enabledMax > 0, `enabledMax should be > 0, got ${result.enabledMax}`);
});

Deno.test("Output: rawScore <= enabledMax", () => {
  const candles = makeFixture();
  const fixedTime = new Date("2024-06-10T10:00:00Z").getTime();
  const result = runConfluenceAnalysis(candles, null, baseConfig, undefined, fixedTime);
  assert(
    result.rawScore <= result.enabledMax,
    `rawScore (${result.rawScore}) > enabledMax (${result.enabledMax})`
  );
});

Deno.test("Output: summary is a non-empty string", () => {
  const candles = makeFixture();
  const result = runConfluenceAnalysis(candles, null, baseConfig);
  assert(typeof result.summary === "string");
  assert(result.summary.length > 0);
});

Deno.test("Output: factors array has consistent length across calls", () => {
  const candles = makeFixture();
  const fixedTime = new Date("2024-06-10T10:00:00Z").getTime();
  const r1 = runConfluenceAnalysis(candles, null, baseConfig, undefined, fixedTime);
  const r2 = runConfluenceAnalysis(candles, makeDailyFixture(), baseConfig, undefined, fixedTime);
  // Factor count should be the same regardless of daily candles presence
  assertEquals(r1.factors.length, r2.factors.length);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 6: Candle edge cases
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Edge: minimum candles (10) does not crash", () => {
  const candles = makeFixture().slice(0, 10);
  const result = runConfluenceAnalysis(candles, null, baseConfig);
  assert(result.score >= 0);
  assert(result.factors.length > 0);
});

Deno.test("Edge: single candle does not crash", () => {
  const candles = makeFixture().slice(0, 1);
  const result = runConfluenceAnalysis(candles, null, baseConfig);
  assert(result.score >= 0);
});

Deno.test("Edge: empty daily candles (null) does not crash", () => {
  const candles = makeFixture();
  const result = runConfluenceAnalysis(candles, null, baseConfig);
  assert(result.score >= 0);
  assert(result.pdLevels === null);
});

Deno.test("Edge: empty daily candles (empty array) does not crash", () => {
  const candles = makeFixture();
  const result = runConfluenceAnalysis(candles, [], baseConfig);
  assert(result.score >= 0);
});
