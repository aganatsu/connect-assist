import {
  evaluateGamePlanShadowAudit,
  finalizeShadowCurrentDecision,
} from "../../functions/_shared/gamePlanShadowAudit.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const tradeablePlan = {
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

Deno.test("shadow audit marks a coherent aligned plan eligible without changing execution", () => {
  const result = evaluateGamePlanShadowAudit({
    plan: tradeablePlan,
    direction: "long",
    directionVerdict: { verdict: "long", confidence: 78, shouldBlock: false },
    impulseZone: { hasZone: true, entryReady: true, score: 7.2, fibDepth: 0.705 },
  });

  assertEquals(result.decision, "eligible");
  assertEquals(result.riskBand, "normal");
  assertEquals(result.permittedDirection, "long");
  assertEquals(result.aligned, true);
  assertEquals(result.directionVerdict, {
    verdict: "long",
    confidence: 78,
    shouldBlock: false,
  });
  assertEquals(result.currentSystem?.decision, "not_evaluated");
});

Deno.test("shadow audit waits when direction conflicts", () => {
  const result = evaluateGamePlanShadowAudit({
    plan: tradeablePlan,
    direction: "short",
    directionVerdict: { verdict: "short", confidence: 75, shouldBlock: false },
    impulseZone: { hasZone: true, entryReady: true },
  });

  assertEquals(result.decision, "wait");
  assertEquals(result.riskBand, "none");
  assertEquals(result.aligned, false);
});

Deno.test("shadow audit skips low-conviction plans", () => {
  const result = evaluateGamePlanShadowAudit({
    plan: {
      ...tradeablePlan,
      conviction: { ...tradeablePlan.conviction, confidence: 6 },
    },
    direction: "long",
    directionVerdict: { verdict: "long", shouldBlock: false },
    impulseZone: { hasZone: true, entryReady: true },
  });

  assertEquals(result.decision, "skip");
  assertEquals(result.riskBand, "none");
});

Deno.test("current-system outcome is attached as audit evidence only", () => {
  const shadow = evaluateGamePlanShadowAudit({
    plan: tradeablePlan,
    direction: "long",
    directionVerdict: { verdict: "long", shouldBlock: false },
    impulseZone: { hasZone: true, entryReady: true },
  });
  const finalized = finalizeShadowCurrentDecision(shadow, "block", "Duplicate position");

  assertEquals(finalized?.decision, "eligible");
  assertEquals(finalized?.currentSystem, {
    decision: "block",
    reason: "Duplicate position",
  });
});
