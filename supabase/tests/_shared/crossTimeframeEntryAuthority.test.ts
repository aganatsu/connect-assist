import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveCrossTimeframeAuthority,
  type CrossTimeframeActivationSnapshot,
} from "../../functions/_shared/crossTimeframeAuthority.ts";
import {
  evaluateCrossTimeframeEntryAuthority,
} from "../../functions/_shared/crossTimeframeEntryAuthority.ts";

const activation: CrossTimeframeActivationSnapshot = {
  authorityStage: "hard_block",
  runtimeScope: "live",
  runtimeEnforced: true,
  revision: 3,
  evidenceHash: "evidence",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const resolution = (mode: "observe" | "soft" | "hard") =>
  resolveCrossTimeframeAuthority({
    rawConfig: { crossTfAuthorityMode: mode },
    runtimeTarget: "live",
    activation,
  });

const blockedEvaluation: any = {
  proposedDecision: "block",
  reasonCodes: ["parent_direction_conflict"],
};

Deno.test("Observe never changes score or authorization", () => {
  const result = evaluateCrossTimeframeEntryAuthority({
    authorityResolution: resolution("observe"),
    evaluation: blockedEvaluation,
  });
  assertEquals(result.allowed, true);
  assertEquals(result.scoreAdjustment, 0);
});

Deno.test("Soft penalizes a blocked candidate but does not deny", () => {
  const result = evaluateCrossTimeframeEntryAuthority({
    authorityResolution: resolution("soft"),
    evaluation: blockedEvaluation,
  });
  assertEquals(result.allowed, true);
  assertEquals(result.scoreAdjustment, -10);
});

Deno.test("Hard denies a blocked candidate", () => {
  const result = evaluateCrossTimeframeEntryAuthority({
    authorityResolution: resolution("hard"),
    evaluation: blockedEvaluation,
  });
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "hard_block_policy");
});

Deno.test("Hard fails closed when frozen evidence is unavailable", () => {
  const result = evaluateCrossTimeframeEntryAuthority({
    authorityResolution: resolution("hard"),
    evaluation: null,
  });
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "hard_block_missing_evidence");
});
