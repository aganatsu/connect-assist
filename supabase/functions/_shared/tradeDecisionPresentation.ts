import type { CanonicalScannerState } from "./canonicalScannerState.ts";

export const TRADE_DECISION_PRESENTATION_VERSION = "trade-decision-presentation.v1";

export interface TradeDecisionPresentation {
  contractVersion: typeof TRADE_DECISION_PRESENTATION_VERSION;
  primary: { stage: CanonicalScannerState["stage"]; reasonCode: string; explanation: string };
  authorityChecks: CanonicalScannerState["authorities"];
  diagnostics: Array<{ code: string; passed: boolean; reason?: string; owner: "legacy_diagnostic" }>;
  diagnosticsAffectAuthorization: false;
}

export function buildTradeDecisionPresentation(input: {
  state: CanonicalScannerState;
  legacyDiagnostics?: Array<{ code?: unknown; passed?: unknown; reason?: unknown; owner?: unknown }>;
}): TradeDecisionPresentation {
  const diagnostics = (input.legacyDiagnostics || [])
    .filter((item) => item.owner === "legacy_diagnostic")
    .map((item) => ({
      code: String(item.code || "legacy_diagnostic"),
      passed: item.passed === true,
      reason: typeof item.reason === "string" ? item.reason : undefined,
      owner: "legacy_diagnostic" as const,
    }));
  return {
    contractVersion: TRADE_DECISION_PRESENTATION_VERSION,
    primary: { stage: input.state.stage, reasonCode: input.state.reasonCode, explanation: input.state.explanation },
    authorityChecks: input.state.authorities,
    diagnostics,
    diagnosticsAffectAuthorization: false,
  };
}
