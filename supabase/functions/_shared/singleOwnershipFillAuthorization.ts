import {
  evaluateSingleOwnershipDecision,
  operationalSafetyChecks,
  type SingleOwnershipDecisionResult,
} from "./singleOwnershipDecision.ts";
import { evaluateSingleOwnershipEnforcement } from "./singleOwnershipEnforcement.ts";
import { normalizeRejectedGate } from "./rejectedSetupLogger.ts";
import { explainReason } from "./singleOwnershipScanOutcome.ts";
import type { FrozenSetupStrategyContext } from "./setupLifecycle.ts";

export function evaluateSingleOwnershipFillAuthorization(input: {
  frozenDecision: SingleOwnershipDecisionResult | null;
  frozenStrategyContext?: FrozenSetupStrategyContext | null;
  evaluatedAt: string;
  candidateId: string;
  symbol: string;
  direction: "long" | "short";
  directionVerdict: {
    verdict?: string | null;
    shouldBlock?: boolean | null;
    id?: string | null;
  } | null;
  canonicalLocation: {
    required: boolean;
    available: boolean;
    allowed: boolean | null;
    rangeId?: string | null;
    reasonCode?: string | null;
  };
  confirmation: {
    passed: boolean;
    authorityVersion?: string | null;
    reasonCodes?: string[];
  };
  thesis: { valid: boolean | null; reasonCodes?: string[] };
  finalChecks: Array<{ passed: boolean; reason: string }>;
  rawFinalAuthorized: boolean;
  requestedMode?: unknown;
  runtimeTarget: "paper" | "live";
}) {
  const frozenZone = input.frozenDecision?.authorities.zoneStory;
  const frozenOriginatingZone = input.frozenStrategyContext?.scenarioZoneStory
    .originatingZone;
  const inheritedZone =
    frozenOriginatingZone && Object.keys(frozenOriginatingZone).length > 0
      ? {
        available: true,
        valid: true,
        entryReady: true,
        source: "frozen_setup_context",
        candidateId: input.frozenStrategyContext?.candidateId ||
          input.candidateId,
        poiType: typeof frozenOriginatingZone.type === "string"
          ? frozenOriginatingZone.type
          : null,
        reasonCodes: ["frozen_zone_story_inherited", "fill_confirmation_ready"],
      }
      : null;
  const decision = evaluateSingleOwnershipDecision({
    evaluatedAt: input.evaluatedAt,
    identity: {
      candidateId: input.candidateId,
      symbol: input.symbol,
      direction: input.direction,
    },
    direction: {
      verdict: input.directionVerdict?.verdict === "long" ||
          input.directionVerdict?.verdict === "short" ||
          input.directionVerdict?.verdict === "neutral"
        ? input.directionVerdict.verdict
        : null,
      shouldBlock: input.directionVerdict?.shouldBlock ?? null,
      evidenceId: input.directionVerdict?.id || null,
      policy: "retain_frozen_until_opposed",
    },
    zoneStory: frozenZone
      ? {
        ...frozenZone,
        entryReady: true,
        reasonCodes: [...frozenZone.reasonCodes, "fill_confirmation_ready"],
      }
      : inheritedZone || {
        available: false,
        valid: null,
        entryReady: null,
        source: null,
        reasonCodes: ["frozen_zone_story_unavailable"],
      },
    canonicalLocation: input.canonicalLocation,
    confirmation: {
      required: true,
      passed: input.confirmation.passed,
      authorityVersion: input.confirmation.authorityVersion || null,
      reasonCodes: input.confirmation.reasonCodes || [],
    },
    thesis: {
      required: true,
      valid: input.thesis.valid,
      reasonCodes: input.thesis.reasonCodes || [],
    },
    safety: {
      complete: true,
      checks: operationalSafetyChecks(input.finalChecks.map((check) => ({
        code: normalizeRejectedGate(check.reason),
        passed: check.passed,
      }))),
    },
    legacyDiagnostics: input.frozenDecision?.legacyDiagnostics || null,
  });
  const enforcement = evaluateSingleOwnershipEnforcement({
    requestedMode: input.requestedMode,
    runtimeTarget: input.runtimeTarget,
    decision,
  });
  const ownershipAllows = enforcement.effectiveMode !== "enforce" ||
    enforcement.authorized;
  const retryable = decision.decision === "watch" ||
    decision.decision === "unavailable";
  const reason = [
    ...decision.reasonCodes,
    ...decision.completeness.unavailable.map((value) => value + "_unavailable"),
  ].join(", ") || "owned_authorities_do_not_allow";
  return {
    decision,
    enforcement,
    authorized: input.rawFinalAuthorized && ownershipAllows,
    retryable,
    reason,
  };
}

