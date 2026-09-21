/**
 * Swing-Fibonacci confluence measurement for IPO zones. RESEARCH ONLY.
 *
 * TWO DIFFERENT THINGS BOTH CALLED "50%". Keeping them apart is the whole point
 * of this module:
 *
 *   IPO CANDLE GEOMETRY — `ipoGeometry.distal = (high + low) / 2`, the midpoint
 *   of ONE candle. This is the frozen E2 entry level. It is NOT Fibonacci, it is
 *   not derived from a swing, and nothing here renames or reinterprets it.
 *
 *   SWING FIBONACCI — retracement levels of the PRIOR leg, measured here purely
 *   as confluence information. A zone sits at its own candle-50% by
 *   construction while its swing retracement can read anything at all.
 *
 * OWN CONSTANTS, DELIBERATELY. `smcAnalysis.RETRACE_RATIOS` is
 * [0.236, 0.382, 0.5, 0.618, 0.705, 0.786] and drives production SMC. It is not
 * touched. This module declares the six trader-defined IPO levels separately,
 * including 0.710 (not 0.705) and the two that production does not have at all,
 * 0.886 and 1.000.
 *
 * NO "NEAR" THRESHOLD. Only INSIDE_ZONE / OUTSIDE_ZONE plus the raw distance,
 * normalised two ways. Picking a proximity cutoff now would bake a tuning
 * decision into the detector and force a re-run to revisit it; storing the
 * continuous value lets any threshold be explored later from the same data.
 *
 * MEASUREMENT ONLY. Nothing here gates, ranks, scores or weights anything, and
 * no distance computed here may become a strategy rule without its own
 * pre-registered out-of-sample test.
 */

import { detectZigZagPivots, calculateATR, type Candle } from "./smcAnalysis.ts";

/** The six trader-defined IPO levels. Independent of production SMC ratios. */
export const IPO_FIB_RATIOS = [0.500, 0.618, 0.710, 0.786, 0.886, 1.000] as const;
export type IpoFibRatio = typeof IPO_FIB_RATIOS[number];

/** Stable labels, so a report column never depends on float formatting. */
export const FIB_LABELS: Record<string, string> = {
  "0.5": "50.0", "0.618": "61.8", "0.71": "71.0",
  "0.786": "78.6", "0.886": "88.6", "1": "100.0",
};

export type ZoneRelation = "INSIDE_ZONE" | "OUTSIDE_ZONE";

export interface FibLevelReading {
  ratio: number;
  label: string;
  price: number;
  relation: ZoneRelation;
  /** 0 when inside. Otherwise absolute price distance to the nearest zone edge. */
  distance: number;
  /** distance / zone width. Null if the zone has no width. */
  distancePerZoneWidth: number | null;
  /** distance / ATR(14) at the decision bar. Null before ATR is computable. */
  distancePerAtr: number | null;
}

export interface FibConfluence {
  /** Null when no completed swing exists yet on the causal prefix. */
  swingHigh: number | null;
  swingLow: number | null;
  swingDirection: "up" | "down" | null;
  levels: FibLevelReading[];
  /** How many of the six land inside the zone. 0-6. */
  clusterCount: number;
  /** Labels of those inside, for grouping. */
  insideLabels: string[];
  zoneWidth: number;
  atr: number | null;
}

const EMPTY: Omit<FibConfluence, "zoneWidth" | "atr"> = {
  swingHigh: null, swingLow: null, swingDirection: null,
  levels: [], clusterCount: 0, insideLabels: [],
};

/**
 * Measures the six levels of the last completed swing against one IPO zone.
 *
 * `prefix` must end at the decision bar — everything is derived from it and
 * nothing later, so the reading is knowable at the time it is attributed to.
 */
export function fibConfluence(
  prefix: Candle[], zoneLow: number, zoneHigh: number,
): FibConfluence {
  const zoneWidth = zoneHigh - zoneLow;
  const atrRaw = prefix.length >= 15 ? calculateATR(prefix, 14) : 0;
  const atr = atrRaw > 0 ? atrRaw : null;

  const z = detectZigZagPivots(prefix);
  if (!z.lastTwo) return { ...EMPTY, zoneWidth, atr };

  const [a, b] = z.lastTwo;
  const swingHigh = Math.max(a.price, b.price);
  const swingLow = Math.min(a.price, b.price);
  const range = swingHigh - swingLow;
  if (range <= 0) return { ...EMPTY, zoneWidth, atr };

  // Direction of the completed leg: which pivot came last decides which end the
  // retracement measures back from.
  const later = a.index > b.index ? a : b;
  const swingDirection: "up" | "down" = later.price === swingHigh ? "up" : "down";

  const levels: FibLevelReading[] = IPO_FIB_RATIOS.map((ratio) => {
    // A retracement runs BACK from the end of the leg toward its origin, so at
    // ratio 1.000 the level is the leg's origin, not its end.
    const price = swingDirection === "up"
      ? swingHigh - ratio * range
      : swingLow + ratio * range;

    const inside = price >= zoneLow && price <= zoneHigh;
    const distance = inside ? 0 : Math.min(Math.abs(price - zoneLow), Math.abs(price - zoneHigh));

    return {
      ratio, label: FIB_LABELS[String(ratio)] ?? String(ratio), price,
      relation: inside ? "INSIDE_ZONE" : "OUTSIDE_ZONE",
      distance,
      distancePerZoneWidth: zoneWidth > 0 ? distance / zoneWidth : null,
      distancePerAtr: atr !== null ? distance / atr : null,
    };
  });

  const insideLabels = levels.filter((l) => l.relation === "INSIDE_ZONE").map((l) => l.label);
  return {
    swingHigh, swingLow, swingDirection, levels,
    clusterCount: insideLabels.length, insideLabels, zoneWidth, atr,
  };
}

/**
 * Competing valid IPOs alive at one decision bar.
 *
 * Recorded so first-come-first-served can be compared against what a
 * confluence-based choice would have picked. Every competitor is kept —
 * discarding the losers is exactly what makes the comparison impossible.
 */
export interface Competitor<T> {
  decisionIndex: number;
  candidates: T[];
}

export function groupCompetitors<T extends { touchIndex: number }>(
  rows: T[],
): Array<Competitor<T>> {
  const byBar = new Map<number, T[]>();
  for (const r of rows) {
    const list = byBar.get(r.touchIndex);
    if (list) list.push(r); else byBar.set(r.touchIndex, [r]);
  }
  return [...byBar.entries()]
    .filter(([, c]) => c.length > 1)
    .sort((x, y) => x[0] - y[0])
    .map(([decisionIndex, candidates]) => ({ decisionIndex, candidates }));
}
