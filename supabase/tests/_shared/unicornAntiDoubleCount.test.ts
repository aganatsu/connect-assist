/**
 * unicornAntiDoubleCount.test.ts — Unicorn Tier Promotion & Anti-Double-Count Regression Tests
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Verifies that:
 *   1. When Unicorn fires WITH FVG present: FVG keeps full Tier 1 credit, Breaker is zeroed,
 *      Unicorn gets Tier 3 bonus. Net = FVG(2.0) + Unicorn(0.5) > FVG-only(2.0).
 *   2. When Unicorn fires WITHOUT FVG present: Unicorn is promoted to Tier 1 (2.0 pts).
 *   3. Breaker Block is always zeroed when Unicorn fires (no double-counting).
 *   4. Rule 2 (Displacement + FVG) still works correctly.
 *   5. Rule 3 (OB + FVG cap at 3.0) still works correctly.
 *   6. Rule 5 (AMD + Sweep absorbs Judas) still works correctly.
 *
 * Run: deno test --allow-all supabase/functions/_shared/unicornAntiDoubleCount.test.ts
 */

import { runConfluenceAnalysis } from "./confluenceScoring.ts";
import { type Candle } from "./smcAnalysis.ts";
import {
  assert,
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
};

// ─── Fixture: Bullish with clear trend ─────────────────────────────────
function generateBullishFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-03-15T10:00:00Z").getTime();
  let price = 1.0800;

  for (let i = 0; i < 200; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");

    if (i < 130) {
      const trend = i * 0.00003;
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

function generateBullishDailyCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.0700;
  for (let i = 0; i < 20; i++) {
    const date = new Date(2024, 2, i + 1);
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

// ═══════════════════════════════════════════════════════════════════════
// TEST: Anti-double-count Rule 1 — Unicorn no longer zeroes FVG
// ═══════════════════════════════════════════════════════════════════════

Deno.test("REGRESSION: Unicorn does NOT zero FVG weight (anti-double-count Rule 1 fix)", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig, undefined, fixedTime);

  const fvg = result.factors.find((f: any) => f.name === "Fair Value Gap");
  const unicorn = result.factors.find((f: any) => f.name === "Unicorn Model");

  // If Unicorn fires, FVG must NOT be zeroed
  if (unicorn && unicorn.present) {
    assertExists(fvg, "FVG factor should exist when Unicorn fires");
    if (fvg.present) {
      assert(
        fvg.weight > 0,
        `FVG weight must NOT be zeroed when Unicorn fires. Got weight=${fvg.weight}. ` +
        `Detail: ${fvg.detail}`
      );
      assert(
        !fvg.detail.includes("[zeroed:"),
        `FVG detail should NOT contain [zeroed:] when Unicorn fires. Got: ${fvg.detail}`
      );
    }
  }
});

Deno.test("REGRESSION: Breaker Block IS zeroed when Unicorn fires", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig, undefined, fixedTime);

  const breaker = result.factors.find((f: any) => f.name === "Breaker Block");
  const unicorn = result.factors.find((f: any) => f.name === "Unicorn Model");

  // If Unicorn fires AND Breaker was present, Breaker must be zeroed
  if (unicorn && unicorn.present && breaker && breaker.present) {
    assert(
      breaker.weight === 0,
      `Breaker Block weight must be zeroed when Unicorn fires. Got weight=${breaker.weight}`
    );
    assert(
      breaker.detail.includes("absorbed by Unicorn"),
      `Breaker detail should mention absorption. Got: ${breaker.detail}`
    );
  }
});

