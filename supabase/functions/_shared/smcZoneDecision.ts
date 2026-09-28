/**
 * SMC zone decision — the production orchestration, extracted. PURE.
 *
 * WHY THIS EXISTS. bot-scanner and backtest-engine were two implementations of
 * one strategy, and they drifted: the 2026-09-01 revert to the July-10 baseline
 * rolled backtest-engine past its 2026-07-26 zone-parity port, leaving it on
 * `findBestEntryZoneMultiTF` at depth 51/120/60 while production moved to
 * `findUnifiedZone` at depth 300/800 with liquidity, confirmation and a zone
 * config. Any profitability number from the backtester since then describes a
 * strategy that has not run in production for weeks.
 *
 * The fix is one decision, two callers. Almost every ALGORITHM was already
 * shared (`findUnifiedZone`, `runConfluenceAnalysis`, `computeDirectionVerdict`,
 * `runSafetyGates`, …); what was duplicated is the ORCHESTRATION around them —
 * the slot mapping, the argument assembly, the config plumbing. That is what
 * this module owns.
 *
 * EXTRACTION ONLY. Every line here is lifted from bot-scanner's per-pair loop
 * with its behaviour preserved exactly, including the parts that look odd. No
 * rule was cleaned up, no threshold moved, no gate simplified. Where the
 * original had a quirk, the quirk is reproduced and commented rather than
 * fixed — fixing it here would be an undetectable strategy change.
 *
 * NO SIDE EFFECTS. No database, no network, no logging, no clock. Callers own
 * fetching, persistence, snapshotting, execution and notification.
 *
 * SCOPE. This is the ZONE slice: HTF-confluence assembly, style-aware slot
 * mapping, the stop-floor inputs, `findUnifiedZone`, and the two result shapes
 * production derives from it (`unifiedZone` and the legacy `impulseZone`/izData
 * that 58 downstream references still read). Direction, confluence, ICT and the
 * gate stack are NOT yet extracted — see SMC_DECISION_EXTRACTION.md for why
 * those cannot be parity-verified against the current corpus.
 */

import {
  findUnifiedZone, type UnifiedZoneResult,
} from "./unifiedZoneEngine.ts";
import type { HTFConfluenceData, TFSlotLabels } from "./impulseZoneEngine.ts";
import type { Candle, LiquidityPool } from "./smcAnalysis.ts";

export const ZONE_DECISION_CONTRACT = "smc-zone-impulse-control-v1";

export type ResolvedStyle = "scalper" | "day_trader" | "swing_trader";

/** Candle series the slot mapping selects from. Names match bot-scanner's. */
export interface ZoneSeries {
  candles: Candle[];          // entry-timeframe series for the active style
  m15Candles: Candle[];
  hourlyCandles: Candle[];
  h4Candles: Candle[];
  dailyCandles: Candle[];
  weeklyCandles: Candle[] | null;
}

/** The positional slots `findUnifiedZone` consumes, plus their intervals. */
export interface ZoneSlots {
  h1: Candle[];                     // arg1 — LOWEST structural slot
  h4: Candle[];                     // arg2 — mid structural slot
  entry: Candle[];                  // arg3
  daily: Candle[] | undefined;      // arg9 — HIGHEST structural slot
  confirm: Candle[];
  ltfConfirm: Candle[];
  labels: TFSlotLabels;             // display text the engine echoes ("1H","D","W")
  intervals: Record<string, string>; // canonical intervals, for the snapshot
}

/**
 * Style-aware slot mapping, verbatim from bot-scanner.
 *
 * The slot names h1/h4/daily are POSITIONAL, not timeframes — the engine is
 * TF-agnostic and a scalper passes 5m into the slot called "h1". `labels` is
 * display text; `intervals` is the canonical spelling bars are keyed by. The
 * two are deliberately different and must not be merged: collapsing them once
 * caused the same 15m bar to be stored twice.
 */
export function resolveZoneSlots(style: ResolvedStyle, s: ZoneSeries): ZoneSlots {
  if (style === "scalper") {
    return {
      h1: s.candles,                 // 5m  = lowest structural TF slot
      h4: s.m15Candles,              // 15m = mid structural TF slot
      entry: s.candles,              // 5m entry
      daily: s.hourlyCandles.length >= 20 ? s.hourlyCandles : undefined, // 1H = highest
      confirm: s.m15Candles.length >= 15 ? s.m15Candles : s.candles,
      ltfConfirm: s.candles,
      labels: { top: "1H", mid: "15m", low: "5m" },
      intervals: {
        top: "1h", mid: "15m", low: "5m", entry: "5m",
        confirm: s.m15Candles.length >= 15 ? "15m" : "5m", ltf_confirm: "5m",
      },
    };
  }
  if (style === "swing_trader") {
    return {
      h1: s.h4Candles,
      h4: s.dailyCandles,
      entry: s.candles,
      daily: s.weeklyCandles && s.weeklyCandles.length >= 20 ? s.weeklyCandles : undefined,
      confirm: s.dailyCandles.length >= 15 ? s.dailyCandles : s.h4Candles,
      ltfConfirm: s.h4Candles,
      labels: { top: "W", mid: "D", low: "4H" },
      intervals: {
        top: "1w", mid: "1d", low: "4h", entry: "1h",
        confirm: s.dailyCandles.length >= 15 ? "1d" : "4h", ltf_confirm: "4h",
      },
    };
  }
  return {
    h1: s.hourlyCandles,
    h4: s.h4Candles,
    entry: s.candles,               // 15m entry
    daily: s.dailyCandles.length >= 30 ? s.dailyCandles : undefined,
    confirm: s.dailyCandles.length >= 30 ? s.h4Candles : s.hourlyCandles,
    ltfConfirm: s.dailyCandles.length >= 30 ? s.hourlyCandles : s.candles,
    labels: { top: "D", mid: "4H", low: "1H" },
    intervals: {
      top: "1d", mid: "4h", low: "1h", entry: "15m",
      confirm: s.dailyCandles.length >= 30 ? "4h" : "1h",
      ltf_confirm: s.dailyCandles.length >= 30 ? "1h" : "15m",
    },
  };
}

