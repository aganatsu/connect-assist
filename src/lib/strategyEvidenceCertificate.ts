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
