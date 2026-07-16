/**
 * confirmationHierarchy.ts — Unified Confirmation Hierarchy
 * ──────────────────────────────────────────────────────────
 * Provides a single function that evaluates all confirmation types
 * and returns the best one with its score contribution.
 *
 * Hierarchy (highest to lowest conviction):
 *   1. Sweep + CHoCH (2.5 pts) — Liquidity swept + structure shift
 *   2. LTF CHoCH (2.0 pts) — Lower timeframe structure shift in zone
 *   3. Displacement (1.5 pts) — Strong momentum candle from zone
 *   4. Inducement only (1.0 pts) — Sweep pattern without structure shift
 *   5. None (0 pts) — Watchlist only, no entry
 *
 * Key rule: CHoCH must be CLOSE-BASED (candle closes past structure level).
 * This is conservative and avoids wick-based false signals.
 */

import { type Candle, calculateATR, detectDisplacement, analyzeMarketStructure } from "./smcAnalysis.ts";
import { type Inducement } from "./inducementDetection.ts";
import { type SweepEvent } from "./zoneLiquidity.ts";

// ─── Types ───────────────────────────────────────────────────────────

export type ConfirmationType =
  | "sweep_choch"      // Liquidity swept + CHoCH in impulse direction
  | "ltf_choch"        // Lower timeframe CHoCH in impulse direction
  | "displacement"     // Strong displacement candle from zone
  | "inducement"       // Inducement pattern (sweep without CHoCH)
  | "none";            // No confirmation — watchlist only

export interface ConfirmationResult {
  /** Best confirmation type found */
  type: ConfirmationType;
  /** Score contribution (0 to 2.5) */
  score: number;
  /** Whether this is strong enough to enter (vs watchlist only) */
  entryReady: boolean;
  /** Candle index where confirmation occurred */
  confirmationIndex: number | null;
  /** Direction of the confirmation signal */
  direction: "bullish" | "bearish";
  /** Human-readable detail */
  detail: string;
  /** Whether the confirmation is inside the zone bounds */
  insideZone: boolean;
}

export interface ConfirmationInput {
  /** Confirmation timeframe candles (typically one TF below the zone TF) */
  confirmationCandles: Candle[];
  /** Optional LTF candles for deeper confirmation (e.g., 15m for 1H zone) */
  ltfCandles?: Candle[];
  /** Zone bounds */
  zoneHigh: number;
  zoneLow: number;
  /** Trade direction (continuation with impulse) */
  direction: "bullish" | "bearish";
  /** Sweep event from zone liquidity detection (if any) */
  sweepEvent?: SweepEvent | null;
  /** Inducement from zone liquidity detection (if any) */
  inducement?: Inducement | null;
  /** Max candles to look back for confirmation (default: 20) */
  maxLookback?: number;
}

// ─── Core Function ──────────────────────────────────────────────────

/**
 * Evaluate the confirmation hierarchy for a zone entry.
 *
 * Checks from highest to lowest conviction and returns the best match.
 * The confirmation must be:
 *   - In the IMPULSE direction (continuation, not reversal)
 *   - Close-based (candle closes past level, not just wicks)
 *   - Recent (within maxLookback candles)
 *   - Inside or near the zone bounds
 */
export function evaluateConfirmation(input: ConfirmationInput): ConfirmationResult {
  const {
    confirmationCandles,
    ltfCandles,
    zoneHigh,
    zoneLow,
    direction,
    sweepEvent = null,
    inducement = null,
    maxLookback = 20,
  } = input;

  if (confirmationCandles.length < 15) {
    return noConfirmation(direction);
  }

  const currentIndex = confirmationCandles.length - 1;

  // ── 1. Check for CHoCH on confirmation TF ──
  const choch = findDirectionalCHoCH(confirmationCandles, direction, zoneHigh, zoneLow, maxLookback);

  // ── 2. Check for displacement on confirmation TF ──
  const disp = findDirectionalDisplacement(confirmationCandles, direction, zoneHigh, zoneLow, maxLookback);

  // ── 3. Check for LTF CHoCH (if LTF candles provided) ──
  let ltfChoch: CHoCHSignal | null = null;
  if (ltfCandles && ltfCandles.length >= 15) {
    ltfChoch = findDirectionalCHoCH(ltfCandles, direction, zoneHigh, zoneLow, maxLookback * 4); // LTF has more candles
  }

  // ── Hierarchy evaluation ──

  // Level 1: Sweep + CHoCH (highest conviction)
  if (sweepEvent && (choch || ltfChoch)) {
    const confirmIdx = choch?.index ?? ltfChoch?.index ?? null;
    const insideZone = choch?.insideZone ?? ltfChoch?.insideZone ?? false;
    return {
      type: "sweep_choch",
      score: 2.5,
      entryReady: true,
      confirmationIndex: confirmIdx,
      direction,
      detail: `Sweep @ ${sweepEvent.level.toFixed(5)} + ${choch ? "CHoCH" : "LTF CHoCH"} (${direction})`,
      insideZone,
    };
  }

  // Level 2: LTF CHoCH (without sweep)
  if (ltfChoch) {
    return {
      type: "ltf_choch",
      score: 2.0,
      entryReady: true,
      confirmationIndex: ltfChoch.index,
      direction,
      detail: `LTF CHoCH (${direction}) @ ${ltfChoch.price.toFixed(5)}${ltfCandles && ltfCandles[ltfChoch.index]?.datetime ? " (" + ltfCandles[ltfChoch.index].datetime.slice(5, 16).replace("T", " ") + ")" : ""}`,
      insideZone: ltfChoch.insideZone,
    };
  }

  // Level 2b: Same-TF CHoCH (without sweep)
  if (choch) {
    return {
      type: "ltf_choch",
      score: 2.0,
      entryReady: true,
      confirmationIndex: choch.index,
      direction,
      detail: `CHoCH (${direction}) @ ${choch.price.toFixed(5)}${confirmationCandles[choch.index]?.datetime ? " (" + confirmationCandles[choch.index].datetime.slice(5, 16).replace("T", " ") + ")" : ""}`,
      insideZone: choch.insideZone,
    };
  }

  // Level 3: Displacement (strong momentum candle)
  if (disp) {
    return {
      type: "displacement",
      score: 1.5,
      entryReady: true,
      confirmationIndex: disp.index,
      direction,
      detail: `Displacement (${direction}) body ${(disp.bodyRatio * 100).toFixed(0)}%`,
      insideZone: disp.insideZone,
    };
  }

  // Level 4: Inducement only (sweep pattern without structure shift)
  if (inducement && inducement.confirmed) {
    return {
      type: "inducement",
      score: 1.0,
      entryReady: false, // Not enough for entry alone, but adds to score
      confirmationIndex: inducement.sweepIndex,
      direction,
      detail: `Inducement: ${inducement.type} (quality ${inducement.quality}/10)`,
      insideZone: inducement.level >= zoneLow && inducement.level <= zoneHigh,
    };
  }

  // Level 5: Sweep without any structure shift
  if (sweepEvent && sweepEvent.rejected) {
    return {
      type: "inducement",
      score: 1.0,
      entryReady: false,
      confirmationIndex: sweepEvent.sweepIndex,
      direction,
      detail: `Sweep rejected @ ${sweepEvent.level.toFixed(5)} (no CHoCH yet)`,
      insideZone: sweepEvent.level >= zoneLow && sweepEvent.level <= zoneHigh,
    };
  }

  // Level 6: None
  return noConfirmation(direction);
}

