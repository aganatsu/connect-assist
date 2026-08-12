import type { LiquiditySequence } from "./canonicalLiquiditySequence.ts";
import { buildEntityId } from "./conceptEvidence.ts";

export const LIQUIDITY_CONFIRMATION_CONTRACT_VERSION =
  "liquidity-confirmation.v2";

export type LiquidityConfirmationReason =
  | "sequence_confirmed"
  | "no_qualifying_sweep"
  | "sweep_identity_unresolved"
  | "legacy_contract_requires_fresh_sequence"
  | "setup_activation_time_unavailable"
  | "zone_touch_pending"
  | "sweep_before_zone_touch"
  | "confirmation_pending"
  | "confirmation_not_after_sweep";

export interface LiquidityConfirmationObservation {
  contractVersion: typeof LIQUIDITY_CONFIRMATION_CONTRACT_VERSION;
  observationOnly: true;
  affectsAuthorization: false;
  ready: boolean;
  reasonCode: LiquidityConfirmationReason;
  candidateId: string;
  sequenceId: string | null;
  sweepId: string | null;
  sweepTime: string | null;
  confirmationId: string | null;
  confirmationTime: string | null;
  stagedAt: string | null;
  zoneTouchTime: string | null;
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildLiquidityConfirmationId(input: {
  symbol: string;
  timeframe: string;
  direction: "long" | "short";
  candleTime: string;
  price: number;
  type: string;
}): string {
  return buildEntityId({
    concept: "structure_break",
    detector: { name: "liquidity-confirmation-contract", version: LIQUIDITY_CONFIRMATION_CONTRACT_VERSION },
    symbol: input.symbol,
    timeframe: input.timeframe,
    sourceCandleStart: input.candleTime,
    direction: input.direction === "long" ? "bullish" : "bearish",
    level: input.price,
    discriminator: input.type,
  });
}

/**
 * Observation-only v2 sequencing contract. A zone touch and sweep may share a
 * candle, but confirmation must occur on a later closed candle because OHLC
 * data cannot establish intrabar ordering.
 */
export function observeLiquidityConfirmation(input: {
  candidateId: string;
  stagedAt?: string | null;
  zoneTouchTime?: string | null;
  sequence?: LiquiditySequence | null;
  confirmationId?: string | null;
  confirmationTime?: string | null;
  legacyContractVersion?: string | null;
}): LiquidityConfirmationObservation {
  const base = {
    contractVersion: LIQUIDITY_CONFIRMATION_CONTRACT_VERSION,
    observationOnly: true as const,
    affectsAuthorization: false as const,
    candidateId: input.candidateId,
    sequenceId: input.sequence?.durableId || null,
    sweepId: input.sequence?.sweep?.durableId || null,
    sweepTime: input.sequence?.sweep?.datetime || null,
    confirmationId: input.confirmationId ||
      input.sequence?.shift?.durableId || null,
    confirmationTime: input.confirmationTime ||
      input.sequence?.shift?.datetime || null,
    stagedAt: input.stagedAt || null,
    zoneTouchTime: input.zoneTouchTime || null,
  };
  const result = (ready: boolean, reasonCode: LiquidityConfirmationReason) =>
    ({ ...base, ready, reasonCode });

  if (input.legacyContractVersion &&
      input.legacyContractVersion !== LIQUIDITY_CONFIRMATION_CONTRACT_VERSION) {
    return result(false, "legacy_contract_requires_fresh_sequence");
  }
  const stagedAt = time(input.stagedAt);
  if (stagedAt === null) return result(false, "setup_activation_time_unavailable");
  const zoneTouch = time(input.zoneTouchTime);
  if (zoneTouch === null) return result(false, "zone_touch_pending");
  if (!input.sequence?.sweep) return result(false, "no_qualifying_sweep");
  if (!input.sequence.durableId || !input.sequence.sweep.durableId) {
    return result(false, "sweep_identity_unresolved");
  }
  const sweepTime = time(input.sequence.sweep.datetime);
  if (sweepTime === null) return result(false, "sweep_identity_unresolved");
  if (sweepTime < zoneTouch || sweepTime < stagedAt) {
    return result(false, "sweep_before_zone_touch");
  }
  const confirmationTime = time(base.confirmationTime);
  if (!base.confirmationId || confirmationTime === null) {
    return result(false, "confirmation_pending");
  }
  if (confirmationTime <= sweepTime) {
    return result(false, "confirmation_not_after_sweep");
  }
  return result(true, "sequence_confirmed");
}
