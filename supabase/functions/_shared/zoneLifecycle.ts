/**
 * zoneLifecycle.ts — Zone Reusability & Invalidation Engine
 * ──────────────────────────────────────────────────────────────────────────────
 * Implements proper SMC zone lifecycle rules:
 *
 *   - Zones are ONLY invalidated when a candle CLOSES through the far boundary
 *   - Wick penetration = "test" (zone remains valid with reduced confidence)
 *   - Multiple entries from same zone are allowed (with decreasing confidence)
 *   - Zones that are invalidated become breaker block candidates
 *
 * This replaces the current 50% penetration = dead logic with industry-standard rules.
 * Does NOT modify smcAnalysis.ts — operates on zone data produced by it.
 */

import type { Candle } from "./smcAnalysis.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ZoneState =
  | "fresh"           // Never tested — highest probability
  | "tested_1"       // Tested once — still high probability
  | "tested_2"       // Tested twice — moderate probability
  | "tested_3_plus"  // Tested 3+ times — low probability, skip unless extreme confluence
  | "invalidated"    // Candle CLOSED through far boundary — zone is dead
  | "breaker_candidate"; // Invalidated with sweep — could flip role

export interface ZoneLifecycleResult {
  /** Current state of the zone */
  state: ZoneState;
  /** Number of times price has tested the zone */
  retestCount: number;
  /** Deepest wick penetration as percentage of zone height (0-100+) */
  maxPenetrationPercent: number;
  /** Whether a candle has CLOSED beyond the far boundary */
  closedThrough: boolean;
  /** Index of the candle that closed through (if invalidated) */
  closedThroughIndex: number | null;
  /** Confidence multiplier for scoring (1.0 for fresh, decreasing per test) */
  confidenceMultiplier: number;
  /** Whether this zone can still be traded */
  canStillTrade: boolean;
  /** If invalidated, whether it qualifies as a breaker candidate */
  breakerCandidate: boolean;
  /** Human-readable summary */
  detail: string;
}

export interface ZoneLifecycleConfig {
  /** Maximum number of retests before zone is considered exhausted (default: 3) */
  maxRetests: number;
  /** Only invalidate on close through far boundary, not wick (default: true) */
  closeInvalidationOnly: boolean;
  /** Confidence multiplier per retest level (default: [1.0, 0.75, 0.5, 0.25]) */
  confidenceByRetest: number[];
  /** Whether invalidated zones with prior sweep qualify as breaker candidates (default: true) */
  detectBreakerCandidates: boolean;
}

export const DEFAULT_ZONE_LIFECYCLE_CONFIG: ZoneLifecycleConfig = {
  maxRetests: 3,
  closeInvalidationOnly: true,
  confidenceByRetest: [1.0, 0.75, 0.5, 0.25],
  detectBreakerCandidates: true,
};

// ─── Core Lifecycle Evaluation ────────────────────────────────────────────────

/**
 * Evaluate the lifecycle state of a zone based on candles that occurred AFTER the zone formed.
 *
 * Key difference from current bot logic:
 *   - Current: 50% penetration = mitigated (dead)
 *   - New: Only CLOSE through far boundary = invalidated
 *   - Wicks into zone = test (zone remains valid)
 *
 * @param zone - The zone boundaries and direction
 * @param candlesAfterZone - All candles that occurred after the zone was created
 * @param config - Lifecycle configuration
 */
