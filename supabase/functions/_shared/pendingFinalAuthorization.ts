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

/**
 * Whether a blocked pending fill should be kept alive for another cycle.
 *
 * `false` means the caller cancels the order permanently, so anything that is
 * merely waiting must report `true` — the function already treats
 * `zone_story_waiting` and `confirmation_waiting` that way.
 *
 * Canonical scanner enforcement is a third gate alongside raw authorization and
 * single ownership, and it was not visible here. When it blocked with
 * `disposition: "wait"` — a transient state such as `awaiting_liquidity` — none
 * of the checks below could see it: ownership had allowed, so its reason codes
 * were empty and its decision was `allow` with complete evidence. The function
 * fell through to `false` and the setup was destroyed instead of held.
 *
 * Observed 2026-08-25 on GBP/USD: `singleOwnershipEnforcement.authorized: true`
 * (`owned_authorities_allow`) alongside `canonicalScannerEnforcement.authorized:
 * false`, `reasonCode: canonical_state_awaiting_liquidity`, `disposition: wait`
 * — cancelled permanently while the state machine was still waiting.
 *
 * `canonical` is optional because backtest-engine has no canonical enforcement
 * gate and projects scanner state only after this call. Omitting it preserves
 * the previous behaviour exactly; backtest cannot diverge on a gate it does not
 * evaluate.
 */
export function pendingFinalAuthorizationRetryable(input: {
  raw: FinalTradeAuthorizationDecision;
  ownership: SingleOwnershipDecisionResult;
  canonical?: {
    authorized: boolean;
    affectsAuthorization: boolean;
    disposition: "allow" | "wait" | "terminal";
  } | null;
}): boolean {
  if (TERMINAL_FINAL_CODES.has(input.raw.code)) return false;
  if (
    input.ownership.reasonCodes.some((reason) =>
      TERMINAL_OWNERSHIP_REASONS.has(reason)
    )
  ) return false;
  // Only meaningful while enforcing; in observe mode canonical always authorizes.
  if (
    input.canonical && input.canonical.affectsAuthorization &&
    !input.canonical.authorized
  ) {
    if (input.canonical.disposition === "terminal") return false;
    if (input.canonical.disposition === "wait") return true;
  }
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
