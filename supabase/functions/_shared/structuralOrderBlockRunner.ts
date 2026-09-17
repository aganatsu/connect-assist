/**
 * Per-symbol driver for the V2 structural order-block engine.
 *
 * Kept out of bot-scanner so the glue is testable on its own, and so the
 * scanner's pair loop gains four lines rather than eighty.
 *
 * Daily is detected FIRST and its blocks are handed to the 4H pass as
 * higher-timeframe context. Daily and 4H blocks that overlap are both kept —
 * they carry different structural information and are deliberately not merged
 * across timeframes.
 *
 * SHADOW MODE. This returns blocks for storage and display. Nothing here
 * influences direction, scoring, entries or exits.
 */

import type { Candle } from "./smcAnalysis.ts";
import { detectSwingPoints } from "./smcAnalysis.ts";
import { findImpulseLeg } from "./impulseZoneEngine.ts";
import type { ImpulseLeg } from "./impulseZoneEngine.ts";
import {
  detectStructuralOrderBlocks,
  type StructuralOrderBlock,
} from "./structuralOrderBlocks.ts";

export interface SeriesInput {
  timeframe: "D" | "4H" | "1H";
  candles: Candle[];
}

/**
 * Both directions are searched on every timeframe.
 *
 * Deliberately NOT gated on the trade direction the scanner settled on: a
 * supply block above price is exactly as real as a demand block below it, and
 * inheriting the direction gate here would make the engine blind to half the
 * chart — the same way the gate already hides retracements from measurement.
 */
function legsFor(candles: Candle[], timeframe: "D" | "4H" | "1H"): ImpulseLeg[] {
  const legs: ImpulseLeg[] = [];
  for (const dir of ["bullish", "bearish"] as const) {
    try {
      const leg = findImpulseLeg(candles, dir, timeframe);
      if (leg && leg.startIndex != null && leg.endIndex != null) legs.push(leg);
    } catch { /* a bad series must not cost the scan */ }
  }
  return legs;
}

export function runStructuralOrderBlocks(
  symbol: string,
  series: SeriesInput[],
): StructuralOrderBlock[] {
  // Daily first, so its blocks are available as HTF context for 4H.
  const order = { D: 0, "4H": 1, "1H": 2 } as const;
  const sorted = [...series].sort((a, b) => order[a.timeframe] - order[b.timeframe]);

  const all: StructuralOrderBlock[] = [];
  const htfSoFar: StructuralOrderBlock[] = [];

  for (const s of sorted) {
    if (!s.candles || s.candles.length < 20) continue;
    try {
      const swings = detectSwingPoints(s.candles, s.timeframe === "D" ? 3 : 5, 0);
      const blocks = detectStructuralOrderBlocks(s.candles, legsFor(s.candles, s.timeframe), {
        symbol,
        timeframe: s.timeframe,
        swings,
        // Empty array still counts as "evaluated" — on the Daily pass there is
        // no higher timeframe, so the factor is genuinely unavailable and must
        // be reported as such rather than scored zero.
        htfBlocks: htfSoFar.length > 0 ? htfSoFar : undefined,
      });
      all.push(...blocks);
      htfSoFar.push(...blocks);
    } catch (e) {
      console.warn(`[sob-v2] ${symbol} ${s.timeframe} detection failed: ${(e as Error)?.message}`);
    }
  }
  return all;
}

/** Row shape for structural_order_blocks_v2. */
export function toRow(ob: StructuralOrderBlock, userId: string, botId: string) {
  return {
    id: ob.id,
    user_id: userId,
    bot_id: botId,
    symbol: ob.symbol,
    timeframe: ob.timeframe,
    direction: ob.direction,
    proximal: ob.proximal,
    distal: ob.distal,
    sweep_level: ob.sweepLevel,
    base_start_index: ob.baseStartIndex,
    base_end_index: ob.baseEndIndex,
    base_candle_count: ob.baseCandleCount,
    confirmed_index: ob.confirmedIndex,
    origin_time: ob.originTime,
    confirmed_time: ob.confirmedTime,
    significance: ob.significance,
    displacement_atr_multiple: ob.displacementAtrMultiple,
    directional_body_ratio: ob.directionalBodyRatio,
    directional_candle_ratio: ob.directionalCandleRatio,
    path_efficiency: ob.pathEfficiency,
    base_compactness_atr: ob.baseCompactnessAtr,
    touches: ob.touches,
    max_penetration_percent: ob.maxPenetrationPercent,
    mitigation_band: ob.mitigationBand,
    first_touch_index: ob.firstTouchIndex ?? null,
    last_touch_index: ob.lastTouchIndex ?? null,
    status: ob.status,
    invalidation_count: ob.invalidationCount,
    invalidated_index: ob.invalidatedIndex ?? null,
    score: ob.score,
    score_breakdown: ob.scoreBreakdown,
    score_unavailable: ob.scoreUnavailable,
    last_seen_at: new Date().toISOString(),
  };
}

/**
 * Compact shape for the scan record and the chart overlay. The full row lives
 * in the table; this is what the panel needs to draw a box and label it.
 */
export function toScanDetail(blocks: StructuralOrderBlock[]) {
  return blocks.map(b => ({
    id: b.id,
    tf: b.timeframe,
    dir: b.direction,
    proximal: b.proximal,
    distal: b.distal,
    sweepLevel: b.sweepLevel,
    status: b.status,
    significance: b.significance,
    score: b.score,
    touches: b.touches,
    penetration: b.maxPenetrationPercent,
    band: b.mitigationBand,
    baseCandles: b.baseCandleCount,
    originTime: b.originTime,
    confirmedTime: b.confirmedTime,
  }));
}
