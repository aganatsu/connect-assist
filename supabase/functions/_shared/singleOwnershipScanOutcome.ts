import type { SingleOwnershipDecisionResult } from "./singleOwnershipDecision.ts";
import type { SingleOwnershipEnforcementResult } from "./singleOwnershipEnforcement.ts";

export type SingleOwnershipScanOutcome =
  | { disposition: "legacy" | "allow"; reasons: string[] }
  | { disposition: "wait"; status: "waiting_for_reconfirmation"; reasons: string[] }
  | { disposition: "reject"; reasons: string[] };

const REASON_LABELS: Record<string, string> = {
  direction_not_authorized: "HTF Bias does not authorize this direction",
  zone_story_invalid: "ICT Setup Model is invalid",
  zone_story_waiting: "Entry Confirmation is not ready",
  confirmation_waiting: "Entry Confirmation is not ready",
  thesis_invalid: "Setup Thesis is invalid",
  // Canonical scanner stages. These surface on pending-order cancellations,
  // where the raw code alone ("canonical_state_awaiting_liquidity") tells an
  // operator nothing about what the bot was actually waiting for.
  canonical_state_context: "Still building higher-timeframe context",
  canonical_state_discovery: "Still looking for a qualified setup",
  canonical_state_watching: "Watching the zone; price has not arrived",
  canonical_state_at_poi: "Price is at the zone but entry is not authorized yet",
  canonical_state_awaiting_liquidity:
    "Waiting for liquidity to be taken before entry",
  canonical_state_awaiting_confirmation: "Waiting for entry confirmation",
  canonical_state_awaiting_retracement:
    "Waiting for price to retrace back into the entry",
  canonical_state_blocked: "The canonical scanner blocked this setup",
  canonical_state_invalidated: "The setup was invalidated",
  canonical_state_expired: "The setup expired",
};

/**
 * Turn an internal reason code into something an operator can act on.
 *
 * Exported because pending-order cancellations render `cancel_reason` verbatim
 * in the UI (`PendingOrdersPanel.tsx`), and a raw code there is unreadable.
 * This is the single owner of code-to-prose for scanner reasons — do not add a
 * second mapping. `WatchlistPanel.tsx` holds a separate frontend copy for
 * lifecycle codes; that one predates this and is a known duplicate to collapse,
 * not a licence for a third.
 */
export function explainReason(code: string): string {
  if (REASON_LABELS[code]) return REASON_LABELS[code];
  if (code.startsWith("safety_")) {
    const safetyCode = code.slice("safety_".length);
    if (safetyCode === "minimum_risk_reward") {
      return "Trade rejected: the expected reward is too small for the risk. See the R:R gate for the calculated and required ratios";
    }
    return `Risk check failed: ${safetyCode.replaceAll("_", " ")}`;
  }
  // Scoped to the location codes this was written for. A bare `canonical`
  // substring also matches every `canonical_state_*` scanner stage, which is a
  // lifecycle position rather than a Premium/Discount rejection — labelling
  // "awaiting liquidity" as a P/D block is actively misleading.
  if (
    code.includes("canonical_location") || code.includes("wrong_side") ||
    code.includes("strict_value")
  ) {
    return `Premium/Discount rule blocked entry: ${code.replaceAll("_", " ")}`;
  }
  return code.replaceAll("_", " ");
}

export function resolveSingleOwnershipScanOutcome(input: {
  enforcement: SingleOwnershipEnforcementResult;
  decision: SingleOwnershipDecisionResult;
}): SingleOwnershipScanOutcome {
  if (input.enforcement.effectiveMode !== "enforce") {
    return { disposition: "legacy", reasons: [] };
  }
  if (input.decision.decision === "allow") {
    return { disposition: "allow", reasons: [] };
  }

  const reasons = [
    ...input.decision.reasonCodes.map(explainReason),
    ...input.decision.completeness.unavailable.map(
      (authority) => `${authority.replaceAll("_", " ")} evidence is unavailable`,
    ),
  ];
  const uniqueReasons = [...new Set(reasons)];

  if (input.decision.decision === "watch") {
    return {
      disposition: "wait",
      status: "waiting_for_reconfirmation",
      reasons: uniqueReasons.length > 0
        ? uniqueReasons
        : ["Entry Confirmation is not ready"],
    };
  }
  return {
    disposition: "reject",
    reasons: uniqueReasons.length > 0
      ? uniqueReasons
      : ["Trade Decision Mode did not authorize entry"],
  };
}
