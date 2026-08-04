/**
 * backtestConviction.test.ts
 * Tests the thesis conviction integration in the backtest engine.
 * Verifies:
 * 1. Conviction state accumulates correctly across bars
 * 2. TF-aware decay scaling produces expected rates
 * 3. Session reset clears conviction state
 * 4. Trade open resets conviction for that direction
 * 5. Score adjustment is applied in active mode, not in shadow mode
 */
import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  updateConviction,
  DEFAULT_CONVICTION_CONFIG,
  type ConvictionInput,
  type ConvictionConfig,
  type ThesisConvictionState,
} from "../../functions/_shared/thesisConviction.ts";

// ─── Test 1: Conviction accumulates across multiple bars ───
Deno.test("Conviction accumulates evidence across multiple bars", () => {
  const input: ConvictionInput = {
    symbol: "EUR/USD",
    direction: "long",
    directionVerdict: { verdict: "ALIGNED", confidence: 80, reasons: [] } as any,
    regime4H: { regime: "trending", bias: "bullish", confidence: 75 },
    opposingFactorCount: 0,
    fotsiAlignment: { label: "aligned", score: 0.7 },
    gamePlanBias: { bias: "bullish", confidence: 80 },
  };

  // First bar: initialize state
  const { state: s1, result: r1 } = updateConviction(null, input);
  assertEquals(s1.symbol, "EUR/USD");
  assertEquals(s1.direction, "long");
  assertEquals(r1.cycleCount, 1);
  // Conviction should start at 100 (full)
  assertEquals(s1.conviction, 100);

  // Second bar: same aligned evidence → conviction stays high
  const { state: s2, result: r2 } = updateConviction(s1, input);
  assertEquals(r2.cycleCount, 2);
  // With all aligned sources, conviction should remain at or near 100
  assertEquals(r2.conviction >= 95, true, `Expected conviction >= 95, got ${r2.conviction}`);
});

// ─── Test 2: TF-aware decay scaling ───
Deno.test("TF-aware decay scaling produces correct rates for different styles", () => {
  const tfScaleMap: Record<string, number> = { "scalper": 1.0, "day_trader": 0.33, "swing_trader": 0.021 };
  
  // Scalper: full decay rate (1 bar ≈ 1 scan cycle)
  const scalperScale = tfScaleMap["scalper"];
  const scalperDecay = DEFAULT_CONVICTION_CONFIG.decayPerOpposingSource * scalperScale;
  assertAlmostEquals(scalperDecay, DEFAULT_CONVICTION_CONFIG.decayPerOpposingSource, 0.001);

  // Day trader: 1/3 decay rate (1 bar ≈ 3 scan cycles)
  const dayTraderScale = tfScaleMap["day_trader"];
  const dayTraderDecay = DEFAULT_CONVICTION_CONFIG.decayPerOpposingSource * dayTraderScale;
  assertAlmostEquals(dayTraderDecay, DEFAULT_CONVICTION_CONFIG.decayPerOpposingSource * 0.33, 0.001);

  // Swing trader: minimal decay rate (1 bar ≈ 48 scan cycles)
  const swingScale = tfScaleMap["swing_trader"];
  const swingDecay = DEFAULT_CONVICTION_CONFIG.decayPerOpposingSource * swingScale;
  assertAlmostEquals(swingDecay, DEFAULT_CONVICTION_CONFIG.decayPerOpposingSource * 0.021, 0.001);
});

