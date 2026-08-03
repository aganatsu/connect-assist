import type { TradeDecisionSummary } from "./streamlinedTradeDecision.ts";

export type StreamlinedDecisionMode = "off" | "observe" | "enforce";

export interface StreamlinedEvidenceCertificate {
  certified: boolean;
  expiresAt: string;
  runtimeTargets: Array<"paper" | "live">;
  styles: string[];
  minimumComparable: number;
  comparable: number;
}

export function evaluateStreamlinedEnforcement(input: {
  requestedMode?: string | null;
  runtimeTarget: "paper" | "live";
  style: string;
  now: string;
  certificate?: StreamlinedEvidenceCertificate | null;
  summary?: TradeDecisionSummary | null;
}) {
  const requestedMode: StreamlinedDecisionMode =
    input.requestedMode === "enforce" ? "enforce" :
    input.requestedMode === "observe" ? "observe" : "off";
  if (requestedMode !== "enforce") return {
    requestedMode, effectiveMode: requestedMode, authorized: true,
    code: requestedMode === "off" ? "streamlined_off" : "streamlined_observe",
  } as const;
  const certificate = input.certificate;
  const certified = certificate?.certified === true &&
    Date.parse(certificate.expiresAt) > Date.parse(input.now) &&
    certificate.runtimeTargets.includes(input.runtimeTarget) &&
    certificate.styles.includes(input.style) &&
    certificate.comparable >= certificate.minimumComparable;
  if (!certified) return {
    requestedMode, effectiveMode: "observe", authorized: true,
    code: "streamlined_enforcement_not_certified",
  } as const;
  if (!input.summary || !input.summary.completeness.complete) return {
    requestedMode, effectiveMode: "enforce", authorized: false,
    code: "streamlined_evidence_unavailable",
  } as const;
  return {
    requestedMode, effectiveMode: "enforce",
    authorized: input.summary.proposedDecision.decision === "allow",
    code: input.summary.proposedDecision.decision === "allow"
      ? "streamlined_authorized" : "streamlined_decision_blocked",
  } as const;
}