/** Whether the active style has enough of its own structural series to score. */
export function hasMinZoneCandles(style: ResolvedStyle, s: ZoneSeries): boolean {
  return style === "scalper"
    ? s.candles.length >= 20
    : style === "swing_trader"
      ? s.h4Candles.length >= 20
      : s.hourlyCandles.length >= 20;
}

/**
 * The HTF confluence bundle, verbatim.
 *
 * Null when there is no direction — the engine treats "absent" and "present but
 * empty" differently, and Stage 2E measured what conflating them costs: an
 * omitted bundle moved AUD/USD agreement from 84.9% to 37.3%.
 */
export function buildHtfConfluence(input: {
  direction: "long" | "short" | null;
  h4OBs: unknown[] | null; h4FVGs: unknown[] | null; h4Breakers: unknown[] | null;
  htfFibLevels4H: unknown; htfFibLevelsD: unknown; htfPD4H: unknown;
}): HTFConfluenceData | null {
  if (!input.direction) return null;
  return {
    h4OBs: input.h4OBs ?? [],
    h4FVGs: input.h4FVGs ?? [],
    h4Breakers: input.h4Breakers ?? [],
    htfFibLevels: input.htfFibLevels4H ?? null,
    dailyFibLevels: input.htfFibLevelsD ?? null,
    htfPD: input.htfPD4H ?? null,
    direction: (input.direction === "long" ? "bullish" : "bearish") as "bullish" | "bearish",
  } as HTFConfluenceData;
}

export interface ZoneDecisionInput {
  symbol: string;
  style: ResolvedStyle;
  series: ZoneSeries;
  direction: "long" | "short" | null;
  lastPrice: number;
  htfConfluence: HTFConfluenceData | null;
  /** Combined Daily + 4H + 1H pools, in that order. Order is significant. */
  liquidityPools: LiquidityPool[];
  /** Stop-floor inputs, already resolved by the caller from pair config + ATR. */
  minSlPips: number;
  maxSlPips: number;
  tpRatio: number;
  entryDepth: number | undefined;
  pipSize: number;
  strictATRMult: number | undefined;
  fibMaxRetracement: number | undefined;
  originOBRetest: boolean | undefined;
  impulseZoneEnabled: boolean;
}

export interface ZoneDecisionResult {
  evaluated: boolean;            // false when direction or candle minimum failed
  slots: ZoneSlots | null;
  unified: UnifiedZoneResult | null;
  /** The `detail.unifiedZone` shape the frontend narrative panel reads. */
  unifiedZone: Record<string, unknown> | null;
  /** The legacy `detail.impulseZone` (izData) shape 58 call sites still read. */
  impulseZone: Record<string, unknown> | null;
}

/**
 * Run the zone decision exactly as bot-scanner does.
 *
 * Returns `evaluated: false` — not a thrown error and not an empty zone — when
 * the caller's direction is null or the style's series is too short, because
 * "not evaluated" and "evaluated, no zone" are different facts downstream.
 */
