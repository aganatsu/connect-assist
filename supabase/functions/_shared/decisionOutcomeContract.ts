export const DECISION_OUTCOME_CONTRACT_VERSION = "decision-outcome.v1";
export type TradingStyle = "scalper" | "day_trader" | "swing_trader" | "unknown";
export interface DecisionOutcomeSnapshot { contractVersion: typeof DECISION_OUTCOME_CONTRACT_VERSION; capturedAt: string; compatibility: "complete" | "legacy_compatible"; tradingStyle: TradingStyle; outcomeWindowHours: number; authority: Record<string, unknown> | null; supportingEvidence: Record<string, unknown> | null; operationalSafety: Record<string, unknown> | null; legacyDiagnostics: { confluenceScore: number; tier1Count: number; tier1Factors: string[] }; }
function record(value: unknown): Record<string, any> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null; }
export function normalizeTradingStyle(value: unknown): TradingStyle { const style = String(value || "").toLowerCase().replaceAll(" ", "_"); if (style === "scalper" || style === "scalp") return "scalper"; if (style === "swing_trader" || style === "swing") return "swing_trader"; if (style === "day_trader" || style === "day") return "day_trader"; return "unknown"; }
export function outcomeWindowForStyle(style: TradingStyle): number { if (style === "scalper") return 8; if (style === "swing_trader") return 72; return 24; }
export function outcomeCandlePlanForStyle(style: TradingStyle): { interval: string; intervalMinutes: number } {
  if (style === "scalper") return { interval: "1min", intervalMinutes: 1 };
  if (style === "swing_trader") return { interval: "1h", intervalMinutes: 60 };
  if (style === "day_trader") return { interval: "5min", intervalMinutes: 5 };
  return { interval: "15min", intervalMinutes: 15 };
}
export interface OutcomeCandleRequest { interval: string; intervalMinutes: number; limit: number; startAt: string; endAt: string; }
export function outcomeCandleRequest(style: TradingStyle, observedAt: string, outcomeWindowHours: number, evaluatedAt = new Date().toISOString()): OutcomeCandleRequest {
  const plan = outcomeCandlePlanForStyle(style);
  const observedMs = Date.parse(observedAt);
  const evaluatedMs = Date.parse(evaluatedAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(evaluatedMs)) throw new RangeError("Outcome candle request requires valid observation and evaluation timestamps");
  const horizonMs = observedMs + outcomeWindowHours * 60 * 60 * 1000;
  const endMs = Math.min(evaluatedMs, horizonMs);
  const startMs = observedMs - plan.intervalMinutes * 30 * 60 * 1000;
  const limit = Math.max(48, Math.ceil((endMs - startMs) / (plan.intervalMinutes * 60 * 1000)) + 4);
  return { ...plan, limit, startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString() };
}
export function buildDecisionOutcomeSnapshot(input: { capturedAt?: string; rawDetail?: Record<string, any>; confluenceScore: number; tier1Count: number; tier1Factors?: string[] }): DecisionOutcomeSnapshot {
  const detail = record(input.rawDetail) || {};
  const style = normalizeTradingStyle(record(detail.stylePolicy)?.style || record(record(detail.frozenStrategyContext)?.stylePolicy)?.style || detail.tradingStyle || detail.activeStyle);
  const authority = record(detail.canonicalScannerState) || record(detail.singleOwnershipDecision) || record(detail.streamlinedTradeDecision);
  const safety = record(record(detail.singleOwnershipDecision)?.authorities)?.safety || record(detail.finalAuthorization) || null;
  const supportingEvidence = record(detail.unifiedZone) || record(detail.impulseZone) || record(detail.timeframeEvidence);
  return { contractVersion: DECISION_OUTCOME_CONTRACT_VERSION, capturedAt: input.capturedAt || new Date().toISOString(), compatibility: authority ? "complete" : "legacy_compatible", tradingStyle: style, outcomeWindowHours: outcomeWindowForStyle(style), authority, supportingEvidence, operationalSafety: record(safety), legacyDiagnostics: { confluenceScore: input.confluenceScore, tier1Count: input.tier1Count, tier1Factors: input.tier1Factors || [] } };
}
