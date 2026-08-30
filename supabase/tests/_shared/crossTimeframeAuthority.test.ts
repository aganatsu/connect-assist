import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CrossTimeframeActivationSnapshot,
  normalizeCrossTimeframeAuthorityConfig,
  resolveCrossTimeframeAuthority,
} from "../../functions/_shared/crossTimeframeAuthority.ts";

const hardLiveActivation: CrossTimeframeActivationSnapshot = {
  authorityStage: "hard_block",
  runtimeScope: "live",
  runtimeEnforced: true,
  revision: 2,
  evidenceHash: "evidence",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

Deno.test("cross-timeframe controls normalize to safe defaults", () => {
  const result = normalizeCrossTimeframeAuthorityConfig(null);
  assertEquals(result.mode, "observe");
  assertEquals(result.requireNestedImpulse, true);
  assertEquals(result.allowStandaloneLowerTimeframe, false);
  assertEquals(result.maximumZoneSeparationATR, 0.25);
  assertEquals(result.minimumParentChildOverlapPercent, 50);
  assertEquals(result.requireSweepOrigin, false);
  assertEquals(result.retestQuality, "fresh_or_held");
  assertEquals(result.maximumCandidatesPerTimeframe, 3);
});

Deno.test("requested hard is capped at Observe without a certificate", () => {
  const result = resolveCrossTimeframeAuthority({
    rawConfig: { crossTfAuthorityMode: "hard" },
    runtimeTarget: "live",
    activation: null,
  });
  assertEquals(result.available, true);
  assertEquals(result.requestedMode, "hard");
  assertEquals(result.certifiedMaximum, "observe");
  assertEquals(result.effectiveMode, "observe");
  assertEquals(result.activationTrusted, false);
  assertEquals(result.reason, "activation_missing");
});

Deno.test("certified hard can become effective in its approved runtime scope", () => {
  const result = resolveCrossTimeframeAuthority({
    rawConfig: {
      crossTfAuthorityMode: "hard",
      crossTfRequireSweepOrigin: true,
      crossTfRetestQuality: "fresh_only",
    },
    runtimeTarget: "live",
    activation: hardLiveActivation,
  });
  assertEquals(result.certifiedMaximum, "hard");
  assertEquals(result.effectiveMode, "hard");
  assertEquals(result.activationTrusted, true);
  assertEquals(result.reason, "certified_mode_enabled");
  assertEquals(result.policy.requireSweepOrigin, true);
  assertEquals(result.policy.allowedRetestQuality, ["fresh"]);
});

Deno.test("hard request is capped to a certified Soft maximum", () => {
  const result = resolveCrossTimeframeAuthority({
    rawConfig: { crossTfAuthorityMode: "hard" },
    runtimeTarget: "paper",
    activation: {
      ...hardLiveActivation,
      authorityStage: "soft_adjustment",
      runtimeScope: "paper",
    },
  });
  assertEquals(result.requestedMode, "hard");
  assertEquals(result.certifiedMaximum, "soft");
  assertEquals(result.effectiveMode, "soft");
  assertEquals(result.activationTrusted, true);
  assertEquals(result.reason, "capped_by_certified_authority");
});

Deno.test("live authority is capped when the certificate is paper-only", () => {
  const result = resolveCrossTimeframeAuthority({
    rawConfig: { crossTfAuthorityMode: "hard" },
    runtimeTarget: "live",
    activation: { ...hardLiveActivation, runtimeScope: "paper" },
  });
  assertEquals(result.certifiedMaximum, "observe");
  assertEquals(result.effectiveMode, "observe");
  assertEquals(result.activationTrusted, false);
  assertEquals(result.reason, "runtime_scope_mismatch");
});

Deno.test("config bounds are enforced before runtime use", () => {
  const result = normalizeCrossTimeframeAuthorityConfig({
    crossTfMaximumZoneSeparationATR: 99,
    crossTfMinimumParentChildOverlapPercent: -20,
    crossTfMaximumCandidatesPerTimeframe: 19,
  });
  assertEquals(result.maximumZoneSeparationATR, 3);
  assertEquals(result.minimumParentChildOverlapPercent, 0);
  assertEquals(result.maximumCandidatesPerTimeframe, 5);
});

Deno.test("saved soft mode remains Observe without approved activation", () => {
  const result = resolveCrossTimeframeAuthority({
    rawConfig: { crossTfAuthorityMode: "soft" },
    runtimeTarget: "paper",
    activation: null,
  });
  assertStringIncludes(
    `${result.requestedMode}/${result.certifiedMaximum}/${result.effectiveMode}`,
    "soft/observe/observe",
  );
});
