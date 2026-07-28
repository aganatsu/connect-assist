import {
  assertEquals,
  assertGreater,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyGamePlan,
  type BiasEvidence,
} from "./gamePlanClassifier.ts";

function evidence(overrides: Partial<Record<string, "bullish" | "bearish" | "neutral">> = {}): BiasEvidence[] {
  const rows: Array<[string, string, number, "bullish" | "bearish" | "neutral"]> = [
    ["daily_structure", "Daily structure", 3, "bearish"],
    ["h4_structure", "4H structure", 2, "bearish"],
    ["market_location", "Premium/discount", 2, "bearish"],
    ["amd_phase", "AMD phase", 2, "bearish"],
    ["draw_on_liquidity", "Draw on liquidity", 1, "bearish"],
    ["market_regime", "Market regime", 1, "bearish"],
  ];
  return rows.map(([id, label, weight, fallback]) => {
    const direction = overrides[id] || fallback;
    return {
      id,
      label,
      direction,
      weight,
      available: true,
      contribution: direction === "bullish" ? weight : direction === "bearish" ? -weight : 0,
      reason: `${label} is ${direction}`,
    };
  });
}

Deno.test("GamePlanClassifier: coherent evidence is tradeable", () => {
  const result = classifyGamePlan({
    bias: "bearish",
    legacyConfidence: 91,
    dailyTrend: "bearish",
    h4Trend: "bearish",
    zone: "premium",
    regime: "mild_trend",
    hasDOL: true,
    legacyTradeable: true,
    evidence: evidence(),
  });

  assertEquals(result.state, "tradeable");
  assertEquals(result.conviction.directionalStrength, 100);
  assertEquals(result.conviction.evidenceCoverage, 100);
});

Deno.test("GamePlanClassifier: HTF conflict produces wait state", () => {
  const result = classifyGamePlan({
    bias: "bearish",
    legacyConfidence: 64,
    dailyTrend: "bearish",
    h4Trend: "bullish",
    zone: "equilibrium",
    regime: "transitional",
    hasDOL: true,
    legacyTradeable: true,
    evidence: evidence({ h4_structure: "bullish", market_location: "neutral" }),
  });

  assertEquals(result.state, "wait");
  assertEquals(result.conflictingEvidence.length, 1);
  assertGreater(result.stateReason.indexOf("disagree"), -1);
});

Deno.test("GamePlanClassifier: existing skip remains skip", () => {
  const result = classifyGamePlan({
    bias: "neutral",
    legacyConfidence: 0,
    dailyTrend: "ranging",
    h4Trend: "ranging",
    zone: "equilibrium",
    regime: "ranging",
    hasDOL: false,
    legacyTradeable: false,
    legacySkipReason: "No clear bias in ranging market",
    evidence: evidence({
      daily_structure: "neutral",
      h4_structure: "neutral",
      market_location: "neutral",
      amd_phase: "neutral",
      draw_on_liquidity: "neutral",
      market_regime: "neutral",
    }),
  });

  assertEquals(result.state, "skip");
  assertEquals(result.stateReason, "No clear bias in ranging market");
});

Deno.test("GamePlanClassifier: conflicting evidence lowers conviction", () => {
  const aligned = classifyGamePlan({
    bias: "bearish",
    legacyConfidence: 91,
    dailyTrend: "bearish",
    h4Trend: "bearish",
    zone: "premium",
    regime: "mild_trend",
    hasDOL: true,
    legacyTradeable: true,
    evidence: evidence(),
  });
  const conflicted = classifyGamePlan({
    bias: "bearish",
    legacyConfidence: 64,
    dailyTrend: "bearish",
    h4Trend: "bullish",
    zone: "discount",
    regime: "transitional",
    hasDOL: true,
    legacyTradeable: true,
    evidence: evidence({
      h4_structure: "bullish",
      market_location: "bullish",
      market_regime: "neutral",
    }),
  });

  assertGreater(aligned.conviction.confidence, conflicted.conviction.confidence);
});

Deno.test("GamePlanClassifier: weak directional support is skipped", () => {
  const result = classifyGamePlan({
    bias: "bearish",
    legacyConfidence: 36,
    dailyTrend: "bearish",
    h4Trend: "bullish",
    zone: "equilibrium",
    regime: "strong_trend",
    hasDOL: true,
    legacyTradeable: true,
    evidence: evidence({ h4_structure: "bullish" }),
  });

  assertEquals(result.state, "skip");
});
