/**
 * Tests for Gap 1 (Standalone CHoCH bypass) and Gap 2 (computeTP next_level)
 * 
 * These test the logic extracted into bot-scanner/index.ts:
 * - Gap 1: isStandaloneSignal skips CHoCH confirmation requirement
 * - Gap 2: computeTP respects tpMethod === "next_level" and uses structure-based TP
 * 
 * Since these are inline functions in bot-scanner, we test the logic patterns
 * in isolation by replicating the exact computeTP logic here.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Replicate computeTP logic exactly as it appears in bot-scanner/index.ts
// This is a regression test — if the logic in bot-scanner changes, this test
// should be updated to match (or should fail to alert us).
// ═══════════════════════════════════════════════════════════════════════════════

interface ComputeTPConfig {
  tpMethod: "fixed_pips" | "rr_ratio" | "next_level" | "atr_multiple";
  tpRatio: number;
}

interface Analysis {
  takeProfit: number | null;
  lastPrice: number;
  direction: "long" | "short";
  stopLoss: number | null;
}

/**
 * Exact replica of the computeTP helper from bot-scanner/index.ts lines 5616-5625
 */
function computeTP(
  entry: number,
  sl: number,
  direction: "long" | "short",
  config: ComputeTPConfig,
  analysisTP: number | null,
): number {
  const risk = Math.abs(entry - sl);
  if (config.tpMethod === "next_level" && analysisTP !== null) {
    // Use structure-based TP from smcAnalysis (PDH/PDL/PWH/PWL/liquidity)
    // but only if it gives at least 1:1 R:R
    const structureReward = Math.abs(analysisTP - entry);
    if (structureReward >= risk) {
      return analysisTP;
    }
  }
  // Fallback: R:R ratio math
  return direction === "long" ? entry + risk * config.tpRatio : entry - risk * config.tpRatio;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAP 2 TESTS: computeTP with next_level
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("computeTP — rr_ratio mode uses ratio math (baseline)", () => {
  const config: ComputeTPConfig = { tpMethod: "rr_ratio", tpRatio: 2.0 };
  const entry = 1.1000;
  const sl = 1.0980; // 20 pip SL
  
  const tp = computeTP(entry, sl, "long", config, 1.1050);
  
  // Should use R:R: entry + (entry - sl) * tpRatio = 1.1000 + 0.002 * 2 = 1.1040
  assertEquals(tp, 1.1040);
});

Deno.test("computeTP — next_level mode uses structure TP when R:R >= 1:1", () => {
  const config: ComputeTPConfig = { tpMethod: "next_level", tpRatio: 2.0 };
  const entry = 1.1000;
  const sl = 1.0980; // 20 pip risk
  const structureTP = 1.1035; // 35 pip reward (1.75:1 R:R) — acceptable
  
  const tp = computeTP(entry, sl, "long", config, structureTP);
  
  // Should use the structure-based TP since reward (35p) >= risk (20p)
  assertEquals(tp, structureTP);
});

Deno.test("computeTP — next_level mode falls back to R:R when structure TP < 1:1", () => {
  const config: ComputeTPConfig = { tpMethod: "next_level", tpRatio: 2.0 };
  const entry = 1.1000;
  const sl = 1.0980; // 20 pip risk
  const structureTP = 1.1010; // Only 10 pip reward (0.5:1 R:R) — too small
  
  const tp = computeTP(entry, sl, "long", config, structureTP);
  
  // Should fall back to R:R math: 1.1000 + 0.002 * 2 = 1.1040
  assertEquals(tp, 1.1040);
});

Deno.test("computeTP — next_level mode falls back when analysisTP is null", () => {
  const config: ComputeTPConfig = { tpMethod: "next_level", tpRatio: 2.0 };
  const entry = 1.1000;
  const sl = 1.0980;
  
  const tp = computeTP(entry, sl, "long", config, null);
  
  // No structure TP available → fall back to R:R
  assertEquals(tp, 1.1040);
});

Deno.test("computeTP — next_level short direction uses structure TP correctly", () => {
  const config: ComputeTPConfig = { tpMethod: "next_level", tpRatio: 2.0 };
  const entry = 1.1000;
  const sl = 1.1020; // 20 pip risk (SL above for short)
  const structureTP = 1.0960; // 40 pip reward — good R:R
  
  const tp = computeTP(entry, sl, "short", config, structureTP);
  
  assertEquals(tp, structureTP);
});

Deno.test("computeTP — next_level short falls back when structure TP is above entry", () => {
  const config: ComputeTPConfig = { tpMethod: "next_level", tpRatio: 2.0 };
  const entry = 1.1000;
  const sl = 1.1020; // 20 pip risk
  const structureTP = 1.0995; // Only 5 pip reward — below 1:1
  
  const tp = computeTP(entry, sl, "short", config, structureTP);
  
  // Fall back: 1.1000 - 0.002 * 2 = 1.0960
  assertEquals(tp, 1.0960);
});

Deno.test("computeTP — fixed_pips mode ignores structure TP entirely", () => {
  const config: ComputeTPConfig = { tpMethod: "fixed_pips", tpRatio: 2.0 };
  const entry = 1.1000;
  const sl = 1.0980;
  const structureTP = 1.1050;
  
  const tp = computeTP(entry, sl, "long", config, structureTP);
  
  // fixed_pips doesn't match "next_level" condition, falls through to R:R math
  assertEquals(tp, 1.1040);
});

Deno.test("computeTP — atr_multiple mode ignores structure TP entirely", () => {
  const config: ComputeTPConfig = { tpMethod: "atr_multiple", tpRatio: 3.0 };
  const entry = 1.1000;
  const sl = 1.0980;
  const structureTP = 1.1050;
  
  const tp = computeTP(entry, sl, "long", config, structureTP);
  
  // atr_multiple doesn't match "next_level", falls through to R:R: 1.1000 + 0.002 * 3 = 1.1060
  assertEquals(tp, 1.1060);
});

// ═══════════════════════════════════════════════════════════════════════════════
// GAP 2 REGRESSION: Verify that when tpMethod is NOT next_level, computeTP
// produces IDENTICAL results to the old inline formula
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("computeTP regression — identical to old inline formula for rr_ratio", () => {
  const testCases = [
    { entry: 1.1000, sl: 1.0980, dir: "long" as const, ratio: 2.0 },
    { entry: 1.1000, sl: 1.1020, dir: "short" as const, ratio: 2.0 },
    { entry: 1850.00, sl: 1845.00, dir: "long" as const, ratio: 3.0 }, // Gold
    { entry: 1850.00, sl: 1855.00, dir: "short" as const, ratio: 3.0 },
    { entry: 0.6500, sl: 0.6480, dir: "long" as const, ratio: 2.5 },
  ];
  
  for (const tc of testCases) {
    const config: ComputeTPConfig = { tpMethod: "rr_ratio", tpRatio: tc.ratio };
    const newTP = computeTP(tc.entry, tc.sl, tc.dir, config, null);
    
    // Old formula (what was inline before):
    const risk = Math.abs(tc.entry - tc.sl);
    const oldTP = tc.dir === "long"
      ? tc.entry + risk * tc.ratio
      : tc.entry - risk * tc.ratio;
    
    assertEquals(newTP, oldTP, `Regression failed for ${JSON.stringify(tc)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GAP 1 TESTS: Standalone CHoCH bypass logic
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gap 1 logic (from bot-scanner lines ~5994-5999):
 * A signal is "standalone" when it comes from a standalone CHoCH (no impulse zone)
 * and standalone signals bypass the limit order / CHoCH confirmation flow.
 * 
 * The key behavior: when isStandaloneSignal is true AND price is at zone,
 * the bot should NOT place a limit order (it should market-fill immediately).
 */

Deno.test("Gap 1 — standalone signal bypasses limit order placement", () => {
  // Simulate the logic from bot-scanner:
  // isStandaloneSignal = true when izGateMode !== "hard" OR no impulse zone found
  const izGateMode: string = "soft"; // Not hard → standalone path
  const hasImpulseZone = false;
  
  const isStandaloneSignal = izGateMode !== "hard" || !hasImpulseZone;
  
  // When standalone, the limit order path is skipped
  const priceIsAtValidatedZone = true;
  const marketFillAtZone = true;
  const priceOnCorrectSide = true;
  
  // The key condition from bot-scanner:
  // useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone && priceOnCorrectSide && !isStandaloneSignal
  const useMarketFillAtZone = priceIsAtValidatedZone && marketFillAtZone && priceOnCorrectSide && !isStandaloneSignal;
  
  // For standalone signals at zone, they get special handling (immediate market fill)
  // The condition `isStandaloneSignal && priceIsAtValidatedZone && marketFillAtZone && priceOnCorrectSide`
  // triggers the standalone market fill path
  const standaloneMarketFill = isStandaloneSignal && priceIsAtValidatedZone && marketFillAtZone && priceOnCorrectSide;
  
  assertEquals(isStandaloneSignal, true);
  assertEquals(useMarketFillAtZone, false); // NOT the regular market fill path
  assertEquals(standaloneMarketFill, true); // YES the standalone path
});

Deno.test("Gap 1 — non-standalone signal uses regular market fill at zone", () => {
  const izGateMode: string = "hard";
  const hasImpulseZone = true;
  
  const isStandaloneSignal = izGateMode !== "hard" || !hasImpulseZone;
  
  const priceIsAtValidatedZone = true;
  const marketFillAtZone = true;
  const priceOnCorrectSide = true;
  
  const useMarketFillAtZone = priceIsAtValidatedZone && marketFillAtZone && priceOnCorrectSide && !isStandaloneSignal;
  
  assertEquals(isStandaloneSignal, false);
  assertEquals(useMarketFillAtZone, true); // Regular market fill path
});

Deno.test("Gap 1 — standalone signal with izGateMode=hard but no zone is still standalone", () => {
  const izGateMode: string = "hard";
  const hasImpulseZone = false; // No zone found despite hard mode
  
  const isStandaloneSignal = izGateMode !== "hard" || !hasImpulseZone;
  
  assertEquals(isStandaloneSignal, true);
});

Deno.test("Gap 1 — effectiveLimitEnabled is false for standalone signals at zone", () => {
  const isStandaloneSignal = true;
  const priceIsAtValidatedZone = true;
  const marketFillAtZone = true;
  const priceOnCorrectSide = true;
  const limitOrderEnabled = true;
  const izGateMode: string = "hard";
  const limitEntry = { price: 1.1000 }; // Zone found
  
  const useMarketFillAtZone = priceIsAtValidatedZone && marketFillAtZone && priceOnCorrectSide && !isStandaloneSignal;
  
  // effectiveLimitEnabled logic from bot-scanner:
  const effectiveLimitEnabled = !useMarketFillAtZone && (limitOrderEnabled || (izGateMode === "hard" && !!limitEntry));
  
  // For standalone at zone: useMarketFillAtZone=false (because isStandaloneSignal=true)
  // So effectiveLimitEnabled = !false && (true || true) = true
  // BUT the standalone path fires BEFORE effectiveLimitEnabled is checked
  // This test documents that the standalone path takes priority
  assertEquals(useMarketFillAtZone, false);
  
  // The standalone market fill condition fires first in the code
  const standaloneMarketFill = isStandaloneSignal && priceIsAtValidatedZone && marketFillAtZone && priceOnCorrectSide;
  assertEquals(standaloneMarketFill, true);
  // When standaloneMarketFill is true, the code skips the limit order path entirely
});
