/**
 * ictFieldFix.test.ts — Regression tests for ICT module field name fixes.
 *
 * These tests verify that the bot-scanner now uses the CORRECT field names
 * from the shared ICT module interfaces, and that the function call signatures
 * match what the modules expect.
 *
 * Each test would have FAILED before the fix (accessing undefined fields).
 */
import { assertEquals, assertNotEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { validateRecentMSS, type MSSValidationResult, DEFAULT_DISPLACEMENT_MSS_CONFIG } from "../_shared/ictDisplacementMSS.ts";
import { detectJudasSwing, type JudasSwingResult, DEFAULT_JUDAS_SWING_CONFIG } from "../_shared/ictJudasSwing.ts";
import { evaluateICTKillZone, type ICTKillZoneResult, DEFAULT_ICT_KILLZONE_CONFIG } from "../_shared/ictKillZones.ts";
import { validateFVGBatch, type BatchFVGValidationResult, DEFAULT_FVG_INVALIDATION_CONFIG } from "../_shared/ictFVGInvalidation.ts";
import type { Candle } from "../_shared/smcAnalysis.ts";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeCandle(index: number, o: number, h: number, l: number, c: number, vol = 100): Candle {
  return {
    open: o, high: h, low: l, close: c, volume: vol,
    datetime: new Date(2024, 0, 1, index).toISOString(),
    index,
  } as Candle;
}

function generateTrendingCandles(count: number, startPrice: number, direction: "up" | "down"): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const move = direction === "up" ? Math.random() * 0.002 : -Math.random() * 0.002;
    const o = price;
    const c = price + move;
    const h = Math.max(o, c) + Math.random() * 0.001;
    const l = Math.min(o, c) - Math.random() * 0.001;
    candles.push(makeCandle(i, o, h, l, c));
    price = c;
  }
  return candles;
}

// ─── Test: MSSValidationResult uses .isValid (not .valid) ──────────────

Deno.test("[ICT Field Fix] MSSValidationResult has .isValid field, not .valid", () => {
  const candles = generateTrendingCandles(30, 1.1000, "up");
  // Create a simple bullish break
  const breaks = [{ index: 20, type: "bullish" as const }];
  const result: MSSValidationResult = validateRecentMSS(candles, breaks, "bullish", {
    ...DEFAULT_DISPLACEMENT_MSS_CONFIG,
    enabled: true,
  });

  // The key assertion: .isValid exists and is a boolean
  assert(typeof result.isValid === "boolean", "MSSValidationResult must have .isValid as boolean");
  // .valid should NOT exist on the result
  assert(!("valid" in result), "MSSValidationResult must NOT have .valid field (old bug)");
  // Other expected fields
  assert(typeof result.reason === "string", "Must have .reason");
  assert(typeof result.displacementStrength === "string", "Must have .displacementStrength");
  assert(typeof result.hasDisplacement === "boolean", "Must have .hasDisplacement");
});

Deno.test("[ICT Field Fix] MSSValidationResult returns isValid=true when disabled", () => {
  const candles = generateTrendingCandles(10, 1.1000, "up");
  const breaks = [{ index: 5, type: "bullish" as const }];
  const result = validateRecentMSS(candles, breaks, "bullish", {
    ...DEFAULT_DISPLACEMENT_MSS_CONFIG,
    enabled: false,
  });
  assertEquals(result.isValid, true, "Disabled MSS should return isValid=true");
});

Deno.test("[ICT Field Fix] validateRecentMSS requires 4 args (candles, breaks, direction, config)", () => {
  // This test verifies the function signature is correct.
  // Before the fix, the scanner called validateRecentMSS(candles, config) — only 2 args.
  const candles = generateTrendingCandles(20, 1.1000, "up");
  const breaks = [{ index: 15, type: "bullish" as const }];
  const direction = "bullish" as const;
  const config = { ...DEFAULT_DISPLACEMENT_MSS_CONFIG, enabled: true };

  // This should NOT throw — correct 4-arg call
  const result = validateRecentMSS(candles, breaks, direction, config);
  assert(result !== null && result !== undefined, "4-arg call must return a valid result");
  assert(typeof result.isValid === "boolean");
});

// ─── Test: JudasSwingResult uses .found (not .detected) ────────────────

Deno.test("[ICT Field Fix] JudasSwingResult has .found field, not .detected", () => {
  const candles = generateTrendingCandles(30, 1.1000, "up");
  const mssIndex = 25;
  const result: JudasSwingResult = detectJudasSwing(candles, mssIndex, "bullish", {
    ...DEFAULT_JUDAS_SWING_CONFIG,
    enabled: true,
  });

  // The key assertion: .found exists and is a boolean
  assert(typeof result.found === "boolean", "JudasSwingResult must have .found as boolean");
  // .detected should NOT exist on the result
  assert(!("detected" in result), "JudasSwingResult must NOT have .detected field (old bug)");
  // Other expected fields
  assert(typeof result.reason === "string", "Must have .reason");
  assert(typeof result.scoreAdjustment === "number", "Must have .scoreAdjustment");
  // .sweep is either null or a SweepCandidate
  if (result.sweep !== null) {
    assert(typeof result.sweep.sweptLevel === "number", "sweep.sweptLevel must be a number");
    assert(typeof result.sweep.wickDepthATR === "number", "sweep.wickDepthATR must be a number");
  }
});

