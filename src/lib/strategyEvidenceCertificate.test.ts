import { describe, expect, it } from "vitest";
import {
  reviewStrategyEvidence,
  shortCertificateHash,
  STRATEGY_EVIDENCE_STATUS,
} from "./strategyEvidenceCertificate";

describe("strategy evidence certificate display", () => {
  it("clearly distinguishes collection from log-only eligibility", () => {
    expect(STRATEGY_EVIDENCE_STATUS.collecting.label).toContain("COLLECTING");
    expect(STRATEGY_EVIDENCE_STATUS.eligible_log_only.label).toContain(
      "LOG-ONLY ELIGIBLE",
    );
  });

  it("shows a compact immutable certificate fingerprint", () => {
    expect(shortCertificateHash("a".repeat(64))).toBe("a".repeat(12));
  });
});

describe("strategy evidence review", () => {
  const certificate = (overrides: Record<string, unknown> = {}) => ({
    feature_key: "gameplan_hierarchy",
    variant_key: "default",
    status: "collecting" as const,
    certificate_hash: "hash",
    resolved_count: 10,
    changed_count: 2,
    coverage_percent: 30,
    beneficial_rate_percent: 50,
    expectancy_delta_r: 0,
    max_drawdown_delta_percent: 0,
    good_trade_retention_percent: 100,
    out_of_sample_passed: false,
    walk_forward_consistent: false,
    source_window_start: null,
    source_window_end: null,
    generated_at: "2026-08-05T00:00:00Z",
    is_current: true,
    ...overrides,
  });

  it("promotes only a server-certified log-only candidate", () => {
    expect(reviewStrategyEvidence(certificate({ status: "eligible_log_only" })).action)
      .toBe("promote_log_only");
  });

  it("marks mature negative evidence as a removal candidate", () => {
    expect(reviewStrategyEvidence(certificate({
      status: "keep_shadow",
      resolved_count: 40,
      changed_count: 15,
      coverage_percent: 70,
      beneficial_rate_percent: 40,
      expectancy_delta_r: -0.1,
    })).action).toBe("remove_candidate");
  });

  it("keeps incomplete evidence observing", () => {
    expect(reviewStrategyEvidence(certificate()).action).toBe("keep_observing");
  });
});
