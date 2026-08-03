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