/**
 * The literal `evaluateSingleOwnershipFillAuthorization` falls back to when it
 * has nothing to report. Exported so the composer below can recognise it as an
 * absence of evidence rather than a cause.
 */
export const OWNERSHIP_EMPTY_FILL_REASON = "owned_authorities_do_not_allow";

/**
 * Compose the reason a pending fill was blocked, preserving every gate that
 * actually said no.
 *
 * A blocked fill is an AND across three independent gates — the raw final
 * authorization, single ownership, and canonical scanner enforcement — but the
 * message previously reported only single ownership's `reason`, overwriting
 * `rawAuthorization.reason` in the process. That is the one field carrying the
 * specific explanation, so the real cause was destroyed before anything reached
 * the database.
 *
 * It compounds: single ownership's `reason` is a join of its reason codes, and
 * falls back to OWNERSHIP_EMPTY_FILL_REASON when there are none. But an empty
 * code list means the ownership decision was `allow` with complete evidence —
 * so the message asserted that the owned authorities refused, in exactly the
 * case where they did not. Observed 2026-08-25 on a GBP/USD fill that had
 * passed confirmation (`both_passed`, lifecycle `entered`), had valid execution
 * geometry, and cleared R:R at 1.115 against a 1.0 minimum. Nothing recorded
 * which gate stopped it.
 *
 * `operationalSafetyChecks` narrows failing checks to a 16-code whitelist, so a
 * gate outside that set drops out of the code list too and lands here as the
 * empty fallback. Naming the gate that failed is therefore the only reliable
 * signal, and it must not be discarded.
 */
export function composePendingFillBlockReason(input: {
  raw: { authorized: boolean; reason?: string | null };
  ownership: { authorized: boolean; reason: string };
  canonical: {
    authorized: boolean;
    affectsAuthorization: boolean;
    reasonCode: string;
  };
}): string {
  const parts: string[] = [];

  if (!input.raw.authorized) {
    const rawReason = (input.raw.reason ?? "").trim();
    // Name the gate even when it carried no text, so "the raw gate failed
    // silently" stays distinguishable from "the raw gate passed".
    parts.push(rawReason || "final_authorization_denied_without_reason");
  }

  // Only meaningful while enforcing; in observe mode this gate always authorizes.
  if (input.canonical.affectsAuthorization && !input.canonical.authorized) {
    // Prose first so the UI line is readable, code retained in parentheses so
    // the cancellation stays greppable and aggregatable.
    parts.push(
      `${explainReason(input.canonical.reasonCode)} (${input.canonical.reasonCode})`,
    );
  }

  const ownershipReason = (input.ownership.reason ?? "").trim();
  if (
    !input.ownership.authorized && ownershipReason &&
    ownershipReason !== OWNERSHIP_EMPTY_FILL_REASON
  ) {
    parts.push(ownershipReason);
  }

  if (parts.length === 0) {
    // Every gate reported authorized, yet the fill was blocked. That is a
    // contract violation upstream, and saying so is more useful than blaming
    // an authority that allowed the trade.
    return "blocked_with_no_gate_reporting_failure";
  }

  return [...new Set(parts)].join("; ");
}
