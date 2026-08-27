import type {
  SingleOwnershipDecisionResult,
} from "./singleOwnershipDecision.ts";

export type SingleOwnershipMode = "observe" | "enforce" | "enforce_live";

export interface SingleOwnershipEnforcementResult {
  requestedMode: SingleOwnershipMode;
  effectiveMode: SingleOwnershipMode;
  runtimeTarget: "paper" | "live";
  authorized: boolean;
  affectsAuthorization: boolean;
  code:
    | "observing"
    | "owned_authorities_allow"
    | "owned_authorities_do_not_allow";
}

export function resolveSingleOwnershipMode(
  requested: unknown,
): Pick<SingleOwnershipEnforcementResult, "requestedMode" | "effectiveMode"> & {
  reasonCode: "observing" | "requested_mode_enabled";
} {
  const requestedMode: SingleOwnershipMode = requested === "enforce_live"
    ? "enforce_live"
    : requested === "enforce"
    ? "enforce"
    : "observe";
  return {
    requestedMode,
    effectiveMode: requestedMode === "observe" ? "observe" : "enforce",
    reasonCode: requestedMode === "observe"
      ? "observing"
      : "requested_mode_enabled",
  };
}

export function evaluateSingleOwnershipEnforcement(input: {
  requestedMode?: unknown;
  runtimeTarget: "paper" | "live";
  decision: SingleOwnershipDecisionResult;
}): SingleOwnershipEnforcementResult {
  const { requestedMode, effectiveMode } = resolveSingleOwnershipMode(
    input.requestedMode,
  );
  if (effectiveMode === "observe") {
    return {
      requestedMode,
      effectiveMode,
      runtimeTarget: input.runtimeTarget,
      authorized: false,
      affectsAuthorization: false,
      code: "observing",
    };
  }

  const authorized = input.decision.decision === "allow" &&
    input.decision.completeness.complete;
  return {
    requestedMode,
    effectiveMode,
    runtimeTarget: input.runtimeTarget,
    authorized,
    affectsAuthorization: true,
    code: authorized
      ? "owned_authorities_allow"
      : "owned_authorities_do_not_allow",
  };
}
