/**
 * fibExtension3Point.ts — 3-Point Fibonacci Extension TP Calculator
 * ──────────────────────────────────────────────────────────────────────────────
 * Implements the correct SMC Fibonacci extension measurement:
 *
 *   Point A = Swing origin (start of impulse)
 *   Point B = Swing end (end of impulse / start of retracement)
 *   Point C = Entry point (retracement level where you enter)
 *
 *   Extension levels are measured FROM Point C:
 *     -27% extension = C + (B - A) * 0.27  (first TP)
 *     -61.8% extension = C + (B - A) * 0.618  (second TP)
 *     -100% extension = C + (B - A) * 1.0  (full measured move)
 *     -127.2% extension = C + (B - A) * 1.272  (extended TP)
 *
 * The current bot measures extensions from Point A (the swing origin).
 * This module provides the correct 3-point measurement from Point C (entry).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FibExtensionInput {
  /** Point A: Start of the impulse swing */
  swingOrigin: number;
  /** Point B: End of the impulse swing (where retracement begins) */
  swingEnd: number;
  /** Point C: Entry price (retracement level) */
  entryPrice: number;
  /** Trade direction */
  direction: "bullish" | "bearish";
}

export interface FibExtensionLevel {
  /** The extension ratio (e.g., 0.272, 0.618, 1.0, 1.272) */
  ratio: number;
  /** The price level */
  price: number;
  /** Label for display */
  label: string;
}

export interface FibExtension3PointResult {
  /** All calculated extension levels */
  levels: FibExtensionLevel[];
  /** Recommended TP (first extension that provides minimum R:R) */
  recommendedTP: number | null;
  /** The impulse range used for calculation (|B - A|) */
  impulseRange: number;
  /** The retracement depth (|C - B| / |B - A|) */
  retracementDepth: number;
  /** Human-readable explanation */
  detail: string;
}

export interface FibExtensionConfig {
  /** Extension ratios to calculate (default: [0.272, 0.618, 1.0, 1.272, 1.618]) */
  extensionRatios: number[];
  /** Minimum R:R for recommended TP selection (default: 2.0) */
  minRR: number;
  /** SL distance for R:R calculation (if not provided, uses |C - B| * 1.2) */
  slDistance?: number;
}

export const DEFAULT_FIB_EXTENSION_CONFIG: FibExtensionConfig = {
  extensionRatios: [0.272, 0.618, 1.0, 1.272, 1.618],
  minRR: 2.0,
};

// ─── Standard Extension Labels ────────────────────────────────────────────────

const EXTENSION_LABELS: Record<number, string> = {
  0.272: "-27.2% Extension",
  0.382: "-38.2% Extension",
  0.5: "-50% Extension",
  0.618: "-61.8% Extension",
  0.786: "-78.6% Extension",
  1.0: "-100% Extension (Measured Move)",
  1.272: "-127.2% Extension",
  1.618: "-161.8% Extension",
  2.0: "-200% Extension",
};

// ─── Core Calculation ─────────────────────────────────────────────────────────

/**
 * Calculate 3-point Fibonacci extension levels for take profit.
 *
 * The key difference from the current bot:
 *   - Current: extensions measured from swing origin (Point A)
 *   - Correct: extensions measured from entry point (Point C)
 *
 * This means TPs are closer to entry (more conservative but more accurate to SMC theory).
 *
 * @param input - The three points (A, B, C) and direction
 * @param config - Extension configuration
 */
export function calculateFibExtension3Point(
  input: FibExtensionInput,
  config: Partial<FibExtensionConfig> = {},
): FibExtension3PointResult {
  const cfg = { ...DEFAULT_FIB_EXTENSION_CONFIG, ...config };

  const { swingOrigin, swingEnd, entryPrice, direction } = input;

  // Calculate impulse range (A to B)
  const impulseRange = Math.abs(swingEnd - swingOrigin);
  if (impulseRange === 0) {
    return {
      levels: [],
      recommendedTP: null,
      impulseRange: 0,
      retracementDepth: 0,
      detail: "Zero impulse range — cannot calculate extensions",
    };
  }

  // Calculate retracement depth (how far C is from B, as ratio of impulse)
  const retracementDepth = Math.abs(entryPrice - swingEnd) / impulseRange;

  // Calculate extension levels FROM Point C
  const levels: FibExtensionLevel[] = cfg.extensionRatios.map(ratio => {
    let price: number;
    if (direction === "bullish") {
      // Bullish: TP is ABOVE entry (C + extension)
      price = entryPrice + impulseRange * ratio;
    } else {
      // Bearish: TP is BELOW entry (C - extension)
      price = entryPrice - impulseRange * ratio;
    }

    return {
      ratio,
      price,
      label: EXTENSION_LABELS[ratio] ?? `${(ratio * 100).toFixed(1)}% Extension`,
    };
  });

  // Find recommended TP based on minimum R:R
  const slDistance = cfg.slDistance ?? Math.abs(entryPrice - swingEnd) * 1.2;
  let recommendedTP: number | null = null;

  if (slDistance > 0) {
    for (const level of levels) {
      const tpDistance = Math.abs(level.price - entryPrice);
      const rr = tpDistance / slDistance;
      if (rr >= cfg.minRR) {
        recommendedTP = level.price;
        break; // Take the first level that meets minimum R:R
      }
    }
  }

  const detail = [
    `3-Point Fib Extension: A=${swingOrigin.toFixed(5)}, B=${swingEnd.toFixed(5)}, C=${entryPrice.toFixed(5)}`,
    `Impulse range: ${impulseRange.toFixed(5)}, Retracement depth: ${(retracementDepth * 100).toFixed(1)}%`,
    `Recommended TP: ${recommendedTP?.toFixed(5) ?? "none (no level meets min R:R)"}`,
  ].join(" | ");

  return {
    levels,
    recommendedTP,
    impulseRange,
    retracementDepth,
    detail,
  };
}

/**
 * Compare the old (2-point from swing origin) vs new (3-point from entry) TP calculation.
 * Useful for regression testing and understanding the impact of the change.
 */
export function compareFibTPMethods(
  input: FibExtensionInput,
  targetRatio = 1.272,
): { oldTP: number; newTP: number; difference: number; differencePercent: number } {
  const { swingOrigin, swingEnd, entryPrice, direction } = input;
  const impulseRange = Math.abs(swingEnd - swingOrigin);

  // Old method: extension from swing origin (Point A)
  let oldTP: number;
  if (direction === "bullish") {
    oldTP = swingOrigin + impulseRange * (1 + targetRatio);
  } else {
    oldTP = swingOrigin - impulseRange * (1 + targetRatio);
  }

  // New method: extension from entry (Point C)
  let newTP: number;
  if (direction === "bullish") {
    newTP = entryPrice + impulseRange * targetRatio;
  } else {
    newTP = entryPrice - impulseRange * targetRatio;
  }

  const difference = Math.abs(newTP - oldTP);
  const differencePercent = impulseRange > 0 ? (difference / impulseRange) * 100 : 0;

  return { oldTP, newTP, difference, differencePercent };
}
