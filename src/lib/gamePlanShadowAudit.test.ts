import { describe, expect, it } from "vitest";
import {
  evaluateGamePlanShadowAudit,
  finalizeShadowCurrentDecision,
} from "../../supabase/functions/_shared/gamePlanShadowAudit";

const alignedPlan = {
  bias: "bullish",
  legacyConfidence: 82,
  state: "tradeable",
  tradeable: true,
  conviction: {
    confidence: 72,
    directionalStrength: 80,
    evidenceCoverage: 100,
    planQuality: 80,
  },
};

describe("Gameplan shadow audit", () => {
  it("marks an aligned plan with a ready zone eligible", () => {
    const result = evaluateGamePlanShadowAudit({
      plan: alignedPlan,
      direction: "long",
      directionVerdict: { verdict: "long", confidence: 78, shouldBlock: false },
      impulseZone: { hasZone: true, entryReady: true, score: 7.2, fibDepth: 0.705 },
    });

    expect(result.decision).toBe("eligible");
    expect(result.riskBand).toBe("normal");
    expect(result.aligned).toBe(true);
    expect(result.directionVerdict?.confidence).toBe(78);
  });

  it("waits on a direction conflict and skips very low conviction", () => {
    const conflict = evaluateGamePlanShadowAudit({
      plan: alignedPlan,
      direction: "short",
      directionVerdict: { verdict: "short", confidence: 75, shouldBlock: false },
      impulseZone: { hasZone: true, entryReady: true },
    });
    const lowConviction = evaluateGamePlanShadowAudit({
      plan: {
        ...alignedPlan,
        conviction: { ...alignedPlan.conviction, confidence: 6 },
      },
      direction: "long",
      directionVerdict: { verdict: "long", shouldBlock: false },
      impulseZone: { hasZone: true, entryReady: true },
    });

    expect(conflict.decision).toBe("wait");
    expect(lowConviction.decision).toBe("skip");
  });

  it("records the live decision without changing the proposed decision", () => {
    const shadow = evaluateGamePlanShadowAudit({
      plan: alignedPlan,
      direction: "long",
      directionVerdict: { verdict: "long", shouldBlock: false },
      impulseZone: { hasZone: true, entryReady: true },
    });

    const finalized = finalizeShadowCurrentDecision(shadow, "block", "Duplicate position");
    expect(finalized?.decision).toBe("eligible");
    expect(finalized?.currentSystem).toEqual({
      decision: "block",
      reason: "Duplicate position",
    });
  });
});
