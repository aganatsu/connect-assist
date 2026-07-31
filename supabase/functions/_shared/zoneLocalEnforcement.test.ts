import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateZoneLocalEnforcement,
  resolveZoneLocalMode,
  type ZoneLocalActivationSnapshot,
} from "./zoneLocalEnforcement.ts";
import { loadZoneLocalActivation } from "./zoneLocalActivationStore.ts";
import type {
  ZoneCandidateShadowRanking,
} from "./zoneCandidateShadowRanking.ts";

const softActivation: ZoneLocalActivationSnapshot = {
  authorityStage: "soft_adjustment",
  runtimeScope: "paper",
  runtimeEnforced: true,
  revision: 4,
  evidenceHash: "evidence",
  updatedAt: "2026-07-31T00:00:00.000Z",
};

const hardActivation: ZoneLocalActivationSnapshot = {
  ...softActivation,
  authorityStage: "hard_block",
  runtimeScope: "live",
};

function ranking(
  overrides: Partial<ZoneCandidateShadowRanking> = {},
): ZoneCandidateShadowRanking {
  return {
    contractVersion: "zone-candidate-shadow-ranking.v1",
    enforcement: "observe_only",
    candidateId: "candidate",
    legacyZoneScore: 7,
    legacyComparableScore: 7,
    shadowLocalScore: 3,
    legacyRank: 1,
    shadowRank: 1,
    rankDelta: 0,
    selectedEvidence: [],
    excludedEvidence: [],
    summary: {
      observedItems: 2,
      locallyQualifiedItems: 2,
      contextOnlyItems: 0,
      uniqueEntities: 2,
      creditedFamilies: 2,
    },
    ...overrides,
  };
}

Deno.test("requested hard remains observe without certified activation", () => {
  const result = resolveZoneLocalMode({
    requestedMode: "hard",
    runtimeTarget: "live",
    activation: null,
  });
  assertEquals(result.effectiveMode, "observe");
  assertEquals(result.reason, "capped_by_certified_authority");
});

Deno.test("soft certificate caps a requested hard mode", () => {
  const result = resolveZoneLocalMode({
    requestedMode: "hard",
    runtimeTarget: "paper",
    activation: softActivation,
  });
  assertEquals(result.effectiveMode, "soft");
  assertEquals(result.certifiedMaximum, "soft");
});

Deno.test("paper-scoped activation cannot enforce live", () => {
  const result = resolveZoneLocalMode({
    requestedMode: "soft",
    runtimeTarget: "live",
    activation: softActivation,
  });
  assertEquals(result.effectiveMode, "observe");
});

Deno.test("observe mode never changes score or authorization", () => {
  const result = evaluateZoneLocalEnforcement({
    requestedMode: "observe",
    runtimeTarget: "live",
    activation: hardActivation,
    ranking: ranking({ shadowRank: 2 }),
  });
  assertEquals(result.allowed, true);
  assertEquals(result.scoreAdjustment, 0);
  assertEquals(result.reason, "observe_only");
});

Deno.test("certified soft mode penalizes rank disagreement without blocking", () => {
  const result = evaluateZoneLocalEnforcement({
    requestedMode: "soft",
    runtimeTarget: "paper",
    activation: softActivation,
    ranking: ranking({ shadowRank: 2 }),
    softPenalty: 12,
  });
  assertEquals(result.mode.effectiveMode, "soft");
  assertEquals(result.allowed, true);
  assertEquals(result.scoreAdjustment, -12);
  assertEquals(result.reason, "soft_penalty_rank_disagreement");
});

Deno.test("certified hard mode fails closed when evidence is missing", () => {
  const result = evaluateZoneLocalEnforcement({
    requestedMode: "hard",
    runtimeTarget: "live",
    activation: hardActivation,
    ranking: null,
  });
  assertEquals(result.mode.effectiveMode, "hard");
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "hard_block_missing_evidence");
});

Deno.test("certified hard mode permits locally supported legacy winner", () => {
  const result = evaluateZoneLocalEnforcement({
    requestedMode: "hard",
    runtimeTarget: "live",
    activation: hardActivation,
    ranking: ranking(),
    minimumLocalScore: 1,
  });
  assertEquals(result.allowed, true);
  assertEquals(result.reason, "locally_supported");
});

Deno.test("activation store fails closed when its database read fails", async () => {
  const result = await loadZoneLocalActivation(
    {
      from: () => ({
        select: () => ({
          eq: () => {
            throw new Error("database unavailable");
          },
        }),
      }),
    },
    { userId: "user", botId: "smc" },
  );
  assertEquals(result, null);
});
