import { calculateATR, type Candle } from "./smcAnalysis.ts";

export const CANONICAL_STRUCTURE_VERSION = "canonical-structure.v1";

export type StructureSignificance = "internal" | "external";
export type StructureDirection = "bullish" | "bearish";
export type SwingLabel = "HH" | "HL" | "LH" | "LL" | "H" | "L";
export type StructureEventType = "sweep" | "bos" | "choch" | "mss";

export interface FrozenStructureLevel {
  id: string;
  significance: StructureSignificance;
  side: "high" | "low";
  price: number;
  pivotIndex: number;
  confirmedIndex: number;
  datetime: string;
  label: SwingLabel;
  status: "active" | "swept" | "broken";
}

export interface CanonicalStructureEvent {
  id: string;
  type: StructureEventType;
  direction: StructureDirection;
  significance: StructureSignificance;
  levelId: string;
  level: number;
  candleIndex: number;
  datetime: string;
  close: number;
  extreme: number;
  closeDistance: number;
  displacementRatio: number;
}

export interface CanonicalStructureAuthority {
  contractVersion: typeof CANONICAL_STRUCTURE_VERSION;
  observationOnly: true;
  affectsAuthorization: false;
  internalLookback: number;
  externalLookback: number;
  levels: FrozenStructureLevel[];
  events: CanonicalStructureEvent[];
  trend: Record<StructureSignificance, StructureDirection | "ranging">;
}

function pivotAt(candles: Candle[], index: number, lookback: number, side: "high" | "low", minMove: number): boolean {
  const candle = candles[index];
  if (!candle || index < lookback || index + lookback >= candles.length) return false;
  for (let offset = 1; offset <= lookback; offset++) {
    if (side === "high" && (candle.high <= candles[index - offset].high || candle.high <= candles[index + offset].high)) return false;
    if (side === "low" && (candle.low >= candles[index - offset].low || candle.low >= candles[index + offset].low)) return false;
  }
  if (minMove <= 0) return true;
  const opposite = Array.from({ length: lookback * 2 + 1 }, (_, offset) => candles[index - lookback + offset])
    .filter((_, offset) => offset !== lookback);
  return side === "high"
    ? candle.high - Math.min(...opposite.map((item) => item.low)) >= minMove
    : Math.max(...opposite.map((item) => item.high)) - candle.low >= minMove;
}

function swingLabel(previous: FrozenStructureLevel | undefined, side: "high" | "low", price: number): SwingLabel {
  if (!previous) return side === "high" ? "H" : "L";
  if (side === "high") return price > previous.price ? "HH" : "LH";
  return price > previous.price ? "HL" : "LL";
}

function displacement(candle: Candle): number {
  const range = candle.high - candle.low;
  return range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
}

export function buildCanonicalStructureAuthority(candles: Candle[], options: {
  internalLookback?: number;
  externalLookback?: number;
  internalAtrFilter?: number;
  externalAtrFilter?: number;
  mssDisplacement?: number;
} = {}): CanonicalStructureAuthority {
  const internalLookback = Math.max(1, options.internalLookback ?? 3);
  const externalLookback = Math.max(internalLookback + 1, options.externalLookback ?? 7);
  const atr = candles.length >= 15 ? calculateATR(candles, 14) : 0;
  const filters = { internal: atr * (options.internalAtrFilter ?? 0.2), external: atr * (options.externalAtrFilter ?? 0.5) };
  const mssThreshold = options.mssDisplacement ?? 0.6;
  const levels: FrozenStructureLevel[] = [];
  const events: CanonicalStructureEvent[] = [];
  const trend: CanonicalStructureAuthority["trend"] = { internal: "ranging", external: "ranging" };

  for (let candleIndex = 0; candleIndex < candles.length; candleIndex++) {
    for (const significance of ["internal", "external"] as const) {
      const lookback = significance === "internal" ? internalLookback : externalLookback;
      const pivotIndex = candleIndex - lookback;
      for (const side of ["high", "low"] as const) {
        if (!pivotAt(candles, pivotIndex, lookback, side, filters[significance])) continue;
        const prior = [...levels].reverse().find((level) => level.significance === significance && level.side === side);
        const price = side === "high" ? candles[pivotIndex].high : candles[pivotIndex].low;
        levels.push({
          id: `${significance}:${side}:${pivotIndex}:${price.toFixed(10)}`,
          significance, side, price, pivotIndex, confirmedIndex: candleIndex,
          datetime: candles[pivotIndex].datetime,
          label: swingLabel(prior, side, price), status: "active",
        });
      }
    }

    const candle = candles[candleIndex];
    if (!candle) continue;
    for (const level of levels.filter((item) => item.status !== "broken" && item.confirmedIndex < candleIndex)) {
      const crossed = level.side === "high" ? candle.high > level.price : candle.low < level.price;
      if (!crossed) continue;
      const closedThrough = level.side === "high" ? candle.close > level.price : candle.close < level.price;
      const breakDirection: StructureDirection = level.side === "high" ? "bullish" : "bearish";
      const ratio = displacement(candle);
      let type: StructureEventType = "sweep";
      if (closedThrough) {
        const against = trend[level.significance] !== "ranging" && trend[level.significance] !== breakDirection;
        type = against ? (ratio >= mssThreshold ? "mss" : "choch") : "bos";
        trend[level.significance] = breakDirection;
        level.status = "broken";
      } else {
        level.status = "swept";
      }
      events.push({
        id: `${type}:${level.id}:${candleIndex}`,
        type,
        direction: closedThrough ? breakDirection : breakDirection === "bullish" ? "bearish" : "bullish",
        significance: level.significance, levelId: level.id,
        level: level.price, candleIndex, datetime: candle.datetime, close: candle.close,
        extreme: level.side === "high" ? candle.high : candle.low,
        closeDistance: Math.abs(candle.close - level.price), displacementRatio: ratio,
      });
    }
  }

  return { contractVersion: CANONICAL_STRUCTURE_VERSION, observationOnly: true, affectsAuthorization: false, internalLookback, externalLookback, levels, events, trend };
}