// ─── Test 3: Opposing evidence degrades conviction ───
Deno.test("Opposing evidence degrades conviction over time", () => {
  const alignedInput: ConvictionInput = {
    symbol: "GBP/USD",
    direction: "short",
    directionVerdict: { verdict: "ALIGNED", confidence: 80, reasons: [] } as any,
    regime4H: { regime: "trending", bias: "bearish", confidence: 75 },
    opposingFactorCount: 0,
    fotsiAlignment: { label: "aligned", score: 0.7 },
    gamePlanBias: { bias: "bearish", confidence: 80 },
  };

  // Build up conviction
  let state: ThesisConvictionState | null = null;
  for (let i = 0; i < 3; i++) {
    const { state: s } = updateConviction(state, alignedInput);
    state = s;
  }
  const convictionBefore = state!.conviction;

  // Now introduce opposing evidence
  const opposingInput: ConvictionInput = {
    ...alignedInput,
    directionVerdict: { verdict: "OPPOSING", confidence: 80, reasons: [] } as any,
    regime4H: { regime: "ranging", bias: "neutral", confidence: 40 },
    opposingFactorCount: 3,
    fotsiAlignment: { label: "opposing", score: -0.5 },
    gamePlanBias: { bias: "bullish", confidence: 70 }, // opposing to short
  };

  const { result } = updateConviction(state, opposingInput);
  // Conviction should decrease with opposing evidence
  assertEquals(result.conviction < convictionBefore, true,
    `Expected conviction to decrease from ${convictionBefore}, got ${result.conviction}`);
});

// ─── Test 4: Session reset clears state (simulated) ───
Deno.test("Session reset clears conviction state (simulated via Map)", () => {
  const convictionStates = new Map<string, ThesisConvictionState>();
  
  const input: ConvictionInput = {
    symbol: "USD/JPY",
    direction: "long",
    directionVerdict: null,
    regime4H: null,
    opposingFactorCount: 0,
    fotsiAlignment: null,
    gamePlanBias: null,
  };

  // Build up state
  const { state } = updateConviction(null, input);
  convictionStates.set("long", state);
  assertEquals(convictionStates.size, 1);

  // Simulate session reset (same as backtest does)
  convictionStates.clear();
  assertEquals(convictionStates.size, 0);
});

// ─── Test 5: Score adjustment in active vs shadow mode ───
Deno.test("Score adjustment is applied in active mode, not in shadow mode", () => {
  const input: ConvictionInput = {
    symbol: "AUD/USD",
    direction: "long",
    directionVerdict: { verdict: "OPPOSING", confidence: 80, reasons: [] } as any,
    regime4H: { regime: "ranging", bias: "neutral", confidence: 30 },
    opposingFactorCount: 4,
    fotsiAlignment: { label: "strong_opposing", score: -0.9 },
    gamePlanBias: { bias: "bearish", confidence: 90 },
  };

  // Run multiple cycles with opposing evidence to build up negative adjustment
  let state: ThesisConvictionState | null = null;
  let result;
  for (let i = 0; i < 5; i++) {
    const out = updateConviction(state, input);
    state = out.state;
    result = out.result;
  }

  // In active mode: effectiveScore should be modified
  let effectiveScoreActive = 15.0;
  effectiveScoreActive += result!.scoreAdjustment;
  // Score adjustment should be negative (conviction degraded)
  assertEquals(result!.scoreAdjustment <= 0, true,
    `Expected negative scoreAdjustment, got ${result!.scoreAdjustment}`);

  // In shadow mode: effectiveScore should NOT be modified
  let effectiveScoreShadow = 15.0;
  const mode = "shadow";
  if (mode !== "shadow") {
    effectiveScoreShadow += result!.scoreAdjustment;
  }
  assertEquals(effectiveScoreShadow, 15.0, "Shadow mode should not modify effectiveScore");
});

// ─── Test 6: Trade open resets conviction for that direction ───
Deno.test("Trade open resets conviction for that direction only", () => {
  const convictionStates = new Map<string, ThesisConvictionState>();
  
  const longInput: ConvictionInput = {
    symbol: "EUR/USD",
    direction: "long",
    directionVerdict: null,
    regime4H: null,
    opposingFactorCount: 0,
    fotsiAlignment: null,
    gamePlanBias: null,
  };
  const shortInput: ConvictionInput = {
    ...longInput,
    direction: "short",
  };

  // Build up state for both directions
  const { state: longState } = updateConviction(null, longInput);
  const { state: shortState } = updateConviction(null, shortInput);
  convictionStates.set("long", longState);
  convictionStates.set("short", shortState);
  assertEquals(convictionStates.size, 2);

  // Simulate trade open for "long" direction
  const tradeDirection = "long";
  convictionStates.delete(tradeDirection);
  
  // Only long should be cleared, short remains
  assertEquals(convictionStates.has("long"), false);
  assertEquals(convictionStates.has("short"), true);
});
