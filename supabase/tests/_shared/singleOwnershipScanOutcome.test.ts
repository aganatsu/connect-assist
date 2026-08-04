import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SingleOwnershipDecisionResult } from "../../functions/_shared/singleOwnershipDecision.ts";
import type { SingleOwnershipEnforcementResult } from "../../functions/_shared/singleOwnershipEnforcement.ts";
import { resolveSingleOwnershipScanOutcome } from "../../functions/_shared/singleOwnershipScanOutcome.ts";

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

Deno.test("observation leaves legacy scanner disposition unchanged", () => {
  assertEquals(resolveSingleOwnershipScanOutcome({
    enforcement: enforcement("observe"),
    decision: decision("watch", ["confirmation_waiting"]),
  }), { disposition: "legacy", reasons: [] });
});
