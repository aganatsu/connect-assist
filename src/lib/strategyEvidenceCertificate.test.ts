import { describe, expect, it } from "vitest";
import {
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
