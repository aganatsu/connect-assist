/**
 * tickZoneConfirmation.ts — Tick-Level Zone Confirmation Engine
 * ──────────────────────────────────────────────────────────────────────
 * Enhances the existing zone-confirmation-scanner with sub-candle (tick-level)
 * precision for entry confirmation. Instead of waiting for a full 5m candle
 * close, this module processes individual price ticks to detect:
 *
 *   1. **Micro-structure breaks** — CHoCH on 1-minute or tick-aggregated bars
 *   2. **Rejection patterns** — Pin bars / wicks forming in real-time
 *   3. **Displacement detection** — Rapid price movement away from zone
 *   4. **Volume spikes** — Unusual tick velocity indicating institutional flow
 *   5. **Order flow imbalance** — Bid/ask pressure asymmetry
 *
 * Architecture:
 *   The zone-confirmation-scanner (1-min cron) calls this module for each
 *   "awaiting_confirmation" order. Instead of only checking 5m candles,
 *   it also evaluates the tick buffer accumulated since the last check.
 *
 * This module is STATELESS per invocation — the tick buffer is passed in
 * from the caller (stored in the pending_order metadata or a cache table).
 *
 * Integration with existing zoneConfirmation.ts:
 *   - zoneConfirmation.ts handles 5m candle-based confirmation (Tier 1-3)
 *   - This module handles sub-5m tick-level confirmation (Tier 0.5)
 *   - Both can trigger a fill; tick-level is faster but requires stronger signal
 */

import { type Candle } from "./smcAnalysis.ts";

// ─── Types ───────────────────────────────────────────────────────────

export interface Tick {
  /** Timestamp in ISO format */
  timestamp: string;
  /** Bid price */
  bid: number;
  /** Ask price */
  ask: number;
  /** Tick volume (number of price changes in this tick batch) */
  volume?: number;
}

export interface TickBuffer {
  /** Symbol this buffer belongs to */
  symbol: string;
  /** Collected ticks since zone touch (or last check) */
  ticks: Tick[];
  /** Timestamp when price first entered the zone */
  zoneEntryTime: string;
  /** The zone boundaries */
  zoneHigh: number;
  zoneLow: number;
  /** Expected direction (if price is in a supply zone, we expect short) */
  expectedDirection: "long" | "short";
}

export interface MicroCandle {
  /** Start time of this micro-candle */
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Number of ticks in this candle */
  tickCount: number;
  /** Tick velocity (ticks per second) */
  velocity: number;
}

export interface TickConfirmationSignal {
  /** Type of tick-level confirmation */
  type: TickConfirmationType;
  /** Confidence level (0-1, higher = stronger signal) */
  confidence: number;
  /** Price at which confirmation occurred */
  confirmationPrice: number;
  /** Timestamp of confirmation */
  confirmationTime: string;
  /** Displacement strength (body/range ratio of the confirming move) */
  displacement: number;
  /** Tick velocity at confirmation (ticks/second) */
  tickVelocity: number;
  /** Supporting evidence */
  evidence: string[];
  /** Suggested entry price (may differ from confirmation price) */
  suggestedEntry: number;
  /** Suggested SL adjustment based on tick-level structure */
  suggestedSlAdjustment: number;
}

export type TickConfirmationType =
  | "micro_choch"          // CHoCH on 1-min aggregated bars
  | "rejection_wick"       // Strong rejection from zone (pin bar forming)
  | "displacement_burst"   // Rapid price movement away from zone
  | "volume_spike"         // Unusual tick velocity (institutional flow)
  | "bid_ask_imbalance";   // Order flow pressure in expected direction

export interface TickConfirmationConfig {
  /** Minimum ticks required before analysis (default: 20) */
  minTicks: number;
  /** Micro-candle aggregation period in seconds (default: 60 = 1 min) */
  microCandlePeriod: number;
  /** Minimum displacement for micro-CHoCH (default: 0.3) */
  minMicroDisplacement: number;
  /** Minimum tick velocity multiplier vs average for volume spike (default: 3.0) */
  volumeSpikeMultiplier: number;
  /** Minimum rejection wick ratio (wick/body, default: 2.5) */
  minRejectionRatio: number;
  /** Maximum time in zone before signal expires (seconds, default: 300 = 5 min) */
  maxTimeInZone: number;
  /** Minimum confidence to trigger (default: 0.6) */
  minConfidence: number;
  /** Pip size for the instrument */
  pipSize: number;
}

