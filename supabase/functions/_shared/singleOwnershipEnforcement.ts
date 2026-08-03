import type {
  SingleOwnershipDecisionResult,
} from "./singleOwnershipDecision.ts";

export type SingleOwnershipMode = "observe" | "enforce";

export interface SingleOwnershipEnforcementResult {
  requestedMode: SingleOwnershipMode;
  effectiveMode: SingleOwnershipMode;
  runtimeTarget: "paper" | "live";
  authorized: boolean;
  affectsAuthorization: boolean;
  code:
    | "observing"
    | "live_enforcement_disabled"
    | "owned_authorities_allow"
    | "owned_authorities_do_not_allow";
}

export function evaluateSingleOwnershipEnforcement(input: {
  requestedMode?: unknown;
  runtimeTarget: "paper" | "live";
  decision: SingleOwnershipDecisionResult;
}): SingleOwnershipEnforcementResult {
  const requestedMode: SingleOwnershipMode = input.requestedMode === "enforce"
    ? "enforce"
    : "observe";
  const effectiveMode: SingleOwnershipMode =
    requestedMode === "enforce" && input.runtimeTarget === "paper"
      ? "enforce"
      : "observe";

  if (requestedMode === "enforce" && input.runtimeTarget === "live") {
    return {
      requestedMode,
      effectiveMode,
      runtimeTarget: input.runtimeTarget,
      authorized: false,
      affectsAuthorization: false,
      code: "live_enforcement_disabled",
    };
  }
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
