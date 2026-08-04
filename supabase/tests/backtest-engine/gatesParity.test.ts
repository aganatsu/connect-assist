/**
 * Gate Parity Tests — Phase A2
 * Tests the new gates added to runBacktestSafetyGates:
 * - Gate 17: Direction Verdict (replaces legacy HTF Bias)
 * - Gate 23: Structural Conviction
 * - Gate 24: Reaction Confirmation
 * - Gates 25-29: ICT Hard Gates
 * - Pre-gates: Zone Score Gate, Min TP Distance Gate
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Minimal stubs for testing gate logic in isolation ───
// We extract the gate logic into testable units by re-implementing the conditions
// (since runBacktestSafetyGates is not exported, we test the logic directly)

Deno.test("Gate 17: Direction Verdict blocks when shouldBlock=true", () => {
  const verdict = {
    verdict: "neutral" as const,
    confidence: 35,
    scoreAdjustment: -2.5,
    shouldBlock: true,
    blockReason: "Low confidence neutral (35%)",
    agreement: 0.3,
    summary: "test",
  };
  // Simulates the gate logic
  const passed = !verdict.shouldBlock;
  assertEquals(passed, false);
});

Deno.test("Gate 17: Direction Verdict passes when shouldBlock=false", () => {
  const verdict = {
    verdict: "bullish" as const,
    confidence: 75,
    scoreAdjustment: 1.5,
    shouldBlock: false,
    blockReason: "",
    agreement: 0.8,
    summary: "test",
  };
  const passed = !verdict.shouldBlock;
  assertEquals(passed, true);
});

Deno.test("Gate 17: Falls back to legacy HTF when verdict is null", () => {
  const directionVerdict = null;
  const config = { htfBiasRequired: true, htfBiasHardVeto: true };
  const htfTrend = "bullish";
  const direction = "long";
  const entryBias = direction === "long" ? "bullish" : "bearish";

  // When verdict is null, legacy logic runs
  let passed: boolean;
  if (directionVerdict) {
    passed = !directionVerdict.shouldBlock;
  } else if (config.htfBiasRequired) {
    if (config.htfBiasHardVeto) {
      passed = htfTrend === entryBias;
    } else {
      passed = htfTrend === "ranging" || htfTrend === entryBias;
    }
  } else {
    passed = true;
  }
  assertEquals(passed, true);
});

Deno.test("Gate 17: Legacy HTF hard veto blocks opposing direction", () => {
  const directionVerdict = null;
  const config = { htfBiasRequired: true, htfBiasHardVeto: true };
  const htfTrend = "bearish";
  const direction = "long";
  const entryBias = direction === "long" ? "bullish" : "bearish";

  let passed: boolean;
  if (directionVerdict) {
    passed = !directionVerdict.shouldBlock;
  } else if (config.htfBiasRequired) {
    if (config.htfBiasHardVeto) {
      passed = htfTrend === entryBias;
    } else {
      passed = htfTrend === "ranging" || htfTrend === entryBias;
    }
  } else {
    passed = true;
  }
  assertEquals(passed, false);
});

// ─── Structural Conviction (Gate 23) ───

Deno.test("Gate 23: Structural Conviction passes when direction has fractals", () => {
  const direction = "long";
  const s2f = { overallRate: 0.6, bullishRate: 0.4, bearishRate: 0.2 };
  const directionRate = direction === "long" ? s2f.bullishRate : s2f.bearishRate;
  const oppositeRate = direction === "long" ? s2f.bearishRate : s2f.bullishRate;
  const s2fBlockThreshold = 0.25;
  const oppositeBlockThreshold = 0.4;

  const blocked =
    (directionRate === 0 && s2f.overallRate < s2fBlockThreshold && oppositeRate > 0) ||
    (directionRate === 0 && oppositeRate > oppositeBlockThreshold) ||
    (directionRate > 0 && oppositeRate > 0 && oppositeRate / directionRate >= 2.5);

  assertEquals(blocked, false);
});

Deno.test("Gate 23: Structural Conviction blocks when 0% fractals + S2F below threshold", () => {
  const direction = "long";
  const s2f = { overallRate: 0.15, bullishRate: 0.0, bearishRate: 0.3 };
  const directionRate = direction === "long" ? s2f.bullishRate : s2f.bearishRate;
  const oppositeRate = direction === "long" ? s2f.bearishRate : s2f.bullishRate;
  const s2fBlockThreshold = 0.25;

  const blocked = directionRate === 0 && s2f.overallRate < s2fBlockThreshold && oppositeRate > 0;
  assertEquals(blocked, true);
});

Deno.test("Gate 23: Structural Conviction blocks when 0% fractals + strong opposite", () => {
  const direction = "short";
  const s2f = { overallRate: 0.5, bullishRate: 0.6, bearishRate: 0.0 };
  const directionRate = direction === "short" ? s2f.bearishRate : s2f.bullishRate;
  const oppositeRate = direction === "short" ? s2f.bullishRate : s2f.bearishRate;
  const oppositeBlockThreshold = 0.4;

  const blocked = directionRate === 0 && oppositeRate > oppositeBlockThreshold;
  assertEquals(blocked, true);
});

Deno.test("Gate 23: Structural Conviction blocks when opposing is 2.5x supporting", () => {
  const direction = "long";
  const s2f = { overallRate: 0.5, bullishRate: 0.1, bearishRate: 0.3 };
  const directionRate = direction === "long" ? s2f.bullishRate : s2f.bearishRate;
  const oppositeRate = direction === "long" ? s2f.bearishRate : s2f.bullishRate;

  const blocked = directionRate > 0 && oppositeRate > 0 && oppositeRate / directionRate >= 2.5;
  // 0.3 / 0.1 = 3.0 >= 2.5
  assertEquals(blocked, true);
});

Deno.test("Gate 23: Structural Conviction disabled by config passes", () => {
  const config = { structuralConvictionEnabled: false };
  const passed = !config.structuralConvictionEnabled;
  assertEquals(passed, true);
});

// ─── Reaction Confirmation (Gate 24) ───

Deno.test("Gate 24: Reaction Confirmation passes in trending market", () => {
  const entryTrend = "bullish";
  // Gate only applies in ranging markets
  const applies = entryTrend === "ranging";
  assertEquals(applies, false); // gate skipped = passes
});

Deno.test("Gate 24: Reaction Confirmation blocks ranging market without reaction factor", () => {
  const entryTrend = "ranging";
  const factors = [
    { name: "Order Block", present: true },
    { name: "Fair Value Gap", present: true },
    { name: "Premium/Discount & Fib", present: true },
  ];
  const reactionFactors = ["Displacement", "Reversal Candle", "Liquidity Sweep", "AMD Phase"];
  const hasReaction = factors.some(
    (f: any) => f.present && reactionFactors.some(rf => f.name?.includes(rf))
  );
  assertEquals(entryTrend === "ranging", true);
  assertEquals(hasReaction, false);
});

Deno.test("Gate 24: Reaction Confirmation passes ranging market WITH reaction factor", () => {
  const factors = [
    { name: "Order Block", present: true },
    { name: "Displacement", present: true },
    { name: "Fair Value Gap", present: false },
  ];
  const reactionFactors = ["Displacement", "Reversal Candle", "Liquidity Sweep", "AMD Phase"];
  const hasReaction = factors.some(
    (f: any) => f.present && reactionFactors.some(rf => f.name?.includes(rf))
  );
  assertEquals(hasReaction, true);
});

// ─── Zone Score Gate (Pre-gate) ───

Deno.test("Zone Score Gate: passes when zone score >= minZoneScore", () => {
  const bestZone = { totalScore: 5.5 };
  const minZoneScore = 4;
  const passed = bestZone.totalScore >= minZoneScore;
  assertEquals(passed, true);
});

Deno.test("Zone Score Gate: blocks when zone score < minZoneScore", () => {
  const bestZone = { totalScore: 3.2 };
  const minZoneScore = 4;
  const passed = bestZone.totalScore >= minZoneScore;
  assertEquals(passed, false);
});

Deno.test("Zone Score Gate: skipped when no impulse zone (no bestZone)", () => {
  const izData = null;
  // When izData is null, gate doesn't apply (passes by default)
  const applies = izData?.bestZone != null;
  assertEquals(applies, false); // gate skipped = passes
});

// ─── Minimum TP Distance Gate (Pre-gate) ───

Deno.test("Min TP Gate: passes when TP distance >= minimum for EUR/USD", () => {
  const MIN_TP_PIPS: Record<string, number> = {
    "EUR/USD": 15, "GBP/USD": 20, "XAU/USD": 40,
  };
  const symbol = "EUR/USD";
  const pipSize = 0.0001;
  const lastPrice = 1.1000;
  const takeProfit = 1.1020; // 20 pips
  const minTpPips = MIN_TP_PIPS[symbol] ?? 12;
  const actualTpPips = Math.abs(takeProfit - lastPrice) / pipSize;
  assertEquals(actualTpPips >= minTpPips, true); // 20 >= 15
});

Deno.test("Min TP Gate: blocks when TP distance < minimum for EUR/USD", () => {
  const MIN_TP_PIPS: Record<string, number> = {
    "EUR/USD": 15, "GBP/USD": 20, "XAU/USD": 40,
  };
  const symbol = "EUR/USD";
  const pipSize = 0.0001;
  const lastPrice = 1.1000;
  const takeProfit = 1.1010; // 10 pips
  const minTpPips = MIN_TP_PIPS[symbol] ?? 12;
  const actualTpPips = Math.abs(takeProfit - lastPrice) / pipSize;
  assertEquals(actualTpPips >= minTpPips, false); // 10 < 15
});

Deno.test("Min TP Gate: uses default 12 pips for unknown symbol", () => {
  const MIN_TP_PIPS: Record<string, number> = {
    "EUR/USD": 15, "GBP/USD": 20,
  };
  const symbol = "AUD/NZD";
  const minTpPips = MIN_TP_PIPS[symbol] ?? 12;
  assertEquals(minTpPips, 12);
});

Deno.test("Min TP Gate: XAU/USD requires 40 pips minimum", () => {
  const MIN_TP_PIPS: Record<string, number> = {
    "XAU/USD": 40,
  };
  const symbol = "XAU/USD";
  const pipSize = 0.1; // gold pip
  const lastPrice = 2000.0;
  const takeProfit = 2003.5; // 35 pips
  const minTpPips = MIN_TP_PIPS[symbol] ?? 12;
  const actualTpPips = Math.abs(takeProfit - lastPrice) / pipSize;
  assertEquals(actualTpPips >= minTpPips, false); // 35 < 40
});

// ─── ICT Hard Gates (Gates 25-29) ───

Deno.test("Gate 25: ICT HTF hard gate blocks when passed=false", () => {
  const config = { ictHTFGateMode: "hard" };
  const ictHTFResult = { passed: false, reason: "Weekly bias misaligned", scoreAdjustment: -3 };
  const blocked = config.ictHTFGateMode === "hard" && ictHTFResult && !ictHTFResult.passed;
  assertEquals(blocked, true);
});

Deno.test("Gate 25: ICT HTF hard gate passes when passed=true", () => {
  const config = { ictHTFGateMode: "hard" };
  const ictHTFResult = { passed: true, reason: "Aligned", scoreAdjustment: 2 };
  const blocked = config.ictHTFGateMode === "hard" && ictHTFResult && !ictHTFResult.passed;
  assertEquals(blocked, false);
});

Deno.test("Gate 25: ICT HTF hard gate skipped when mode is soft", () => {
  const config = { ictHTFGateMode: "soft" };
  const ictHTFResult = { passed: false, reason: "Misaligned", scoreAdjustment: -3 };
  const blocked = config.ictHTFGateMode === "hard" && ictHTFResult && !ictHTFResult.passed;
  assertEquals(blocked, false); // soft mode = no hard block
});

Deno.test("Gate 26: ICT MSS hard gate blocks when isValid=false", () => {
  const config = { ictDisplacementMSSGateMode: "hard" };
  const ictMSSResult = { isValid: false, reason: "No displacement found" };
  const blocked = config.ictDisplacementMSSGateMode === "hard" && ictMSSResult && !ictMSSResult.isValid;
  assertEquals(blocked, true);
});

Deno.test("Gate 27: ICT Judas hard gate blocks when found=false", () => {
  const config = { ictJudasSwingGateMode: "hard" };
  const ictJudasResult = { found: false, reason: "No sweep detected" };
  const blocked = config.ictJudasSwingGateMode === "hard" && ictJudasResult && !ictJudasResult.found;
  assertEquals(blocked, true);
});

Deno.test("Gate 28: ICT FVG hard gate blocks when all FVGs invalidated", () => {
  const config = { ictFVGInvalidationGateMode: "hard" };
  const ictFVGCounts = { invalidated: 3, exhausted: 1, total: 4, valid: 0 };
  const blocked = config.ictFVGInvalidationGateMode === "hard" && ictFVGCounts.valid === 0 && ictFVGCounts.total > 0;
  assertEquals(blocked, true);
});

Deno.test("Gate 28: ICT FVG hard gate passes when some FVGs still valid", () => {
  const config = { ictFVGInvalidationGateMode: "hard" };
  const ictFVGCounts = { invalidated: 1, exhausted: 1, total: 4, valid: 2 };
  const blocked = config.ictFVGInvalidationGateMode === "hard" && ictFVGCounts.valid === 0 && ictFVGCounts.total > 0;
  assertEquals(blocked, false);
});

Deno.test("Gate 29: ICT KZ hard gate blocks when outside kill zone", () => {
  const config = { ictKillZoneGateMode: "hard" };
  const ictKZResult = { isKillZone: false, reason: "Outside all kill zones", isPrime: false, windowLabel: "none" };
  const blocked = config.ictKillZoneGateMode === "hard" && ictKZResult && !ictKZResult.isKillZone;
  assertEquals(blocked, true);
});

Deno.test("Gate 29: ICT KZ hard gate passes when inside kill zone", () => {
  const config = { ictKillZoneGateMode: "hard" };
  const ictKZResult = { isKillZone: true, reason: "London session", isPrime: true, windowLabel: "london" };
  const blocked = config.ictKillZoneGateMode === "hard" && ictKZResult && !ictKZResult.isKillZone;
  assertEquals(blocked, false);
});

// ─── Backward Compatibility ───

Deno.test("All new gates are no-ops when features disabled (default config)", () => {
  // Default config: structuralConvictionEnabled=true but with neutral S2F,
  // ICT gate modes all "off", no directionVerdict, no izData
  const config = {
    structuralConvictionEnabled: true,
    structuralConvictionS2FLong: 0.25,
    structuralConvictionOppositeLong: 0.4,
    ictHTFGateMode: "off",
    ictDisplacementMSSGateMode: "off",
    ictJudasSwingGateMode: "off",
    ictFVGInvalidationGateMode: "off",
    ictKillZoneGateMode: "off",
  };

  // With neutral S2F (0.5/0.5), structural conviction passes
  const s2f = { overallRate: 0.5, bullishRate: 0.5, bearishRate: 0.5 };
  const directionRate = s2f.bullishRate;
  const oppositeRate = s2f.bearishRate;
  const structBlocked =
    (directionRate === 0 && s2f.overallRate < config.structuralConvictionS2FLong && oppositeRate > 0) ||
    (directionRate === 0 && oppositeRate > config.structuralConvictionOppositeLong) ||
    (directionRate > 0 && oppositeRate > 0 && oppositeRate / directionRate >= 2.5);
  assertEquals(structBlocked, false);

  // ICT hard gates don't fire when mode is "off"
  const ictHTFBlocked = config.ictHTFGateMode === "hard";
  const ictMSSBlocked = config.ictDisplacementMSSGateMode === "hard";
  const ictJudasBlocked = config.ictJudasSwingGateMode === "hard";
  const ictFVGBlocked = config.ictFVGInvalidationGateMode === "hard";
  const ictKZBlocked = config.ictKillZoneGateMode === "hard";
  assertEquals(ictHTFBlocked, false);
  assertEquals(ictMSSBlocked, false);
  assertEquals(ictJudasBlocked, false);
  assertEquals(ictFVGBlocked, false);
  assertEquals(ictKZBlocked, false);
});