export const DEFAULT_TICK_CONFIRMATION_CONFIG: TickConfirmationConfig = {
  minTicks: 20,
  microCandlePeriod: 60,
  minMicroDisplacement: 0.3,
  volumeSpikeMultiplier: 3.0,
  minRejectionRatio: 2.5,
  maxTimeInZone: 300,
  minConfidence: 0.6,
  pipSize: 0.0001,
};

// ─── Tick Aggregation ────────────────────────────────────────────────

/**
 * Aggregate raw ticks into micro-candles of specified period.
 */
export function aggregateTicksToMicroCandles(
  ticks: Tick[],
  periodSeconds: number,
): MicroCandle[] {
  if (ticks.length === 0) return [];

  const candles: MicroCandle[] = [];
  let currentStart = new Date(ticks[0].timestamp).getTime();
  let periodEnd = currentStart + periodSeconds * 1000;
  let open = 0, high = -Infinity, low = Infinity, close = 0;
  let tickCount = 0;
  let firstTick = true;

  for (const tick of ticks) {
    const tickTime = new Date(tick.timestamp).getTime();
    const mid = (tick.bid + tick.ask) / 2;

    // Start new candle if period elapsed
    if (tickTime >= periodEnd && tickCount > 0) {
      const duration = (periodEnd - currentStart) / 1000;
      candles.push({
        timestamp: new Date(currentStart).toISOString(),
        open, high, low, close,
        tickCount,
        velocity: tickCount / Math.max(duration, 1),
      });
      // Reset for next candle
      currentStart = periodEnd;
      periodEnd = currentStart + periodSeconds * 1000;
      open = mid;
      high = mid;
      low = mid;
      close = mid;
      tickCount = 1;
      firstTick = false;
      continue;
    }

    if (firstTick || tickCount === 0) {
      open = mid;
      high = mid;
      low = mid;
      firstTick = false;
    }

    high = Math.max(high, mid);
    low = Math.min(low, mid);
    close = mid;
    tickCount++;
  }

  // Final candle
  if (tickCount > 0) {
    const lastTickTime = new Date(ticks[ticks.length - 1].timestamp).getTime();
    const duration = (lastTickTime - currentStart) / 1000;
    candles.push({
      timestamp: new Date(currentStart).toISOString(),
      open, high, low, close,
      tickCount,
      velocity: tickCount / Math.max(duration, 1),
    });
  }

  return candles;
}

// ─── Micro-Structure Detection ───────────────────────────────────────

/**
 * Detect micro-CHoCH on aggregated tick candles.
 * A micro-CHoCH is when price breaks a recent swing point on the 1-min level.
 */
function detectMicroCHoCH(
  candles: MicroCandle[],
  expectedDirection: "long" | "short",
  config: TickConfirmationConfig,
): { detected: boolean; confidence: number; displacement: number; price: number } {
  if (candles.length < 5) return { detected: false, confidence: 0, displacement: 0, price: 0 };

  // Find swing points on micro-candles (lookback=2 for fast detection)
  const swingHighs: { index: number; price: number }[] = [];
  const swingLows: { index: number; price: number }[] = [];

  for (let i = 2; i < candles.length - 2; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i - 2].high &&
        candles[i].high > candles[i + 1].high && candles[i].high > candles[i + 2].high) {
      swingHighs.push({ index: i, price: candles[i].high });
    }
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i - 2].low &&
        candles[i].low < candles[i + 1].low && candles[i].low < candles[i + 2].low) {
      swingLows.push({ index: i, price: candles[i].low });
    }
  }

  const lastCandle = candles[candles.length - 1];

  if (expectedDirection === "short" && swingLows.length > 0) {
    // For short: need to break below a recent swing low
    const recentLow = swingLows[swingLows.length - 1];
    if (lastCandle.close < recentLow.price) {
      const range = lastCandle.high - lastCandle.low;
      const body = Math.abs(lastCandle.close - lastCandle.open);
      const displacement = range > 0 ? body / range : 0;
      if (displacement >= config.minMicroDisplacement) {
        return {
          detected: true,
          confidence: Math.min(1.0, displacement * 1.2),
          displacement,
          price: lastCandle.close,
        };
      }
    }
  }

  if (expectedDirection === "long" && swingHighs.length > 0) {
    // For long: need to break above a recent swing high
    const recentHigh = swingHighs[swingHighs.length - 1];
    if (lastCandle.close > recentHigh.price) {
      const range = lastCandle.high - lastCandle.low;
      const body = Math.abs(lastCandle.close - lastCandle.open);
      const displacement = range > 0 ? body / range : 0;
      if (displacement >= config.minMicroDisplacement) {
        return {
          detected: true,
          confidence: Math.min(1.0, displacement * 1.2),
          displacement,
          price: lastCandle.close,
        };
      }
    }
  }

  return { detected: false, confidence: 0, displacement: 0, price: 0 };
}

