/**
 * unifiedZoneEngine.ts — Unified Impulse Zone Engine
 * ───────────────────────────────────────────────────
 * Single entry point that composes:
 *   - Impulse Zone Engine (zone detection across D/4H/1H)
 *   - Zone Liquidity (BSL/SSL near zone, sweep detection)
 *   - Confirmation Hierarchy (sweep+CHoCH, displacement, inducement)
 *
 * Returns a story-driven result that tells the full narrative:
 *   Daily Impulse → Zone → Price → Liquidity → Confirmation → Entry
 *
 * Key principles:
 *   - Entry direction = impulse direction (continuation, not reversal)
 *   - Daily always wins when available (highest conviction)
 *   - One zone, one story, one score
 *   - "Don't catch a falling knife" — never trade against the impulse
 */

import { type Candle, type LiquidityPool, calculateATR } from "./smcAnalysis.ts";
import {
  findBestEntryZoneMultiTF,
  type MultiTFZoneResult,
  type HTFConfluenceData,
  type ZoneEngineOptions,
  type ImpulseLeg,
  type RankedPOI,
  type BestZone,
  type TFSlotLabels,
  DEFAULT_TF_LABELS,
} from "./impulseZoneEngine.ts";
import { findZoneLiquidity, type ZoneLiquidityResult } from "./zoneLiquidity.ts";
import { evaluateConfirmation, type ConfirmationResult, type ConfirmationInput } from "./confirmationHierarchy.ts";

// ─── Types ───────────────────────────────────────────────────────────

/** The full story-driven result from the unified engine */
export interface UnifiedZoneResult {
  /** Whether a valid zone was found */
  hasZone: boolean;

  /** Which timeframe produced the winning zone */
  selectedTF: string | null;

  /** The impulse leg that created the zone */
  impulse: ImpulseStory | null;

  /** The zone details */
  zone: ZoneStory | null;

  /** Price proximity to the zone */
  price: PriceStory;

  /** Liquidity context near the zone */
  liquidity: ZoneLiquidityResult | null;

  /** Confirmation status */
  confirmation: ConfirmationResult | null;

  /** Entry details (only when confirmation is ready) */
  entry: EntryStory | null;

  /** Unified score (out of 14) */
  unifiedScore: number;

  /** Score breakdown */
  scoreBreakdown: ScoreBreakdown;

  /** Human-readable story summary */
  storySummary: string;

  /** The underlying multi-TF result (for backward compatibility) */
  multiTFResult: MultiTFZoneResult;

  /** Overall state of the setup */
  state: UnifiedState;

  /** Reason string */
  reason: string;
}

export type UnifiedState =
  | "no_impulse"          // No valid impulse found on any TF
  | "no_zone"            // Impulse exists but no valid zone
  | "watching"           // Zone found, price not there yet (watchlist)
  | "at_zone"            // Price at zone, waiting for confirmation
  | "confirmed"          // Confirmation fired, entry ready
  | "triggered";         // Price at entry level — execute

export interface ImpulseStory {
  direction: "bullish" | "bearish";
  high: number;
  low: number;
  pips: number;
  timeframe: string;
  startDate: string | null;
  endDate: string | null;
  spanBars: number;
  bosPrice: number;
}

export interface ZoneStory {
  type: "OB" | "FVG";
  high: number;
  low: number;
  fibLevel: number;
  fibLabel: string;
  srConfirmed: boolean;
  htfLayers: string[];
  ltfRefined: boolean;
  totalScore: number;
  zonesFound: number;
}

export interface PriceStory {
  currentPrice: number;
  atZone: boolean;
  atZoneStrict: boolean;
  insideZone: boolean;
  distancePips: number;
  sideOk: boolean;
}