export function decideZone(input: ZoneDecisionInput): ZoneDecisionResult {
  if (!input.direction || !hasMinZoneCandles(input.style, input.series)) {
    return { evaluated: false, slots: null, unified: null, unifiedZone: null, impulseZone: null };
  }

  const slots = resolveZoneSlots(input.style, input.series);
  const unifiedDir = input.direction === "long" ? "bullish" : "bearish";

  const unifiedResult: UnifiedZoneResult = findUnifiedZone(
    slots.h1,
    slots.h4,
    slots.entry,
    unifiedDir as "bullish" | "bearish",
    input.lastPrice,
    input.liquidityPools,
    input.htfConfluence ?? undefined,
    {
      strictATRMult: input.strictATRMult,
      pipSize: input.pipSize,
      fibMaxRetracement: input.fibMaxRetracement,
      originOBRetest: input.originOBRetest,
    },
    slots.daily,
    slots.confirm,
    slots.ltfConfirm,
    // minRR and requireConfirmation stay at their defaults — both gate whether
    // an entry object exists at all, so moving them changes trade selection.
    // minSlPips and tpRatio are supplied only so the engine can report what
    // execution WOULD place (EntryStory.executable); they feed no gate.
    {
      minSlPips: input.minSlPips,
      maxSlPips: input.maxSlPips,
      tpRatio: input.tpRatio,
      entryDepth: input.entryDepth,
    },
    slots.labels,
  );

  const unifiedZone = {
    hasZone: unifiedResult.hasZone,
    state: unifiedResult.state,
    selectedTF: unifiedResult.selectedTF,
    unifiedScore: unifiedResult.unifiedScore,
    scoreBreakdown: unifiedResult.scoreBreakdown,
    impulse: unifiedResult.impulse,
    zone: unifiedResult.zone,
    price: unifiedResult.price,
    liquidity: unifiedResult.liquidity
      ? {
        liquidityScore: unifiedResult.liquidity.liquidityScore,
        summary: unifiedResult.liquidity.summary,
        nearbyPools: unifiedResult.liquidity.nearbyPools.length,
        sweepEvent: unifiedResult.liquidity.sweepEvent
          ? {
            level: unifiedResult.liquidity.sweepEvent.level,
            type: unifiedResult.liquidity.sweepEvent.type,
            rejected: unifiedResult.liquidity.sweepEvent.rejected,
          }
          : null,
      }
      : null,
    confirmation: unifiedResult.confirmation
      ? {
        type: unifiedResult.confirmation.type,
        score: unifiedResult.confirmation.score,
        entryReady: unifiedResult.confirmation.entryReady,
        direction: unifiedResult.confirmation.direction,
        detail: unifiedResult.confirmation.detail,
      }
      : null,
    entry: unifiedResult.entry,
    storySummary: unifiedResult.storySummary,
    reason: unifiedResult.reason,
  };

  // Derived from the unified result's multiTFResult for backward compatibility
  // with the 58 downstream references to izData.*
  const multiTF = unifiedResult.multiTFResult;
  const impulseZone = {
    hasZone: !!multiTF.bestZone,
    selectedTF: multiTF.selectedTF,
    reason: multiTF.reason,
    impulse: multiTF.bestZone?.impulse
      ? {
        high: multiTF.bestZone.impulse.high,
        low: multiTF.bestZone.impulse.low,
        direction: multiTF.bestZone.impulse.direction,
      }
      : null,
    bestZone: multiTF.bestZone
      ? {
        type: multiTF.bestZone.zone.poi.type,
        high: multiTF.bestZone.zone.poi.high,
        low: multiTF.bestZone.zone.poi.low,
        fibLevel: multiTF.bestZone.zone.fibLevel,
        fibDepth: multiTF.bestZone.zone.fibDepth,
        totalScore: multiTF.bestZone.zone.totalScore,
        srConfirmed: multiTF.bestZone.zone.srConfirmed,
        ltfRefined: multiTF.bestZone.zone.ltfRefined,
        ltfType: multiTF.bestZone.zone.ltfType || null,
        refinedEntry: multiTF.bestZone.zone.refinedEntry || null,
        refinedSL: multiTF.bestZone.zone.refinedSL || null,
        htfConfluenceScore: multiTF.bestZone.zone.htfConfluenceScore,
        htfLayers: multiTF.bestZone.zone.htfLayers,
        priceAtZone: multiTF.bestZone.priceAtZone,
        priceInsideZone: multiTF.bestZone.priceInsideZone,
        priceAtZoneStrict: multiTF.bestZone.priceAtZoneStrict,
        sideOk: multiTF.bestZone.sideOk,
        distanceToZone: multiTF.bestZone.distanceToZone,
        distancePips: multiTF.bestZone.distancePips,
        // How deep into the zone price has actually come, as a fraction of zone
        // width from the NEAR edge. An entry at depth D fills only when
        // penetration reaches D, and today D is pinned at 1.
        //   <0 price has not entered the zone
        //    0 just touched the near edge
        //    1 reached the far edge  (what the entry currently requires)
        //   >1 traded clean through
        zonePenetration: (() => {
          const zw = multiTF.bestZone.zone.poi.high - multiTF.bestZone.zone.poi.low;
          if (!(zw > 0)) return null;
          return input.direction === "long"
            ? (multiTF.bestZone.zone.poi.high - input.lastPrice) / zw
            : (input.lastPrice - multiTF.bestZone.zone.poi.low) / zw;
        })(),
        entryDepthInUse: input.entryDepth ?? 1,
      }
      : null,
    allZonesCount: multiTF.allZones.length,
    h1HasZone: !!multiTF.h1Result.bestZone,
    h4HasZone: !!multiTF.h4Result?.bestZone,
    dailyHasZone: !!multiTF.dailyResult?.bestZone,
    scoringEnabled: input.impulseZoneEnabled,
  };

  return { evaluated: true, slots, unified: unifiedResult, unifiedZone, impulseZone };
}
