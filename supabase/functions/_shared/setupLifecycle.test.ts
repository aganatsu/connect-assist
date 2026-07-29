import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSetupLifecycleEvidence,
  canTransitionSetup,
  resolvePendingConfirmationMethod,
  resolvePendingIndicatorMinimum,
} from "./setupLifecycle.ts";

Deno.test("setup lifecycle permits only canonical forward transitions", () => {
  assertEquals(canTransitionSetup("watching", "qualified"), true);
  assertEquals(canTransitionSetup("qualified", "pending"), true);
  assertEquals(
    canTransitionSetup("pending", "awaiting_confirmation"),
    true,
  );
  assertEquals(canTransitionSetup("awaiting_confirmation", "pending"), true);
  assertEquals(canTransitionSetup("awaiting_confirmation", "filled"), true);
  assertEquals(canTransitionSetup("watching", "filled"), false);
  assertEquals(canTransitionSetup("filled", "pending"), false);
  assertEquals(
    canTransitionSetup("blocked_after_qualification", "pending"),
    false,
  );
});

Deno.test("pending confirmation method is frozen on the pending row", () => {
  assertEquals(
    resolvePendingConfirmationMethod(
      {
        confirmation_method: "indicators",
        signal_reason: { confirmationMethod: "choch" },
      },
      { confirmationMethod: "choch_and_indicators" },
    ),
    "indicators",
  );
});

Deno.test("legacy pending confirmation method falls back without overriding evidence", () => {
  assertEquals(
    resolvePendingConfirmationMethod(
      {
        signal_reason: {
          watchlistLifecycle: {
            confirmationMethod: "choch_and_indicators",
          },
        },
      },
      { confirmationMethod: "choch" },
    ),
    "choch_and_indicators",
  );
  assertEquals(
    resolvePendingConfirmationMethod({}, { confirmationMethod: "indicators" }),
    "indicators",
  );
});

Deno.test("indicator threshold uses the setup snapshot before runtime config", () => {
  assertEquals(
    resolvePendingIndicatorMinimum(
      { confirmation_config: { indicatorMinCount: 4 } },
      { indicatorMinCount: 2 },
    ),
    4,
  );
});

Deno.test("lifecycle evidence ties candidate to exact strategy versions", () => {
  const evidence = buildSetupLifecycleEvidence({
    identity: {
      setupId: "setup-1",
      candidateId: "candidate-1",
    },
    symbol: "GBP/CAD",
    gamePlan: {
      planVersion: "session-v1",
      plans: [{
        symbol: "GBP/CAD",
        gamePlanId: "gp-1",
        planVersion: "gp-v1",
      }],
    } as any,
    directionVerdict: {
      id: "dv-1",
      verdictVersion: "dv-v1",
      gamePlanId: "gp-1",
      gamePlanVersion: "gp-v1",
    },
    confirmationMethod: "choch_and_indicators",
    originatingZone: { type: "fvg", low: 1.2, high: 1.21 },
  });
  assertEquals(evidence.candidateId, "candidate-1");
  assertEquals(evidence.gamePlanId, "gp-1");
  assertEquals(evidence.gamePlanVersion, "gp-v1");
  assertEquals(evidence.directionVerdictVersion, "dv-v1");
  assertEquals(evidence.confirmationMethod, "choch_and_indicators");
  assertEquals(evidence.thesisVersion, "thesis.v1");
});
