import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildStrategyEvidenceCertificate,
  type StrategyEvidenceObservation,
} from "../../functions/_shared/strategyEvidenceCertificate.ts";

function observation(
  index: number,
  options: Partial<StrategyEvidenceObservation> = {},
): StrategyEvidenceObservation {
  return {
    feature: "gameplan_hierarchy",
    sourceId: `observation-${index}`,
    source: index % 2 === 0 ? "rejected_setup" : "closed_trade",
    observedAt: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
    symbol: index % 2 === 0 ? "GBP/USD" : "EUR/USD",
    style: "scalper",
    currentDecision: "block",
    proposedDecision: "allow",
    outcome: "win",
    outcomeR: 2,
    ...options,
  };
}

Deno.test("strategy evidence remains collecting below minimum sample gates", () => {
  const certificate = buildStrategyEvidenceCertificate({
    feature: "gameplan_hierarchy",
    observations: [observation(1)],
    totalCandidates: 10,
    generatedAt: "2026-07-30T20:00:00.000Z",
  });

  assertEquals(certificate.eligibility.status, "collecting");
  assertEquals(certificate.sample.resolved, 1);
  assert(
    certificate.eligibility.reasons.some((reason) =>
      reason.includes("Need 30 resolved")
    ),
  );
});

Deno.test("strategy evidence passes only when train and test effects agree", () => {
  const observations = Array.from(
    { length: 40 },
    (_, index) => observation(index),
  );
  const certificate = buildStrategyEvidenceCertificate({
    feature: "gameplan_hierarchy",
    observations,
    totalCandidates: 40,
    generatedAt: "2026-07-30T20:00:00.000Z",
  });

  assertEquals(certificate.sample.trainResolved, 28);
  assertEquals(certificate.sample.testResolved, 12);
  assertEquals(certificate.effect.beneficialRatePercent, 100);
  assertEquals(certificate.effect.expectancyDeltaR, 2);
  assertEquals(certificate.validation.outOfSample, true);
  assertEquals(certificate.validation.walkForwardConsistent, true);
  assertEquals(certificate.eligibility.status, "eligible_log_only");
  assertEquals(certificate.eligibility.nextAuthorityStage, "log_only");
});

Deno.test("strategy evidence keeps shadow when test window reverses", () => {
  const observations = Array.from(
    { length: 40 },
    (_, index) =>
      observation(index, index >= 28 ? { outcome: "loss", outcomeR: -1 } : {}),
  );
  const certificate = buildStrategyEvidenceCertificate({
    feature: "gameplan_hierarchy",
    observations,
    totalCandidates: 40,
  });

  assertEquals(certificate.validation.outOfSample, false);
  assertEquals(certificate.validation.walkForwardConsistent, false);
  assertEquals(certificate.eligibility.status, "keep_shadow");
  assertEquals(certificate.eligibility.nextAuthorityStage, null);
});

Deno.test("strategy evidence measures blocked-winner retention", () => {
  const observations = Array.from(
    { length: 40 },
    (_, index) =>
      observation(index, {
        currentDecision: "allow",
        proposedDecision: index < 20 ? "block" : "allow",
      }),
  );
  const certificate = buildStrategyEvidenceCertificate({
    feature: "gameplan_hierarchy",
    observations,
    totalCandidates: 40,
  });

  assertEquals(certificate.effect.goodTradeRetentionPercent, 50);
  assert(
    certificate.eligibility.reasons.some((reason) =>
      reason.includes("good-trade retention")
    ),
  );
});
