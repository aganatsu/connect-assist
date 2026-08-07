export const DIRECTION_AVAILABILITY_POLICY_VERSION = "direction-availability-policy.v1";

export type DirectionUnavailableMode = "legacy_fallback" | "observe_fail_closed" | "fail_closed";

export interface DirectionAvailabilityDecision {
  contractVersion: typeof DIRECTION_AVAILABILITY_POLICY_VERSION;
  requestedMode: DirectionUnavailableMode;
  effectiveMode: "legacy_fallback" | "fail_closed";
  observationOnly: boolean;
  verdictAvailable: boolean;
  legacyDirection: "long" | "short" | null;
  selectedDirection: "long" | "short" | null;
  wouldWait: boolean;
  reasonCode: "verdict_available" | "legacy_direction_fallback" | "direction_authority_unavailable";
}

export function resolveDirectionAvailability(input: {
  mode?: unknown;
  verdictDirection: "long" | "short" | null;
  legacyDirection: "long" | "short" | null;
}): DirectionAvailabilityDecision {
  const requestedMode: DirectionUnavailableMode = input.mode === "fail_closed"
    ? "fail_closed" : input.mode === "observe_fail_closed"
    ? "observe_fail_closed" : "legacy_fallback";
  if (input.verdictDirection) return {
    contractVersion: DIRECTION_AVAILABILITY_POLICY_VERSION,
    requestedMode, effectiveMode: requestedMode === "fail_closed" ? "fail_closed" : "legacy_fallback",
    observationOnly: requestedMode !== "fail_closed", verdictAvailable: true,
    legacyDirection: input.legacyDirection, selectedDirection: input.verdictDirection,
    wouldWait: false, reasonCode: "verdict_available",
  };
  const failClosed = requestedMode === "fail_closed";
  return {
    contractVersion: DIRECTION_AVAILABILITY_POLICY_VERSION,
    requestedMode, effectiveMode: failClosed ? "fail_closed" : "legacy_fallback",
    observationOnly: !failClosed, verdictAvailable: false,
    legacyDirection: input.legacyDirection,
    selectedDirection: failClosed ? null : input.legacyDirection,
    wouldWait: input.legacyDirection !== null,
    reasonCode: failClosed ? "direction_authority_unavailable" : "legacy_direction_fallback",
  };
}
