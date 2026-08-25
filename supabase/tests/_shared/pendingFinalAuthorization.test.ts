import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { FinalTradeAuthorizationDecision } from "../../functions/_shared/finalTradeAuthorization.ts";
import type { SingleOwnershipDecisionResult } from "../../functions/_shared/singleOwnershipDecision.ts";
import { pendingFinalAuthorizationRetryable } from "../../functions/_shared/pendingFinalAuthorization.ts";

function raw(code: FinalTradeAuthorizationDecision["code"], retryable = false) {
  return {
    authorized: false,
    code,
    reason: code,
    retryable,
    checks: [],
    evaluatedAt: new Date(0).toISOString(),
  };
}
function ownership(
  decision: SingleOwnershipDecisionResult["decision"],
  reasons: string[] = [],
  unavailable: string[] = [],
) {
  return {
    contractVersion: "single-ownership-decision.v1",
    observationOnly: true,
    affectsAuthorization: false,
    evaluatedAt: new Date(0).toISOString(),
    identity: {
      candidateId: "candidate",
      symbol: "ETH/USD",
      direction: "long",
    },
    authorities: {
      direction: { verdict: "long", shouldBlock: false },
      zoneStory: {
        available: true,
        valid: true,
        entryReady: true,
        source: "frozen",
        reasonCodes: [],
      },
      canonicalLocation: { required: true, available: true, allowed: true },
      confirmation: { required: true, passed: true, reasonCodes: [] },
      thesis: { required: true, valid: true, reasonCodes: [] },
      safety: { complete: true, checks: [] },
    },
    decision,
    reasonCodes: reasons,
    completeness: { complete: unavailable.length === 0, unavailable },
    legacyDiagnostics: {},
  } as SingleOwnershipDecisionResult;
}

Deno.test("discount/premium location failure waits for a valid executable price", () => {
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("additional_gate"),
      ownership: ownership("block", ["strict_value_required"]),
    }),
    true,
  );
});
Deno.test("missing direction or zone authority waits instead of cancelling", () => {
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("additional_gate"),
      ownership: ownership("unavailable", [], ["direction", "zone_story"]),
    }),
    true,
  );
});
Deno.test("news, spread and capacity remain retryable", () => {
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("news", true),
      ownership: ownership("block", ["strict_value_required"]),
    }),
    true,
  );
});
Deno.test("genuine direction reversal and invalid geometry remain terminal", () => {
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("direction_conflict"),
      ownership: ownership("block", ["direction_not_authorized"]),
    }),
    false,
  );
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("invalid_orientation"),
      ownership: ownership("allow"),
    }),
    false,
  );
});

import { rearmPostChochRetracement } from "../../functions/_shared/postChochRetracement.ts";

Deno.test("temporary final block rearms the same frozen retracement", () => {
  const plan = {
    contractVersion: "post-choch-retracement.v1",
    state: "ready",
    mode: "wait_retracement",
    direction: "long",
    candidateId: "deep-ob",
    confirmationGeneration: 2,
    confirmation: {
      type: "bullish_choch",
      tier: 1,
      price: 1884.77,
      candleIndex: 10,
      candleTime: "2026-08-13T12:00:00Z",
      displacement: 1,
      significance: "internal",
      closeBased: true,
      supportingSignals: [],
      authority: null,
    },
    zone: { type: "micro_ob", low: 1883, high: 1885, midpoint: 1884 },
    protectedLevel: 1875,
    createdAt: "2026-08-13T12:00:00Z",
    expiresAt: "2026-08-13T13:00:00Z",
    touchedAt: "2026-08-13T12:10:00Z",
    resolvedAt: "2026-08-13T12:10:00Z",
    reason: "Price retraced",
  } as const;
  const rearmed = rearmPostChochRetracement(plan, "entry is not in Discount");
  assertEquals(rearmed.state, "awaiting_retracement");
  assertEquals(rearmed.candidateId, "deep-ob");
  assertEquals(rearmed.confirmationGeneration, 2);
  assertEquals(rearmed.touchedAt, null);
});

import { evaluateSingleOwnershipFillAuthorization } from "../../functions/_shared/singleOwnershipFillAuthorization.ts";

