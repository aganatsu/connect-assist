export const PENDING_AUTHORIZATION_OBSERVATION_VERSION =
  "pending-authorization-observation.v1";

export type ConfirmationMatrixBucket =
  | "both_passed"
  | "detector_only"
  | "lifecycle_only"
  | "neither_passed";

export interface GeometryObservation {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number | null;
}

export interface PendingAuthorizationObservation {
  contractVersion: typeof PENDING_AUTHORIZATION_OBSERVATION_VERSION;
  updatedAt: string;
  confirmation: {
    evaluations: number;
    matrixCounts: Record<ConfirmationMatrixBucket, number>;
    missingContractSamples: number;
    lastSampleKey: string | null;
    latest: {
      sampledAt: string;
      candleTime: string;
      timeframe: string;
      method: string;
      lifecycleMode: "off" | "observe" | "enforce";
      lifecycleAvailable: boolean;
      lifecycleStatus: string | null;
      detectorPassed: boolean;
      lifecyclePassed: boolean;
      lifecycleGatePassed: boolean;
      matrixBucket: ConfirmationMatrixBucket;
    } | null;
  };
  finalAuthorization: {
    evaluatedAt: string;
    authorized: boolean;
    code: string;
    retryable: boolean;
    reason: string;
    effectiveTargetRiskReward: number;
    effectiveMinimumRiskReward: number;
    plannedGeometry: GeometryObservation;
    authorizationGeometry: GeometryObservation;
    wouldBeExecutionGeometry: GeometryObservation | null;
    executionGeometryValid: boolean;
    executionGeometryReason: string | null;
    favorableEntryDriftPrice: number;
    favorableEntryDriftR: number | null;
  } | null;
}

function emptyCounts(): Record<ConfirmationMatrixBucket, number> {
  return {
    both_passed: 0,
    detector_only: 0,
    lifecycle_only: 0,
    neither_passed: 0,
  };
}

function emptyObservation(at: string): PendingAuthorizationObservation {
  return {
    contractVersion: PENDING_AUTHORIZATION_OBSERVATION_VERSION,
    updatedAt: at,
    confirmation: {
      evaluations: 0,
      matrixCounts: emptyCounts(),
      missingContractSamples: 0,
      lastSampleKey: null,
      latest: null,
    },
    finalAuthorization: null,
  };
}

function asObservation(
  value: unknown,
  at: string,
): PendingAuthorizationObservation {
  if (
    value && typeof value === "object" &&
    (value as { contractVersion?: unknown }).contractVersion ===
      PENDING_AUTHORIZATION_OBSERVATION_VERSION
  ) {
    return value as PendingAuthorizationObservation;
  }
  return emptyObservation(at);
}

function matrixBucket(
  detectorPassed: boolean,
  lifecyclePassed: boolean,
): ConfirmationMatrixBucket {
  if (detectorPassed && lifecyclePassed) return "both_passed";
  if (detectorPassed) return "detector_only";
  if (lifecyclePassed) return "lifecycle_only";
  return "neither_passed";
}

