/**
 * structureLagObserver.ts — measurement only, changes no decision.
 *
 * WHY THIS EXISTS
 *
 * analyzeMarketStructure derives BOS/CHoCH by comparing consecutive swings. For
 * each pair of swing highs it builds an event and then tests:
 *
 *   const breakCandle  = candles[evt.index];              // the LATER SWING's candle
 *   const closedThrough = breakCandle.close > evt.prevLevel;
 *
 * confirmedTrend in directionEngine does the same:
 *
 *   const candleClose = candles[curr.index].close;
 *   const closedAbove = candleClose > prev.price;
 *
 * Both test the close of the next swing candle, not the candle that actually
 * broke the level. A break is supposed to be the moment price closes beyond the
 * prior swing; here it is inferred from one swing to the next, so it is
 * recorded at a candle that may be well past the real break.
 *
 * Three consequences, all in the same direction:
 *
 *   1. LAG. A swing must be a local extreme over +/- lookback bars AND clear an
 *      ATR filter, so no break exists until a new swing forms after it. The most
 *      recent break is therefore invisible — which for a 5m scalper is the only
 *      one that matters.
 *   2. MISCLASSIFICATION. If price closes decisively through a level and the
 *      eventual swing candle closes back below it, closedThrough is false and it
 *      is filed as a liquidity sweep instead of a break.
 *   3. RECENCY IS MEASURED FROM THE WRONG BAR. recentBreaks() filters on
 *      b.index, and those are swing indices that already lag the real break, so
 *      "recent CHoCH" is staler than the lookback implies.
 *
 * This module measures 1 and 2 against live data. It does NOT change detection.
 * Nothing here feeds a gate, a score or a direction — it only writes numbers
 * into scan detail so the size of the problem is known before anything is
 * altered. Structure detection sits under every gate in the system, so it is
 * the last thing that should be changed on a hunch.
 */

import type { Candle, StructureBreak, LiquiditySweep } from "./smcAnalysis.ts";

export interface StructureLagReport {
  /** Breaks we could locate a corrected index for. */
  breaksAnalysed: number;
  /**
   * Breaks whose recorded candle was NOT closed beyond their own level.
   * By construction that should never happen — analyzeMarketStructure only
   * records a break when closedThrough is true — so a non-zero count means the
   * candles passed in are not the array the indices refer to. Reported rather
   * than skipped silently: the first version of this observer was handed the
   * full series while structure had been computed on candles.slice(-50), and it
   * produced confident nonsense instead of complaining.
   */
  breaksSkipped: number;
  /** Bars between the real close-through and where the break is recorded. */
  medianBarLag: number;
  maxBarLag: number;
  /** Breaks recorded at the same bar the level was actually closed through. */
  zeroLagBreaks: number;
  /**
   * Sweeps where an earlier candle DID close through the swept level — i.e. a
   * close-through filed as a wick because the swing candle closed back inside.
   */
  sweepsWithEarlierCloseThrough: number;
  sweepsAnalysed: number;
  /**
   * Bars from the corrected index of the newest break to the end of the series.
   * How stale the freshest structure reading is, in bars.
   */
  barsSinceNewestBreak: number | null;
}

/** How far back to hunt for the true close-through before giving up. */
const SCAN_WINDOW = 40;

/**
 * Walk backwards from `atIndex` to find the first candle of the contiguous run
 * that is closed beyond `level`. Contiguity is the right notion: if price closed
 * through, fell back inside, then closed through again, the second run is the
 * one that produced this swing.
 *
 * Returns null when the candle at atIndex is not itself closed through — that is
 * the sweep case, handled separately.
 */
function firstCloseThroughIndex(
  candles: Candle[],
  atIndex: number,
  level: number,
  direction: "bullish" | "bearish",
): number | null {
  const beyond = (c: Candle) => direction === "bullish" ? c.close > level : c.close < level;
  if (!candles[atIndex] || !beyond(candles[atIndex])) return null;
  let i = atIndex;
  const stop = Math.max(0, atIndex - SCAN_WINDOW);
  while (i - 1 >= stop && candles[i - 1] && beyond(candles[i - 1])) i--;
  return i;
}

/** True when any candle in the window before atIndex closed beyond the level. */
function hadEarlierCloseThrough(
  candles: Candle[],
  atIndex: number,
  level: number,
  direction: "bullish" | "bearish",
): boolean {
  const beyond = (c: Candle) => direction === "bullish" ? c.close > level : c.close < level;
  const stop = Math.max(0, atIndex - SCAN_WINDOW);
  for (let i = atIndex - 1; i >= stop; i--) {
    if (candles[i] && beyond(candles[i])) return true;
  }
  return false;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function observeStructureLag(
  candles: Candle[],
  bos: StructureBreak[],
  choch: StructureBreak[],
  sweeps: LiquiditySweep[],
): StructureLagReport {
  const empty: StructureLagReport = {
    breaksAnalysed: 0, breaksSkipped: 0, medianBarLag: 0, maxBarLag: 0, zeroLagBreaks: 0,
    sweepsWithEarlierCloseThrough: 0, sweepsAnalysed: 0, barsSinceNewestBreak: null,
  };
  if (!Array.isArray(candles) || candles.length < 10) return empty;

  const allBreaks = [...bos, ...choch];
  const lags: number[] = [];
  let newestCorrected: number | null = null;

  let skipped = 0;
  for (const b of allBreaks) {
    if (typeof b.index !== "number" || typeof b.level !== "number") { skipped++; continue; }
    const corrected = firstCloseThroughIndex(candles, b.index, b.level, b.type);
    if (corrected === null) { skipped++; continue; }
    lags.push(b.index - corrected);
    if (newestCorrected === null || corrected > newestCorrected) newestCorrected = corrected;
  }

  // A sweep whose level was already closed through earlier is a break wearing
  // the wrong label — the swing candle simply closed back inside.
  let misfiled = 0;
  let sweepsAnalysed = 0;
  for (const s of sweeps) {
    if (typeof s.index !== "number" || typeof s.sweptLevel !== "number") continue;
    sweepsAnalysed++;
    // A "bearish" sweep is a high swept then rejected, so a genuine break there
    // would have closed ABOVE the level.
    const dir: "bullish" | "bearish" = s.type === "bearish" ? "bullish" : "bearish";
    if (hadEarlierCloseThrough(candles, s.index, s.sweptLevel, dir)) misfiled++;
  }

  return {
    breaksAnalysed: lags.length,
    breaksSkipped: skipped,
    medianBarLag: median(lags),
    maxBarLag: lags.length ? Math.max(...lags) : 0,
    zeroLagBreaks: lags.filter((l) => l === 0).length,
    sweepsWithEarlierCloseThrough: misfiled,
    sweepsAnalysed,
    barsSinceNewestBreak: newestCorrected === null ? null : (candles.length - 1) - newestCorrected,
  };
}
