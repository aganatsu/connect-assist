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

export interface RoundTripTradingCostInput {
  lots: number;
  /** Full bid/ask spread paid over the completed trade, in pips. */
  spreadPips?: number;
  pipSize: number;
  lotUnits: number;
  /** USD value of one unit of the instrument's quote currency. */
  quoteToUSD?: number;
  /** Already-resolved round-trip commission per standard lot. */
  roundTripCommissionPerLot?: number;
}

export interface RoundTripTradingCosts {
  spreadCost: number;
  commission: number;
  totalCost: number;
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

/** Apply an already-resolved round-trip $/lot commission exactly once. */
export function calculateRoundTripCommission(
  lots: number,
  roundTripPerLot: number,
): number {
  if (!Number.isFinite(lots) || lots <= 0) return 0;
  if (!Number.isFinite(roundTripPerLot) || roundTripPerLot <= 0) return 0;
  return lots * roundTripPerLot;
}

/** Resolve a positive explicit spread override or fall back to the instrument default. */
export function resolveEffectiveSpreadPips(
  spreadPipsOverride: number | null | undefined,
  typicalSpreadPips: number | null | undefined,
): number {
  const override = positiveFinite(spreadPipsOverride);
  return override > 0 ? override : positiveFinite(typicalSpreadPips);
}

/**
 * Convert a completed trade's full spread and round-trip commission to USD.
 *
 * Backtests use one midpoint OHLC stream, so they cannot separately model the
 * entry ask and exit bid. Charging one full spread on the quantity that closes
 * is the cash-equivalent result and composes correctly across partial exits.
 */
export function calculateRoundTripTradingCosts(
  input: RoundTripTradingCostInput,
): RoundTripTradingCosts {
  const lots = positiveFinite(input.lots);
  const spreadPips = positiveFinite(input.spreadPips);
  const pipSize = positiveFinite(input.pipSize);
  const lotUnits = positiveFinite(input.lotUnits);
  const quoteToUSD = positiveFinite(input.quoteToUSD) || 1;
  const spreadCost = lots * spreadPips * pipSize * lotUnits * quoteToUSD;
  const commission = calculateRoundTripCommission(
    lots,
    positiveFinite(input.roundTripCommissionPerLot),
  );
  return {
    spreadCost,
    commission,
    totalCost: spreadCost + commission,
  };
}
