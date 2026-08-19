import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  recordConfirmationMatrixObservation,
  recordFinalAuthorizationObservation,
} from "../../functions/_shared/pendingAuthorizationObservation.ts";

const baseSample = {
  sampledAt: "2026-08-18T14:01:00.000Z",
  candleTime: "2026-08-18T14:00:00.000Z",
  timeframe: "5min",
  method: "choch",
  lifecycleMode: "enforce" as const,
  lifecycleAvailable: true,
  lifecycleStatus: "active",
  detectorPassed: false,
};

Deno.test("confirmation observation records all four owners-agreement states once per closed candle", () => {
  let observation: unknown = null;
  const samples = [
    { detectorPassed: true, lifecycleStatus: "entered", bucket: "both_passed" },
    {
      detectorPassed: true,
      lifecycleStatus: "active",
      bucket: "detector_only",
    },
    {
      detectorPassed: false,
      lifecycleStatus: "entered",
      bucket: "lifecycle_only",
    },
    {
      detectorPassed: false,
      lifecycleStatus: "active",
      bucket: "neither_passed",
    },
  ] as const;

  samples.forEach((sample, index) => {
    observation = recordConfirmationMatrixObservation(observation, {
      ...baseSample,
      candleTime: `2026-08-18T14:${String(index * 5).padStart(2, "0")}:00.000Z`,
      detectorPassed: sample.detectorPassed,
      lifecycleStatus: sample.lifecycleStatus,
    });
  });

  const result = observation as ReturnType<
    typeof recordConfirmationMatrixObservation
  >;
  assertEquals(result.confirmation.evaluations, 4);
  for (const sample of samples) {
    assertEquals(result.confirmation.matrixCounts[sample.bucket], 1);
  }
});

Deno.test("confirmation observation does not count one closed candle on every poll", () => {
  const first = recordConfirmationMatrixObservation(null, baseSample);
  const repeated = recordConfirmationMatrixObservation(first, {
    ...baseSample,
    sampledAt: "2026-08-18T14:02:00.000Z",
  });
  assertEquals(repeated.confirmation.evaluations, 1);
  assertEquals(repeated.confirmation.matrixCounts.neither_passed, 1);
  assertEquals(repeated.updatedAt, first.updatedAt);
});

Deno.test("confirmation observation refreshes lifecycle state without double-counting the candle", () => {
  const first = recordConfirmationMatrixObservation(null, baseSample);
  const locked = recordConfirmationMatrixObservation(first, {
    ...baseSample,
    sampledAt: "2026-08-18T14:02:00.000Z",
    lifecycleStatus: "trigger_locked",
  });
  assertEquals(locked.confirmation.evaluations, 1);
  assertEquals(locked.confirmation.latest?.lifecycleStatus, "trigger_locked");
  assertEquals(locked.updatedAt, "2026-08-18T14:02:00.000Z");
});

Deno.test("confirmation observation distinguishes a missing lifecycle contract", () => {
  const result = recordConfirmationMatrixObservation(null, {
    ...baseSample,
    lifecycleAvailable: false,
    lifecycleStatus: null,
    detectorPassed: true,
  });
  assertEquals(result.confirmation.missingContractSamples, 1);
  assertEquals(result.confirmation.latest?.matrixBucket, "detector_only");
  assertEquals(result.confirmation.latest?.lifecycleGatePassed, false);
});

Deno.test("final authorization observation freezes both geometries and favorable drift in R", () => {
  const result = recordFinalAuthorizationObservation(null, {
    evaluatedAt: "2026-08-18T14:05:00.000Z",
    direction: "long",
    plannedEntryPrice: 100,
    authorizationEntryPrice: 101,
    storedStopLoss: 95,
    storedTakeProfit: 105,
    effectiveTargetRiskReward: 1,
    effectiveMinimumRiskReward: 1,
    executionGeometry: {
      valid: true,
      entryPrice: 101,
      stopLoss: 94,
      takeProfit: 108,
    },
    authorization: {
      authorized: false,
      code: "risk_reward",
      retryable: false,
      reason: "remaining reward is below the floor",
    },
  });

  assertAlmostEquals(
    result.finalAuthorization!.authorizationGeometry.riskReward!,
    4 / 6,
  );
  assertEquals(
    result.finalAuthorization!.wouldBeExecutionGeometry?.riskReward,
    1,
  );
  assertAlmostEquals(result.finalAuthorization!.favorableEntryDriftR!, 0.2);
  assertEquals(result.finalAuthorization!.effectiveTargetRiskReward, 1);
  assertEquals(result.finalAuthorization!.effectiveMinimumRiskReward, 1);
});

Deno.test("pending authorization observation is additive and cannot authorize a trade", () => {
  const migration = Deno.readTextFileSync(
    "supabase/migrations/20260818230000_add_pending_authorization_observation.sql",
  );
  assertStringIncludes(
    migration,
    "ADD COLUMN IF NOT EXISTS pending_authorization_observation JSONB",
  );
  assertStringIncludes(migration, "Never authorizes, blocks, sizes or fills");

  const scanner = Deno.readTextFileSync(
    "supabase/functions/zone-confirmation-scanner/index.ts",
  );
  assertStringIncludes(
    scanner,
    "if (!confirmationPassed || !lifecycleConfirmationPassed)",
  );
  assertStringIncludes(
    scanner,
    "pending_authorization_observation: confirmationObservation",
  );
  assertStringIncludes(
    scanner,
    "pending_authorization_observation: finalAuthorizationObservation",
  );
  assert(
    !scanner.includes(
      "authorization.authorized = finalAuthorizationObservation",
    ),
  );
});