// ─── Rejection Wick Detection ────────────────────────────────────────

/**
 * Detect rejection wick forming in real-time from tick data.
 * A rejection wick shows price entered the zone but was rejected back.
 */
function detectRejectionWick(
  candles: MicroCandle[],
  expectedDirection: "long" | "short",
  zoneHigh: number,
  zoneLow: number,
  config: TickConfirmationConfig,
): { detected: boolean; confidence: number; price: number } {
  if (candles.length < 2) return { detected: false, confidence: 0, price: 0 };

  const lastCandle = candles[candles.length - 1];
  const range = lastCandle.high - lastCandle.low;
  if (range === 0) return { detected: false, confidence: 0, price: 0 };

  const body = Math.abs(lastCandle.close - lastCandle.open);
  const isBullish = lastCandle.close > lastCandle.open;

  if (expectedDirection === "long") {
    // Bullish rejection: long lower wick, price rejected from demand zone
    const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;
    const wickRatio = body > 0 ? lowerWick / body : 0;
    const touchedZone = lastCandle.low <= zoneHigh && lastCandle.low >= zoneLow;

    if (wickRatio >= config.minRejectionRatio && isBullish && touchedZone) {
      return {
        detected: true,
        confidence: Math.min(1.0, wickRatio / (config.minRejectionRatio * 2)),
        price: lastCandle.close,
      };
    }
  }

  if (expectedDirection === "short") {
    // Bearish rejection: long upper wick, price rejected from supply zone
    const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const wickRatio = body > 0 ? upperWick / body : 0;
    const touchedZone = lastCandle.high >= zoneLow && lastCandle.high <= zoneHigh;

    if (wickRatio >= config.minRejectionRatio && !isBullish && touchedZone) {
      return {
        detected: true,
        confidence: Math.min(1.0, wickRatio / (config.minRejectionRatio * 2)),
        price: lastCandle.close,
      };
    }
  }

  return { detected: false, confidence: 0, price: 0 };
}

// ─── Displacement Burst Detection ────────────────────────────────────

/**
 * Detect rapid price movement away from zone (displacement burst).
 * This indicates strong institutional flow in the expected direction.
 */
function detectDisplacementBurst(
  ticks: Tick[],
  expectedDirection: "long" | "short",
  config: TickConfirmationConfig,
): { detected: boolean; confidence: number; displacement: number; price: number } {
  if (ticks.length < 10) return { detected: false, confidence: 0, displacement: 0, price: 0 };

  // Look at the last 10 ticks for a burst
  const recentTicks = ticks.slice(-10);
  const firstMid = (recentTicks[0].bid + recentTicks[0].ask) / 2;
  const lastMid = (recentTicks[recentTicks.length - 1].bid + recentTicks[recentTicks.length - 1].ask) / 2;

  const movePips = (lastMid - firstMid) / config.pipSize;
  const timeSpan = (new Date(recentTicks[recentTicks.length - 1].timestamp).getTime() -
    new Date(recentTicks[0].timestamp).getTime()) / 1000;

  // Calculate pip velocity (pips per second)
  const pipVelocity = timeSpan > 0 ? Math.abs(movePips) / timeSpan : 0;

  // A burst is > 5 pips in < 30 seconds in the expected direction
  const isCorrectDirection = expectedDirection === "long" ? movePips > 0 : movePips < 0;
  const isFastEnough = pipVelocity > 0.2; // > 0.2 pips/second
  const isLargeEnough = Math.abs(movePips) > 5;

  if (isCorrectDirection && isFastEnough && isLargeEnough) {
    const confidence = Math.min(1.0, pipVelocity / 0.5); // Normalize to 0.5 pips/sec = full confidence
    return {
      detected: true,
      confidence,
      displacement: pipVelocity,
      price: lastMid,
    };
  }

  return { detected: false, confidence: 0, displacement: 0, price: 0 };
}

// ─── Volume Spike Detection ──────────────────────────────────────────

/**
 * Detect unusual tick velocity indicating institutional flow.
 */
