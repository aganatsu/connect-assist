import type { FinalTradeAuthorizationDecision } from "./finalTradeAuthorization.ts";
import type { SingleOwnershipDecisionResult } from "./singleOwnershipDecision.ts";

export const PENDING_FINAL_AUTHORIZATION_VERSION =
  "pending-final-authorization.v1";

const TERMINAL_FINAL_CODES = new Set([
  "invalid_price",
  "invalid_orientation",
  "risk_reward",
  "direction_blocked",
  "direction_conflict",
  "thesis_invalid",
  "cross_timeframe_blocked",
]);

const TERMINAL_OWNERSHIP_REASONS = new Set([
  "direction_not_authorized",
  "zone_story_invalid",
  "thesis_invalid",
]);

export function pendingFinalAuthorizationRetryable(input: {
  raw: FinalTradeAuthorizationDecision;
  ownership: SingleOwnershipDecisionResult;
}): boolean {
  if (TERMINAL_FINAL_CODES.has(input.raw.code)) return false;
  if (
    input.ownership.reasonCodes.some((reason) =>
      TERMINAL_OWNERSHIP_REASONS.has(reason)
    )
  ) return false;
  if (input.raw.retryable) return true;
  if (
    input.ownership.decision === "watch" ||
    input.ownership.decision === "unavailable" ||
    !input.ownership.completeness.complete
  ) return true;
  return input.ownership.reasonCodes.some((reason) =>
    reason === "wrong_side" ||
    reason === "strict_value_required" ||
    reason === "canonical_location_blocked" ||
    reason === "zone_story_waiting" ||
    reason === "confirmation_waiting" ||
    reason.startsWith("safety_")
  );
}
