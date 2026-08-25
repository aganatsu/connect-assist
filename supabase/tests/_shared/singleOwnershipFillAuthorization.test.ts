import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  composePendingFillBlockReason,
  evaluateSingleOwnershipFillAuthorization,
  OWNERSHIP_EMPTY_FILL_REASON,
} from "../../functions/_shared/singleOwnershipFillAuthorization.ts";
import type { SingleOwnershipDecisionResult } from "../../functions/_shared/singleOwnershipDecision.ts";

const frozen = {
  authorities: {
    zoneStory: {
      available: true, valid: true, entryReady: true, source: "unified",
      reasonCodes: ["zone_story_available"],
    },
  },
  legacyDiagnostics: { effectiveScore: 20, threshold: 55 },
} as SingleOwnershipDecisionResult;

const base = {
  frozenDecision: frozen,
  evaluatedAt: "2026-08-03T00:00:00Z",
  candidateId: "candidate-1",
  symbol: "EUR/USD",
  direction: "short" as const,
  directionVerdict: { verdict: "short", shouldBlock: false },
  canonicalLocation: { required: true, available: true, allowed: true },
  confirmation: { passed: true },
  thesis: { valid: true },
  finalChecks: [{ passed: true, reason: "Spread OK" }],
  rawFinalAuthorized: true,
  requestedMode: "enforce",
  runtimeTarget: "paper" as const,
};

Deno.test("fill authorization refreshes frozen story and allows complete paper setup", () => {
  const result = evaluateSingleOwnershipFillAuthorization(base);
  assertEquals(result.decision.authorities.zoneStory.source, "unified");
  assertEquals(result.authorized, true);
});

Deno.test("fill authorization retains frozen direction while a current verdict is unavailable", () => {
  const result = evaluateSingleOwnershipFillAuthorization({
    ...base,
    directionVerdict: null,
    rawFinalAuthorized: false,
  });
  assertEquals(result.decision.decision, "unavailable");
  assertEquals(result.decision.completeness.unavailable, ["direction"]);
  assertEquals(result.retryable, true);
  assertEquals(result.authorized, false);
});

Deno.test("fill authorization blocks a fresh explicit direction reversal", () => {
  const result = evaluateSingleOwnershipFillAuthorization({
    ...base,
    directionVerdict: { verdict: "long", shouldBlock: false },
  });
  assertEquals(result.decision.decision, "block");
  assertEquals(result.decision.reasonCodes, ["direction_not_authorized"]);
  assertEquals(result.retryable, false);
  assertEquals(result.authorized, false);
});

Deno.test("fill authorization blocks changed canonical location", () => {
  const result = evaluateSingleOwnershipFillAuthorization({
    ...base,
    canonicalLocation: { required: true, available: true, allowed: false },
  });
  assertEquals(result.authorized, false);
  assertEquals(result.enforcement.authorized, false);
  assertEquals(result.retryable, false);
  assertEquals(result.reason.includes("canonical_location"), true);
});

Deno.test("fill authorization cannot override raw operational failure", () => {
  const result = evaluateSingleOwnershipFillAuthorization({
    ...base, rawFinalAuthorized: false,
  });
  assertEquals(result.enforcement.authorized, true);
  assertEquals(result.authorized, false);
});

Deno.test("fill enforcement fails closed without frozen Zone Story", () => {
  const result = evaluateSingleOwnershipFillAuthorization({
    ...base, frozenDecision: null,
  });
  assertEquals(result.authorized, false);
  assertEquals(result.decision.completeness.unavailable, ["zone_story"]);
  assertEquals(result.retryable, true);
  assertEquals(result.reason.includes("zone_story_unavailable"), true);
});

// ── composePendingFillBlockReason ───────────────────────────────────────────
// A blocked fill is an AND across three gates, but the message used to report
// only single ownership's reason and overwrite rawAuthorization.reason — the
// one field carrying the specific cause. Observed 2026-08-25: a GBP/USD fill
// that passed confirmation, had valid geometry and cleared R:R was cancelled
// with the bare literal `owned_authorities_do_not_allow`, which is what
// ownership emits when it has NO reason codes — i.e. when it allowed the trade.

Deno.test("fill block reason keeps the raw gate's own explanation", () => {
  const reason = composePendingFillBlockReason({
    raw: { authorized: false, reason: "Breaker fill rejected: retest incomplete" },
    ownership: { authorized: false, reason: OWNERSHIP_EMPTY_FILL_REASON },
    canonical: { authorized: true, affectsAuthorization: false, reasonCode: "observing" },
  });
  assertEquals(reason, "Breaker fill rejected: retest incomplete");
});