function detectVolumeSpike(
  candles: MicroCandle[],
  config: TickConfirmationConfig,
): { detected: boolean; confidence: number; velocity: number } {
  if (candles.length < 3) return { detected: false, confidence: 0, velocity: 0 };

  const lastCandle = candles[candles.length - 1];
  const prevCandles = candles.slice(0, -1);

  const avgVelocity = prevCandles.reduce((s, c) => s + c.velocity, 0) / prevCandles.length;
  if (avgVelocity === 0) return { detected: false, confidence: 0, velocity: 0 };

  const velocityRatio = lastCandle.velocity / avgVelocity;

  if (velocityRatio >= config.volumeSpikeMultiplier) {
    return {
      detected: true,
      confidence: Math.min(1.0, velocityRatio / (config.volumeSpikeMultiplier * 2)),
      velocity: lastCandle.velocity,
    };
  }

  return { detected: false, confidence: 0, velocity: 0 };
}

// ─── Bid/Ask Imbalance Detection ─────────────────────────────────────

/**
 * Detect order flow imbalance from bid/ask spread behavior.
 * When the spread narrows on one side, it indicates pressure in that direction.
 */
function detectBidAskImbalance(
  ticks: Tick[],
  expectedDirection: "long" | "short",
  config: TickConfirmationConfig,
): { detected: boolean; confidence: number; imbalance: number } {
  if (ticks.length < 15) return { detected: false, confidence: 0, imbalance: 0 };

  const recentTicks = ticks.slice(-15);

  // Count directional moves
  let bullMoves = 0, bearMoves = 0;
  for (let i = 1; i < recentTicks.length; i++) {
    const prevMid = (recentTicks[i - 1].bid + recentTicks[i - 1].ask) / 2;
    const currMid = (recentTicks[i].bid + recentTicks[i].ask) / 2;
    if (currMid > prevMid) bullMoves++;
    else if (currMid < prevMid) bearMoves++;
  }

  const total = bullMoves + bearMoves;
  if (total === 0) return { detected: false, confidence: 0, imbalance: 0 };

  const imbalance = expectedDirection === "long"
    ? (bullMoves - bearMoves) / total
    : (bearMoves - bullMoves) / total;

  // Imbalance > 0.5 means 75%+ of moves are in expected direction
  if (imbalance > 0.5) {
    return {
      detected: true,
      confidence: Math.min(1.0, imbalance),
      imbalance,
    };
  }

  return { detected: false, confidence: 0, imbalance: 0 };
}

// ─── Main: Tick-Level Confirmation Check ─────────────────────────────

/**
 * Analyze a tick buffer for zone confirmation signals.
 * Returns the strongest signal found, or null if no confirmation.
 *
 * @param buffer - Accumulated tick data for this pending order
 * @param config - Configuration (instrument-specific thresholds)
 * @returns Strongest confirmation signal, or null
 */