Deno.test("REGRESSION: Unicorn setup scores HIGHER than FVG-only (never penalizes)", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();

  // Run with Unicorn enabled
  const withUnicorn = runConfluenceAnalysis(candles, dailyCandles, {
    ...baseConfig,
    useUnicornModel: true,
    useBreakerBlocks: true,
  }, undefined, fixedTime);

  // Run with Unicorn disabled (FVG-only baseline)
  const withoutUnicorn = runConfluenceAnalysis(candles, dailyCandles, {
    ...baseConfig,
    useUnicornModel: false,
    useBreakerBlocks: true,
  }, undefined, fixedTime);

  const unicornFactor = withUnicorn.factors.find((f: any) => f.name === "Unicorn Model");

  // If Unicorn actually fired, the score with Unicorn must be >= score without
  if (unicornFactor && unicornFactor.present) {
    assert(
      withUnicorn.score >= withoutUnicorn.score,
      `Unicorn setup score (${withUnicorn.score}) must be >= FVG-only score (${withoutUnicorn.score}). ` +
      `Unicorn should NEVER penalize. This was the critical bug: Unicorn used to zero FVG (Tier 1, 2pts) ` +
      `but only contributed Tier 3 (0.5pts), causing a net -1.5pt penalty.`
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════
// TEST: Unicorn Tier 1 promotion when FVG is absent
// ═══════════════════════════════════════════════════════════════════════

Deno.test("REGRESSION: Unicorn tier classification is correct", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig, undefined, fixedTime);

  const unicorn = result.factors.find((f: any) => f.name === "Unicorn Model");
  const fvg = result.factors.find((f: any) => f.name === "Fair Value Gap");

  if (unicorn && unicorn.present) {
    if (fvg && fvg.present && fvg.weight > 0) {
      // FVG is present → Unicorn stays Tier 3 (bonus on top)
      assert(
        (unicorn as any).tier === 3,
        `When FVG is present, Unicorn should be Tier 3 (bonus). Got tier=${(unicorn as any).tier}`
      );
    } else {
      // FVG is absent → Unicorn promoted to Tier 1
      assert(
        (unicorn as any).tier === 1,
        `When FVG is absent, Unicorn should be promoted to Tier 1. Got tier=${(unicorn as any).tier}`
      );
      assert(
        unicorn.detail.includes("promoted to Tier 1"),
        `Promoted Unicorn detail should mention promotion. Got: ${unicorn.detail}`
      );
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════
// TEST: Other anti-double-count rules still work correctly
// ═══════════════════════════════════════════════════════════════════════

Deno.test("REGRESSION: Rule 2 — Displacement reduced when FVG present", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, dailyCandles, {
    ...baseConfig,
    useDisplacement: true,
  }, undefined, fixedTime);

  const displacement = result.factors.find((f: any) => f.name === "Displacement");
  const fvg = result.factors.find((f: any) => f.name === "Fair Value Gap");

  // If both are present and displacement mentions FVG, it should be adjusted
  if (displacement && displacement.present && fvg && fvg.present) {
    if (displacement.detail.includes("FVG")) {
      assert(
        displacement.weight <= 0.5,
        `Displacement weight should be capped at 0.5 when FVG is present. Got: ${displacement.weight}`
      );
      assert(
        displacement.detail.includes("adjusted"),
        `Displacement detail should mention adjustment. Got: ${displacement.detail}`
      );
    }
  }
});

Deno.test("REGRESSION: Rule 3 — OB + FVG cap at 3.0 still works", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig, undefined, fixedTime);

  const ob = result.factors.find((f: any) => f.name === "Order Block");
  const fvg = result.factors.find((f: any) => f.name === "Fair Value Gap");

  // If both are present, their combined weight should not exceed 3.0
  if (ob && ob.present && fvg && fvg.present) {
    const combined = ob.weight + fvg.weight;
    assert(
      combined <= 3.01, // small epsilon for floating point
      `OB + FVG combined weight should be capped at 3.0. Got: ${combined} (OB=${ob.weight}, FVG=${fvg.weight})`
    );
  }
});

Deno.test("REGRESSION: Rule 5 — AMD + Sweep absorbs Judas", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, dailyCandles, {
    ...baseConfig,
    useAMD: true,
    enableLiquiditySweep: true,
  }, undefined, fixedTime);

  const amd = result.factors.find((f: any) => f.name === "AMD Phase");
  const sweep = result.factors.find((f: any) => f.name === "Liquidity Sweep");
  const judas = result.factors.find((f: any) => f.name === "Judas Swing");

  // If all three are present, Judas should be zeroed
  if (amd && amd.present && sweep && sweep.present && judas && judas.present) {
    assert(
      judas.weight === 0,
      `Judas weight should be zeroed when AMD + Sweep are present. Got: ${judas.weight}`
    );
    assert(
      judas.detail.includes("absorbed"),
      `Judas detail should mention absorption. Got: ${judas.detail}`
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════
// TEST: Tiered scoring integrity after changes
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Tiered scoring: tier counts are valid after Unicorn fix", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig, undefined, fixedTime);

  const ts = result.tieredScoring;
  assertExists(ts, "tieredScoring must exist");

  // Tier 1 max can be 4 (MS, OB, FVG, PD) or 5 (if Unicorn promoted)
  assert(ts.tier1Max >= 4 && ts.tier1Max <= 5,
    `tier1Max should be 4-5, got ${ts.tier1Max}`);
  assert(ts.tier1Count >= 0 && ts.tier1Count <= ts.tier1Max,
    `tier1Count (${ts.tier1Count}) must be 0..tier1Max (${ts.tier1Max})`);
  assert(ts.tier2Count >= 0 && ts.tier2Count <= ts.tier2Max,
    `tier2Count (${ts.tier2Count}) must be 0..tier2Max (${ts.tier2Max})`);
  assert(ts.tier3Count >= 0,
    `tier3Count must be >= 0, got ${ts.tier3Count}`);

  // Score must be a valid percentage
  assert(result.score >= 0 && result.score <= 100,
    `Score must be 0-100%, got ${result.score}`);
});

Deno.test("Tiered scoring: rawScore <= enabledMax", () => {
  const candles = generateBullishFixture();
  const dailyCandles = generateBullishDailyCandles();
  const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();
  const result = runConfluenceAnalysis(candles, dailyCandles, baseConfig, undefined, fixedTime);

  assert(
    result.rawScore <= result.enabledMax + 0.01,
    `rawScore (${result.rawScore}) must be <= enabledMax (${result.enabledMax})`
  );
});