// ─── Internal Helpers ───────────────────────────────────────────────

interface CHoCHSignal {
  index: number;
  price: number;
  insideZone: boolean;
}

interface DisplacementSignal {
  index: number;
  bodyRatio: number;
  insideZone: boolean;
}

/**
 * Find a close-based CHoCH in the specified direction, inside/near the zone.
 */
function findDirectionalCHoCH(
  candles: Candle[],
  direction: "bullish" | "bearish",
  zoneHigh: number,
  zoneLow: number,
  maxLookback: number,
): CHoCHSignal | null {
  const structure = analyzeMarketStructure(candles);
  const startIdx = Math.max(0, candles.length - maxLookback);

  // Filter CHoCH events:
  // - Must be in the trade direction
  // - Must be close-based (user preference: only closes past level count)
  // - Must be recent (within lookback)
  // - Must be inside or near the zone
  const validCHoCH = structure.choch
    .filter(c => {
      if (c.type !== direction) return false;
      if (!c.closeBased) return false;
      if (c.index < startIdx) return false;
      return true;
    })
    .sort((a, b) => b.index - a.index); // Most recent first

  if (validCHoCH.length === 0) return null;

  const best = validCHoCH[0];
  const chochCandle = candles[best.index];
  if (!chochCandle) return null;

  // Check if inside zone or near zone (within 1 ATR)
  const atr = calculateATR(candles, 14);
  const overlaps = chochCandle.high >= zoneLow && chochCandle.low <= zoneHigh;
  const priceInZone = best.price >= zoneLow && best.price <= zoneHigh;
  const nearZone = direction === "bullish"
    ? chochCandle.low >= zoneLow - atr && chochCandle.low <= zoneHigh + atr
    : chochCandle.high >= zoneLow - atr && chochCandle.high <= zoneHigh + atr;

  if (overlaps || priceInZone || nearZone) {
    return {
      index: best.index,
      price: best.price,
      insideZone: overlaps || priceInZone,
    };
  }

  return null;
}

/**
 * Find a displacement candle in the specified direction, inside/near the zone.
 */
function findDirectionalDisplacement(
  candles: Candle[],
  direction: "bullish" | "bearish",
  zoneHigh: number,
  zoneLow: number,
  maxLookback: number,
): DisplacementSignal | null {
  const displacement = detectDisplacement(candles);
  if (!displacement.isDisplacement) return null;
  if (displacement.lastDirection !== direction) return null;

  const startIdx = Math.max(0, candles.length - maxLookback);

  // Find the most recent displacement candle in the right direction and zone
  const atr = calculateATR(candles, 14);
  for (let i = displacement.displacementCandles.length - 1; i >= 0; i--) {
    const dc = displacement.displacementCandles[i];
    if (dc.index < startIdx) continue;

    const candle = candles[dc.index];
    if (!candle) continue;

    // Check direction
    const isBullish = candle.close > candle.open;
    const isBearish = candle.close < candle.open;
    if (direction === "bullish" && !isBullish) continue;
    if (direction === "bearish" && !isBearish) continue;

    // Check if inside/near zone
    const overlaps = candle.high >= zoneLow && candle.low <= zoneHigh;
    const nearZone = Math.min(
      Math.abs(candle.close - zoneHigh),
      Math.abs(candle.close - zoneLow),
    ) <= atr;

    if (overlaps || nearZone) {
      return {
        index: dc.index,
        bodyRatio: dc.bodyRatio,
        insideZone: overlaps,
      };
    }
  }

  return null;
}

function noConfirmation(direction: "bullish" | "bearish"): ConfirmationResult {
  return {
    type: "none",
    score: 0,
    entryReady: false,
    confirmationIndex: null,
    direction,
    detail: "No confirmation — watchlist only",
    insideZone: false,
  };
}