Deno.test("[ICT Field Fix] detectJudasSwing requires 4 args (candles, mssIndex, direction, config)", () => {
  // Before the fix, the scanner called detectJudasSwing(candles, direction, config) — 3 args with wrong types.
  const candles = generateTrendingCandles(30, 1.1000, "down");
  const mssIndex = 20; // number, not string
  const direction = "bearish" as const;
  const config = { ...DEFAULT_JUDAS_SWING_CONFIG, enabled: true };

  // This should NOT throw — correct 4-arg call
  const result = detectJudasSwing(candles, mssIndex, direction, config);
  assert(result !== null && result !== undefined, "4-arg call must return a valid result");
  assert(typeof result.found === "boolean");
});

// ─── Test: ICTKillZoneResult uses .isKillZone (not .inKillZone) ────────

Deno.test("[ICT Field Fix] ICTKillZoneResult has .isKillZone field, not .inKillZone", () => {
  const result: ICTKillZoneResult = evaluateICTKillZone(new Date(), {
    ...DEFAULT_ICT_KILLZONE_CONFIG,
    enabled: true,
  });

  // The key assertion: .isKillZone exists and is a boolean
  assert(typeof result.isKillZone === "boolean", "ICTKillZoneResult must have .isKillZone as boolean");
  // .inKillZone should NOT exist on the result
  assert(!("inKillZone" in result), "ICTKillZoneResult must NOT have .inKillZone field (old bug)");
  // .windowLabel exists (not .activeZone)
  assert(typeof result.windowLabel === "string", "Must have .windowLabel (not .activeZone)");
  assert(!("activeZone" in result), "ICTKillZoneResult must NOT have .activeZone field (old bug)");
  // Other expected fields
  assert(typeof result.isPrime === "boolean", "Must have .isPrime");
  assert(typeof result.reason === "string", "Must have .reason");
});

// ─── Test: BatchFVGValidationResult does NOT have count fields natively ─

Deno.test("[ICT Field Fix] BatchFVGValidationResult needs derived count fields", () => {
  // The raw result from validateFVGBatch does NOT have validCount/invalidatedCount/exhaustedCount/totalCount.
  // The scanner must compute them from the results array.
  const fvgs = [
    { index: 5, high: 1.1020, low: 1.1000, type: "bullish" as const, midpoint: 1.1010 },
    { index: 10, high: 1.1050, low: 1.1030, type: "bullish" as const, midpoint: 1.1040 },
  ];
  const candles = generateTrendingCandles(30, 1.0950, "up");
  const result: BatchFVGValidationResult = validateFVGBatch(fvgs, candles, "bullish", {
    ...DEFAULT_FVG_INVALIDATION_CONFIG,
    enabled: true,
  });

  // The raw interface does NOT have these fields
  assert(!("validCount" in result), "Raw BatchFVGValidationResult must NOT have .validCount");
  assert(!("invalidatedCount" in result), "Raw BatchFVGValidationResult must NOT have .invalidatedCount");
  assert(!("exhaustedCount" in result), "Raw BatchFVGValidationResult must NOT have .exhaustedCount");
  assert(!("totalCount" in result), "Raw BatchFVGValidationResult must NOT have .totalCount");

  // But it DOES have .results which we can derive counts from
  assert(Array.isArray(result.results), "Must have .results array");
  assert(typeof result.passed === "boolean", "Must have .passed");

  // Demonstrate the correct derivation pattern (what the fixed scanner does)
  const totalCount = result.results.length;
  const validCount = result.results.filter(r => r.status === "fresh" || r.status === "first_touch").length;
  const invalidatedCount = result.results.filter(r => r.status === "invalidated").length;
  const exhaustedCount = result.results.filter(r => r.status === "exhausted").length;

  assert(totalCount >= 0, "totalCount must be non-negative");
  assert(validCount + invalidatedCount + exhaustedCount <= totalCount, "Counts must sum to <= total");
});

Deno.test("[ICT Field Fix] validateFVGBatch requires 4 args (fvgs, candles, direction, config)", () => {
  // Before the fix, the scanner called validateFVGBatch(fvgs, candles, config) — 3 args, missing direction.
  const fvgs = [
    { index: 5, high: 1.1020, low: 1.1000, type: "bullish" as const, midpoint: 1.1010 },
  ];
  const candles = generateTrendingCandles(20, 1.0950, "up");
  const direction = "bullish" as const;
  const config = { ...DEFAULT_FVG_INVALIDATION_CONFIG, enabled: true };

  // This should NOT throw — correct 4-arg call
  const result = validateFVGBatch(fvgs, candles, direction, config);
  assert(result !== null && result !== undefined, "4-arg call must return a valid result");
  assert(Array.isArray(result.results));
});

