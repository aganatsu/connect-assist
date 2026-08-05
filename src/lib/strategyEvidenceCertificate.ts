export type StrategyEvidenceCertificateStatus =
  | "collecting"
  | "eligible_log_only"
  | "keep_shadow";

export interface StrategyEvidenceCertificateRecord {
  feature_key: string;
  variant_key: string;
  status: StrategyEvidenceCertificateStatus;
  certificate_hash: string;
  resolved_count: number;
  changed_count: number;
  coverage_percent: number;
  beneficial_rate_percent: number | null;
  expectancy_delta_r: number;
  max_drawdown_delta_percent: number;
  good_trade_retention_percent: number;
  out_of_sample_passed: boolean;
  walk_forward_consistent: boolean;
  source_window_start: string | null;
  source_window_end: string | null;
  generated_at: string;
  is_current: boolean;
}

export type StrategyEvidenceReviewAction =
  | "promote_log_only"
  | "keep_observing"
  | "remove_candidate";

export interface StrategyEvidenceReview {
  action: StrategyEvidenceReviewAction;
  label: string;
  reason: string;
}

export function reviewStrategyEvidence(
  certificate?: StrategyEvidenceCertificateRecord,
): StrategyEvidenceReview {
  if (!certificate) {
    return { action: "keep_observing", label: "KEEP OBSERVING", reason: "No trusted certificate exists for this feature yet." };
  }
  if (certificate.status === "eligible_log_only") {
    return {
      action: "promote_log_only",
      label: "PROMOTE TO LOG-ONLY",
      reason: "The server certificate passed sample, out-of-sample, walk-forward, expectancy, drawdown, and winner-retention screening.",
    };
  }
  const matureNegativeSample = certificate.resolved_count >= 30
    && certificate.changed_count >= 10
    && certificate.coverage_percent >= 50
    && certificate.expectancy_delta_r <= 0
    && (certificate.beneficial_rate_percent ?? 0) < 50;
  if (matureNegativeSample) {
    return {
      action: "remove_candidate",
      label: "REMOVE CANDIDATE",
      reason: "The sample is mature, but changed decisions were more harmful than useful and did not improve expectancy. Keep it non-enforcing while reviewing removal.",
    };
  }
  return {
    action: "keep_observing",
    label: "KEEP OBSERVING",
    reason: "The evidence is incomplete or inconsistent. Continue observation without changing runtime authority.",
  };
}

export const STRATEGY_EVIDENCE_STATUS = {
  collecting: {
    label: "CERTIFICATE · COLLECTING",
    className: "border-info-c/40 text-info-c",
  },
  eligible_log_only: {
    label: "CERTIFICATE · LOG-ONLY ELIGIBLE",
    className: "border-success/40 text-success",
  },
  keep_shadow: {
    label: "CERTIFICATE · KEEP SHADOW",
    className: "border-warning/40 text-warning",
  },
} as const;

export function shortCertificateHash(hash: string): string {
  return hash.length <= 12 ? hash : hash.slice(0, 12);
}
