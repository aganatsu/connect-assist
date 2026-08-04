import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildConceptEvidence } from "../../functions/_shared/conceptEvidence.ts";
import {
  createZoneLocalConfluenceObservation,
  observeContextOnly,
  observeZoneLocalPoint,
  observeZoneLocalRange,
} from "../../functions/_shared/zoneLocalConfluence.ts";
import { rankZoneCandidatesShadow } from "../../functions/_shared/zoneCandidateShadowRanking.ts";

function fibEvidence(
  detector: string,
  level: number,
  discriminator: number,
) {
  return buildConceptEvidence({
    concept: "fib_level",
    detector: { name: detector, version: "1" },
    symbol: "GBP/USD",
    timeframe: "1H",
    sourceCandleStart: "2026-07-31T10:00:00Z",
    sourceCandleEnd: "2026-07-31T11:00:00Z",
    observedAt: "2026-07-31T12:00:00Z",
    direction: "bullish",
    level,
    discriminator,
  });
}

Deno.test("shadow rank prefers locally supported zone over inflated distant Fib", () => {
  const distant = createZoneLocalConfluenceObservation({
    candidateId: "distant",
    zone: { low: 1.274, high: 1.275 },
    pipSize: 0.0001,
    atr: 0.01,
  });
  distant.items.push(observeZoneLocalPoint({
    source: "impulse_fib",
    label: "Impulse Fib 88.6%",
    evidence: fibEvidence("impulse-fib", 1.2725, 0.886),
    candidate: distant,
    level: 1.2725,
    legacyScoreContribution: 2,
  }));
  distant.items.push(observeContextOnly({
    source: "premium_discount",
    label: "Premium/Discount alignment",
    evidence: null,
    candidate: distant,
    legacyScoreContribution: 0.5,
    reasonCode: "directional_context_not_price_local",
  }));

  const local = createZoneLocalConfluenceObservation({
    candidateId: "local",
    zone: { low: 1.28, high: 1.281 },
    pipSize: 0.0001,
    atr: 0.002,
  });
  local.items.push(observeZoneLocalPoint({
    source: "impulse_fib",
    label: "Impulse Fib 61.8%",
    evidence: fibEvidence("impulse-fib", 1.2805, 0.618),
    candidate: local,
    level: 1.2805,
    legacyScoreContribution: 1.5,
  }));
  local.items.push(observeZoneLocalPoint({
    source: "historical_sr",
    label: "Historical close S/R",
    evidence: buildConceptEvidence({
      concept: "support_resistance",
      detector: { name: "close-cluster", version: "1" },
      symbol: "GBP/USD",
      timeframe: "1H",
      sourceCandleStart: "2026-07-30T10:00:00Z",
      observedAt: "2026-07-31T12:00:00Z",
      direction: "neutral",
      level: 1.2807,
    }),
    candidate: local,
    level: 1.2807,
    legacyScoreContribution: 1,
  }));

  const rankings = rankZoneCandidatesShadow([
    {
      candidateId: "distant",
      legacyZoneScore: 4,
      fibDepth: 0.886,
      localConfluence: distant,
    },
    {
      candidateId: "local",
      legacyZoneScore: 3,
      fibDepth: 0.618,
      localConfluence: local,
    },
  ]);
  const distantRank = rankings.get("distant");
  const localRank = rankings.get("local");
  assertExists(distantRank);
  assertExists(localRank);
  assertEquals(distantRank.legacyRank, 1);
  assertEquals(localRank.legacyRank, 2);
  assertEquals(distantRank.shadowLocalScore, 0);
  assertEquals(localRank.shadowLocalScore, 2.5);
  assertEquals(localRank.shadowRank, 1);
  assertEquals(distantRank.shadowRank, 2);
  assertEquals(localRank.enforcement, "observe_only");
});

Deno.test("shadow rank credits the same entity only once across detectors", () => {
  const candidate = createZoneLocalConfluenceObservation({
    candidateId: "candidate",
    zone: { low: 1.274, high: 1.275 },
    pipSize: 0.0001,
    atr: 0.002,
  });
  const common = {
    concept: "fvg" as const,
    symbol: "GBP/USD",
    timeframe: "4H",
    sourceCandleStart: "2026-07-31T08:00:00Z",
    observedAt: "2026-07-31T12:00:00Z",
    direction: "bullish" as const,
    bounds: { low: 1.2742, high: 1.2748 },
  };
  const first = buildConceptEvidence({
    ...common,
    detector: { name: "detector-a", version: "1" },
  });
  const second = buildConceptEvidence({
    ...common,
    detector: { name: "detector-b", version: "1" },
  });
  assertEquals(first.entityId, second.entityId);
  candidate.items.push(observeZoneLocalRange({
    source: "htf_fvg",
    label: "FVG A",
    evidence: first,
    candidate,
    bounds: common.bounds,
    legacyScoreContribution: 1,
  }));
  candidate.items.push(observeZoneLocalRange({
    source: "htf_fvg",
    label: "FVG B",
    evidence: second,
    candidate,
    bounds: common.bounds,
    legacyScoreContribution: 1,
  }));

  const ranking = rankZoneCandidatesShadow([{
    candidateId: "candidate",
    legacyZoneScore: 2,
    fibDepth: 0.7,
    localConfluence: candidate,
  }]).get("candidate");
  assertExists(ranking);
  assertEquals(ranking.shadowLocalScore, 1);
  assertEquals(ranking.summary.uniqueEntities, 1);
  assertEquals(ranking.selectedEvidence.length, 1);
  assertEquals(
    ranking.excludedEvidence.some((item) => item.reason === "duplicate_entity"),
    true,
  );
});

Deno.test("shadow ranking is metadata-only and does not mutate input order or scores", () => {
  const zones = [
    { candidateId: "a", legacyZoneScore: 1, fibDepth: 0.5 },
    { candidateId: "b", legacyZoneScore: 2, fibDepth: 0.6 },
  ];
  const before = structuredClone(zones);
  rankZoneCandidatesShadow(zones);
  assertEquals(zones, before);
});
