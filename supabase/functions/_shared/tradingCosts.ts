export type CommissionMode = "auto" | "manual" | "none";

export interface CommissionSettings {
  commission_mode?: string | null;
  /** User-entered round-trip commission per standard lot. */
  commission_per_lot?: number | string | null;
  /** Broker-observed commission per standard lot, per side. */
  detected_commission_per_lot?: number | string | null;
}

export interface ResolvedRoundTripCommission {
  mode: CommissionMode;
  source:
    | "manual_round_trip"
    | "detected_per_side"
    | "none"
    | "unavailable";
  detectedPerSide: number;
  roundTripPerLot: number;
}

function positiveFinite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Single owner for turning persisted broker commission settings into the
 * round-trip $/lot value consumed by R:R checks and position sizing.
 *
 * Rows created before commission_mode existed preserve the old behavior:
 * positive manual values win; otherwise a detected per-side charge is doubled.
 */
export function resolveRoundTripCommission(
  settings: CommissionSettings,
): ResolvedRoundTripCommission {
  const manualRoundTrip = positiveFinite(settings.commission_per_lot);
  const detectedPerSide = positiveFinite(
    settings.detected_commission_per_lot,
  );
  const requestedMode = settings.commission_mode;
  const mode: CommissionMode = requestedMode === "manual" ||
      requestedMode === "none" || requestedMode === "auto"
    ? requestedMode
    : manualRoundTrip > 0
    ? "manual"
    : "auto";

  if (mode === "none") {
    return {
      mode,
      source: "none",
      detectedPerSide,
      roundTripPerLot: 0,
    };
  }
  if (mode === "manual") {
    return {
      mode,
      source: "manual_round_trip",
      detectedPerSide,
      roundTripPerLot: manualRoundTrip,
    };
  }
  return {
    mode,
    source: detectedPerSide > 0 ? "detected_per_side" : "unavailable",
    detectedPerSide,
    roundTripPerLot: detectedPerSide * 2,
  };
}

export function averageRoundTripCommission(
  connections: CommissionSettings[],
): number {
  const values = connections.map((connection) =>
    resolveRoundTripCommission(connection).roundTripPerLot
  ).filter((value) => value > 0);
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}