export function recordConfirmationMatrixObservation(
  previous: unknown,
  input: {
    sampledAt: string;
    candleTime: string;
    timeframe: string;
    method: string;
    lifecycleMode: "off" | "observe" | "enforce";
    lifecycleAvailable: boolean;
    lifecycleStatus: string | null;
    detectorPassed: boolean;
  },
): PendingAuthorizationObservation {
  const observation = structuredClone(asObservation(previous, input.sampledAt));
  const lifecyclePassed = input.lifecycleStatus === "entered";
  const lifecycleGatePassed = input.lifecycleMode !== "enforce" ||
    lifecyclePassed;
  const bucket = matrixBucket(input.detectorPassed, lifecyclePassed);
  const sampleKey = `${input.timeframe}:${input.candleTime}`;
  const isNewClosedCandle =
    observation.confirmation.lastSampleKey !== sampleKey;

  const previousLatest = observation.confirmation.latest;
  const stateChanged = !previousLatest ||
    previousLatest.detectorPassed !== input.detectorPassed ||
    previousLatest.lifecyclePassed !== lifecyclePassed ||
    previousLatest.lifecycleAvailable !== input.lifecycleAvailable ||
    previousLatest.lifecycleStatus !== input.lifecycleStatus ||
    previousLatest.lifecycleMode !== input.lifecycleMode ||
    previousLatest.timeframe !== input.timeframe ||
    previousLatest.method !== input.method;

  if (isNewClosedCandle) {
    observation.confirmation.evaluations += 1;
    observation.confirmation.matrixCounts[bucket] += 1;
    if (!input.lifecycleAvailable) {
      observation.confirmation.missingContractSamples += 1;
    }
    observation.confirmation.lastSampleKey = sampleKey;
  }
  if (isNewClosedCandle || stateChanged) {
    observation.confirmation.latest = {
      ...input,
      lifecyclePassed,
      lifecycleGatePassed,
      matrixBucket: bucket,
    };
    observation.updatedAt = input.sampledAt;
  }
  return observation;
}

export function observeGeometry(input: {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}): GeometryObservation {
  const entryPrice = Number(input.entryPrice);
  const stopLoss = Number(input.stopLoss);
  const takeProfit = Number(input.takeProfit);
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(takeProfit - entryPrice);
  return {
    entryPrice,
    stopLoss,
    takeProfit,
    riskReward:
      [entryPrice, stopLoss, takeProfit].every(Number.isFinite) && risk > 0
        ? reward / risk
        : null,
  };
}

export function recordFinalAuthorizationObservation(
  previous: unknown,
  input: {
    evaluatedAt: string;
    direction: "long" | "short";
    plannedEntryPrice: number;
    authorizationEntryPrice: number;
    storedStopLoss: number;
    storedTakeProfit: number;
    effectiveTargetRiskReward: number;
    effectiveMinimumRiskReward: number;
    executionGeometry:
      | {
        valid: true;
        entryPrice: number;
        stopLoss: number;
        takeProfit: number;
      }
      | { valid: false; reason: string };
    authorization: {
      authorized: boolean;
      code: string;
      retryable: boolean;
      reason: string;
    };
  },
): PendingAuthorizationObservation {
  const observation = structuredClone(
    asObservation(previous, input.evaluatedAt),
  );
  const plannedGeometry = observeGeometry({
    entryPrice: input.plannedEntryPrice,
    stopLoss: input.storedStopLoss,
    takeProfit: input.storedTakeProfit,
  });
  const authorizationGeometry = observeGeometry({
    entryPrice: input.authorizationEntryPrice,
    stopLoss: input.storedStopLoss,
    takeProfit: input.storedTakeProfit,
  });
  const executionGeometry = input.executionGeometry.valid
    ? observeGeometry(input.executionGeometry)
    : null;
  const favorableEntryDriftPrice = input.direction === "long"
    ? input.authorizationEntryPrice - input.plannedEntryPrice
    : input.plannedEntryPrice - input.authorizationEntryPrice;
  const plannedRisk = Math.abs(input.plannedEntryPrice - input.storedStopLoss);

  observation.updatedAt = input.evaluatedAt;
  observation.finalAuthorization = {
    evaluatedAt: input.evaluatedAt,
    ...input.authorization,
    effectiveTargetRiskReward: input.effectiveTargetRiskReward,
    effectiveMinimumRiskReward: input.effectiveMinimumRiskReward,
    plannedGeometry,
    authorizationGeometry,
    wouldBeExecutionGeometry: executionGeometry,
    executionGeometryValid: input.executionGeometry.valid,
    executionGeometryReason: input.executionGeometry.valid
      ? null
      : input.executionGeometry.reason,
    favorableEntryDriftPrice,
    favorableEntryDriftR:
      Number.isFinite(favorableEntryDriftPrice) && plannedRisk > 0
        ? favorableEntryDriftPrice / plannedRisk
        : null,
  };
  return observation;
}
