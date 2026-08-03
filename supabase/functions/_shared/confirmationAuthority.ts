export const CONFIRMATION_AUTHORITY_VERSION = "confirmation-authority.v1";

export type ConfirmationAuthoritySource =
  | "unified_hierarchy"
  | "legacy_tier"
  | "indicator_router"
  | "combined_router"
  | "unavailable";

export type ConfirmationAuthorityLevel =
  | "sweep_close_choch"
  | "close_choch"
  | "displacement"
  | "wick_choch_supported"
  | "reversal_pattern"
  | "indicator_minimum"
  | "combined"
  | "none";

export interface ConfirmationAuthorityObservation {
  contractVersion: typeof CONFIRMATION_AUTHORITY_VERSION;
  observationOnly: true;
  affectsAuthorization: false;
  evaluatedAt: string | null;
  source: ConfirmationAuthoritySource;
  level: ConfirmationAuthorityLevel;
  direction: "long" | "short";
  entryReadyUnderCurrentBehavior: boolean;
  candleIndex: number | null;
  candleTime: string | null;
  price: number | null;
  closeBased: boolean | null;
  displacement: number | null;
  supportingSignals: string[];
  reasonCodes: string[];
}

export function buildConfirmationAuthorityObservation(input: {
  source: ConfirmationAuthoritySource;
  level: ConfirmationAuthorityLevel;
  direction: "long" | "short";
  entryReadyUnderCurrentBehavior: boolean;
  evaluatedAt?: string | null;
  candleIndex?: number | null;
  candleTime?: string | null;
  price?: number | null;
  closeBased?: boolean | null;
  displacement?: number | null;
  supportingSignals?: string[];
  reasonCodes?: string[];
}): ConfirmationAuthorityObservation {
  return {
    contractVersion: CONFIRMATION_AUTHORITY_VERSION,
    observationOnly: true,
    affectsAuthorization: false,
    evaluatedAt: input.evaluatedAt ?? null,
    source: input.source,
    level: input.level,
    direction: input.direction,
    entryReadyUnderCurrentBehavior: input.entryReadyUnderCurrentBehavior,
    candleIndex: input.candleIndex ?? null,
    candleTime: input.candleTime ?? null,
    price: Number.isFinite(input.price) ? input.price! : null,
    closeBased: input.closeBased ?? null,
    displacement: Number.isFinite(input.displacement)
      ? input.displacement!
      : null,
    supportingSignals: [...new Set(input.supportingSignals || [])].sort(),
    reasonCodes: [...new Set(input.reasonCodes || [])].sort(),
  };
}

export function confirmationLevelFromLegacySignal(signal: {
  tier: 1 | 2 | 3;
  closeBased: boolean;
  supportingSignals: string[];
}): ConfirmationAuthorityLevel {
  if (signal.supportingSignals.includes("sweep_choch")) {
    return "sweep_close_choch";
  }
  if (signal.tier === 1 && signal.closeBased) return "close_choch";
  if (signal.tier === 2) return "wick_choch_supported";
  return "reversal_pattern";
}

export function buildRoutedConfirmationObservation(input: {
  method: "choch" | "indicators" | "choch_and_indicators";
  direction: "long" | "short";
  structural?: ConfirmationAuthorityObservation | null;
  indicatorsPassed?: number | null;
  indicatorsRequired?: number | null;
  indicatorConfirmed?: boolean;
  evaluatedAt?: string | null;
  candleIndex?: number | null;
  candleTime?: string | null;
  price?: number | null;
}): ConfirmationAuthorityObservation {
  const indicatorPassed = input.indicatorConfirmed === true;
  if (input.method === "choch" && input.structural) return input.structural;
  if (input.method === "indicators") {
    return buildConfirmationAuthorityObservation({
      source: "indicator_router",
      level: indicatorPassed ? "indicator_minimum" : "none",
      direction: input.direction,
      entryReadyUnderCurrentBehavior: indicatorPassed,
      evaluatedAt: input.evaluatedAt, candleIndex: input.candleIndex,
      candleTime: input.candleTime, price: input.price,
      supportingSignals: ["indicators:" + (input.indicatorsPassed ?? 0) + "/" + (input.indicatorsRequired ?? 0)],
      reasonCodes: [indicatorPassed ? "indicator_minimum_met" : "indicator_minimum_not_met"],
    });
  }
  if (input.method === "choch_and_indicators") {
    const structuralPassed = input.structural?.entryReadyUnderCurrentBehavior === true;
    return buildConfirmationAuthorityObservation({
      source: "combined_router", level: "combined", direction: input.direction,
      entryReadyUnderCurrentBehavior: structuralPassed && indicatorPassed,
      evaluatedAt: input.evaluatedAt,
      candleIndex: input.structural?.candleIndex ?? input.candleIndex,
      candleTime: input.structural?.candleTime ?? input.candleTime,
      price: input.structural?.price ?? input.price,
      closeBased: input.structural?.closeBased ?? null,
      displacement: input.structural?.displacement ?? null,
      supportingSignals: [
        "structural:" + (input.structural?.source ?? "none") + ":" + (input.structural?.level ?? "none"),
        "indicators:" + (input.indicatorsPassed ?? 0) + "/" + (input.indicatorsRequired ?? 0),
      ],
      reasonCodes: [
        structuralPassed ? "structural_confirmation_met" : "structural_confirmation_not_met",
        indicatorPassed ? "indicator_minimum_met" : "indicator_minimum_not_met",
      ],
    });
  }
  return buildConfirmationAuthorityObservation({
    source: "unavailable", level: "none", direction: input.direction,
    entryReadyUnderCurrentBehavior: false, evaluatedAt: input.evaluatedAt,
    candleIndex: input.candleIndex, candleTime: input.candleTime, price: input.price,
    reasonCodes: ["structural_confirmation_not_met"],
  });
}