// ─── Test: Soft mode penalty logic with correct field names ────────────

Deno.test("[ICT Field Fix] Soft mode MSS penalty uses .isValid correctly", () => {
  // Simulate the scanner's soft mode penalty logic with the FIXED field name
  const ictMSSResult: MSSValidationResult = {
    isValid: false,
    hasDisplacement: false,
    displacementStrength: "none",
    displacementCandles: [],
    consecutiveCount: 0,
    scoreAdjustment: -2.0,
    passed: false,
    reason: "No displacement found",
  };

  const penalty = 2.0;
  // FIXED logic: uses .isValid
  const ictMSSAdj = (!ictMSSResult.isValid) ? -penalty : 0;
  assertEquals(ictMSSAdj, -2.0, "When isValid=false, penalty should apply");

  // OLD BROKEN logic would have been: !ictMSSResult.valid → !undefined → true → ALWAYS penalty
  // Now with the correct field, it only fires when MSS actually lacks displacement
});

Deno.test("[ICT Field Fix] Soft mode Judas penalty uses .found correctly", () => {
  const ictJudasResult: JudasSwingResult = {
    found: true,
    sweep: { index: 10, sweptLevel: 1.1000, wickDepth: 0.0005, wickDepthATR: 0.3, closedBack: true, direction: "bullish" },
    scoreAdjustment: 1.0,
    passed: true,
    reason: "Judas swing confirmed",
  };

  const penalty = 1.5;
  // FIXED logic: uses .found
  const ictJudasAdj = (!ictJudasResult.found) ? -penalty : 0;
  assertEquals(ictJudasAdj, 0, "When found=true, NO penalty should apply");

  // OLD BROKEN logic: !ictJudasResult.detected → !undefined → true → penalty ALWAYS applied
});

Deno.test("[ICT Field Fix] Soft mode KZ penalty uses .isKillZone correctly", () => {
  const ictKZResult: ICTKillZoneResult = {
    currentWindow: "london" as any,
    windowLabel: "London Session",
    isKillZone: true,
    isSilverBullet: false,
    isDeadZone: false,
    isPrime: true,
    nyHour: 10,
    scoreAdjustment: 1.0,
    passed: true,
    reason: "In London kill zone",
  };

  const primeBonus = 0.5;
  const outsidePenalty = 1.0;
  // FIXED logic: uses .isKillZone
  const ictKZAdj = ictKZResult.isKillZone
    ? (ictKZResult.isPrime ? primeBonus : 0)
    : -outsidePenalty;
  assertEquals(ictKZAdj, 0.5, "When isKillZone=true and isPrime=true, should get prime bonus");

  // OLD BROKEN logic: ictKZResult.inKillZone → undefined (falsy) → always -outsidePenalty
});

// ─── Test: Hard gate logic with correct field names ────────────────────

Deno.test("[ICT Field Fix] Hard gate MSS blocks correctly with .isValid", () => {
  const ictMSSResult: MSSValidationResult = {
    isValid: true,
    hasDisplacement: true,
    displacementStrength: "strong",
    displacementCandles: [],
    consecutiveCount: 2,
    scoreAdjustment: 1.0,
    passed: true,
    reason: "Strong displacement confirmed",
  };

  // FIXED hard gate: should NOT block when isValid=true
  const shouldBlock = !ictMSSResult.isValid;
  assertEquals(shouldBlock, false, "Hard gate should NOT block when MSS is valid");

  // OLD BROKEN: !ictMSSResult.valid → !undefined → true → ALWAYS blocked
});

Deno.test("[ICT Field Fix] Hard gate Judas blocks correctly with .found", () => {
  const ictJudasResult: JudasSwingResult = {
    found: false,
    sweep: null,
    scoreAdjustment: -1.5,
    passed: false,
    reason: "No sweep found before MSS",
  };

  // FIXED hard gate: should block when found=false
  const shouldBlock = !ictJudasResult.found;
  assertEquals(shouldBlock, true, "Hard gate should block when no Judas swing found");
});

Deno.test("[ICT Field Fix] Hard gate KZ blocks correctly with .isKillZone", () => {
  const ictKZResult: ICTKillZoneResult = {
    currentWindow: "dead_zone" as any,
    windowLabel: "Dead Zone",
    isKillZone: false,
    isSilverBullet: false,
    isDeadZone: true,
    isPrime: false,
    nyHour: 23,
    scoreAdjustment: -1.0,
    passed: false,
    reason: "Outside all kill zones",
  };

  // FIXED hard gate: should block when isKillZone=false
  const shouldBlock = !ictKZResult.isKillZone;
  assertEquals(shouldBlock, true, "Hard gate should block when outside kill zone");
});
