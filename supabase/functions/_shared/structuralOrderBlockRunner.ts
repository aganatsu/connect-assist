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
import { detectSwingPoints, SPECS } from "./smcAnalysis.ts";
import { dropFxClosedBars } from "./sessions.ts";
import { enumerateImpulseLegs } from "./impulseZoneEngine.ts";
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
 * EVERY valid leg in the window, both directions, on every timeframe.
 *
 * This used to call findImpulseLeg() twice, which returns only the most recent
 * valid leg per direction. That capped the whole engine at
 * symbols x directions x timeframes = 32 blocks, and it measured 28 — the
 * ceiling, not a finding. A 4H chart with six stacked historical zones could
 * never be reproduced, however deep the candles went.
 *
 * Deliberately NOT gated on the trade direction the scanner settled on: a
 * supply block above price is exactly as real as a demand block below it, and
 * inheriting the direction gate here would make the engine blind to half the
 * chart — the same way that gate already hides retracements from measurement.
 */
function legsFor(candles: Candle[], timeframe: "D" | "4H" | "1H"): ImpulseLeg[] {
  try {
    // includeBrokenOrigin: a leg whose origin price has since been exceeded is
    // no longer tradeable, but the order block it created still exists. The
    // reference charts carry zones for months after the move that made them was
    // undone. A parent impulse must not retroactively delete its child zone —
    // only the zone's own invalidation rule can.
    return enumerateImpulseLegs(candles, timeframe, { includeBrokenOrigin: true })
      .filter(l => l.startIndex != null && l.endIndex != null);
  } catch {
    return [];   // a bad series must not cost the scan
  }
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

  // Weekend bars are not real price. Measured 2026-09-17: 26% of 4H bases and
  // 19% of Daily bases originated on bars the FX market was shut for —
  // Saturday 17:00, Sunday 09:00, Daily bars stamped Saturday. Nothing in the
  // candle path filters them, so they reached structure detection intact.
  //
  // Dropped for V2 only, for now. Every legacy engine reads the same
  // contaminated series, and fixing that changes which trades fire — a
  // separate decision, not something to slip in behind a shadow-mode feature.
  const isForex = (SPECS as any)[symbol]?.type === "forex";

  for (const s of sorted) {
    const candles = dropFxClosedBars(s.candles ?? [], isForex);
    if (candles.length < 20) continue;
    try {
      const swings = detectSwingPoints(candles, s.timeframe === "D" ? 3 : 5, 0);
      const blocks = detectStructuralOrderBlocks(candles, legsFor(candles, s.timeframe), {
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
    extent: ob.extent,
    base_start_index: ob.baseStartIndex,
    base_end_index: ob.baseEndIndex,
    base_candle_count: ob.baseCandleCount,
    confirmed_index: ob.confirmedIndex,
    origin_time: ob.originTime,
    confirmed_time: ob.confirmedTime,
    significance: ob.significance,
    parent_impulse_broken: ob.parentImpulseBroken,
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
    extent: b.extent,
    status: b.status,
    significance: b.significance,
    parentBroken: b.parentImpulseBroken,
    score: b.score,
    touches: b.touches,
    penetration: b.maxPenetrationPercent,
    band: b.mitigationBand,
    baseCandles: b.baseCandleCount,
    originTime: b.originTime,
    confirmedTime: b.confirmedTime,
  }));
}
