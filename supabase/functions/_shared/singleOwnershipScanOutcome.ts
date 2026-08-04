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
};

function explainReason(code: string): string {
  if (REASON_LABELS[code]) return REASON_LABELS[code];
  if (code.startsWith("safety_")) {
    return `Risk check failed: ${code.slice("safety_".length).replaceAll("_", " ")}`;
  }
  if (code.includes("canonical") || code.includes("wrong_side") || code.includes("strict_value")) {
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