export interface EntryStory {
  direction: "long" | "short";
  entryPrice: number;
  /**
   * Zone-derived stop: zone edge plus half the zone's own width. Kept because
   * two things read it — the Unified Zone SL Override guard in bot-scanner and
   * the minRR check below. NOT what gets traded. Display `executable` instead.
   */
  slPrice: number;
  /** Structural target (the impulse BOS level). Also not what gets traded. */
  tpPrice: number | null;
  riskPips: number;
  rewardPips: number | null;
  rrRatio: number | null;
  /**
   * What execution would actually place, computed with the same rules
   * bot-scanner uses: the stop floored by effectiveMinSlPips, and the target at
   * entry +/- risk * tpRatio.
   *
   * These exist because the panel was showing a plan that could never be
   * traded. Observed 2026-09-04 on NZD/USD: a 2.7-pip zone produced "Risk 1.3
   * pips, R:R 31.48:1", while execution would have floored the stop and set a
   * 2:1 target. The override guard rejects a stop below the floor, so that plan
   * was never reachable — but nothing on screen said so, and it was read as an
   * exceptional setup twice.
   *
   * null when the caller does not supply minSlPips/tpRatio.
   */
  executable: {
    slPrice: number;
    tpPrice: number;
    riskPips: number;
    rewardPips: number;
    rrRatio: number;
    /** True when the zone-derived stop was below the floor and had to widen. */
    slWidenedToFloor: boolean;
  } | null;
  /**
   * What execution will do with this zone's stop.
   *
   *   "accepted"        within [floor, cap] — the override applies it
   *   "widened_to_floor" below the floor — widened, then applied
   *   "rejected_too_wide" above the cap — DISCARDED; execution uses its own
   *                       structural stop, which this engine cannot see
   *   "unknown"         caller did not supply the bounds
   *
   * Observed 2026-09-04 on BTC/USD: a 677.3-point zone stop against a 225-point
   * cap (MIN_SL_PIPS 150 x scalper multiplier 1.5). Rejected, and execution fell
   * back to a 150-point structural stop — the bare floor — inside a 1354-point
   * zone. The panel showed the 677 and gave no hint it was unusable.
   */
  slDisposition: "accepted" | "widened_to_floor" | "rejected_too_wide" | "unknown";
  /**
   * ALWAYS true. Both entry routes fill at live price:
   *   market-fill-at-zone  -> analysis.lastPrice
   *   pending + CHoCH      -> `const actualFillPrice = currentPrice` (the log
   *                           even records "limit was ${entryPrice}")
   * so entryPrice is a target level, never a fill price. Kept as a field so the
   * panel cannot quietly start presenting it as one again.
   */
  fillsAtMarket: true;
}

export interface ScoreBreakdown {
  /** Base zone score from impulse zone engine (out of 9) */
  baseScore: number;
  /** Liquidity bonus (0 to 3.0) */
  liquidityBonus: number;
  /** Confirmation bonus (0 to 2.5) */
  confirmationBonus: number;
  /** Timeframe bonus: Daily +2.0, 4H +1.0, 1H +0 */
  tfBonus: number;
  /** Total unified score (out of ~14) */
  total: number;
}

// ─── Configuration ──────────────────────────────────────────────────

export interface UnifiedZoneConfig {
  /** Minimum R:R ratio for entry. Default: 2.0 */
  minRR: number;
  /** Whether to require confirmation for entry (vs watchlist). Default: true */
  requireConfirmation: boolean;
  /**
   * Effective minimum stop in pips — max(MIN_SL_PIPS, ATR floor), the same
   * value bot-scanner applies. Supplied so the displayed plan can be the one
   * that would actually be placed. Omit and `executable` is null.
   */
  minSlPips?: number;
  /** Reward multiple used by execution (entry +/- risk * tpRatio). */
  tpRatio?: number;
  /**
   * Upper bound the Unified Zone SL Override enforces:
   * staticMinSlPips * impulseSlCapMultiplier. A zone stop wider than this is
   * REJECTED and execution falls back to its own structural stop, so the plan
   * shown must say so rather than quote a number that cannot be used.
   */
  maxSlPips?: number;
}

