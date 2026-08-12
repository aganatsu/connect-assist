import type { CanonicalStructureAuthority, CanonicalStructureEvent, FrozenStructureLevel, StructureDirection } from "./canonicalStructureAuthority.ts";

export const CANONICAL_LIQUIDITY_SEQUENCE_VERSION = "canonical-liquidity-sequence.v1";

export interface LiquiditySequence {
  id: string;
  durableId: string;
  direction: StructureDirection;
  status: "sweep_only" | "fakeout_confirmed" | "structure_shift_only";
  sweep: CanonicalStructureEvent | null;
  shift: CanonicalStructureEvent | null;
  inducement: FrozenStructureLevel | null;
  entryReady: boolean;
  reasonCodes: string[];
}

export interface CanonicalLiquiditySequenceReport {
  contractVersion: typeof CANONICAL_LIQUIDITY_SEQUENCE_VERSION;
  observationOnly: true;
  affectsAuthorization: false;
  sequences: LiquiditySequence[];
}

function eventTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function nearestInducement(authority: CanonicalStructureAuthority, event: CanonicalStructureEvent): FrozenStructureLevel | null {
  const desiredSide = event.direction === "bullish" ? "low" : "high";
  return [...authority.levels]
    .filter((level) => level.significance === "internal" && level.side === desiredSide && eventTime(level.datetime) < eventTime(event.datetime))
    .sort((a, b) => eventTime(b.datetime) - eventTime(a.datetime))[0] || null;
}

export function buildCanonicalLiquiditySequences(authority: CanonicalStructureAuthority, options: { confirmationWindow?: number; requireMss?: boolean } = {}): CanonicalLiquiditySequenceReport {
  const window = Math.max(1, options.confirmationWindow ?? 12);
  const sequences: LiquiditySequence[] = [];
  const shifts = authority.events.filter((event) => event.type === "choch" || event.type === "mss");

  for (const sweep of authority.events.filter((event) => event.type === "sweep")) {
    const shift = shifts.find((candidate) => candidate.direction === sweep.direction && eventTime(candidate.datetime) > eventTime(sweep.datetime) && candidate.candleIndex - sweep.candleIndex <= window) || null;
    const entryReady = !!shift && (!options.requireMss || shift.type === "mss");
    sequences.push({
      id: `liquidity:${sweep.id}`,
      durableId: `liquidity:${sweep.durableId}`,
      direction: sweep.direction,
      status: shift ? "fakeout_confirmed" : "sweep_only",
      sweep,
      shift,
      inducement: nearestInducement(authority, sweep),
      entryReady,
      reasonCodes: shift
        ? ["liquidity_swept_and_rejected", shift.type === "mss" ? "displacement_mss_confirmed" : "choch_confirmed"]
        : ["liquidity_sweep_without_structure_shift"],
    });
  }

  for (const shift of shifts) {
    if (sequences.some((sequence) => sequence.shift?.id === shift.id)) continue;
    sequences.push({
      id: `structure:${shift.id}`,
      durableId: `structure:${shift.durableId}`,
      direction: shift.direction,
      status: "structure_shift_only",
      sweep: null,
      shift,
      inducement: nearestInducement(authority, shift),
      entryReady: false,
      reasonCodes: ["structure_shift_without_qualified_sweep"],
    });
  }

  return { contractVersion: CANONICAL_LIQUIDITY_SEQUENCE_VERSION, observationOnly: true, affectsAuthorization: false, sequences };
}
