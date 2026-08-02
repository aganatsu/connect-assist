import type {
  CrossTimeframeAuthorityResolution,
} from "./crossTimeframeAuthority.ts";
import type {
  CrossTimeframeShadowEvaluation,
} from "./crossTimeframeShadowValidation.ts";

export const CROSS_TF_ENTRY_AUTHORITY_VERSION =
  "cross-tf-entry-authority.v1";
export const CROSS_TF_SOFT_SCORE_PENALTY = 10;

export interface CrossTimeframeEntryAuthorityDecision {
  contractVersion: typeof CROSS_TF_ENTRY_AUTHORITY_VERSION;
  requestedMode: "observe" | "soft" | "hard";
  certifiedMaximum: "observe" | "soft" | "hard";
  effectiveMode: "observe" | "soft" | "hard";
  candidateId: string | null;
  evidenceAvailable: boolean;
  proposedDecision: "allow" | "block" | "unavailable";
  allowed: boolean;
  scoreAdjustment: number;
  reasonCodes: string[];
  reason:
    | "observe_only"
    | "policy_supported"
    | "soft_penalty_policy_block"
    | "soft_penalty_missing_evidence"
    | "hard_block_policy"
    | "hard_block_missing_evidence";
  authorityResolution: CrossTimeframeAuthorityResolution;
  evaluation: CrossTimeframeShadowEvaluation | null;
}

export function evaluateCrossTimeframeEntryAuthority(input: {
  authorityResolution: CrossTimeframeAuthorityResolution;
  evaluation: CrossTimeframeShadowEvaluation | null | undefined;
  candidateId?: string | null;
}): CrossTimeframeEntryAuthorityDecision {
  const evaluation = input.evaluation || null;
  const evidenceAvailable = evaluation !== null;
  const proposedDecision = evaluation?.proposedDecision ?? "unavailable";
  const base = {
    contractVersion: CROSS_TF_ENTRY_AUTHORITY_VERSION,
    requestedMode: input.authorityResolution.requestedMode,
    certifiedMaximum: input.authorityResolution.certifiedMaximum,
    effectiveMode: input.authorityResolution.effectiveMode,
    candidateId: input.candidateId || null,
    evidenceAvailable,
    proposedDecision,
    reasonCodes: evaluation?.reasonCodes || ["cross_tf_evidence_unavailable"],
    authorityResolution: input.authorityResolution,
    evaluation,
  } as const;

  if (input.authorityResolution.effectiveMode === "observe") {
    return {
      ...base,
      allowed: true,
      scoreAdjustment: 0,
      reason: "observe_only",
    };
  }
  if (evaluation?.proposedDecision === "allow") {
    return {
      ...base,
      allowed: true,
      scoreAdjustment: 0,
      reason: "policy_supported",
    };
  }
  if (input.authorityResolution.effectiveMode === "soft") {
    return {
      ...base,
      allowed: true,
      scoreAdjustment: -CROSS_TF_SOFT_SCORE_PENALTY,
      reason: evidenceAvailable
        ? "soft_penalty_policy_block"
        : "soft_penalty_missing_evidence",
    };
  }
  return {
    ...base,
    allowed: false,
    scoreAdjustment: 0,
    reason: evidenceAvailable
      ? "hard_block_policy"
      : "hard_block_missing_evidence",
  };
}