export const DEFAULT_UNIFIED_CONFIG: UnifiedZoneConfig = {
  minRR: 2.0,
  requireConfirmation: true,
};

// ─── Core Function ──────────────────────────────────────────────────

/**
 * findUnifiedZone — The single entry point for zone detection.
 *
 * Composes impulse zone engine + liquidity + confirmation into one story.
 * Entry direction is ALWAYS the impulse direction (continuation).
 *
 * @param h1Candles - 1H candles
 * @param h4Candles - 4H candles
 * @param entryCandles - Entry TF candles (15m) for LTF refinement
 * @param direction - Impulse direction (the direction we want to CONTINUE)
 * @param currentPrice - Current market price
 * @param liquidityPools - Pre-detected liquidity pools (from detectLiquidityPools on relevant TF)
 * @param htfData - Optional HTF confluence data
 * @param options - Optional zone engine options
 * @param dailyCandles - Optional Daily candles for top-down analysis
 * @param confirmationCandles - Candles for confirmation detection (typically one TF below zone TF)
 * @param ltfConfirmationCandles - Optional LTF candles for deeper confirmation
 * @param config - Optional unified engine config
 */
export function findUnifiedZone(
  h1Candles: Candle[],
  h4Candles: Candle[],
  entryCandles: Candle[],
  direction: "bullish" | "bearish",
  currentPrice: number,
  liquidityPools: LiquidityPool[],
  htfData?: HTFConfluenceData,
  options?: ZoneEngineOptions,
  dailyCandles?: Candle[],
  confirmationCandles?: Candle[],
  ltfConfirmationCandles?: Candle[],
  config?: Partial<UnifiedZoneConfig>,
  tfLabels?: TFSlotLabels,
): UnifiedZoneResult {
  const cfg = { ...DEFAULT_UNIFIED_CONFIG, ...config };
  const labels = tfLabels ?? DEFAULT_TF_LABELS;

  // ── Step 1: Find the best zone (waterfall: top → mid → low TF) ──
  const multiTFResult = findBestEntryZoneMultiTF(
    h1Candles, h4Candles, entryCandles, direction, currentPrice, htfData, options, dailyCandles, labels,
  );

  // No zone found
  if (!multiTFResult.bestZone) {
    return buildNoZoneResult(multiTFResult, direction, currentPrice);
  }

  const bestZone = multiTFResult.bestZone;
  const selectedTF = multiTFResult.selectedTF!;
  const impulse = bestZone.impulse;
  const zonePOI = bestZone.zone;

  // ── Step 2: Build impulse story ──
  const pipSize = options?.pipSize ?? 0.0001;
  const impulsePips = Math.abs(impulse.high - impulse.low) / pipSize;
  const impulseStory: ImpulseStory = {
    direction: impulse.direction,
    high: impulse.high,
    low: impulse.low,
    pips: Math.round(impulsePips * 10) / 10,
    timeframe: impulse.timeframe ?? selectedTF,
    startDate: impulse.startDate ?? null,
    endDate: impulse.endDate ?? null,
    spanBars: impulse.spanBars ?? 0,
    bosPrice: impulse.bosPrice,
  };

  // ── Step 3: Build zone story ──
  const zoneStory: ZoneStory = {
    type: zonePOI.poi.type === "ob" ? "OB" : "FVG",
    high: zonePOI.poi.high,
    low: zonePOI.poi.low,
    fibLevel: zonePOI.fibLevel,
    fibLabel: `${(zonePOI.fibLevel * 100).toFixed(1)}%`,
    srConfirmed: zonePOI.srConfirmed,
    htfLayers: zonePOI.htfLayers,
    ltfRefined: zonePOI.ltfRefined,
    totalScore: zonePOI.totalScore,
    zonesFound: multiTFResult.allZones.length,
  };

  // ── Step 4: Build price story ──
  const priceStory: PriceStory = {
    currentPrice,
    atZone: bestZone.priceAtZone,
    atZoneStrict: bestZone.priceAtZoneStrict,
    insideZone: bestZone.priceInsideZone,
    distancePips: bestZone.distancePips,
    sideOk: bestZone.sideOk,
  };

  // ── Step 5: Liquidity detection ──
  let liquidity: ZoneLiquidityResult | null = null;
  if (liquidityPools.length > 0) {
    liquidity = findZoneLiquidity(
      // Use the candles from the zone's timeframe for ATR context
      selectedTF === labels.top ? (dailyCandles ?? h4Candles) : selectedTF === labels.mid ? h4Candles : h1Candles,
      zonePOI.poi.high,
      zonePOI.poi.low,
      direction,
      liquidityPools,
    );
  }

  // ── Step 6: Confirmation detection ──
  let confirmation: ConfirmationResult | null = null;
  if (confirmationCandles && confirmationCandles.length >= 15) {
    const confInput: ConfirmationInput = {
      confirmationCandles,
      ltfCandles: ltfConfirmationCandles,
      zoneHigh: zonePOI.poi.high,
      zoneLow: zonePOI.poi.low,
      direction,
      sweepEvent: liquidity?.sweepEvent ?? null,
      inducement: liquidity?.inducement ?? null,
    };
    confirmation = evaluateConfirmation(confInput);
  }

  // ── Step 7: Calculate unified score ──
  const baseScore = zonePOI.totalScore; // Out of 9 (existing scoring)
  const liquidityBonus = liquidity?.liquidityScore ?? 0;
  const confirmationBonus = confirmation?.score ?? 0;
  // TF bonus based on slot position: top slot = 2.0, mid = 1.0, low = 0
  const tfBonus = selectedTF === labels.top ? 2.0 : selectedTF === labels.mid ? 1.0 : 0;
  const totalScore = baseScore + liquidityBonus + confirmationBonus + tfBonus;

  const scoreBreakdown: ScoreBreakdown = {
    baseScore,
    liquidityBonus,
    confirmationBonus,
    tfBonus,
    total: Math.round(totalScore * 10) / 10,
  };

  // ── Step 8: Determine state ──
  let state: UnifiedState;
  if (!bestZone.priceAtZone) {
    state = "watching";
  } else if (!confirmation || !confirmation.entryReady) {
    state = cfg.requireConfirmation ? "at_zone" : "confirmed";
  } else {
    state = bestZone.priceAtZoneStrict ? "triggered" : "confirmed";
  }

  // ── Step 9: Build entry story (only when confirmed) ──
  let entry: EntryStory | null = null;
  if (state === "confirmed" || state === "triggered") {
    entry = buildEntryStory(
      direction, zonePOI, impulse, currentPrice, 1 / pipSize, cfg.minRR,
      pipSize, cfg.minSlPips, cfg.tpRatio, cfg.maxSlPips,
    );
  }

  // ── Step 10: Build story summary ──
  const storySummary = buildStorySummary(
    impulseStory, zoneStory, priceStory, liquidity, confirmation, entry, selectedTF, state,
  );

  return {
    hasZone: true,
    selectedTF,
    impulse: impulseStory,
    zone: zoneStory,
    price: priceStory,
    liquidity,
    confirmation,
    entry,
    unifiedScore: scoreBreakdown.total,
    scoreBreakdown,
    storySummary,
    multiTFResult,
    state,
    reason: multiTFResult.reason,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function buildNoZoneResult(
  multiTFResult: MultiTFZoneResult,
  direction: "bullish" | "bearish",
  currentPrice: number,
): UnifiedZoneResult {
  return {
    hasZone: false,
    selectedTF: null,
    impulse: null,
    zone: null,
    price: { currentPrice, atZone: false, atZoneStrict: false, insideZone: false, distancePips: 0, sideOk: false },
    liquidity: null,
    confirmation: null,
    entry: null,
    unifiedScore: 0,
    scoreBreakdown: { baseScore: 0, liquidityBonus: 0, confirmationBonus: 0, tfBonus: 0, total: 0 },
    storySummary: `No valid ${direction} zone found on any timeframe.`,
    multiTFResult,
    state: "no_zone",
    reason: multiTFResult.reason,
  };
}

function buildEntryStory(
  direction: "bullish" | "bearish",
  zonePOI: RankedPOI,
  impulse: ImpulseLeg,
  currentPrice: number,
  pipMult: number,
  minRR: number,
  pipSize?: number,
  minSlPips?: number,
  tpRatio?: number,
  maxSlPips?: number,
): EntryStory | null {
  const entryDirection: "long" | "short" = direction === "bullish" ? "long" : "short";

  // Entry: edge of zone closest to current price (continuation entry)
  // For bearish continuation: price retraces UP to zone, entry at zone HIGH (sell limit)
  // For bullish continuation: price retraces DOWN to zone, entry at zone LOW (buy limit)
  let entryPrice: number;
  let slPrice: number;

  if (direction === "bearish") {
    // Sell at zone high, SL above zone
    entryPrice = zonePOI.poi.high;
    slPrice = zonePOI.poi.high + (zonePOI.poi.high - zonePOI.poi.low) * 0.5;
    // Cap SL at impulse origin (high of bearish impulse)
    if (slPrice > impulse.high) slPrice = impulse.high;
  } else {
    // Buy at zone low, SL below zone
    entryPrice = zonePOI.poi.low;
    slPrice = zonePOI.poi.low - (zonePOI.poi.high - zonePOI.poi.low) * 0.5;
    // Cap SL at impulse origin (low of bullish impulse)
    if (slPrice < impulse.low) slPrice = impulse.low;
  }

  const riskPips = Math.abs(entryPrice - slPrice) * pipMult;

  // TP: BOS level (the level where the impulse broke structure)
  // For bearish: target is the low of the impulse (BOS level)
  // For bullish: target is the high of the impulse (BOS level)
  const tpPrice = impulse.bosPrice;
  const rewardPips = tpPrice ? Math.abs(entryPrice - tpPrice) * pipMult : null;
  const rrRatio = (rewardPips && riskPips > 0) ? Math.round((rewardPips / riskPips) * 100) / 100 : null;

  // Check minimum R:R
  if (rrRatio !== null && rrRatio < minRR) {
    return null; // R:R too low
  }

  // ── What execution would actually place ──
  // bot-scanner floors the stop at effectiveMinSlPips and then recomputes the
  // target as entry +/- risk * tpRatio, overwriting whatever came before. Mirror
  // that here so the panel shows the plan that survives rather than the one the
  // zone geometry suggests.
  let executable: EntryStory["executable"] = null;
  let slDisposition: EntryStory["slDisposition"] = "unknown";
  if (typeof pipSize === "number" && pipSize > 0
      && typeof minSlPips === "number" && minSlPips > 0
      && typeof tpRatio === "number" && tpRatio > 0) {
    const rawRiskPrice = Math.abs(entryPrice - slPrice);
    const rawRiskPips = rawRiskPrice / pipSize;
    const floorPrice = minSlPips * pipSize;

    // Mirror the Unified Zone SL Override guard in bot-scanner:
    //   if (unifiedSlPips >= effectiveMinSlPips && unifiedSlPips <= maxUnifiedSlPips)
    // Outside that band the zone stop is discarded and execution uses its own
    // structural stop, which this engine has no visibility of — so there is no
    // honest executable plan to show.
    if (typeof maxSlPips === "number" && maxSlPips > 0 && rawRiskPips > maxSlPips) {
      slDisposition = "rejected_too_wide";
      return {
        direction: entryDirection,
        entryPrice,
        slPrice,
        tpPrice,
        riskPips: Math.round(riskPips * 10) / 10,
        rewardPips: rewardPips ? Math.round(rewardPips * 10) / 10 : null,
        rrRatio,
        executable: null,
        slDisposition,
        fillsAtMarket: true,
      };
    }

    const execRiskPrice = Math.max(rawRiskPrice, floorPrice);
    slDisposition = execRiskPrice > rawRiskPrice ? "widened_to_floor" : "accepted";
    const execSL = entryDirection === "long"
      ? entryPrice - execRiskPrice
      : entryPrice + execRiskPrice;
    const execTP = entryDirection === "long"
      ? entryPrice + execRiskPrice * tpRatio
      : entryPrice - execRiskPrice * tpRatio;
    executable = {
      slPrice: execSL,
      tpPrice: execTP,
      riskPips: Math.round(execRiskPrice * pipMult * 10) / 10,
      rewardPips: Math.round(execRiskPrice * tpRatio * pipMult * 10) / 10,
      rrRatio: Math.round(tpRatio * 100) / 100,
      slWidenedToFloor: execRiskPrice > rawRiskPrice,
    };
  }

  return {
    direction: entryDirection,
    entryPrice,
    slPrice,
    tpPrice,
    riskPips: Math.round(riskPips * 10) / 10,
    rewardPips: rewardPips ? Math.round(rewardPips * 10) / 10 : null,
    rrRatio,
    executable,
    slDisposition,
    fillsAtMarket: true,
  };
}

function buildStorySummary(
  impulse: ImpulseStory,
  zone: ZoneStory,
  price: PriceStory,
  liquidity: ZoneLiquidityResult | null,
  confirmation: ConfirmationResult | null,
  entry: EntryStory | null,
  selectedTF: string,
  state: UnifiedState,
): string {
  const lines: string[] = [];
  const dir = impulse.direction === "bearish" ? "↓ BEARISH" : "↑ BULLISH";
  const filled = "●";
  const empty = "○";

  // Line 1: Impulse
  lines.push(`${filled} ${selectedTF} Impulse: ${dir} ${impulse.low.toFixed(5)} → ${impulse.high.toFixed(5)} (${impulse.pips} pips)`);
  if (impulse.startDate && impulse.endDate) {
    lines.push(`    BOS: ${impulse.bosPrice.toFixed(5)}  ${impulse.startDate} → ${impulse.endDate} (${impulse.spanBars} bars)`);
  }

  // Line 2: Zone
  const srTag = zone.srConfirmed ? "S/R ✓" : "S/R ✗";
  lines.push(`${filled} Zone: ${zone.type} @ Fib ${zone.fibLabel} (${srTag}) [${zone.low.toFixed(5)}–${zone.high.toFixed(5)}]`);

  // Line 3: Price
  if (price.atZone || price.insideZone) {
    lines.push(`${filled} Price: ${price.insideZone ? "Inside zone" : "At zone"}`);
  } else {
    lines.push(`${empty} Price: ${price.distancePips.toFixed(1)} pips away`);
  }

  // Line 4: Liquidity
  if (liquidity && liquidity.liquidityScore > 0) {
    lines.push(`${filled} Liquidity: ${liquidity.summary}`);
  } else {
    lines.push(`${empty} Liquidity: No significant pools near zone`);
  }

  // Line 5: Confirmation
  if (confirmation && confirmation.entryReady) {
    lines.push(`${filled} Confirmation: ${confirmation.detail}`);
  } else if (confirmation && confirmation.score > 0) {
    lines.push(`◐ Confirmation: ${confirmation.detail} (partial)`);
  } else {
    lines.push(`${empty} Confirmation: Waiting for CHoCH/displacement in ${impulse.direction} direction`);
  }

  // Line 6: Entry
  if (entry) {
    lines.push(`${filled} Entry: ${entry.direction.toUpperCase()} @ ${entry.entryPrice.toFixed(5)}  SL: ${entry.slPrice.toFixed(5)}  R:R ${entry.rrRatio}:1`);
  } else if (state === "confirmed" || state === "triggered") {
    lines.push(`${empty} Entry: R:R below minimum (${DEFAULT_UNIFIED_CONFIG.minRR}:1)`);
  } else {
    lines.push(`${empty} Entry: Not yet`);
  }

  return lines.join("\n");
}