export function evaluateZoneLifecycle(
  zone: { high: number; low: number; direction: "bullish" | "bearish" },
  candlesAfterZone: Candle[],
  config: Partial<ZoneLifecycleConfig> = {},
): ZoneLifecycleResult {
  const cfg = { ...DEFAULT_ZONE_LIFECYCLE_CONFIG, ...config };

  let retestCount = 0;
  let maxPenetrationPercent = 0;
  let closedThrough = false;
  let closedThroughIndex: number | null = null;
  let hadPriorSweep = false;

  const zoneHeight = zone.high - zone.low;
  if (zoneHeight <= 0) {
    return _makeResult("fresh", 0, 0, false, null, 1.0, true, false, "Zone has zero height");
  }

  for (let i = 0; i < candlesAfterZone.length; i++) {
    const c = candlesAfterZone[i];

    if (zone.direction === "bullish") {
      // Bullish OB: zone is below price. Price comes DOWN to test it.
      // Far boundary = zone.low (invalidation = close below zone.low)
      // Near boundary = zone.high (entry edge)

      // Check for close-through invalidation
      if (c.close < zone.low) {
        closedThrough = true;
        closedThroughIndex = i;
        break;
      }

      // Check for wick penetration (test)
      if (c.low <= zone.high) {
        // Price entered the zone
        const penetration = ((zone.high - c.low) / zoneHeight) * 100;
        maxPenetrationPercent = Math.max(maxPenetrationPercent, Math.min(penetration, 100));

        // Count as a test if price entered zone but didn't close through
        // Only count distinct tests (not consecutive candles in the same test)
        if (i === 0 || candlesAfterZone[i - 1].low > zone.high) {
          retestCount++;
        }
      }

      // Track if there was a sweep below (wick below zone.low but close back inside/above)
      if (c.low < zone.low && c.close >= zone.low) {
        hadPriorSweep = true;
      }
    } else {
      // Bearish OB: zone is above price. Price comes UP to test it.
      // Far boundary = zone.high (invalidation = close above zone.high)
      // Near boundary = zone.low (entry edge)

      // Check for close-through invalidation
      if (c.close > zone.high) {
        closedThrough = true;
        closedThroughIndex = i;
        break;
      }

      // Check for wick penetration (test)
      if (c.high >= zone.low) {
        // Price entered the zone
        const penetration = ((c.high - zone.low) / zoneHeight) * 100;
        maxPenetrationPercent = Math.max(maxPenetrationPercent, Math.min(penetration, 100));

        // Count distinct tests
        if (i === 0 || candlesAfterZone[i - 1].high < zone.low) {
          retestCount++;
        }
      }

      // Track if there was a sweep above (wick above zone.high but close back inside/below)
      if (c.high > zone.high && c.close <= zone.high) {
        hadPriorSweep = true;
      }
    }
  }

  // Determine state
  let state: ZoneState;
  let confidenceMultiplier: number;
  let canStillTrade: boolean;
  let breakerCandidate = false;

  if (closedThrough) {
    // Zone is dead — candle closed through far boundary
    if (cfg.detectBreakerCandidates && hadPriorSweep) {
      state = "breaker_candidate";
      breakerCandidate = true;
    } else {
      state = "invalidated";
    }
    confidenceMultiplier = 0;
    canStillTrade = false;
  } else if (retestCount === 0) {
    state = "fresh";
    confidenceMultiplier = cfg.confidenceByRetest[0] ?? 1.0;
    canStillTrade = true;
  } else if (retestCount === 1) {
    state = "tested_1";
    confidenceMultiplier = cfg.confidenceByRetest[1] ?? 0.75;
    canStillTrade = retestCount < cfg.maxRetests;
  } else if (retestCount === 2) {
    state = "tested_2";
    confidenceMultiplier = cfg.confidenceByRetest[2] ?? 0.5;
    canStillTrade = retestCount < cfg.maxRetests;
  } else {
    state = "tested_3_plus";
    confidenceMultiplier = cfg.confidenceByRetest[3] ?? 0.25;
    canStillTrade = retestCount < cfg.maxRetests;
  }

  const detail = closedThrough
    ? `Zone invalidated: candle at index ${closedThroughIndex} closed through far boundary${breakerCandidate ? " (breaker candidate — prior sweep detected)" : ""}`
    : `Zone ${state}: ${retestCount} test(s), max penetration ${maxPenetrationPercent.toFixed(1)}%, confidence ${(confidenceMultiplier * 100).toFixed(0)}%`;

  return _makeResult(state, retestCount, maxPenetrationPercent, closedThrough, closedThroughIndex, confidenceMultiplier, canStillTrade, breakerCandidate, detail);
}

/**
 * Compare old lifecycle (50% penetration = dead) with new lifecycle (close-through = dead).
 * Useful for regression testing and gradual migration.
 *
 * Returns the DIFFERENCE in tradability: positive means new logic allows more trades,
 * negative means new logic is stricter.
 */
export function compareLifecycleMethods(
  zone: { high: number; low: number; direction: "bullish" | "bearish" },
  candlesAfterZone: Candle[],
): { oldWouldTrade: boolean; newWouldTrade: boolean; diverges: boolean; reason: string } {
  // Old method: 50% penetration = mitigated = dead
  const zoneHeight = zone.high - zone.low;
  let oldMitigated = false;
  let oldBroken = false;

  for (const c of candlesAfterZone) {
    if (zone.direction === "bullish") {
      if (c.close < zone.low) { oldBroken = true; break; }
      const mid = (zone.high + zone.low) / 2;
      if (c.low <= mid) { oldMitigated = true; }
    } else {
      if (c.close > zone.high) { oldBroken = true; break; }
      const mid = (zone.high + zone.low) / 2;
      if (c.high >= mid) { oldMitigated = true; }
    }
  }

  const oldWouldTrade = !oldMitigated && !oldBroken;

  // New method
  const newResult = evaluateZoneLifecycle(zone, candlesAfterZone);
  const newWouldTrade = newResult.canStillTrade;

  const diverges = oldWouldTrade !== newWouldTrade;
  let reason = "";
  if (diverges) {
    if (newWouldTrade && !oldWouldTrade) {
      reason = `New logic allows trade (${newResult.state}, ${newResult.retestCount} tests) where old logic blocked (50% penetration rule)`;
    } else {
      reason = `New logic blocks trade (${newResult.state}) where old logic allowed`;
    }
  }

  return { oldWouldTrade, newWouldTrade, diverges, reason };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _makeResult(
  state: ZoneState,
  retestCount: number,
  maxPenetrationPercent: number,
  closedThrough: boolean,
  closedThroughIndex: number | null,
  confidenceMultiplier: number,
  canStillTrade: boolean,
  breakerCandidate: boolean,
  detail: string,
): ZoneLifecycleResult {
  return {
    state,
    retestCount,
    maxPenetrationPercent,
    closedThrough,
    closedThroughIndex,
    confidenceMultiplier,
    canStillTrade,
    breakerCandidate,
    detail,
  };
}