Deno.test("fill inherits the persisted originating zone when the scan snapshot is absent", () => {
  const result = evaluateSingleOwnershipFillAuthorization({
    frozenDecision: null,
    frozenStrategyContext: {
      candidateId: "candidate",
      scenarioZoneStory: {
        originatingZone: { type: "fvg", low: 1877.26, high: 1881.68 },
      },
    } as any,
    evaluatedAt: new Date(0).toISOString(),
    candidateId: "candidate",
    symbol: "ETH/USD",
    direction: "long",
    directionVerdict: { verdict: "long", shouldBlock: false, id: "verdict" },
    canonicalLocation: { required: true, available: true, allowed: true },
    confirmation: { passed: true },
    thesis: { valid: true },
    finalChecks: [],
    rawFinalAuthorized: true,
    requestedMode: "enforce",
    runtimeTarget: "live",
  });
  assertEquals(result.decision.authorities.zoneStory.available, true);
  assertEquals(
    result.decision.authorities.zoneStory.source,
    "frozen_setup_context",
  );
  assertEquals(result.decision.completeness.complete, true);
  assertEquals(result.authorized, true);
});

Deno.test("the sole pending fill route uses the shared retry policy", async () => {
  const mainScanner = await Deno.readTextFile(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  const confirmationScanner = await Deno.readTextFile(
    new URL(
      "../../functions/zone-confirmation-scanner/index.ts",
      import.meta.url,
    ),
  );
  assertEquals(
    mainScanner.includes("pendingFinalAuthorizationRetryable({"),
    false,
  );
  assertEquals(
    confirmationScanner.includes("pendingFinalAuthorizationRetryable({"),
    true,
  );
  assertEquals(
    confirmationScanner.includes("rearmPostChochRetracement("),
    true,
  );
});

// ── Canonical scanner enforcement is the third gate ─────────────────────────
// It was invisible here, so a canonical "wait" fell through every check and
// returned false — permanently cancelling a setup the state machine still
// wanted to hold. Observed 2026-08-25 on GBP/USD: ownership authorized
// (owned_authorities_allow) while canonical blocked with
// canonical_state_awaiting_liquidity / disposition "wait", and the order was
// destroyed rather than kept for the next cycle.

const canonical = (
  disposition: "allow" | "wait" | "terminal",
  authorized = false,
  affectsAuthorization = true,
) => ({ authorized, affectsAuthorization, disposition });

Deno.test("canonical wait keeps the setup alive even when every other gate allowed", () => {
  // The exact GBP/USD shape: ownership allowed with no reason codes, so nothing
  // else in this function can see a reason to wait.
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("additional_gate"),
      ownership: ownership("allow"),
      canonical: canonical("wait"),
    }),
    true,
  );
});

Deno.test("canonical terminal cancels permanently", () => {
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("additional_gate"),
      ownership: ownership("allow"),
      canonical: canonical("terminal"),
    }),
    false,
  );
});

Deno.test("canonical is ignored while observing or when it authorized", () => {
  // Observe mode: affectsAuthorization false, so it must not force a wait.
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("additional_gate"),
      ownership: ownership("allow"),
      canonical: canonical("wait", false, false),
    }),
    false,
  );
  // Authorized: canonical is not the blocker, so it has nothing to say.
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("additional_gate"),
      ownership: ownership("allow"),
      canonical: canonical("allow", true),
    }),
    false,
  );
});

Deno.test("a genuinely terminal setup stays terminal despite a canonical wait", () => {
  // Direction reversal and invalid geometry must not be resurrected by a
  // transient canonical state.
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("direction_conflict"),
      ownership: ownership("allow"),
      canonical: canonical("wait"),
    }),
    false,
  );
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("additional_gate"),
      ownership: ownership("block", ["direction_not_authorized"]),
      canonical: canonical("wait"),
    }),
    false,
  );
});

Deno.test("omitting canonical preserves the previous behaviour for backtest", () => {
  // backtest-engine has no canonical enforcement gate and projects scanner
  // state only after this call, so it passes nothing and must be unaffected.
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("additional_gate"),
      ownership: ownership("allow"),
    }),
    false,
  );
  assertEquals(
    pendingFinalAuthorizationRetryable({
      raw: raw("additional_gate"),
      ownership: ownership("block", ["strict_value_required"]),
    }),
    true,
  );
});

Deno.test("zone-confirmation-scanner passes canonical enforcement into the retry decision", async () => {
  const scanner = await Deno.readTextFile(
    new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url),
  );
  assertEquals(
    scanner.includes(
      "pendingFinalAuthorizationRetryable({ raw: rawAuthorization, ownership: ownershipFill.decision, canonical: pendingCanonicalEnforcement })",
    ),
    true,
    "the live retry decision must see the canonical gate that blocked the fill",
  );
});
