export const DECISION_OUTCOME_CONTRACT_VERSION = "decision-outcome.v1";
export type TradingStyle = "scalper" | "day_trader" | "swing_trader" | "unknown";
export interface DecisionOutcomeSnapshot { contractVersion: typeof DECISION_OUTCOME_CONTRACT_VERSION; capturedAt: string; compatibility: "complete" | "legacy_compatible"; tradingStyle: TradingStyle; outcomeWindowHours: number; authority: Record<string, unknown> | null; supportingEvidence: Record<string, unknown> | null; operationalSafety: Record<string, unknown> | null; legacyDiagnostics: { confluenceScore: number; tier1Count: number; tier1Factors: string[] }; }
function record(value: unknown): Record<string, any> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null; }
export function normalizeTradingStyle(value: unknown): TradingStyle { const style = String(value || "").toLowerCase().replaceAll(" ", "_"); if (style === "scalper" || style === "scalp") return "scalper"; if (style === "swing_trader" || style === "swing") return "swing_trader"; if (style === "day_trader" || style === "day") return "day_trader"; return "unknown"; }
export function outcomeWindowForStyle(style: TradingStyle): number { if (style === "scalper") return 8; if (style === "swing_trader") return 72; return 24; }
export function buildDecisionOutcomeSnapshot(input: { capturedAt?: string; rawDetail?: Record<string, any>; confluenceScore: number; tier1Count: number; tier1Factors?: string[] }): DecisionOutcomeSnapshot {
  const detail = record(input.rawDetail) || {};
  const style = normalizeTradingStyle(record(detail.stylePolicy)?.style || record(record(detail.frozenStrategyContext)?.stylePolicy)?.style || detail.tradingStyle || detail.activeStyle);
  const authority = record(detail.canonicalScannerState) || record(detail.singleOwnershipDecision) || record(detail.streamlinedTradeDecision);
  const safety = record(record(detail.singleOwnershipDecision)?.authorities)?.safety || record(detail.finalAuthorization) || null;
  const supportingEvidence = record(detail.unifiedZone) || record(detail.impulseZone) || record(detail.timeframeEvidence);
  return { contractVersion: DECISION_OUTCOME_CONTRACT_VERSION, capturedAt: input.capturedAt || new Date().toISOString(), compatibility: authority ? "complete" : "legacy_compatible", tradingStyle: style, outcomeWindowHours: outcomeWindowForStyle(style), authority, supportingEvidence, operationalSafety: record(safety), legacyDiagnostics: { confluenceScore: input.confluenceScore, tier1Count: input.tier1Count, tier1Factors: input.tier1Factors || [] } };
}
