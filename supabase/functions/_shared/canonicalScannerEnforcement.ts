import type { CanonicalScannerState } from "./canonicalScannerState.ts";

export const CANONICAL_SCANNER_ENFORCEMENT_VERSION = "canonical-scanner-enforcement.v1";
export type CanonicalScannerMode = "observe" | "enforce";

export function evaluateCanonicalScannerEnforcement(input: {
  requestedMode?: unknown;
  singleOwnershipEffectiveMode: "observe" | "enforce" | "enforce_live";
  state: CanonicalScannerState;
}) {
  const requestedMode: CanonicalScannerMode = input.requestedMode === "enforce" ? "enforce" : "observe";
  const effectiveMode: CanonicalScannerMode = requestedMode === "enforce" && input.singleOwnershipEffectiveMode === "enforce" ? "enforce" : "observe";
  const authorized = effectiveMode === "observe" || input.state.stage === "authorized" || input.state.stage === "entered" || input.state.stage === "managing";
  return {
    contractVersion: CANONICAL_SCANNER_ENFORCEMENT_VERSION,
    requestedMode, effectiveMode, authorized,
    affectsAuthorization: effectiveMode === "enforce",
    reasonCode: effectiveMode === "observe" ? (requestedMode === "enforce" ? "single_ownership_required" : "observing") : authorized ? "canonical_state_authorized" : `canonical_state_${input.state.stage}`,
  } as const;
}

export function compareCanonicalScannerDecisions(rows: Array<{ legacyAllowed: boolean; canonicalStage: CanonicalScannerState["stage"]; outcome?: "won" | "lost" | "unresolved" }>) {
  const resolved = rows.filter((row) => row.outcome === "won" || row.outcome === "lost");
  const canonicalAllowed = (stage: CanonicalScannerState["stage"]) => ["authorized", "entered", "managing"].includes(stage);
  return {
    total: rows.length,
    resolved: resolved.length,
    agreements: rows.filter((row) => row.legacyAllowed === canonicalAllowed(row.canonicalStage)).length,
    disagreements: rows.filter((row) => row.legacyAllowed !== canonicalAllowed(row.canonicalStage)).length,
    winnersPreserved: resolved.filter((row) => row.outcome === "won" && canonicalAllowed(row.canonicalStage)).length,
    winnersBlocked: resolved.filter((row) => row.outcome === "won" && !canonicalAllowed(row.canonicalStage)).length,
    poorEntriesRejected: resolved.filter((row) => row.outcome === "lost" && !canonicalAllowed(row.canonicalStage)).length,
    poorEntriesAllowed: resolved.filter((row) => row.outcome === "lost" && canonicalAllowed(row.canonicalStage)).length,
  };
}