Deno.test("fill block reason never blames ownership when ownership had no codes", () => {
  // The exact GBP/USD shape: ownership allowed (empty codes), raw denied.
  const reason = composePendingFillBlockReason({
    raw: { authorized: false, reason: "" },
    ownership: { authorized: false, reason: OWNERSHIP_EMPTY_FILL_REASON },
    canonical: { authorized: true, affectsAuthorization: false, reasonCode: "observing" },
  });
  assertEquals(reason, "final_authorization_denied_without_reason");
});

Deno.test("fill block reason reports canonical enforcement only while it enforces", () => {
  const enforcing = composePendingFillBlockReason({
    raw: { authorized: true },
    ownership: { authorized: true, reason: "" },
    canonical: {
      authorized: false,
      affectsAuthorization: true,
      reasonCode: "canonical_state_watching",
    },
  });
  assertEquals(
    enforcing,
    "Watching the zone; price has not arrived (canonical_state_watching)",
  );

  // In observe mode canonical always authorizes, so it must not appear.
  const observing = composePendingFillBlockReason({
    raw: { authorized: false, reason: "spread too wide" },
    ownership: { authorized: false, reason: OWNERSHIP_EMPTY_FILL_REASON },
    canonical: {
      authorized: true,
      affectsAuthorization: false,
      reasonCode: "single_ownership_required",
    },
  });
  assertEquals(observing, "spread too wide");
});

Deno.test("fill block reason lists every gate that failed, deduplicated", () => {
  const reason = composePendingFillBlockReason({
    raw: { authorized: false, reason: "minimum risk reward" },
    ownership: { authorized: false, reason: "safety_spread, thesis_invalid" },
    canonical: {
      authorized: false,
      affectsAuthorization: true,
      reasonCode: "canonical_state_at_poi",
    },
  });
  assertEquals(
    reason,
    "minimum risk reward; " +
      "Price is at the zone but entry is not authorized yet (canonical_state_at_poi); " +
      "safety_spread, thesis_invalid",
  );
});

Deno.test("fill block reason says so when no gate reported a failure", () => {
  // Every gate authorized yet the fill was blocked — an upstream contract
  // violation. Saying that is more useful than naming an authority that allowed it.
  const reason = composePendingFillBlockReason({
    raw: { authorized: true },
    ownership: { authorized: true, reason: "" },
    canonical: { authorized: true, affectsAuthorization: true, reasonCode: "canonical_state_authorized" },
  });
  assertEquals(reason, "blocked_with_no_gate_reporting_failure");
});

Deno.test("zone-confirmation-scanner composes the block reason instead of discarding it", async () => {
  const scanner = await Deno.readTextFile(
    new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url),
  );
  assertEquals(
    scanner.includes('"Trade Decision did not authorize entry: " + ownershipFill.reason'),
    false,
    "the failure branch is still overwriting rawAuthorization.reason with ownership's",
  );
  assertEquals(
    scanner.includes("composePendingFillBlockReason({ raw: rawAuthorization, ownership: ownershipFill, canonical: pendingCanonicalEnforcement })"),
    true,
    "the failure branch must compose from all three gates",
  );
});

Deno.test("the GBP/USD cancellation now reads as an explanation, not a code", () => {
  // What the operator actually saw in PendingOrdersPanel on 2026-08-25:
  //   [final-auth:additional_gate] Trade Decision did not authorize entry:
  //   owned_authorities_do_not_allow
  // — which named the one gate that had ALLOWED the trade, in machine syntax.
  const reason = composePendingFillBlockReason({
    raw: { authorized: true },
    ownership: { authorized: true, reason: "" },
    canonical: {
      authorized: false,
      affectsAuthorization: true,
      reasonCode: "canonical_state_awaiting_liquidity",
    },
  });
  assertEquals(
    reason,
    "Waiting for liquidity to be taken before entry (canonical_state_awaiting_liquidity)",
  );
  // The code is retained so cancellations stay greppable and aggregatable.
  assertEquals(reason.includes("canonical_state_awaiting_liquidity"), true);
});

Deno.test("an unmapped canonical code degrades to readable words, never raw snake_case", () => {
  const reason = composePendingFillBlockReason({
    raw: { authorized: true },
    ownership: { authorized: true, reason: "" },
    canonical: {
      authorized: false,
      affectsAuthorization: true,
      reasonCode: "canonical_state_some_future_stage",
    },
  });
  assertEquals(reason.includes("canonical_state_some_future_stage"), true);
  assertEquals(reason.includes("_"), true); // the code half keeps underscores
  assertEquals(
    reason.startsWith("canonical state some future stage ("),
    true,
    "unmapped codes must still be spaced out rather than shown raw",
  );
});
