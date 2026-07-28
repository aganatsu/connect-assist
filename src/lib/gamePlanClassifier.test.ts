import { describe, expect, it } from "vitest";
import {
  classifyGamePlan,
  type BiasEvidence,
} from "../../supabase/functions/_shared/gamePlanClassifier";

function makeEvidence(h4: "bullish" | "bearish" = "bearish"): BiasEvidence[] {
  return [
    { id: "daily", label: "Daily", direction: "bearish", weight: 3, available: true, contribution: -3, reason: "Daily bearish" },
    { id: "h4", label: "4H", direction: h4, weight: 2, available: true, contribution: h4 === "bearish" ? -2 : 2, reason: `4H ${h4}` },
    { id: "location", label: "Location", direction: "bearish", weight: 2, available: true, contribution: -2, reason: "Premium" },
    { id: "amd", label: "AMD", direction: "bearish", weight: 2, available: true, contribution: -2, reason: "Buy-side swept" },
    { id: "dol", label: "DOL", direction: "bearish", weight: 1, available: true, contribution: -1, reason: "Sell-side target" },
    { id: "regime", label: "Regime", direction: "bearish", weight: 1, available: true, contribution: -1, reason: "Bearish trend" },
  ];
}

describe("classifyGamePlan", () => {
  it("marks a coherent plan tradeable", () => {
    const result = classifyGamePlan({
      bias: "bearish",
      legacyConfidence: 91,
      dailyTrend: "bearish",
      h4Trend: "bearish",
      zone: "premium",
      regime: "mild_trend",
      hasDOL: true,
      legacyTradeable: true,
      evidence: makeEvidence(),
    });

    expect(result.state).toBe("tradeable");
    expect(result.conviction.confidence).toBe(100);
  });

  it("marks a conflicted plan as wait", () => {
    const result = classifyGamePlan({
      bias: "bearish",
      legacyConfidence: 64,
      dailyTrend: "bearish",
      h4Trend: "bullish",
      zone: "equilibrium",
      regime: "transitional",
      hasDOL: true,
      legacyTradeable: true,
      evidence: makeEvidence("bullish"),
    });

    expect(result.state).toBe("wait");
    expect(result.stateReason).toContain("disagree");
  });

  it("preserves an existing skip decision", () => {
    const result = classifyGamePlan({
      bias: "neutral",
      legacyConfidence: 0,
      dailyTrend: "ranging",
      h4Trend: "ranging",
      zone: "equilibrium",
      regime: "ranging",
      hasDOL: false,
      legacyTradeable: false,
      legacySkipReason: "No clear bias",
      evidence: makeEvidence(),
    });

    expect(result.state).toBe("skip");
    expect(result.stateReason).toBe("No clear bias");
  });

  it("skips a weak directional plan", () => {
    const result = classifyGamePlan({
      bias: "bearish",
      legacyConfidence: 36,
      dailyTrend: "bearish",
      h4Trend: "bullish",
      zone: "equilibrium",
      regime: "strong_trend",
      hasDOL: true,
      legacyTradeable: true,
      evidence: makeEvidence("bullish"),
    });

    expect(result.state).toBe("skip");
    expect(result.stateReason).toContain("40% planning floor");
  });
});