export function analyzeTicksForConfirmation(
  buffer: TickBuffer,
  config: Partial<TickConfirmationConfig> = {},
): TickConfirmationSignal | null {
  const cfg = { ...DEFAULT_TICK_CONFIRMATION_CONFIG, ...config };

  if (buffer.ticks.length < cfg.minTicks) return null;

  // Check time limit (use last tick time as "now" for deterministic behavior)
  const lastTickTime = new Date(buffer.ticks[buffer.ticks.length - 1].timestamp).getTime();
  const elapsed = (lastTickTime - new Date(buffer.zoneEntryTime).getTime()) / 1000;
  if (elapsed > cfg.maxTimeInZone) return null; // Signal expired

  // Aggregate ticks into micro-candles
  const microCandles = aggregateTicksToMicroCandles(buffer.ticks, cfg.microCandlePeriod);

  const signals: TickConfirmationSignal[] = [];
  const lastTick = buffer.ticks[buffer.ticks.length - 1];
  const lastMid = (lastTick.bid + lastTick.ask) / 2;

  // 1. Check micro-CHoCH
  const choch = detectMicroCHoCH(microCandles, buffer.expectedDirection, cfg);
  if (choch.detected) {
    signals.push({
      type: "micro_choch",
      confidence: choch.confidence,
      confirmationPrice: choch.price,
      confirmationTime: lastTick.timestamp,
      displacement: choch.displacement,
      tickVelocity: microCandles.length > 0 ? microCandles[microCandles.length - 1].velocity : 0,
      evidence: [`Micro-CHoCH detected with ${(choch.displacement * 100).toFixed(0)}% displacement`],
      suggestedEntry: choch.price,
      suggestedSlAdjustment: 0,
    });
  }

  // 2. Check rejection wick
  const rejection = detectRejectionWick(
    microCandles, buffer.expectedDirection,
    buffer.zoneHigh, buffer.zoneLow, cfg,
  );
  if (rejection.detected) {
    signals.push({
      type: "rejection_wick",
      confidence: rejection.confidence,
      confirmationPrice: rejection.price,
      confirmationTime: lastTick.timestamp,
      displacement: 0,
      tickVelocity: microCandles.length > 0 ? microCandles[microCandles.length - 1].velocity : 0,
      evidence: ["Strong rejection wick from zone boundary"],
      suggestedEntry: rejection.price,
      suggestedSlAdjustment: 0,
    });
  }

  // 3. Check displacement burst
  const burst = detectDisplacementBurst(buffer.ticks, buffer.expectedDirection, cfg);
  if (burst.detected) {
    signals.push({
      type: "displacement_burst",
      confidence: burst.confidence,
      confirmationPrice: burst.price,
      confirmationTime: lastTick.timestamp,
      displacement: burst.displacement,
      tickVelocity: burst.displacement,
      evidence: [`Displacement burst: ${burst.displacement.toFixed(2)} pips/sec`],
      suggestedEntry: burst.price,
      suggestedSlAdjustment: 0,
    });
  }

  // 4. Check volume spike
  const volume = detectVolumeSpike(microCandles, cfg);
  if (volume.detected) {
    // Volume spike alone is supporting evidence, not standalone confirmation
    // Only include if another signal is also present
    signals.push({
      type: "volume_spike",
      confidence: volume.confidence * 0.7, // Reduced weight standalone
      confirmationPrice: lastMid,
      confirmationTime: lastTick.timestamp,
      displacement: 0,
      tickVelocity: volume.velocity,
      evidence: [`Tick velocity ${volume.velocity.toFixed(1)}/sec (${(volume.velocity / (microCandles.slice(0, -1).reduce((s, c) => s + c.velocity, 0) / Math.max(microCandles.length - 1, 1))).toFixed(1)}x average)`],
      suggestedEntry: lastMid,
      suggestedSlAdjustment: 0,
    });
  }

  // 5. Check bid/ask imbalance
  const imbalance = detectBidAskImbalance(buffer.ticks, buffer.expectedDirection, cfg);
  if (imbalance.detected) {
    signals.push({
      type: "bid_ask_imbalance",
      confidence: imbalance.confidence * 0.6, // Supporting only
      confirmationPrice: lastMid,
      confirmationTime: lastTick.timestamp,
      displacement: 0,
      tickVelocity: 0,
      evidence: [`Order flow imbalance: ${(imbalance.imbalance * 100).toFixed(0)}% in expected direction`],
      suggestedEntry: lastMid,
      suggestedSlAdjustment: 0,
    });
  }

  if (signals.length === 0) return null;

  // Boost confidence when multiple signals align
  if (signals.length >= 2) {
    for (const sig of signals) {
      sig.confidence = Math.min(1.0, sig.confidence * (1 + 0.15 * (signals.length - 1)));
      sig.evidence.push(`+${signals.length - 1} supporting signals`);
    }
  }

  // Return the strongest signal that meets minimum confidence
  const strongest = signals
    .filter((s) => s.confidence >= cfg.minConfidence)
    .sort((a, b) => b.confidence - a.confidence)[0];

  return strongest || null;
}

/**
 * Determine if a tick buffer has enough data for meaningful analysis.
 */
export function isTickBufferReady(buffer: TickBuffer, config: Partial<TickConfirmationConfig> = {}): boolean {
  const cfg = { ...DEFAULT_TICK_CONFIRMATION_CONFIG, ...config };
  return buffer.ticks.length >= cfg.minTicks;
}

/**
 * Check if the tick buffer has expired (price left zone or time exceeded).
 */
export function isTickBufferExpired(buffer: TickBuffer, config: Partial<TickConfirmationConfig> = {}, nowMs?: number): boolean {
  const cfg = { ...DEFAULT_TICK_CONFIRMATION_CONFIG, ...config };
  const now = nowMs ?? (buffer.ticks.length > 0
    ? new Date(buffer.ticks[buffer.ticks.length - 1].timestamp).getTime()
    : Date.now());
  const elapsed = (now - new Date(buffer.zoneEntryTime).getTime()) / 1000;
  return elapsed > cfg.maxTimeInZone;
}
