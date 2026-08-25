import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SingleOwnershipDecisionResult } from "../../functions/_shared/singleOwnershipDecision.ts";
import type { SingleOwnershipEnforcementResult } from "../../functions/_shared/singleOwnershipEnforcement.ts";
import {
  explainReason,
  resolveSingleOwnershipScanOutcome,
} from "../../functions/_shared/singleOwnershipScanOutcome.ts";

function decision(
  value: "allow" | "watch" | "block" | "unavailable",
  reasonCodes: string[] = [],
  unavailable: string[] = [],
): SingleOwnershipDecisionResult {
  return {
    decision: value,
    reasonCodes,
    completeness: { complete: unavailable.length === 0, unavailable },
  } as SingleOwnershipDecisionResult;
}

function enforcement(mode: "observe" | "enforce"): SingleOwnershipEnforcementResult {
  return {
    effectiveMode: mode,
    requestedMode: mode,
    runtimeTarget: "paper",
    authorized: false,
    affectsAuthorization: mode === "enforce",
    code: mode === "enforce" ? "owned_authorities_do_not_allow" : "observing",
  };
}

Deno.test("ownership watch remains waiting instead of becoming rejected", () => {
  assertEquals(resolveSingleOwnershipScanOutcome({
    enforcement: enforcement("enforce"),
    decision: decision("watch", ["confirmation_waiting", "zone_story_waiting"]),
  }), {
    disposition: "wait",
    status: "waiting_for_reconfirmation",
    reasons: ["Entry Confirmation is not ready"],
  });
});

Deno.test("ownership block and unavailable decisions always explain rejection", () => {
  assertEquals(resolveSingleOwnershipScanOutcome({
    enforcement: enforcement("enforce"),
    decision: decision("block", ["direction_not_authorized"]),
  }).reasons, ["HTF Bias does not authorize this direction"]);
  assertEquals(resolveSingleOwnershipScanOutcome({
    enforcement: enforcement("enforce"),
    decision: decision("unavailable", [], ["canonical_location"]),
  }).reasons, ["canonical location evidence is unavailable"]);
});

Deno.test("minimum R:R fallback explains the trading meaning", () => {
  assertEquals(resolveSingleOwnershipScanOutcome({
    enforcement: enforcement("enforce"),
    decision: decision("block", ["safety_minimum_risk_reward"]),
  }).reasons, [
    "Trade rejected: the expected reward is too small for the risk. See the R:R gate for the calculated and required ratios",
  ]);
});

Deno.test("observation leaves legacy scanner disposition unchanged", () => {
  assertEquals(resolveSingleOwnershipScanOutcome({
    enforcement: enforcement("observe"),
    decision: decision("watch", ["confirmation_waiting"]),
  }), { disposition: "legacy", reasons: [] });
});

Deno.test("Premium/Discount labelling is scoped to location codes, not every canonical code", () => {
  // The catch-all matched a bare `canonical` substring, so every
  // `canonical_state_*` scanner stage was labelled a Premium/Discount block.
  // Those are lifecycle positions, not P/D rejections.
  assertEquals(
    explainReason("canonical_location_blocked").startsWith(
      "Premium/Discount rule blocked entry",
    ),
    true,
  );
  assertEquals(
    explainReason("canonical_state_awaiting_liquidity"),
    "Waiting for liquidity to be taken before entry",
  );
  assertEquals(
    explainReason("canonical_state_some_future_stage").includes(
      "Premium/Discount",
    ),
    false,
    "an unmapped scanner stage must not be reported as a Premium/Discount block",
  );
});

Deno.test("canonical scanner stages read as explanations", () => {
  assertEquals(
    explainReason("canonical_state_watching"),
    "Watching the zone; price has not arrived",
  );
  assertEquals(
    explainReason("canonical_state_awaiting_retracement"),
    "Waiting for price to retrace back into the entry",
  );
});
