import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ADJUSTMENT_EVIDENCE_OWNERSHIP,
  FACTOR_EVIDENCE_OWNERSHIP,
  mapLegacyFactorsToPillars,
  PROMOTION_EVIDENCE_OWNERSHIP,
  STREAMLINED_EVIDENCE_REGISTRY_VERSION,
} from "./streamlinedEvidenceRegistry.ts";

const evaluatedAt = "2026-08-03T16:00:00.000Z";

Deno.test("each setup pillar receives only its owned evidence", () => {
  const result = mapLegacyFactorsToPillars({
    evaluatedAt,
    factors: [
      { name: "Market Structure", present: true, weight: 2.5 },
      { name: "Order Block", present: true, weight: 2 },
      { name: "Liquidity Sweep", present: true, weight: 1.5 },
      { name: "Session Quality", present: true, weight: 1.5 },
      { name: "Daily Bias", present: true, weight: 1.5 },
      { name: "Spread Quality", present: false, weight: 0 },
      { name: "Power of 3 Combo", present: true, weight: 1 },
    ],
    locationEvidence: {
      source: "zone_story_and_market_location",
      id: "zone-1",
    },
  });

  assertEquals(result.registryVersion, STREAMLINED_EVIDENCE_REGISTRY_VERSION);
  assertEquals(result.mappingComplete, true);
  assertEquals(result.unmappedFactors, []);
  assertEquals(result.pillars.structure.score, 25);
  assertEquals(result.pillars.location.score, 25);
  assertEquals(result.pillars.confirmation.score, 25);
  assertEquals(result.pillars.timing.score, 25);
  assertEquals(
    result.directionEvidence.map((item) => item.source),
    ["confluence_factor:daily_bias"],
  );
  assertEquals(
    result.safetyEvidence.map((item) => item.source),
    ["confluence_factor:spread_quality"],
  );
  assertEquals(
    result.excludedEvidence.map((item) => item.source),
    ["confluence_factor:power_of_3_combo"],
  );
  assert(
    result.pillars.location.evidence.some((item) => item.id === "zone-1"),
  );
});

Deno.test("unknown factors fail mapping closed instead of guessing a pillar", () => {
  const result = mapLegacyFactorsToPillars({
    evaluatedAt,
    factors: [
      { name: "Market Structure", present: true, weight: 2.5 },
      { name: "Order Block", present: true, weight: 2 },
      { name: "Liquidity Sweep", present: true, weight: 1.5 },
      { name: "Session Quality", present: true, weight: 1.5 },
      { name: "Future Mystery Signal", present: true, weight: 4 },
    ],
  });

  assertEquals(result.mappingComplete, false);
  assertEquals(result.unmappedFactors, ["Future Mystery Signal"]);
  assertEquals(result.pillars.structure.complete, false);
  assertEquals(result.pillars.structure.score, null);
  assert(
    result.pillars.structure.reasonCodes.includes(
      "unmapped_factor.future_mystery_signal",
    ),
  );
});

Deno.test("opposing evidence reduces its pillar and cannot create negative score", () => {
  const result = mapLegacyFactorsToPillars({
    evaluatedAt,
    factors: [
      { name: "Market Structure", present: true, weight: 2.5 },
      { name: "Displacement", present: true, weight: -1 },
      { name: "Order Block", present: true, weight: 2 },
      { name: "Liquidity Sweep", present: true, weight: 1.5 },
      { name: "Session Quality", present: true, weight: 1.5 },
    ],
  });

  assertEquals(result.pillars.structure.score, 10.7);
});

Deno.test("current confluence factors all have explicit ownership", async () => {
  const source = await Deno.readTextFile(
    "./supabase/functions/_shared/confluenceScoring.ts",
  );
  const discovered = [
    ...source.matchAll(/factors\.push\(\{\s*name:\s*"([^"]+)"/g),
  ].map((match) => match[1]);
  discovered.push("Fair Value Gap");

  for (const factor of [...new Set(discovered)]) {
    assert(
      FACTOR_EVIDENCE_OWNERSHIP[factor],
      `Missing streamlined ownership for confluence factor: ${factor}`,
    );
  }
});

Deno.test("promotions and scanner adjustments are classified but not double-counted", () => {
  assertEquals(
    PROMOTION_EVIDENCE_OWNERSHIP.unicornTier1Promotion.contribution,
    "existing_factor_only",
  );
  assertEquals(
    PROMOTION_EVIDENCE_OWNERSHIP.impulseZoneCompatibilityCredit.contribution,
    "existing_factor_only",
  );
  assertEquals(
    ADJUSTMENT_EVIDENCE_OWNERSHIP.directionVerdictAdjustment.role,
    "direction",
  );
  assertEquals(
    ADJUSTMENT_EVIDENCE_OWNERSHIP.conflictCounter.contribution,
    "excluded_duplicate",
  );
});
