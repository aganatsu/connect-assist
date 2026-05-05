/**
 * _shared/confluenceScoring.ts — Shared Confluence Scoring Engine
 * ──────────────────────────────────────────────────────────────────────
 * Single source of truth for the 22-factor, tiered confluence scoring
 * engine used by both bot-scanner (live) and backtest-engine (historical).
 *
 * The `atMs` parameter controls time-dependent detectors:
 *   - undefined → wall-clock (live scanner)
 *   - number   → candle timestamp (backtest)
 *
 * This is a PURE function: no DB calls, no fetches, no side effects.
 * All external data (FOTSI, SMT, candles) must be injected via config.
 */

import {
  classifyInstrumentRegime,
  type Candle, type SwingPoint, type OrderBlock,
  type LiquidityPool, type BreakerBlock, type UnicornSetup,
  type SMTResult, type AMDResult, type SilverBulletResult, type MacroWindowResult,
  type ReasoningFactor, type GateResult,
  SPECS, SUPPORTED_SYMBOLS, SMT_PAIRS, ASSET_PROFILES, getAssetProfile,
  calculateATR, calculateAnchoredVWAP,
  detectSwingPoints, analyzeMarketStructure,
  detectOrderBlocks, detectFVGs, detectLiquidityPools,
  detectDisplacement, tagDisplacementQuality,
  detectBreakerBlocks, detectUnicornSetups,
  detectJudasSwing, detectReversalCandle,
  calculatePDLevels,
  computeOpeningRange, calculateSLTP,
  computeConfluenceStacking, detectSweepReclaim, measurePullbackDecay,
  type ConfluenceStack, type SweepReclaim, type PullbackDecay,
  type FairValueGap,
  detectZigZagPivots, computeFibLevels,
  type ZigZagPivot, type FibLevel, type FibLevels,
  detectOptimalStyle,
  calculatePremiumDiscount,
  detectSilverBullet,
  detectMacroWindow,
  detectAMDPhase,
} from "./smcAnalysis.ts";

import {
  detectSession,
  type SessionResult,
} from "./sessions.ts";

import {
  type FOTSIResult,
  type Currency,
  getCurrencyAlignment,
  parsePairCurrencies,
} from "./fotsi.ts";

// ─── Default Factor Weights ─────────────────────────────────────────────────
export const DEFAULT_FACTOR_WEIGHTS: Record<string, number> = {
  marketStructure: 2.5,
  orderBlock: 2.0,
  fairValueGap: 2.0,
  premiumDiscountFib: 2.0,
  sessionQuality: 1.5,
  judasSwing: 0.75,
  pdPwLevels: 1.0,
  reversalCandle: 1.5,
  liquiditySweep: 1.5,
  displacement: 1.0,
  breakerBlock: 1.0,
  unicornModel: 1.5,
  smtDivergence: 1.0,
  volumeProfile: 0.75,
  amdPhase: 1.0,
  currencyStrength: 1.5,
  dailyBias: 1.0,
};

// ─── Volume Profile (Time-at-Price / TPO) ────────────────────────────
interface VolumeProfileResult {
  poc: number;
  vah: number;
  val: number;
  nodes: Array<{ price: number; count: number; type: "HVN" | "LVN" | "normal" }>;
  totalBins: number;
}

function computeVolumeProfile(candles: Candle[], numBins = 50): VolumeProfileResult | null {
  if (candles.length < 20) return null;
  let overallHigh = -Infinity, overallLow = Infinity;
  for (const c of candles) {
    if (c.high > overallHigh) overallHigh = c.high;
    if (c.low < overallLow) overallLow = c.low;
  }
  const range = overallHigh - overallLow;
  if (range <= 0) return null;
  const binSize = range / numBins;
  const bins: number[] = new Array(numBins).fill(0);
  for (const c of candles) {
    const lowBin = Math.max(0, Math.floor((c.low - overallLow) / binSize));
    const highBin = Math.min(numBins - 1, Math.floor((c.high - overallLow) / binSize));
    for (let b = lowBin; b <= highBin; b++) {
      bins[b]++;
    }
  }
  let pocBin = 0, maxCount = 0;
  for (let i = 0; i < numBins; i++) {
    if (bins[i] > maxCount) { maxCount = bins[i]; pocBin = i; }
  }
  const poc = overallLow + (pocBin + 0.5) * binSize;
  const totalCount = bins.reduce((a, b) => a + b, 0);
  const targetCount = totalCount * 0.70;
  let vaLowBin = pocBin, vaHighBin = pocBin;
  let vaCount = bins[pocBin];
  while (vaCount < targetCount && (vaLowBin > 0 || vaHighBin < numBins - 1)) {
    const expandLow = vaLowBin > 0 ? bins[vaLowBin - 1] : -1;
    const expandHigh = vaHighBin < numBins - 1 ? bins[vaHighBin + 1] : -1;
    if (expandLow >= expandHigh && expandLow >= 0) { vaLowBin--; vaCount += bins[vaLowBin]; }
    else if (expandHigh >= 0) { vaHighBin++; vaCount += bins[vaHighBin]; }
    else break;
  }
  const val = overallLow + vaLowBin * binSize;
  const vah = overallLow + (vaHighBin + 1) * binSize;
  const avgCount = totalCount / numBins;
  const nodes = bins.map((count, i) => ({
    price: overallLow + (i + 0.5) * binSize,
    count,
    type: count > avgCount * 1.5 ? "HVN" as const
         : count < avgCount * 0.5 ? "LVN" as const
         : "normal" as const,
  }));
  return { poc, vah, val, nodes, totalBins: numBins };
}

// ─── Helper: Weight Scaling ──────────────────────────────────────────
export function resolveWeightScale(factorKey: string, config: any): number {
  const fw = config.factorWeights;
  if (!fw || fw[factorKey] === undefined || fw[factorKey] === null) return 1.0;
  const defaultW = DEFAULT_FACTOR_WEIGHTS[factorKey];
  if (!defaultW || defaultW === 0) return 1.0;
  return Math.max(0, fw[factorKey]) / defaultW;
}

export function applyWeightScale(pts: number, factorKey: string, displayWeight: number, config: any): { pts: number; displayWeight: number } {
  const scale = resolveWeightScale(factorKey, config);
  if (scale === 1.0) return { pts, displayWeight };
  return {
    pts: Math.round(pts * scale * 1000) / 1000,
    displayWeight: Math.round(displayWeight * scale * 1000) / 1000,
  };
}

// ─── Helper: Regime Classification (thin wrapper) ────────────────────
function classifyInstrumentRegimeLocal(dailyCandles: Candle[]): {
  regime: string; confidence: number; atrTrend: string; bias: string; indicators: string[];
  transition?: { state: string; confidence: number; momentum: number; priorScore: number; currentScore: number; detail: string };
} {
  const result = classifyInstrumentRegime(dailyCandles);
  return {
    regime: result.regime,
    confidence: result.confidence,
    atrTrend: result.atrTrend,
    bias: result.directionalBias,
    indicators: result.indicators || [],
    transition: result.transition ? {
      state: result.transition.state,
      confidence: result.transition.confidence,
      momentum: result.transition.momentum,
      priorScore: result.transition.priorScore,
      currentScore: result.transition.currentScore,
      detail: result.transition.detail,
    } : undefined,
  };
}

// ─── Helper: Regime Alignment Adjustment ─────────────────────────────
function regimeAlignmentAdjustment(
  regime: string,
  confidence: number,
  direction: string | null,
  factors: Array<{ name: string; present: boolean; weight: number; detail: string; group?: string }>,
  regimeBias?: string | null,
): { adjustment: number; detail: string } {
  if (!direction || confidence < 0.5) {
    return { adjustment: 0, detail: "Regime unknown or low confidence — no adjustment" };
  }
  const scaleFactor = Math.min(1.0, confidence);
  const directionAligned = regimeBias
    ? (direction === "long" && regimeBias === "bullish")
      || (direction === "short" && regimeBias === "bearish")
    : null;
  if (regime === "strong_trend" || regime === "mild_trend") {
    if (directionAligned === true) {
      const bonus = regime === "strong_trend" ? 0.5 : 0.25;
      return {
        adjustment: +(bonus * scaleFactor).toFixed(2),
        detail: `${direction} entry aligns with ${regime.replace("_", " ")} (${regimeBias}) → +${(bonus * scaleFactor).toFixed(1)} bonus (conf: ${(confidence * 100).toFixed(0)}%)`,
      };
    } else if (directionAligned === false) {
      const penalty = regime === "strong_trend" ? -1.5 : -0.75;
      return {
        adjustment: +(penalty * scaleFactor).toFixed(2),
        detail: `${direction} entry opposes ${regime.replace("_", " ")} (${regimeBias}) → ${(penalty * scaleFactor).toFixed(1)} penalty (conf: ${(confidence * 100).toFixed(0)}%)`,
      };
    }
    return { adjustment: 0, detail: `Trending regime but no bias info — no adjustment` };
  }
  if (regime === "choppy_range" || regime === "mild_range") {
    const penalty = regime === "choppy_range" ? -0.75 : -0.25;
    return {
      adjustment: +(penalty * scaleFactor).toFixed(2),
      detail: `Entry in ${regime.replace("_", " ")} market → ${(penalty * scaleFactor).toFixed(1)} penalty (no clear directional edge, conf: ${(confidence * 100).toFixed(0)}%)`,
    };
  }
  return { adjustment: 0, detail: `Transitional regime — no adjustment` };
}

export function runConfluenceAnalysis(candles: Candle[], dailyCandles: Candle[] | null, config: any, hourlyCandles?: Candle[], atMs?: number) {
  // P1: structure lookback — limit candles fed into structure analysis (config-driven, default 50)
  const structureLookback = (typeof config.structureLookback === "number" && config.structureLookback > 0)
    ? config.structureLookback
    : 50;
  const structureCandles = candles.length > structureLookback ? candles.slice(-structureLookback) : candles;
  const structure = analyzeMarketStructure(structureCandles);
  const structureBreaks = [...structure.bos, ...structure.choch];
  // P1: OB lookback — pass config-driven recency window
  let orderBlocks = detectOrderBlocks(candles, structureBreaks, config.obLookbackCandles);
  const fvgs = detectFVGs(candles, structureBreaks);

  // FVG adjacency bonus: tag OBs that have an FVG within 5 candles
  // This doesn't filter them out, but boosts quality for Factor 2 detail
  for (const ob of orderBlocks) {
    const hasFVGNearby = fvgs.some(f => Math.abs(f.index - ob.index) <= 5);
    (ob as any).hasFVGAdjacency = hasFVGNearby;
  }
  // P1: liquidity pool min touches — pass config-driven threshold
  const liquidityPools = detectLiquidityPools(candles, 0.001, config.liquidityPoolMinTouches);
  const judasSwing = detectJudasSwing(candles);
  const reversalCandle = detectReversalCandle(candles);
  const pd = calculatePremiumDiscount(candles);
  const session = detectSession(atMs);
  const pdLevels = dailyCandles ? calculatePDLevels(dailyCandles) : null;

  // ── ZigZag-based Fibonacci anchoring ──
  // Uses deviation-based pivot detection (TradingView-style) for clean Fib levels.
  // Falls back to the old 5-swing envelope if ZigZag doesn't find 2 pivots.
  const zigzagResult = detectZigZagPivots(candles, config.fibDevMultiplier || 3, config.fibDepth || 10);
  let fibLevels: FibLevels | null = null;
  if (zigzagResult.lastTwo) {
    fibLevels = computeFibLevels(zigzagResult.lastTwo[0], zigzagResult.lastTwo[1]);
  }
  // Fallback: if ZigZag didn't produce 2 pivots, build from detectSwingPoints envelope
  if (!fibLevels) {
    const fallbackSwings = detectSwingPoints(candles);
    const fbHighs = fallbackSwings.filter(s => s.type === "high").slice(-5);
    const fbLows = fallbackSwings.filter(s => s.type === "low").slice(-5);
    if (fbHighs.length > 0 && fbLows.length > 0) {
      const fbHigh = fbHighs.reduce((best, s) => s.price > best.price ? s : best);
      const fbLow = fbLows.reduce((best, s) => s.price < best.price ? s : best);
      fibLevels = computeFibLevels(
        { index: fbLow.index, price: fbLow.price, type: "low", datetime: fbLow.datetime },
        { index: fbHigh.index, price: fbHigh.price, type: "high", datetime: fbHigh.datetime },
      );
    }
  }

  // ── Early regime classification (needed by Factor 4 for 0.236 scoring) ──
  // Computed here so Factor 4 can use regime-aware Fib scoring.
  // The full regime gate logic still runs later in its original position.
  const h4CandlesEarly: Candle[] | null = (config as any)._h4Candles || null;
  let regimeInfo: { regime: string; confidence: number; atrTrend: string; bias: string; indicators: string[];
    transition?: { state: string; confidence: number; momentum: number; priorScore: number; currentScore: number; detail: string };
  } | null = null;
  let regime4HInfo: { regime: string; confidence: number; atrTrend: string; bias: string; indicators: string[];
    transition?: { state: string; confidence: number; momentum: number; priorScore: number; currentScore: number; detail: string };
  } | null = null;
  const regimeScoringEnabled = config.regimeScoringEnabled !== false;
  if (regimeScoringEnabled && dailyCandles && dailyCandles.length >= 20) {
    regimeInfo = classifyInstrumentRegimeLocal(dailyCandles);
    if (h4CandlesEarly && h4CandlesEarly.length >= 20) {
      regime4HInfo = classifyInstrumentRegimeLocal(h4CandlesEarly);
    }
  }

  const lastPrice = candles[candles.length - 1].close;
  let score = 0;
  const factors: ReasoningFactor[] = [];

  // ── Factor 1: Market Structure (merged BOS/CHoCH + Trend Direction) (max 2.5) ──
  // Now integrates: internal vs external BOS significance, derived S/R, and structure-to-fractal rate.
  {
    let pts = 0;
    let detail = "";
    if (config.enableStructureBreak !== false) {
      // Count close-based (strong) vs wick-only breaks
      const closeBasedChoch = structure.choch.filter((c: any) => c.closeBased);
      const closeBasedBos = structure.bos.filter((b: any) => b.closeBased);
      const sweepCount = structure.sweeps?.length || 0;

      // Internal vs External BOS counts (new)
      const sCounts = structure.structureCounts || { internalBOS: 0, externalBOS: 0, internalCHoCH: 0, externalCHoCH: 0 };
      const hasExternalCHoCH = sCounts.externalCHoCH > 0;
      const hasExternalBOS = sCounts.externalBOS > 0;

      // Base structure score (0-1.5) — now weighted by significance
      let structurePts = 0;
      if (closeBasedChoch.length > 0) {
        structurePts = hasExternalCHoCH ? 1.5 : 1.2;  // external CHoCH = full, internal = slightly less
        detail = `${closeBasedChoch.length} CHoCH (close-based${hasExternalCHoCH ? ", EXTERNAL — major reversal" : ", internal"}) — strong trend reversal`;
      } else if (structure.choch.length > 0) {
        structurePts = 1.0;
        detail = `${structure.choch.length} CHoCH (wick-based, no close confirmation) — possible reversal`;
      } else if (closeBasedBos.length > 0) {
        structurePts = hasExternalBOS ? 1.2 : 0.9;  // external BOS = stronger continuation
        detail = `${closeBasedBos.length} BOS (close-based${hasExternalBOS ? ", EXTERNAL — major continuation" : ", internal"}) — trend continuation confirmed`;
      } else if (structure.bos.length > 0) {
        structurePts = 0.5;
        detail = `${structure.bos.length} BOS (wick-based only) — weak continuation`;
      } else {
        detail = "No BOS or CHoCH detected";
      }

      // Structure-to-Fractal conversion rate bonus (new)
      // High rate = swings keep breaking = strong trend. Low rate = swings hold = range.
      const s2f = structure.structureToFractal;
      if (s2f && s2f.totalFractals >= 4) {
        if (s2f.overallRate > 0.6) {
          structurePts += 0.15;
          detail += ` | S2F rate ${(s2f.overallRate * 100).toFixed(0)}% — high conversion, strong trend`;
        } else if (s2f.overallRate < 0.2) {
          structurePts -= 0.1;
          detail += ` | S2F rate ${(s2f.overallRate * 100).toFixed(0)}% — low conversion, swings holding`;
        }
      }

      // Derived S/R proximity bonus (new)
      // If price is near an active (unbroken) BOS-derived S/R level, that's a high-quality reaction zone
      const derivedSR = structure.derivedSR;
      if (derivedSR && derivedSR.active.length > 0 && typeof lastPrice === "number") {
        const atr = calculateATR(candles);
        const nearActiveSR = derivedSR.active.find((sr: any) => Math.abs(lastPrice - sr.price) < atr * 0.5);
        if (nearActiveSR) {
          structurePts += 0.2;
          detail += ` | Near active BOS-derived ${nearActiveSR.type} at ${nearActiveSR.price.toFixed(5)}`;
        }
      }

      if (sweepCount > 0) {
        detail += ` | ${sweepCount} liquidity sweep${sweepCount > 1 ? "s" : ""} detected`;
      }

      // Internal/External summary
      if (sCounts.externalBOS > 0 || sCounts.externalCHoCH > 0) {
        detail += ` | Structure: ${sCounts.externalBOS} ext BOS, ${sCounts.externalCHoCH} ext CHoCH, ${sCounts.internalBOS} int BOS, ${sCounts.internalCHoCH} int CHoCH`;
      }

      pts = structurePts;

      // Trend alignment bonus/penalty (adds up to +1.0 or -0.5)
      if (structure.trend !== "ranging" && structurePts > 0) {
        pts += 1.0;
        detail += ` | Entry TF trend ${structure.trend} — aligned`;
      } else if (structure.trend === "ranging" && structurePts > 0) {
        pts += 0.25;
        detail += " | Ranging market — partial trend credit";
      }
      // Cap at 2.5
      pts = Math.min(2.5, pts);
    } else {
      detail = "BOS/CHoCH disabled";
    }
    { const s = applyWeightScale(pts, "marketStructure", 2.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Market Structure", present: pts > 0, weight: s.displayWeight, detail, group: "Market Structure" }); }
  }

  // Displacement detection (used by OB/FVG bonus + new factor below)
  const displacement = detectDisplacement(candles);
  tagDisplacementQuality(orderBlocks, fvgs, displacement.displacementCandles);

  // Breaker Blocks + Unicorn Setups (computed early, scored after direction)
  const breakerBlocks = config.useBreakerBlocks !== false ? detectBreakerBlocks(orderBlocks, candles, structureBreaks) : [];
  const unicornSetups = config.useUnicornModel !== false ? detectUnicornSetups(breakerBlocks, fvgs) : [];

  // ── Factor 2: Order Block (max 2.0) ──
  // OBs are quality-gated: displacement required for full score, FVG adjacency bonus.
  // Without displacement, OB scores at most 0.75 (reduced from 2.0).
  // FIX #8: mitigatedPercent now scales the score — fresh OBs score higher than exhausted ones.
  // FIX #9: hasFVGAdjacency now provides a concrete score boost, not just a display tag.
  {
    let pts = 0;
    let detail = "";
    if (config.enableOB !== false) {
      // Lifecycle-aware filtering: exclude broken OBs entirely
      const activeOBs = orderBlocks.filter(ob => ob.state !== "broken" && !ob.mitigated);
      const insideOB = activeOBs.find(ob => lastPrice >= ob.low && lastPrice <= ob.high);
      if (insideOB) {
        const tags: string[] = [];
        if (insideOB.hasDisplacement) {
          pts = 2.0;
          tags.push("displacement \u2713");
        } else {
          pts = 0.75;
          tags.push("no displacement \u2014 reduced score");
        }

        // Lifecycle state scoring
        const obState = insideOB.state || "fresh";
        const mitPct = insideOB.mitigatedPercent || 0;
        const testCount = insideOB.testedCount || 0;

        if (obState === "fresh" && mitPct <= 20) {
          tags.push(`fresh (${mitPct.toFixed(0)}% mitigated)`);
        } else if (obState === "tested" && mitPct <= 50) {
          // Tested-and-held OBs are STRONGER: price tested the zone edge but it held
          // Bonus scales with test count: +0.15 per test, max +0.45 (3 tests)
          const testBonus = Math.min(0.45, testCount * 0.15);
          pts += testBonus;
          tags.push(`tested ${testCount}x & held (+${testBonus.toFixed(2)}, ${mitPct.toFixed(0)}% mitigated)`);
        } else if (obState === "mitigated" || mitPct > 50) {
          // Mitigated OBs: scale down based on how deeply penetrated
          if (mitPct <= 60) {
            pts *= 0.7;
            tags.push(`mitigated (${mitPct.toFixed(0)}%, score \u00d70.7)`);
          } else if (mitPct <= 90) {
            pts *= 0.4;
            tags.push(`deeply mitigated (${mitPct.toFixed(0)}%, score \u00d70.4)`);
          } else {
            pts *= 0.15;
            tags.push(`nearly broken (${mitPct.toFixed(0)}%, score \u00d70.15)`);
          }
        }

        // FVG adjacency bonus
        if (insideOB.hasFVGAdjacency) {
          pts = Math.min(2.5, pts + 0.25);
          tags.push("FVG adjacent (+0.25)");
        }
        if (insideOB.hasVolumePivot) tags.push("volume pivot \u2713");
        detail = `Price inside ${insideOB.type} OB at ${insideOB.low.toFixed(5)}-${insideOB.high.toFixed(5)} [${tags.join(", ")}]`;
      } else if (activeOBs.length > 0) {
        const withDisp = activeOBs.filter(ob => ob.hasDisplacement).length;
        const withVol = activeOBs.filter(ob => ob.hasVolumePivot).length;
        const freshOBs = activeOBs.filter(ob => ob.state === "fresh").length;
        const testedOBs = activeOBs.filter(ob => ob.state === "tested").length;
        const brokenCount = orderBlocks.filter(ob => ob.state === "broken").length;
        pts = 0;
        detail = `${activeOBs.length} OBs nearby (${freshOBs} fresh, ${testedOBs} tested, ${withDisp} displaced${withVol > 0 ? `, ${withVol} vol pivot` : ""}${brokenCount > 0 ? `, ${brokenCount} broken/excluded` : ""}) \u2014 not at level`;
      }
    } else {
      detail = "Order Blocks disabled";
    }
    { const s = applyWeightScale(pts, "orderBlock", 2.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Order Block", present: pts > 0, weight: s.displayWeight, detail: detail || "No active order blocks", group: "Order Flow Zones" }); }
  }

  // ── Direction Determination (moved before Factors 3-4 so they can use actual direction) ──
  // Depends only on structure.trend and pd.currentZone, both computed before scoring.
  let direction: "long" | "short" | null = null;
  const hasRecentBOS = structure.bos.length > 0;
  const hasRecentCHoCH = structure.choch.length > 0;
  const strongTrend = hasRecentBOS && !hasRecentCHoCH; // BOS without CHoCH = strong continuation

  if (structure.trend === "bullish") {
    if (pd.currentZone !== "premium") {
      direction = "long"; // Normal: bullish trend + discount/equilibrium
    } else if (strongTrend) {
      direction = "long"; // Strong trend override: allow premium longs in strong uptrend
    }
  } else if (structure.trend === "bearish") {
    if (pd.currentZone !== "discount") {
      direction = "short"; // Normal: bearish trend + premium/equilibrium
    } else if (strongTrend) {
      direction = "short"; // Strong trend override: allow discount shorts in strong downtrend
    }
  } else if (structure.trend === "ranging") {
    if (pd.currentZone === "discount") direction = "long";
    else if (pd.currentZone === "premium") direction = "short";
  }

  // ── Factor 3: Fair Value Gap (max 2.0) ──
  // Displacement is scored ONLY via Factor 10 to avoid double-counting.
  // ICT: Consequent Encroachment (CE) = 50% of FVG is a key entry level.
  {
    let pts = 0;
    let detail = "";
    let _matchedFvgHasDisplacement = false; // Fix C: track across scope boundary
    if (config.enableFVG !== false) {
      // P1: pip-size lookup for FVG min-size filter (default 0.0001 if symbol unknown)
      const _sym = (config as any)._currentSymbol as string | undefined;
      const _spec = _sym ? SPECS[_sym] : undefined;
      const _pipSize = _spec?.pipSize ?? 0.0001;
      const _minPips = typeof config.fvgMinSizePips === "number" ? config.fvgMinSizePips : 0;
      const _onlyUnfilled = config.fvgOnlyUnfilled !== false;

      // P1: filter FVGs by config — lifecycle-aware: exclude filled FVGs entirely
      const activeFVGs = fvgs.filter(f => {
        if (f.state === "filled") return false; // Lifecycle: fully filled = dead
        if (_onlyUnfilled && f.mitigated) return false;
        if (_minPips > 0) {
          const sizePips = (f.high - f.low) / _pipSize;
          if (sizePips < _minPips) return false;
        }
        return true;
      });
      // Directional context: ONLY use FVGs aligned with trade direction.
      // Bullish FVG (gap up) = support for longs; Bearish FVG (gap down) = resistance for shorts.
      // Fix A: Counter-directional FVGs are NOT valid entry zones — a bearish FVG is sell-side
      // imbalance, entering long there is fighting institutional flow.
      const trendHint = direction === "long" ? "bullish" : direction === "short" ? "bearish" : null;
      const alignedFVGs = trendHint ? activeFVGs.filter(f => f.type === trendHint) : activeFVGs;
      // Fix A: No fallback to counter-directional FVGs — only aligned FVGs qualify
      const fvgPool = alignedFVGs;
      const insideFVG = fvgPool.find(f => lastPrice >= f.low && lastPrice <= f.high);
      if (insideFVG) {
        const ce = (insideFVG.high + insideFVG.low) / 2; // Consequent Encroachment
        const fvgRange = insideFVG.high - insideFVG.low;
        const distFromCE = Math.abs(lastPrice - ce);
        const nearCE = fvgRange > 0 && (distFromCE / fvgRange) <= 0.15; // within 15% of CE
        const isAligned = trendHint ? insideFVG.type === trendHint : true;
        // Fix A: Since fvgPool is now aligned-only, isAligned is always true when we reach here.
        // Keeping the variable for clarity but counter-directional path is dead code.
        if (nearCE) {
          pts = 2.0;
          detail = `Price at CE (${ce.toFixed(5)}) of ${insideFVG.type} FVG ${insideFVG.low.toFixed(5)}-${insideFVG.high.toFixed(5)} — optimal entry`;
        } else {
          pts = 1.5;
          detail = `Price inside ${insideFVG.type} FVG at ${insideFVG.low.toFixed(5)}-${insideFVG.high.toFixed(5)} (CE: ${ce.toFixed(5)})`;
        }
        // Quality scaling: scale base pts by FVG quality (0-8, max 8)
        const fvgQuality = insideFVG.quality ?? 4; // default 4 (mid-range) for backward compat
        const MAX_FVG_QUALITY = 8;
        const qualityMultiplier = 0.4 + 0.6 * (fvgQuality / MAX_FVG_QUALITY); // range: 0.4 – 1.0
        pts *= qualityMultiplier;
        detail += ` [Q:${fvgQuality.toFixed(1)}/${MAX_FVG_QUALITY}]`;

        // ── Lifecycle state scoring ──
        const fvgState = insideFVG.state || "open";
        const fillPct = insideFVG.fillPercent || 0;
        const respectCount = insideFVG.respectedCount || 0;

        if (fvgState === "open" && fillPct === 0) {
          detail += " [pristine gap]";
        } else if (fvgState === "respected") {
          // Respected FVGs get a bonus — they've proven themselves as S/R
          const respectBonus = Math.min(0.4, respectCount * 0.2);
          pts += respectBonus;
          detail += ` [respected ${respectCount}x, +${respectBonus.toFixed(2)}]`;
        } else if (fvgState === "partially_filled") {
          // Partially filled: scale down based on how much is filled
          // Fix B: FVGs filled >75% are dead zones — set pts to 0 (present: false)
          if (fillPct <= 30) {
            detail += ` [${fillPct.toFixed(0)}% filled — still viable]`;
          } else if (fillPct <= 60) {
            pts *= 0.75;
            detail += ` [${fillPct.toFixed(0)}% filled, score \u00d70.75]`;
          } else if (fillPct <= 75) {
            pts *= 0.45;
            detail += ` [${fillPct.toFixed(0)}% filled, score \u00d70.45]`;
          } else {
            pts = 0;
            detail += ` [${fillPct.toFixed(0)}% filled — dead zone, disqualified]`;
          }
        }

        // Recency bonus: FVGs closer to current price action are more relevant
        const recencyIdx = insideFVG.index || 0;
        const isRecent = recencyIdx >= candles.length - 15;
        if (!isRecent && pts > 0.5) {
          pts *= 0.75; // Decay older FVGs
          detail += " [older FVG, reduced]";
        }
        if ((insideFVG as any).hasDisplacement) {
          detail += " [displacement-created, scored via Factor 10]";
          _matchedFvgHasDisplacement = true; // Fix C: propagate to tier logic
        }
      } else if (activeFVGs.length > 0) {
        // FVGs exist but price not inside any — no score (ICT: entry requires price AT the level)
        const openFVGs = activeFVGs.filter(f => f.state === "open").length;
        const respectedFVGs = activeFVGs.filter(f => f.state === "respected").length;
        const partialFVGs = activeFVGs.filter(f => f.state === "partially_filled").length;
        const filledCount = fvgs.filter(f => f.state === "filled").length;
        pts = 0;
        detail = `${activeFVGs.length} qualifying FVGs (${openFVGs} open, ${respectedFVGs} respected, ${partialFVGs} partial${filledCount > 0 ? `, ${filledCount} filled/excluded` : ""}${_minPips > 0 ? `, \u2265${_minPips} pips` : ""}) \u2014 not at level`;
      }
    } else {
      detail = "FVGs disabled";
    }
    { const s = applyWeightScale(pts, "fairValueGap", 2.0, config); pts = s.pts; score += pts;
    const fvgFactor: any = { name: "Fair Value Gap", present: pts > 0, weight: s.displayWeight, detail: detail || "No active FVGs", group: "Order Flow Zones" };
    // Fix C: stash displacement status for tier demotion logic downstream
    fvgFactor._hasDisplacement = _matchedFvgHasDisplacement;
    factors.push(fvgFactor); }
  }

  // ── Factor 4: Premium/Discount & Fibonacci (max 2.5, group-capped) ──
  // Merged: P/D zone + Fibonacci retracement levels + PD/PW levels.
  // Now uses ZigZag-based 2-pivot Fib anchoring (with fallback to old envelope).
  // Added 0.236 level: in strong trends, shallow pullbacks are high-probability continuation entries.
  // FIX: Handles swing-direction vs trade-direction alignment properly.
  //   - ALIGNED (swing up + long, swing down + short): standard retracement scoring
  //   - COUNTER (swing up + short, swing down + long): inverted scoring (low retrace = good entry)
  {
    let pts = 0;
    let detail = "";

    // Compute retracement % using ZigZag-based Fib levels if available
    let retrace = 0;
    let fibSource = "legacy";
    // Track whether swing direction aligns with trade direction
    // aligned = trading WITH the swing (continuation), counter = trading AGAINST it (reversal)
    let swingTradeAlignment: "aligned" | "counter" | "unknown" = "unknown";

    if (fibLevels) {
      const range = fibLevels.swingHigh - fibLevels.swingLow;
      if (range > 0) {
        // Retracement measured from the END of the swing
        if (fibLevels.direction === "up") {
          // Swing went up (low→high), retracement = how far price pulled back from high
          retrace = ((fibLevels.swingHigh - lastPrice) / range) * 100;
        } else {
          // Swing went down (high→low), retracement = how far price bounced from low
          retrace = ((lastPrice - fibLevels.swingLow) / range) * 100;
        }
        fibSource = "zigzag";

        // Determine alignment: swing up + long = aligned (buying the pullback in an upswing)
        //                      swing down + short = aligned (selling the bounce in a downswing)
        //                      swing up + short = counter (shorting near the top of an upswing)
        //                      swing down + long = counter (buying near the bottom of a downswing)
        if (direction) {
          const swingBias = fibLevels.direction === "up" ? "long" : "short";
          swingTradeAlignment = (swingBias === direction) ? "aligned" : "counter";
        }

        detail = `Price at ${retrace.toFixed(1)}% retracement (${fibSource}, ${swingTradeAlignment}, range ${fibLevels.swingLow.toFixed(5)}–${fibLevels.swingHigh.toFixed(5)})`;
      }
    }
    // Fallback to legacy pd calculation if no fibLevels
    if (!fibLevels || detail === "") {
      const fibPercent = pd.zonePercent;
      retrace = direction === "long" ? (100 - fibPercent) : fibPercent;
      swingTradeAlignment = "aligned"; // legacy method already accounts for direction
      detail = `Price at ${retrace.toFixed(1)}% retracement (legacy, ${pd.currentZone} zone)`;
    }

    const fibDirection = direction;

    // Regime-aware 0.236 scoring: in strong trends, shallow pullbacks are valid entries
    const isStrongRegime = regimeInfo && (
      regimeInfo.regime === "strong_trend" ||
      (regimeInfo.confidence >= 70 && (regimeInfo.regime === "trending" || regimeInfo.regime === "strong_trend"))
    );
    const isAccelerating = regimeInfo?.transition?.state === "accelerating";

    if (fibDirection === "long" || fibDirection === "short") {
      if (swingTradeAlignment === "counter") {
        // ── COUNTER-SWING ENTRY (reversal trade) ──
        // Trading against the last swing. For this to be a good entry:
        //   - LOW retrace = price is near the swing extreme = good reversal entry
        //   - HIGH retrace = price already moved in your direction = you're late
        // Invert the scoring: low retrace scores high, high retrace scores low.
        // Also cap the max score lower than aligned entries (reversals are inherently riskier).
        if (retrace <= 23.6) {
          // Price near the swing extreme — excellent reversal entry point
          pts = 1.5;
          detail += ` | COUNTER-SWING: Near swing extreme (${retrace.toFixed(1)}% retrace) — strong reversal entry`;
        } else if (retrace <= 38.2) {
          // Still close to the extreme — decent reversal entry
          pts = 1.0;
          detail += ` | COUNTER-SWING: Fib 23.6–38.2% from extreme (${retrace.toFixed(1)}%) — valid reversal`;
        } else if (retrace <= 50) {
          // At equilibrium — mediocre reversal entry
          pts = 0.5;
          detail += ` | COUNTER-SWING: Near equilibrium (${retrace.toFixed(1)}%) — late reversal entry`;
        } else {
          // Price has already moved significantly in your trade direction — you're chasing
          pts = 0;
          detail += ` | COUNTER-SWING: Price already moved ${retrace.toFixed(1)}% — chasing, no Fib confluence`;
        }
      } else {
        // ── ALIGNED ENTRY (continuation/pullback trade) ──
        // Trading with the swing. Standard retracement scoring:
        //   - HIGH retrace = deep pullback into OTE = good entry
        //   - LOW retrace = barely pulled back = weak entry
        if (retrace >= 70 && retrace <= 72) {
          // 70.5% sweet spot (ICT optimal)
          pts = 2.0;
          detail += ` | Fib 70.5% sweet spot — OPTIMAL ENTRY`;
        } else if (retrace >= 61.8 && retrace <= 78.6) {
          // OTE zone
          pts = 1.5;
          detail += ` | Fib OTE zone (${retrace.toFixed(1)}%)`;
        } else if (retrace > 50 && retrace < 61.8) {
          // Discount/premium zone (beyond equilibrium but not OTE)
          pts = 1.0;
          detail += ` | ${fibDirection === "long" ? "Discount" : "Premium"} zone (${retrace.toFixed(1)}%)`;
        } else if (retrace >= 38.2 && retrace <= 50) {
          // Shallow retracement
          pts = 0.5;
          detail += ` | Shallow retracement (${retrace.toFixed(1)}%)`;
        } else if (retrace >= 23.6 && retrace < 38.2) {
          // 0.236 level — regime-dependent scoring
          if (isStrongRegime && isAccelerating) {
            pts = 0.75;
            detail += ` | Fib 23.6% continuation (strong trend + accelerating) — valid shallow entry`;
          } else if (isStrongRegime) {
            pts = 0.5;
            detail += ` | Fib 23.6% pullback (strong trend) — moderate entry`;
          } else {
            pts = 0.25;
            detail += ` | Fib 23.6% pullback (weak regime) — minimal confluence`;
          }
        } else if (retrace > 78.6) {
          // Deep retracement — risky but still in play
          pts = 0.5;
          detail += ` | Deep retracement (${retrace.toFixed(1)}%) — approaching invalidation`;
        } else {
          // < 23.6% — barely pulled back, or wrong side
          detail += ` | ${fibDirection === "long" ? "Buying in premium" : "Selling in discount"} — unfavorable (${retrace.toFixed(1)}%)`;
        }
      }
    } else {
      // Ranging — no clear direction from structure
      if (pd.oteZone) {
        pts = 0.5;
        detail += " | OTE zone active (ranging — no directional bias)";
      }
    }

    // Append Fib level proximity info if we have computed levels
    if (fibLevels && pts > 0) {
      const nearestRetrace = fibLevels.retracements.reduce((best, lvl) =>
        Math.abs(lvl.price - lastPrice) < Math.abs(best.price - lastPrice) ? lvl : best
      );
      detail += ` | Nearest Fib: ${nearestRetrace.label} @ ${nearestRetrace.price.toFixed(5)}`;
    }

    { const s = applyWeightScale(pts, "premiumDiscountFib", 2.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Premium/Discount & Fib", present: pts > 0, weight: s.displayWeight, detail, group: "Premium/Discount & Fib" }); }
  }

  // ── Factor 5: Session Quality (max 1.5) ──
  // Collapsed from Kill Zone + Silver Bullet + Macro into a single tiered factor.
  // Tier 1 (1.5): SB + KZ + Macro | Tier 2 (1.25): SB + KZ | Tier 3 (1.0): KZ + Macro
  // Tier 4 (0.75): KZ only | Tier 5 (0.5): Macro only | Tier 6 (0.25): active session | Tier 7 (0): nothing
  const silverBullet = detectSilverBullet(atMs);
  const macroWindow = detectMacroWindow(atMs);
  {
    const inKZ = session.isKillZone;
    const inSB = silverBullet.active && config.useSilverBullet !== false;
    const inMacro = macroWindow.active && config.useMacroWindows !== false;
    let pts = 0;
    let tier = "";
    let detail = "";
    if (inKZ && inSB && inMacro) {
      pts = 1.5; tier = "Tier 1 — Perfect";
      detail = `${session.name} Kill Zone + ${silverBullet.window} + ${macroWindow.window} — all timing windows aligned`;
    } else if (inKZ && inSB) {
      pts = 1.25; tier = "Tier 2 — Excellent";
      detail = `${session.name} Kill Zone + ${silverBullet.window} — strong timing confluence`;
    } else if (inKZ && inMacro) {
      pts = 1.0; tier = "Tier 3 — Good";
      detail = `${session.name} Kill Zone + ${macroWindow.window} — good timing overlap`;
    } else if (inKZ) {
      pts = 0.75; tier = "Tier 4 — Acceptable";
      detail = `${session.name} Kill Zone — standard high-probability window`;
    } else if (inMacro) {
      pts = 0.5; tier = "Tier 5 — Marginal";
      detail = `${macroWindow.window} active (${macroWindow.minutesRemaining}min left) — macro reprice window only`;
    } else if (session.name && session.name !== "Off-Hours") {
      pts = 0.25; tier = "Tier 6 — Low";
      detail = `${session.name} session active — no special timing window`;
    } else {
      pts = 0; tier = "Tier 7 — None";
      detail = "Outside active trading sessions — no timing edge";
    }
    { const s = applyWeightScale(pts, "sessionQuality", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Session Quality", present: pts > 0, weight: s.displayWeight, detail: `[${tier}] ${detail}`, group: "Timing" }); }
  }

  // ── Factor 6: Judas Swing (max 0.75) ──
  // ICT: Judas Swing is a manipulation move that sweeps liquidity before the real move.
  // Improved: Now anchored to actual NY midnight open. Requires liquidity sweep for full score.
  // FIX #4: Now uses judasSwing.type to check directional alignment with trade direction.
  {
    let pts = 0;
    let detail = judasSwing.description;
    if (judasSwing.detected && judasSwing.confirmed) {
      // Check if a liquidity sweep also fired — Judas + sweep = high-quality manipulation signal
      const hasSweep = liquidityPools.some(lp => lp.swept && lp.strength >= 2);
      if (session.isKillZone && hasSweep) {
        pts = 0.75;
        detail += " — kill zone + liquidity sweep (high-quality manipulation)";
      } else if (session.isKillZone) {
        pts = 0.5;
        detail += " — during kill zone (confirmed)";
      } else if (hasSweep) {
        pts = 0.4;
        detail += " — with liquidity sweep but outside kill zone";
      } else {
        pts = 0.25;
        detail += " — outside kill zone, no sweep (lower probability)";
      }
      // ── Direction alignment check (FIX #4) ──
      // A bullish Judas Swing = fake move DOWN then real move UP (supports long entries)
      // A bearish Judas Swing = fake move UP then real move DOWN (supports short entries)
      if (direction && judasSwing.type) {
        const jsAligned = (direction === "long" && judasSwing.type === "bullish")
          || (direction === "short" && judasSwing.type === "bearish");
        if (jsAligned) {
          pts = Math.min(0.75, pts + 0.15);
          detail += ` | ${judasSwing.type} JS aligned with ${direction} ✓`;
        } else {
          // Counter-directional Judas Swing — the manipulation is AGAINST our trade
          pts = Math.max(0, pts * 0.5);
          detail += ` | ${judasSwing.type} JS COUNTER to ${direction} (reduced)`;
        }
      }
    } else if (judasSwing.detected) {
      pts = 0.1;
      detail += " (unconfirmed)";
    }
    { const s = applyWeightScale(pts, "judasSwing", 0.75, config); pts = s.pts; score += pts;
    factors.push({ name: "Judas Swing", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 7: PD/PW Levels + Opens (max 1.5) ──
  // ICT: PD/PW levels are primary draw-on-liquidity targets.
  // Now scores ALL 11 levels: PDH, PDL, PDO, PDC, PWH, PWL, PWO, PWC, DO, WO, MO.
  // Also computes bias alignment from current-period opens.
  {
    let pts = 0;
    let detail = "No PD/PW levels";
    let biasAlignmentDetail = "";
    if (pdLevels) {
      const threshold = lastPrice * 0.002;
      // All 11 key levels, tiered by significance
      const allLevels = [
        // Tier A: Weekly H/L and Monthly Open (highest significance)
        { name: "PWH", price: pdLevels.pwh, tier: "A" },
        { name: "PWL", price: pdLevels.pwl, tier: "A" },
        { name: "MO",  price: pdLevels.monthlyOpen, tier: "A" },
        // Tier B: Daily H/L, Weekly Open, Weekly Close
        { name: "PDH", price: pdLevels.pdh, tier: "B" },
        { name: "PDL", price: pdLevels.pdl, tier: "B" },
        { name: "WO",  price: pdLevels.weeklyOpen, tier: "B" },
        { name: "PWC", price: pdLevels.pwc, tier: "B" },
        // Tier C: Daily Open, Daily Close, Previous Week Open, Previous Day Open
        { name: "DO",  price: pdLevels.dailyOpen, tier: "C" },
        { name: "PDC", price: pdLevels.pdc, tier: "C" },
        { name: "PDO", price: pdLevels.pdo, tier: "C" },
        { name: "PWO", price: pdLevels.pwo, tier: "C" },
      ];
      const nearLevels = allLevels.filter(l => Math.abs(lastPrice - l.price) <= threshold);
      if (nearLevels.length > 0) {
        const hasA = nearLevels.some(l => l.tier === "A");
        const hasB = nearLevels.some(l => l.tier === "B");
        // Tier A = 1.0, Tier B = 0.75, Tier C = 0.5, multiple tiers = bonus
        if (hasA) pts = 1.0;
        else if (hasB) pts = 0.75;
        else pts = 0.5;
        // Multiple level confluence bonus (price near 2+ levels = stronger)
        if (nearLevels.length >= 3) pts = Math.min(1.5, pts + 0.5);
        else if (nearLevels.length >= 2) pts = Math.min(1.5, pts + 0.25);
        detail = `Price near ${nearLevels.map(l => l.name).join(", ")} (${nearLevels[0].price.toFixed(5)})${hasA ? " — high-significance level" : ""}`;
      } else {
        detail = `PDH=${pdLevels.pdh.toFixed(5)} PDL=${pdLevels.pdl.toFixed(5)} PWH=${pdLevels.pwh.toFixed(5)} PWL=${pdLevels.pwl.toFixed(5)} DO=${pdLevels.dailyOpen.toFixed(5)} WO=${pdLevels.weeklyOpen.toFixed(5)} MO=${pdLevels.monthlyOpen.toFixed(5)}`;
      }

      // ── Bias Alignment from Opens ──
      // Price above open = bullish bias for that timeframe, below = bearish.
      // When all 3 opens agree with trade direction, strong confirmation.
      if (direction) {
        const doBias = lastPrice > pdLevels.dailyOpen ? "bullish" : "bearish";
        const woBias = lastPrice > pdLevels.weeklyOpen ? "bullish" : "bearish";
        const moBias = lastPrice > pdLevels.monthlyOpen ? "bullish" : "bearish";
        const tradeBias = direction === "long" ? "bullish" : "bearish";
        const doAlign = doBias === tradeBias;
        const woAlign = woBias === tradeBias;
        const moAlign = moBias === tradeBias;
        const alignCount = [doAlign, woAlign, moAlign].filter(Boolean).length;
        if (alignCount === 3) {
          // All 3 opens agree with direction — strong bias confirmation
          pts = Math.min(1.5, pts + 0.5);
          biasAlignmentDetail = ` | Bias: DO/WO/MO all ${tradeBias} ✓✓✓ (strong)`;
        } else if (alignCount === 2) {
          pts = Math.min(1.5, pts + 0.25);
          biasAlignmentDetail = ` | Bias: ${doAlign ? "DO✓" : "DO✗"} ${woAlign ? "WO✓" : "WO✗"} ${moAlign ? "MO✓" : "MO✗"} (2/3 aligned)`;
        } else if (alignCount === 1) {
          // Only 1 open agrees — mild headwind
          biasAlignmentDetail = ` | Bias: ${doAlign ? "DO✓" : "DO✗"} ${woAlign ? "WO✓" : "WO✗"} ${moAlign ? "MO✓" : "MO✗"} (1/3 — headwind)`;
        } else {
          // All 3 opens disagree — significant headwind, reduce score
          pts = Math.max(0, pts - 0.25);
          biasAlignmentDetail = ` | Bias: DO/WO/MO all against ${tradeBias} ✗✗✗ (strong headwind, score reduced)`;
        }
      }
      detail += biasAlignmentDetail;
    }
    { const s = applyWeightScale(pts, "pdPwLevels", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "PD/PW Levels", present: pts > 0, weight: s.displayWeight, detail, group: "Premium/Discount & Fib" }); }
  }

  // ── Factor 8: Reversal Candle (max 1.5) ──
  // ICT: reversal candles are a PRIMARY entry trigger — the actual "pull the trigger" signal.
  // Bumped from 0.5 to 1.5 to match ICT importance.
  {
    let pts = 0;
    let detail = "No reversal pattern";
    if (reversalCandle.detected) {
      const lastC = candles[candles.length - 1];
      const lastMid = (lastC.high + lastC.low) / 2;
      // Check if reversal formed at an OB
      const atOB = orderBlocks.some(ob => !ob.mitigated && lastC.low <= ob.high && lastC.high >= ob.low);
      // Check if reversal formed at an FVG
      const atFVG = fvgs.some(f => !f.mitigated && lastC.low <= f.high && lastC.high >= f.low);
      // Check if reversal formed at a PD/PW level
      const atPDPW = pdLevels ? [
        pdLevels.pdh, pdLevels.pdl, pdLevels.pwh, pdLevels.pwl,
      ].some(lvl => Math.abs(lastMid - lvl) / lastMid <= 0.002) : false;

      const atKeyLevel = atOB || atFVG || atPDPW;
      // Check for displacement on the reversal candle
      const hasDisp = displacement.isDisplacement;
      if (atKeyLevel && hasDisp) {
        pts = 1.5;
        const levels: string[] = [];
        if (atOB) levels.push("OB");
        if (atFVG) levels.push("FVG");
        if (atPDPW) levels.push("PD/PW level");
        detail = `${reversalCandle.type} reversal + displacement at key level (${levels.join(", ")}) — high-conviction entry`;
      } else if (atKeyLevel) {
        pts = 1.0;
        const levels: string[] = [];
        if (atOB) levels.push("OB");
        if (atFVG) levels.push("FVG");
        if (atPDPW) levels.push("PD/PW level");
        detail = `${reversalCandle.type} reversal at key level (${levels.join(", ")}) — no displacement`;
      } else if (hasDisp) {
        pts = 0.5;
        detail = `${reversalCandle.type} reversal with displacement but not at a key level`;
      } else {
        pts = 0.25;
        detail = `${reversalCandle.type} reversal candle detected but not at a key level, no displacement`;
      }
    }
    { const s = applyWeightScale(pts, "reversalCandle", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Reversal Candle", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 9: Liquidity Sweep (max 1.5) ──
  // ICT: Liquidity sweeps are a cornerstone entry trigger. Weight increased per audit.
  // Now uses rejection confirmation and recency for higher-quality signals.
  {
    let pts = 0;
    let detail = "";
    if (config.enableLiquiditySweep !== false) {
      // Prefer swept pools with rejection confirmation (wick through + close back)
      const sweptPools = liquidityPools.filter(lp => lp.swept && lp.strength >= 2);
      // Sort: rejection-confirmed first, then by strength, then by recency
      const sorted = sweptPools.sort((a, b) => {
        if (a.rejectionConfirmed !== b.rejectionConfirmed) return a.rejectionConfirmed ? -1 : 1;
        if (b.strength !== a.strength) return b.strength - a.strength;
        return (b.sweptAtIndex || 0) - (a.sweptAtIndex || 0); // more recent first
      });
      const best = sorted[0];
      if (best) {
        // Recency check: sweep should be within last 20 candles for full score
        const isRecent = best.sweptAtIndex != null && best.sweptAtIndex >= candles.length - 20;
        if (best.rejectionConfirmed) {
          // Sweep + rejection = high-quality signal
          pts = isRecent ? 1.5 : 1.0;
          detail = `${best.type} liquidity swept + rejected at ${best.price.toFixed(5)} (${best.strength} touches)${isRecent ? " — recent" : " — older sweep"}${best.strength >= 4 ? " — strong pool" : ""}`;
        } else {
          // Sweep without rejection = moderate signal (could be a real break, not a sweep)
          pts = isRecent ? 0.75 : 0.5;
          detail = `${best.type} liquidity swept at ${best.price.toFixed(5)} (${best.strength} touches) — no rejection candle${isRecent ? "" : " (older sweep)"}${best.strength >= 4 ? " — strong pool" : ""}`;
        }
      } else {
        detail = "No recent liquidity sweep";
      }
    } else {
      detail = "Liquidity Sweeps disabled";
    }
    { const s = applyWeightScale(pts, "liquiditySweep", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Liquidity Sweep", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Opening Range Enhancements ──
  const or = config.openingRange?.enabled && hourlyCandles
    ? computeOpeningRange(hourlyCandles, config.openingRange.candleCount || 24)
    : null;

  if (or && config.openingRange?.enabled) {
    // (a) OR Bias boost — modifies Factor 1
    if (config.openingRange.useBias && or.completed) {
      if (lastPrice > or.high) { score += 0.5; factors[0].detail += " | OR bias: bullish (above OR high)"; }
      else if (lastPrice < or.low) { score += 0.5; factors[0].detail += " | OR bias: bearish (below OR low)"; }
    }

    // (b) OR Judas Swing — enhances Factor 6
    if (config.openingRange.useJudasSwing && or.completed) {
      const recentCandles = candles.slice(-10);
      const sweptHigh = recentCandles.some(c => c.high > or.high);
      const sweptLow = recentCandles.some(c => c.low < or.low);
      if (sweptHigh && lastPrice < or.high) {
        score += 0.5;
        const f6 = factors.find(f => f.name === "Judas Swing");
        if (f6) { f6.present = true; f6.detail += " | OR high swept then reversed"; }
      }
      if (sweptLow && lastPrice > or.low) {
        score += 0.5;
        const f6 = factors.find(f => f.name === "Judas Swing");
        if (f6) { f6.present = true; f6.detail += " | OR low swept then reversed"; }
      }
    }

    // (c) OR Key Levels — enhances Factor 7
    if (config.openingRange.useKeyLevels && or.completed) {
      const threshold = lastPrice * 0.002;
      const orLevels = [
        { name: "OR High", price: or.high },
        { name: "OR Low", price: or.low },
        { name: "OR Mid", price: or.midpoint },
      ];
      const nearOR = orLevels.find(l => Math.abs(lastPrice - l.price) <= threshold);
      if (nearOR) {
        score += 0.5;
        const f7 = factors.find(f => f.name === "PD/PW Levels");
        if (f7) { f7.present = true; f7.detail += ` | Near ${nearOR.name} (${nearOR.price.toFixed(5)})`; }
      }
    }

    // (d) OR Premium/Discount override — modifies Factor 4
    if (config.openingRange.usePremiumDiscount && or.completed) {
      const orRange = or.high - or.low;
      if (orRange > 0) {
        const orZonePercent = ((lastPrice - or.low) / orRange) * 100;
        const orZone = orZonePercent > 55 ? "premium" : orZonePercent < 45 ? "discount" : "equilibrium";
        const f4 = factors.find(f => f.name === "Premium/Discount");
        if (f4) { f4.detail += ` | OR zone: ${orZone} (${orZonePercent.toFixed(1)}%)`; }
      }
    }
  }

  // Direction was already determined above (before Factor 3) so all factors can use it.

  // Factor 19 (Trend Direction) has been merged into Factor 1 (Market Structure).
  // The entry-TF trend alignment is now scored as part of the Market Structure factor.
  // Post-direction counter-trend penalty: if direction is now known and opposes structure.trend,
  // apply a penalty to the Market Structure factor.
  {
    const msFactor = factors.find(f => f.name === "Market Structure");
    if (msFactor && direction && structure.trend !== "ranging") {
      const trendAligned = (direction === "long" && structure.trend === "bullish")
        || (direction === "short" && structure.trend === "bearish");
      if (!trendAligned && msFactor.present) {
        // C7 fix: Proportional counter-trend penalty based on trend strength.
        // A strong trend (multiple BOS, no CHoCH) means counter-trend is riskier
        // than a weak trend (few BOS, some CHoCH). Scale penalty from 0.3 to 1.0.
        const bosCount = structure.bos.length;
        const chochCount = structure.choch.length;
        const trendStrength = Math.max(0, bosCount - chochCount); // 0 = weak, 3+ = strong
        // Base penalty 0.3, +0.15 per net BOS, capped at 1.0
        const penalty = Math.min(1.0, 0.3 + trendStrength * 0.15);
        score -= penalty;
        msFactor.weight = Math.max(0, msFactor.weight - penalty);
        msFactor.detail += ` | Counter-trend penalty: ${direction} against ${structure.trend} (-${penalty.toFixed(2)}, strength=${trendStrength})`;
      } else if (trendAligned && msFactor.present) {
        msFactor.detail += ` | Trend aligned: ${direction} with ${structure.trend} \u2713`;
      }
    }
  }

  // ── Post-direction OB alignment check ──────────────────────────────────────
  // Factor 2 runs before direction is known, so it scores any OB the price is inside.
  // Now that direction is set, check if the OB type aligns with trade direction.
  // Bullish OB = demand zone (supports longs). Bearish OB = supply zone (supports shorts).
  // Counter-directional OB gets a heavy penalty (×0.3) because you're trading against the zone.
  {
    const obFactor = factors.find(f => f.name === "Order Block");
    if (obFactor && obFactor.present && direction) {
      // Extract OB type from the detail string (e.g., "Price inside bullish OB at...")
      const obTypeBullish = obFactor.detail.includes("bullish OB");
      const obTypeBearish = obFactor.detail.includes("bearish OB");
      const obAligned = (direction === "long" && obTypeBullish)
        || (direction === "short" && obTypeBearish);
      if (!obAligned && (obTypeBullish || obTypeBearish)) {
        // Counter-directional OB: heavy penalty
        const oldWeight = obFactor.weight;
        obFactor.weight = Math.round(obFactor.weight * 0.3 * 1000) / 1000;
        const penalty = oldWeight - obFactor.weight;
        score -= penalty;
        const obType = obTypeBullish ? "bullish" : "bearish";
        obFactor.detail += ` | OB direction mismatch: ${obType} OB vs ${direction} entry (×0.3 penalty)`;
      } else if (obAligned) {
        obFactor.detail += ` | OB aligned with ${direction} entry ✓`;
      }
    }
  }

  // ── Factor 10: Displacement (max 1.0) ──
  // ICT: True displacement should create an FVG (institutional footprint).
  {
    let pts = 0;
    let detail = "No displacement candle in last 5 bars";
    if (config.useDisplacement !== false) {
      if (displacement.isDisplacement && direction && displacement.lastDirection) {
        const aligned = (direction === "long" && displacement.lastDirection === "bullish")
          || (direction === "short" && displacement.lastDirection === "bearish");
        if (aligned) {
          const last = displacement.displacementCandles[displacement.displacementCandles.length - 1];
          // Check if displacement candle created an FVG (within 1 candle of displacement)
          const createdFVG = fvgs.some(f => Math.abs(f.index - last.index) <= 1);
          if (createdFVG) {
            pts = 1.0;
            detail = `Displacement + FVG created — strong institutional footprint (${last.rangeMultiple.toFixed(1)}× avg range, body ${(last.bodyRatio * 100).toFixed(0)}%)`;
          } else {
            pts = 0.5;
            detail = `Displacement aligned but no FVG created (${last.rangeMultiple.toFixed(1)}× avg range, body ${(last.bodyRatio * 100).toFixed(0)}%)`;
          }
        } else {
          detail = `Displacement detected but opposite to signal direction (${displacement.lastDirection})`;
        }
      } else if (displacement.isDisplacement) {
        detail = `Displacement detected (${displacement.lastDirection}) but no signal direction`;
      }
    } else {
      detail = "Displacement scoring disabled";
    }
    { const s = applyWeightScale(pts, "displacement", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Displacement", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 11: Breaker Block (max 1.0) ──
  // Improved: ATR-based proximity instead of fixed 1% distance.
  {
    let pts = 0;
    let detail = "No active breaker block aligned with signal";
    if (config.useBreakerBlocks !== false && direction && breakerBlocks.length > 0) {
      const wantType = direction === "long" ? "bullish_breaker" : "bearish_breaker";
      // Use ATR for proximity — 2× ATR is a reasonable "near" threshold
      const breakerATR = calculateATR(candles, 14);
      const atrThreshold = breakerATR * 2;
      // Find the closest aligned breaker
      // Lifecycle-aware: exclude broken breakers from scoring
      const alignedBreakers = breakerBlocks.filter(b => b.type === wantType && b.state !== "broken");
      const brokenCount = breakerBlocks.filter(b => b.type === wantType && b.state === "broken").length;
      let bestBreaker: typeof alignedBreakers[0] | null = null;
      let bestDist = Infinity;
      for (const b of alignedBreakers) {
        const mid = (b.high + b.low) / 2;
        const dist = Math.abs(lastPrice - mid);
        if (dist < bestDist) { bestDist = dist; bestBreaker = b; }
      }
      if (bestBreaker) {
        const isInside = lastPrice >= bestBreaker.low && lastPrice <= bestBreaker.high;
        const subtypeLabel = bestBreaker.subtype === "breaker" ? "BB" : "MB";
        const bState = bestBreaker.state || "active";
        const bTests = bestBreaker.testedCount || 0;
        if (isInside) {
          pts = 1.0;
          // Lifecycle bonus: respected breakers are stronger
          if (bState === "respected" && bTests > 0) {
            const respectBonus = Math.min(0.3, bTests * 0.15);
            pts += respectBonus;
            detail = `Price inside ${bestBreaker.type.replace("_", " ")} (${subtypeLabel}, respected ${bTests}x +${respectBonus.toFixed(2)}) at ${bestBreaker.low.toFixed(5)}-${bestBreaker.high.toFixed(5)}`;
          } else {
            detail = `Price inside ${bestBreaker.type.replace("_", " ")} (${subtypeLabel}, ${bState}) at ${bestBreaker.low.toFixed(5)}-${bestBreaker.high.toFixed(5)}`;
          }
        } else if (bestDist <= atrThreshold) {
          pts = 0.5;
          detail = `Price within ${(bestDist / breakerATR).toFixed(1)}\u00d7 ATR of ${bestBreaker.type.replace("_", " ")} (${subtypeLabel}, ${bState}) at ${bestBreaker.low.toFixed(5)}-${bestBreaker.high.toFixed(5)}`;
        } else {
          detail = `${bestBreaker.type.replace("_", " ")} (${subtypeLabel}, ${bState}) at ${bestBreaker.low.toFixed(5)}-${bestBreaker.high.toFixed(5)} but ${(bestDist / breakerATR).toFixed(1)}\u00d7 ATR away${brokenCount > 0 ? ` (${brokenCount} broken/excluded)` : ""}`;
        }
      }
    } else if (config.useBreakerBlocks === false) {
      detail = "Breaker Blocks disabled";
    }
    { const s = applyWeightScale(pts, "breakerBlock", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Breaker Block", present: pts > 0, weight: s.displayWeight, detail, group: "Order Flow Zones" }); }
  }

  // ── Factor 12: Unicorn Model (max 1.5) ──
  {
    let pts = 0;
    let detail = "No unicorn (Breaker + FVG overlap) aligned with signal";
    if (config.useUnicornModel !== false && direction && unicornSetups.length > 0) {
      const wantType = direction === "long" ? "bullish_unicorn" : "bearish_unicorn";
      // Lifecycle-aware: only score active unicorns, invalidated ones get zero
      const activeUnicorns = unicornSetups.filter(u => u.state !== "invalidated");
      const invalidatedCount = unicornSetups.filter(u => u.state === "invalidated").length;
      const aligned = activeUnicorns.find(u => u.type === wantType
        && lastPrice >= u.overlapLow && lastPrice <= u.overlapHigh);
      if (aligned) {
        pts = 1.5;
        detail = `Unicorn: Breaker + FVG overlap at ${aligned.overlapLow.toFixed(5)}-${aligned.overlapHigh.toFixed(5)} [${aligned.state}]`;
      } else {
        const anyAligned = activeUnicorns.find(u => u.type === wantType);
        if (anyAligned) {
          detail = `Unicorn zone at ${anyAligned.overlapLow.toFixed(5)}-${anyAligned.overlapHigh.toFixed(5)} [${anyAligned.state}] but price outside${invalidatedCount > 0 ? ` (${invalidatedCount} invalidated/excluded)` : ""}`;
        } else if (invalidatedCount > 0) {
          detail = `${invalidatedCount} unicorn(s) found but all invalidated (${unicornSetups.filter(u => u.state === "invalidated").map(u => u.invalidationReason || "unknown").join(", ")})`;
        }
      }
    } else if (config.useUnicornModel === false) {
      detail = "Unicorn Model disabled";
    }
    { const s = applyWeightScale(pts, "unicornModel", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Unicorn Model", present: pts > 0, weight: s.displayWeight, detail, group: "Order Flow Zones" }); }
  }

  // ── Factors 13 & 14 (Silver Bullet + Macro) absorbed into Factor 5 Session Quality ──
  // silverBullet and macroWindow variables are declared at Factor 5 and remain available
  // for the return object and Power of 3 combo check.

  // ── Factor 15: SMT Divergence (max 1.0) ──
  // Reads precomputed SMT result injected by scan loop via config._smtResult.
  const smtResult: SMTResult | null = config._smtResult ?? null;
  {
    let pts = 0;
    let detail = smtResult ? smtResult.detail : "SMT not computed (no correlated pair fetched)";
    if (config.useSMT === false) {
      detail = "SMT Divergence disabled";
    } else if (smtResult && smtResult.detected && direction) {
      const aligned = (direction === "long" && smtResult.type === "bullish")
        || (direction === "short" && smtResult.type === "bearish");
      if (aligned) {
        pts = 1.0;
        detail = `SMT aligned: ${smtResult.detail}`;
      } else {
        detail = `SMT detected (${smtResult.type}) but opposite to signal direction`;
      }
    } else if (smtResult && smtResult.detected) {
      detail = `SMT (${smtResult.type}) detected but no signal direction yet`;
    }
    { const s = applyWeightScale(pts, "smtDivergence", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "SMT Divergence", present: pts > 0, weight: s.displayWeight, detail, group: "Macro Confirmation" }); }
  }

  // ── Factor 16: Volume Profile (max 1.5) ──
  // Replaces VWAP. Uses Time-at-Price (TPO) histogram to identify POC, HVN, LVN.
  // Validates OBs and FVGs with price-time data.
  const volumeProfile = computeVolumeProfile(candles);
  if (config.useVolumeProfile !== false) {
    let pts = 0;
    let detail = "";
    if (!volumeProfile) {
      detail = "Volume Profile unavailable (insufficient candles)";
    } else {
      const { poc, vah, val, nodes } = volumeProfile;
      const pipSize = (SPECS[config._currentSymbol || "EUR/USD"] || SPECS["EUR/USD"]).pipSize;
      const distFromPOC = Math.abs(lastPrice - poc) / pipSize;
      const pocProximityPips = 20; // within 20 pips of POC

      // Find the node closest to current price
      let closestNode = nodes[0];
      let minDist = Infinity;
      for (const node of nodes) {
        const d = Math.abs(lastPrice - node.price);
        if (d < minDist) { minDist = d; closestNode = node; }
      }

      if (distFromPOC <= pocProximityPips && direction) {
        // Price at POC — institutional fair value level
        pts = 1.0;
        detail = `Price ${distFromPOC.toFixed(1)} pips from POC (${poc.toFixed(5)}) — institutional fair value`;
      } else if (closestNode.type === "HVN" && direction) {
        // Price at High Volume Node — institutional defense level
        pts = 0.75;
        detail = `Price at HVN (${closestNode.price.toFixed(5)}, ${closestNode.count} TPOs) — institutional defense level`;
      } else if (closestNode.type === "LVN" && direction) {
        // Price at Low Volume Node — fast-move zone (validates FVG)
        pts = 0.5;
        detail = `Price at LVN (${closestNode.price.toFixed(5)}) — thin liquidity zone (FVG validation)`;
      } else if (direction) {
        detail = `Price in normal volume zone (POC: ${poc.toFixed(5)}, VA: ${val.toFixed(5)}-${vah.toFixed(5)})`;
      } else {
        detail = `Volume Profile computed (POC: ${poc.toFixed(5)}) but no direction`;
      }

      // Cross-validation bonus: OB or FVG overlaps with HVN/LVN
      if (pts > 0) {
        const obAtHVN = closestNode.type === "HVN" && factors.some(f => f.name === "Order Block" && f.present);
        const fvgAtLVN = closestNode.type === "LVN" && factors.some(f => f.name === "Fair Value Gap" && f.present);
        if (obAtHVN) {
          pts += 0.5;
          detail += " + OB at HVN (cross-validated)";
        } else if (fvgAtLVN) {
          pts += 0.5;
          detail += " + FVG at LVN (cross-validated)";
        }
      }
      pts = Math.min(0.75, pts);
    }
    { const s = applyWeightScale(pts, "volumeProfile", 0.75, config); pts = s.pts; score += pts;
    factors.push({ name: "Volume Profile", present: pts > 0, weight: s.displayWeight, detail, group: "Volume Profile" }); }
  } else {
    factors.push({ name: "Volume Profile", present: false, weight: 0, detail: "Volume Profile disabled", group: "Volume Profile" });
  }

  // Retain VWAP calculation for backward compatibility (not scored)
  const _vwapSymbol = config._currentSymbol || "EUR/USD";
  const _vwapPipSize = (SPECS[_vwapSymbol] || SPECS["EUR/USD"]).pipSize;
  const vwap = calculateAnchoredVWAP(candles, _vwapPipSize);

  // ── Factor 17: AMD Phase (max 1.5; bias alignment + distribution + Asian range key levels) ──
  // FIX #7: Now uses asianHigh/asianLow as key levels — price near Asian range boundary = extra confluence.
  const amd = detectAMDPhase(candles, atMs);
  {
    let pts = 0;
    let detail = `AMD: ${amd.detail}`;
    if (config.useAMD === false) {
      detail = "AMD Phase disabled";
    } else if (direction && amd.bias) {
      const aligned = (direction === "long" && amd.bias === "bullish") || (direction === "short" && amd.bias === "bearish");
      if (aligned) {
        pts = 1.0;
        if (amd.phase === "distribution") {
          pts += 0.5;
          detail = `AMD distribution + ${amd.bias} bias aligned (Asian sweep ${amd.sweptSide})`;
        } else {
          detail = `AMD ${amd.phase} + ${amd.bias} bias aligned (Asian sweep ${amd.sweptSide})`;
        }
      } else {
        detail = `AMD ${amd.bias} bias opposite to signal direction (phase: ${amd.phase})`;
      }
    }
    // ── Asian range as key levels (FIX #7) ──
    // asianHigh and asianLow are primary liquidity targets during London/NY.
    // Price near these levels = potential manipulation zone.
    if (amd.asianHigh != null && amd.asianLow != null) {
      const asianRange = amd.asianHigh - amd.asianLow;
      const nearThreshold = asianRange * 0.15; // within 15% of the Asian range
      const nearAsianHigh = Math.abs(lastPrice - amd.asianHigh) <= nearThreshold;
      const nearAsianLow = Math.abs(lastPrice - amd.asianLow) <= nearThreshold;
      if (nearAsianHigh || nearAsianLow) {
        const whichLevel = nearAsianHigh ? `Asian High (${amd.asianHigh.toFixed(5)})` : `Asian Low (${amd.asianLow.toFixed(5)})`;
        detail += ` | Price near ${whichLevel} — key liquidity level`;
        // Boost if the Asian level aligns with trade direction
        // Near Asian High + short = selling at resistance (good)
        // Near Asian Low + long = buying at support (good)
        const asianAligned = (nearAsianHigh && direction === "short") || (nearAsianLow && direction === "long");
        if (asianAligned) {
          pts = Math.min(1.5, pts + 0.25);
          detail += " (directionally aligned)";
        }
      }
    }
    { const s = applyWeightScale(pts, "amdPhase", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "AMD Phase", present: pts > 0, weight: s.displayWeight, detail, group: "AMD / Power of 3" }); }
  }

  // ── Factor 18: Currency Strength / FOTSI (max 1.5, min -0.5) ──
  // Uses pre-computed FOTSI strengths from the scan cycle (module-scoped _fotsiResult).
  // Rewards trades aligned with macro currency flow; penalizes exhaustion trades.
  let _fotsiAlignment: any = null;
  {
    let pts = 0;
    let detail = "";
    const fotsi = config._fotsiResult as FOTSIResult | null;
    if (config.useFOTSI === false) {
      detail = "Currency Strength disabled";
    } else if (fotsi && direction) {
      const currencies = parsePairCurrencies(config._currentSymbol || "");
      if (currencies) {
        const [base, quote] = currencies;
        const dir = direction === "long" ? "BUY" : "SELL";
        const alignment = getCurrencyAlignment(base, quote, dir as "BUY" | "SELL", fotsi.strengths);
        _fotsiAlignment = alignment;
        pts = alignment.score;
        detail = `${alignment.label} (${base} ${alignment.baseTSI.toFixed(1)}, ${quote} ${alignment.quoteTSI.toFixed(1)}, spread ${alignment.spread.toFixed(1)})`;
      } else {
        detail = "Non-forex pair — currency strength N/A";
      }
    } else if (!fotsi) {
      detail = "FOTSI data unavailable this cycle";
    } else {
      detail = "No direction — currency strength check skipped";
    }
    { const s = applyWeightScale(pts, "currencyStrength", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Currency Strength", present: pts !== 0, weight: s.displayWeight, detail, group: "Macro Confirmation" }); }
  }

  // ── Cached Daily Structure (computed once, reused by Factor 22 + gates) ──
  const cachedDailyStructure = (dailyCandles && dailyCandles.length >= 10)
    ? analyzeMarketStructure(dailyCandles) : null;

  // ── Factor 22: Daily Bias / HTF Trend (max 1.5) ──
  // Now fully activates htfStructure: trend, BOS/CHoCH recency, trend strength,
  // and daily swing points as key levels. Increased max from 1.0 to 1.5.
  if (config.useDailyBias !== false) {
    let pts = 0;
    let detail = "";
    if (cachedDailyStructure && dailyCandles && dailyCandles.length >= 20 && direction) {
      const dailyStructure = cachedDailyStructure;
      const dailyTrend = dailyStructure.trend;
      const dailyBOS = dailyStructure.bos;
      const dailyCHoCH = dailyStructure.choch;
      const dailySwings = dailyStructure.swingPoints;

      // ── Trend strength: BOS count without CHoCH = strong continuation ──
      const recentBOS = dailyBOS.filter(b => b.index >= dailyCandles.length - 20);
      const recentCHoCH = dailyCHoCH.filter(c => c.index >= dailyCandles.length - 20);
      const trendStrength = recentBOS.length - recentCHoCH.length; // positive = strong trend, negative = choppy

      // ── Last BOS/CHoCH recency ──
      const lastBOS = dailyBOS.length > 0 ? dailyBOS[dailyBOS.length - 1] : null;
      const lastCHoCH = dailyCHoCH.length > 0 ? dailyCHoCH[dailyCHoCH.length - 1] : null;
      const bosRecency = lastBOS ? dailyCandles.length - 1 - lastBOS.index : Infinity;
      const chochRecency = lastCHoCH ? dailyCandles.length - 1 - lastCHoCH.index : Infinity;

      if (dailyTrend !== "ranging") {
        const htfAligned = (direction === "long" && dailyTrend === "bullish")
          || (direction === "short" && dailyTrend === "bearish");
        if (htfAligned) {
          pts = 1.0;
          detail = `Daily ${dailyTrend} aligned with ${direction}`;
          // Trend strength bonus: strong trend (3+ BOS without CHoCH) = extra conviction
          if (trendStrength >= 3) {
            pts += 0.25;
            detail += ` — strong trend (${recentBOS.length} BOS, ${recentCHoCH.length} CHoCH)`;
          } else {
            detail += ` (${recentBOS.length} BOS, ${recentCHoCH.length} CHoCH)`;
          }
          // Recent BOS bonus: BOS within last 5 daily candles = fresh momentum
          if (bosRecency <= 5) {
            pts += 0.25;
            detail += ` + recent BOS (${bosRecency}d ago)`;
          }
        } else {
          pts = -0.5;
          // C5 fix: Communicate gate severity in the factor detail.
          // If htfBiasRequired is on, Gate 1 will block this trade entirely.
          // The score penalty alone doesn't convey that — add explicit warning.
          const gateWillBlock = config.htfBiasRequired;
          detail = `Counter-HTF: ${direction} against daily ${dailyTrend} (penalty)${gateWillBlock ? " ⚠ Gate 1 will BLOCK" : ""}`;
          // Recent CHoCH against us = extra danger
          if (chochRecency <= 5) {
            pts -= 0.25;
            detail += ` + recent CHoCH against direction (${chochRecency}d ago)`;
          }
        }
      } else {
        // C5 fix: Align Factor 22 ranging treatment with Gate 1 tolerance.
        // Hard veto mode: Gate 1 blocks ranging daily for ALL directions, so
        // Factor 22 should give 0 pts (not 0.25) to avoid inflating the score
        // for a trade that will be gate-blocked anyway.
        // Soft mode: Gate 1 passes ranging, so Factor 22 gives a small neutral bonus.
        const hardVeto = config.htfBiasHardVeto;
        if (hardVeto) {
          pts = 0;
          detail = `Daily ranging — hard veto mode will block (${recentBOS.length} BOS, ${recentCHoCH.length} CHoCH)`;
        } else {
          pts = 0.25;
          detail = `Daily ranging — neutral (${recentBOS.length} BOS, ${recentCHoCH.length} CHoCH)`;
        }
        // If there's a very recent CHoCH, the range is fresh — could be a reversal
        if (chochRecency <= 3) {
          detail += ` — fresh CHoCH (${chochRecency}d ago, possible reversal)`;
        }
      }

      // ── Daily swing points as key levels ──
      // Check if current price is near a daily swing high/low (strong S/R)
      if (dailySwings.length >= 2) {
        const recentDailySwings = dailySwings.slice(-6);
        const pipSize = (SPECS[config._currentSymbol || "EUR/USD"] || SPECS["EUR/USD"]).pipSize;
        const threshold = pipSize * 30; // within 30 pips of a daily swing
        const nearDailySwing = recentDailySwings.find(s => Math.abs(lastPrice - s.price) <= threshold);
        if (nearDailySwing) {
          detail += ` | Near daily swing ${nearDailySwing.type} at ${nearDailySwing.price.toFixed(5)}`;
        }
      }

      pts = Math.min(1.5, Math.max(-0.75, pts)); // cap at 1.5, floor at -0.75
    } else if (!dailyCandles || dailyCandles.length < 20) {
      detail = "Daily candles unavailable — HTF bias skipped";
    } else {
      detail = "No direction determined — HTF bias skipped";
    }
    { const s = applyWeightScale(pts, "dailyBias", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Daily Bias", present: pts > 0, weight: s.displayWeight, detail, group: "Daily Bias" }); }
  } else {
    factors.push({ name: "Daily Bias", present: false, weight: 0, detail: "Daily Bias disabled", group: "Daily Bias" });
  }

  // ── Factor 19: Confluence Stacking (max 1.5) ──
  // Detects when FVG/OB boxes overlap with S/R levels AND Fib retracement levels.
  // Triple confluence (FVG/OB + S/R + Fib) = highest probability entry zone.
  let confluenceStacks: ConfluenceStack[] = [];
  {
    let pts = 0;
    let detail = "";
    confluenceStacks = computeConfluenceStacking(
      orderBlocks, fvgs, structure.swingPoints, candles, direction, fibLevels
    );
    if (confluenceStacks.length > 0) {
      const best = confluenceStacks[0]; // Already sorted by layerCount desc + alignment
      const priceInZone = lastPrice >= best.overlapZone[0] && lastPrice <= best.overlapZone[1];

      if (best.layerCount >= 3 && priceInZone) {
        // Triple+ confluence AND price is inside the zone — maximum score
        pts = 1.5;
        detail = `TRIPLE CONFLUENCE at price: ${best.label} [${best.overlapZone[0].toFixed(5)}-${best.overlapZone[1].toFixed(5)}]`;
        if (best.directionalAlignment === "aligned") detail += " — directionally aligned";
        else if (best.directionalAlignment === "counter") { pts *= 0.5; detail += " — counter-directional (reduced)"; }
      } else if (best.layerCount >= 3) {
        // Triple confluence but price not yet at the zone
        pts = 0.75;
        detail = `Triple confluence nearby: ${best.label} [${best.overlapZone[0].toFixed(5)}-${best.overlapZone[1].toFixed(5)}] — price not at level`;
      } else if (best.layerCount === 2 && priceInZone) {
        // Double confluence at price
        pts = 1.0;
        detail = `Double confluence at price: ${best.label} [${best.overlapZone[0].toFixed(5)}-${best.overlapZone[1].toFixed(5)}]`;
        if (best.directionalAlignment === "counter") { pts *= 0.5; detail += " — counter-directional (reduced)"; }
      } else if (best.layerCount === 2) {
        // Double confluence nearby
        pts = 0.5;
        detail = `Double confluence nearby: ${best.label} — price not at level`;
      }

      // Add summary of all stacks found
      if (confluenceStacks.length > 1) {
        detail += ` | ${confluenceStacks.length} total stacks found (best: ${best.layerCount} layers)`;
      }
    } else {
      detail = "No confluence stacking detected (FVG/OB zones don't overlap with S/R + Fib)";
    }
    { const s = applyWeightScale(pts, "confluenceStack", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Confluence Stack", present: pts > 0, weight: s.displayWeight, detail, group: "Order Flow Zones" }); }
  }

  // ── Factor 20: Sweep Reclaim Enhancement ──
  // Enhances existing sweep data with reclaim confirmation.
  // Sweep + reclaim = highest quality entry trigger (price grabs liquidity then reverses with conviction).
  let sweepReclaims: SweepReclaim[] = [];
  {
    // Build sweep data from structure.sweeps for detectSweepReclaim
    const structureSweeps = (structure.sweeps || []).map((s: any) => ({
      index: s.index,
      type: s.type as "bullish" | "bearish",
      price: s.price,
      datetime: s.datetime || "",
      sweptLevel: s.sweptLevel,
      wickDepth: s.wickDepth,
    }));
    sweepReclaims = detectSweepReclaim(candles, structureSweeps, fvgs);

    // Enhance Factor 9 (Liquidity Sweep) detail with reclaim info if available
    const sweepFactor = factors.find(f => f.name === "Liquidity Sweep");
    if (sweepFactor && sweepReclaims.length > 0) {
      const bestReclaim = sweepReclaims.find(sr => sr.reclaimed);
      if (bestReclaim) {
        const reclaimDetail = ` | SWEEP RECLAIM: ${bestReclaim.type} sweep at ${bestReclaim.sweptLevel.toFixed(5)} reclaimed (strength: ${(bestReclaim.reclaimStrength * 100).toFixed(0)}%)`;
        if (bestReclaim.createdFVG) sweepFactor.detail += reclaimDetail + " + FVG created";
        else if (bestReclaim.createdDisplacement) sweepFactor.detail += reclaimDetail + " + displacement";
        else sweepFactor.detail += reclaimDetail;

        // Boost sweep score if reclaim confirmed and sweep was already scored
        if (sweepFactor.present && sweepFactor.weight < 1.5) {
          const boost = bestReclaim.createdFVG ? 0.5 : bestReclaim.createdDisplacement ? 0.35 : 0.25;
          const newWeight = Math.min(1.5, sweepFactor.weight + boost);
          const diff = newWeight - sweepFactor.weight;
          score += diff;
          sweepFactor.weight = newWeight;
          sweepFactor.detail += ` [reclaim boost: +${diff.toFixed(2)}]`;
        }
      } else {
        // Sweeps detected but none reclaimed
        sweepFactor.detail += ` | ${sweepReclaims.length} sweep(s) detected, none reclaimed`;
      }
    }
  }

  // ── Factor 21: Pullback Health (max 0.5) ──
  // Measures pullback depth progression to assess trend health.
  // Shallower pullbacks = healthy trend. Deeper pullbacks = exhausting.
  let pullbackDecay: PullbackDecay | null = null;
  {
    let pts = 0;
    let detail = "";
    const trendForPullback = structure.trend === "bullish" ? "bullish"
      : structure.trend === "bearish" ? "bearish" : "ranging";
    pullbackDecay = measurePullbackDecay(structure.swingPoints, trendForPullback as "bullish" | "bearish" | "ranging");

    if (pullbackDecay.trend === "healthy") {
      pts = 0.5;
      detail = pullbackDecay.detail;
    } else if (pullbackDecay.trend === "exhausting") {
      pts = 0;
      detail = pullbackDecay.detail + " — WARNING: consider reducing position size";
    } else if (pullbackDecay.trend === "stable") {
      pts = 0.25;
      detail = pullbackDecay.detail;
    } else {
      detail = pullbackDecay.detail;
    }
    { const s = applyWeightScale(pts, "pullbackHealth", 0.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Pullback Health", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 23: HTF POI Alignment (max 2.0) ──
  // Checks if current price is inside a higher-timeframe Point of Interest (FVG, OB, Breaker)
  // detected on 4H or 1H candles. Being inside an HTF POI means the entry is backed by
  // institutional activity on a higher timeframe — significantly increases probability.
  {
    let pts = 0;
    let detail = "";
    const htfPOIs: { timeframe: string; type: "fvg" | "ob" | "breaker"; high: number; low: number; direction: "bullish" | "bearish" }[] | null = (config as any)._htfPOIs || null;

    if (htfPOIs && htfPOIs.length > 0) {
      // Find all HTF POIs that contain the current price
      const matchingPOIs = htfPOIs.filter(poi => lastPrice >= poi.low && lastPrice <= poi.high);

      if (matchingPOIs.length > 0) {
        // Score based on what we're inside
        // 4H zones are more significant than 1H zones
        // FVGs score highest (unfilled institutional orders), then OBs, then Breakers
        const BOOST_MAP: Record<string, Record<string, number>> = {
          "4H": { fvg: 0.8, ob: 0.7, breaker: 0.5 },
          "1H": { fvg: 0.5, ob: 0.4, breaker: 0.3 },
          "D":  { fvg: 1.0, ob: 0.8, breaker: 0.6 },
        };

        let totalBoost = 0;
        const matchDetails: string[] = [];

        // Directional alignment bonus: if HTF POI direction matches trade direction, extra boost
        for (const poi of matchingPOIs) {
          const baseBoost = BOOST_MAP[poi.timeframe]?.[poi.type] ?? 0.3;
          let poiBoost = baseBoost;

          // Directional alignment: bullish POI + long direction = aligned (or bearish + short)
          const aligned = (direction === "long" && poi.direction === "bullish")
            || (direction === "short" && poi.direction === "bearish");
          const counter = (direction === "long" && poi.direction === "bearish")
            || (direction === "short" && poi.direction === "bullish");

          if (aligned) {
            poiBoost *= 1.2; // 20% bonus for directional alignment
          } else if (counter) {
            poiBoost *= 0.5; // 50% reduction for counter-directional
          }

          totalBoost += poiBoost;
          const alignStr = aligned ? "aligned" : counter ? "counter" : "";
          matchDetails.push(`${poi.timeframe} ${poi.type.toUpperCase()} [${poi.low.toFixed(5)}-${poi.high.toFixed(5)}]${alignStr ? " (" + alignStr + ")" : ""}`);
        }

        // Cap total boost at 2.0
        pts = Math.min(2.0, Math.round(totalBoost * 100) / 100);
        detail = `Price inside HTF POI: ${matchDetails.join(", ")} → +${pts.toFixed(2)} boost`;

        // Also inject HTF POIs as layers into the confluence stacking
        for (const poi of matchingPOIs) {
          const layerType = poi.type === "fvg" ? "htf_fvg" as const
            : poi.type === "ob" ? "htf_ob" as const
            : "htf_breaker" as const;
          const layerLabel = `${poi.timeframe} ${poi.type === "fvg" ? "FVG" : poi.type === "ob" ? "OB" : "Breaker"}`;

          // Add to existing confluence stacks that overlap with this HTF POI
          for (const stack of confluenceStacks) {
            const stackOverlapsHTF = stack.overlapZone[0] <= poi.high && stack.overlapZone[1] >= poi.low;
            if (stackOverlapsHTF) {
              stack.layers.push({ type: layerType, label: layerLabel, priceRange: [poi.low, poi.high] });
              stack.layerCount = stack.layers.length;
              stack.label += ` + ${layerLabel}`;
            }
          }

          // If no existing stack overlaps, create a new standalone HTF POI stack
          if (!confluenceStacks.some(s => s.overlapZone[0] <= poi.high && s.overlapZone[1] >= poi.low)) {
            confluenceStacks.push({
              layerCount: 1,
              overlapZone: [poi.low, poi.high],
              layers: [{ type: layerType, label: layerLabel, priceRange: [poi.low, poi.high] }],
              label: layerLabel,
              fibLevels: [],
              directionalAlignment: direction
                ? ((direction === "long" && poi.direction === "bullish") || (direction === "short" && poi.direction === "bearish")
                  ? "aligned" : "counter")
                : "neutral",
            });
          }
        }
      } else {
        detail = `${htfPOIs.length} HTF POIs detected but price not inside any`;
      }
    } else {
      detail = "No HTF POI data available";
    }

    // Apply weight scale and add to factors
    score += pts;
    factors.push({ name: "HTF POI Alignment", present: pts > 0, weight: pts, detail, group: "Multi-Timeframe" });
  }

  // ── Factor 24: HTF Fib + Premium/Discount + Liquidity (max 2.5) ──────────────
  // Checks if current price aligns with higher-timeframe Fibonacci levels,
  // Premium/Discount zones, or Liquidity Pools detected on 4H and 1H candles.
  // These provide institutional-level confluence from higher timeframes.
  {
    let pts = 0;
    let detail = "";
    const htfFibData: { h4: FibLevels | null; h1: FibLevels | null } | null = (config as any)._htfFibLevels || null;
    const htfPDData: { h4: { currentZone: string; zonePercent: number; oteZone: boolean } | null; h1: { currentZone: string; zonePercent: number; oteZone: boolean } | null } | null = (config as any)._htfPD || null;
    const htfLiqData: { h4: LiquidityPool[]; h1: LiquidityPool[] } | null = (config as any)._htfLiquidityPools || null;

    const atrForTolerance = calculateATR(candles, 14);
    const fibTolerance = atrForTolerance * 0.3; // Price must be within 0.3×ATR of Fib level
    const matchDetails: string[] = [];

    // ─── HTF Fibonacci Level Scoring ───
    // 4H: 61.8%/OTE = +1.0, 50% = +0.6, 38.2% = +0.4
    // 1H: 61.8%/OTE = +0.6, 50% = +0.4, 38.2% = +0.3
    const FIB_SCORES: Record<string, { h4: number; h1: number }> = {
      "0.618": { h4: 1.0, h1: 0.6 },
      "0.705": { h4: 1.0, h1: 0.6 }, // OTE zone
      "0.786": { h4: 1.0, h1: 0.6 }, // OTE zone
      "0.5":   { h4: 0.6, h1: 0.4 },
      "0.382": { h4: 0.4, h1: 0.3 },
    };

    const scoreFibLevels = (fibs: FibLevels, tf: "h4" | "h1", tfLabel: string) => {
      if (!fibs || !fibs.retracements) return;
      // Find the closest Fib level within tolerance (only count one per TF)
      let bestFibScore = 0;
      let bestFibLabel = "";
      for (const level of fibs.retracements) {
        const dist = Math.abs(lastPrice - level.price);
        if (dist <= fibTolerance) {
          const key = level.ratio.toFixed(3);
          const scoreEntry = FIB_SCORES[key];
          if (scoreEntry) {
            const fibScore = scoreEntry[tf];
            if (fibScore > bestFibScore) {
              bestFibScore = fibScore;
              bestFibLabel = `${tfLabel} Fib ${level.label}`;
            }
          }
        }
      }
      if (bestFibScore > 0) {
        pts += bestFibScore;
        matchDetails.push(`${bestFibLabel} (+${bestFibScore.toFixed(1)})`);
        // Add confluence stacking layer
        const fibLevel = fibs.retracements.find(l => `${tfLabel} Fib ${l.label}` === bestFibLabel);
        if (fibLevel) {
          for (const stack of confluenceStacks) {
            const stackOverlap = stack.overlapZone[0] <= fibLevel.price + fibTolerance && stack.overlapZone[1] >= fibLevel.price - fibTolerance;
            if (stackOverlap) {
              stack.layers.push({ type: "htf_fib" as const, label: bestFibLabel, priceRange: [fibLevel.price - fibTolerance, fibLevel.price + fibTolerance] });
              stack.layerCount = stack.layers.length;
              stack.label += ` + ${bestFibLabel}`;
            }
          }
          // Standalone stack if no overlap
          if (!confluenceStacks.some(s => s.overlapZone[0] <= fibLevel.price + fibTolerance && s.overlapZone[1] >= fibLevel.price - fibTolerance)) {
            confluenceStacks.push({
              layerCount: 1,
              overlapZone: [fibLevel.price - fibTolerance, fibLevel.price + fibTolerance],
              layers: [{ type: "htf_fib" as const, label: bestFibLabel, priceRange: [fibLevel.price - fibTolerance, fibLevel.price + fibTolerance] }],
              label: bestFibLabel,
              fibLevels: [fibLevel.ratio],
              directionalAlignment: "neutral",
            });
          }
        }
      }
    };

    if (htfFibData) {
      if (htfFibData.h4) scoreFibLevels(htfFibData.h4, "h4", "4H");
      if (htfFibData.h1) scoreFibLevels(htfFibData.h1, "h1", "1H");
    }

    // ─── HTF Premium/Discount Zone Scoring ───
    // Discount zone for longs / Premium for shorts = directionally aligned
    // 4H: aligned = +0.8, OTE = +1.0; 1H: aligned = +0.5, OTE = +0.6
    const scorePD = (pd: { currentZone: string; zonePercent: number; oteZone: boolean }, tf: "h4" | "h1", tfLabel: string) => {
      if (!pd) return;
      const aligned = (direction === "long" && pd.currentZone === "discount")
        || (direction === "short" && pd.currentZone === "premium");
      if (!aligned) return;

      let pdScore = 0;
      let pdLabel = "";
      if (pd.oteZone) {
        pdScore = tf === "h4" ? 1.0 : 0.6;
        pdLabel = `${tfLabel} OTE Zone`;
      } else {
        pdScore = tf === "h4" ? 0.8 : 0.5;
        pdLabel = `${tfLabel} ${pd.currentZone === "discount" ? "Discount" : "Premium"} Zone`;
      }
      pts += pdScore;
      matchDetails.push(`${pdLabel} (+${pdScore.toFixed(1)})`);

      // Add confluence stacking layer
      for (const stack of confluenceStacks) {
        // PD zones are broad — add to any stack where price currently is
        const priceInStack = lastPrice >= stack.overlapZone[0] && lastPrice <= stack.overlapZone[1];
        if (priceInStack) {
          stack.layers.push({ type: "htf_pd" as const, label: pdLabel, priceRange: stack.overlapZone });
          stack.layerCount = stack.layers.length;
          stack.label += ` + ${pdLabel}`;
        }
      }
    };

    if (htfPDData) {
      if (htfPDData.h4) scorePD(htfPDData.h4, "h4", "4H");
      if (htfPDData.h1) scorePD(htfPDData.h1, "h1", "1H");
    }

    // ─── HTF Liquidity Pool Scoring ───
    // Active pool in direction of trade (buy-side above for longs, sell-side below for shorts)
    // 4H: +0.5, 1H: +0.3
    const scoreLiquidity = (pools: LiquidityPool[], tf: "h4" | "h1", tfLabel: string) => {
      if (!pools || pools.length === 0) return;
      // For longs: look for buy-side liquidity ABOVE price (draw on liquidity / target)
      // For shorts: look for sell-side liquidity BELOW price (draw on liquidity / target)
      const activePools = pools.filter(p => p.state === "active");
      let found = false;
      for (const pool of activePools) {
        if (direction === "long" && pool.type === "buy-side" && pool.price > lastPrice) {
          found = true;
          break;
        }
        if (direction === "short" && pool.type === "sell-side" && pool.price < lastPrice) {
          found = true;
          break;
        }
      }
      if (found) {
        const liqScore = tf === "h4" ? 0.5 : 0.3;
        pts += liqScore;
        const liqLabel = `${tfLabel} Liquidity Pool`;
        matchDetails.push(`${liqLabel} (+${liqScore.toFixed(1)})`);

        // Add confluence stacking layer
        for (const stack of confluenceStacks) {
          const priceInStack = lastPrice >= stack.overlapZone[0] && lastPrice <= stack.overlapZone[1];
          if (priceInStack) {
            stack.layers.push({ type: "htf_liquidity" as const, label: liqLabel, priceRange: stack.overlapZone });
            stack.layerCount = stack.layers.length;
            stack.label += ` + ${liqLabel}`;
          }
        }
      }
    };

    if (htfLiqData) {
      if (htfLiqData.h4) scoreLiquidity(htfLiqData.h4, "h4", "4H");
      if (htfLiqData.h1) scoreLiquidity(htfLiqData.h1, "h1", "1H");
    }

    // Cap total at 2.5
    pts = Math.min(2.5, Math.round(pts * 100) / 100);
    if (matchDetails.length > 0) {
      detail = `HTF Fib/PD/Liquidity: ${matchDetails.join(", ")} → +${pts.toFixed(2)}`;
    } else {
      detail = "No HTF Fib/PD/Liquidity alignment detected";
    }

    score += pts;
    factors.push({ name: "HTF Fib + PD + Liquidity", present: pts > 0, weight: pts, detail, group: "Multi-Timeframe" });
  }

  // ─── Anti-Double-Count Adjustment Pass ──────────────────────────────────────
  // Corrects overlapping scores where sub-factors are subsets of parent factors.
  // Applied AFTER all individual scoring, BEFORE final clamp.
  {
    const findFactor = (name: string) => factors.find(f => f.name === name);
    const adjustFactor = (name: string, newWeight: number, reason: string) => {
      const f = findFactor(name);
      if (f && f.present) {
        const diff = f.weight - newWeight;
        if (diff > 0) {
          score -= diff;
          f.weight = newWeight;
          f.detail += ` [adjusted: ${reason}]`;
        }
      }
    };

    // Rule 1: Unicorn fires → Breaker = 0, FVG stays.
    // Unicorn = Breaker Block + FVG overlap. The Breaker Block is already
    // represented inside the Unicorn, so zero it to avoid double-counting.
    // FVG is kept because the Unicorn is a *better* FVG (FVG + Breaker confluence);
    // zeroing FVG would penalize the highest-conviction setups.
    // If FVG is NOT separately present (price inside Unicorn overlap but not
    // independently inside an FVG), Unicorn is promoted to Tier 1 so it can
    // fill the FVG's role as a core setup factor.
    const unicorn = findFactor("Unicorn Model");
    if (unicorn && unicorn.present) {
      const breaker = findFactor("Breaker Block");
      const fvg = findFactor("Fair Value Gap");
      // Always zero the Breaker Block — it's subsumed by the Unicorn
      if (breaker && breaker.present) {
        score -= breaker.weight;
        breaker.weight = 0;
        breaker.detail += " [zeroed: absorbed by Unicorn Model]";
      }
      // FVG stays scored. Tag it for clarity but do NOT zero it.
      if (fvg && fvg.present) {
        fvg.detail += " [confirmed: part of Unicorn confluence]";
      }
      // If FVG is absent or not present, promote Unicorn to fill the Tier 1 slot.
      // This ensures a Unicorn entry (which IS an FVG + Breaker overlap) always
      // counts as at least a Tier 1 core factor.
      if (!fvg || !fvg.present || fvg.weight <= 0) {
        (unicorn as any)._promotedToTier1 = true;
      }
    }

    // Rule 2: Displacement + FVG overlap
    // If displacement created the FVG, reduce displacement to 0.5 (already partially counted in FVG).
    const displacement = findFactor("Displacement");
    const fvgFactor = findFactor("Fair Value Gap");
    if (displacement && displacement.present && fvgFactor && fvgFactor.present
        && displacement.detail.includes("FVG")) {
      adjustFactor("Displacement", 0.5, "FVG already scored the displacement event");
    }

    // Rule 3: OB + FVG both inside same zone → cap combined at 3.0
    // Applies regardless of Unicorn (Rule 1 no longer zeroes FVG).
    {
      const ob = findFactor("Order Block");
      const fvg2 = findFactor("Fair Value Gap");
      if (ob && ob.present && fvg2 && fvg2.present) {
        const combinedZone = ob.weight + fvg2.weight;
        if (combinedZone > 3.0) {
          const excess = combinedZone - 3.0;
          score -= excess;
          fvg2.weight = Math.max(0, fvg2.weight - excess);
          fvg2.detail += ` [capped: OB+FVG combined limited to 3.0]`;
        }
      }
    }

    // Rule 4 & 6 removed: Kill Zone / Silver Bullet / Macro are now a single Session Quality factor.

    // Rule 5: AMD distribution + sweep → absorbs Judas
    const amdFactor = findFactor("AMD Phase");
    const judas = findFactor("Judas Swing");
    const sweep = findFactor("Liquidity Sweep");
    if (amdFactor && amdFactor.present && sweep && sweep.present && judas && judas.present) {
      score -= judas.weight;
      judas.weight = 0;
      judas.detail += " [zeroed: absorbed by AMD + Sweep sequence]";
    }

    // Rule 6 removed: Macro absorbed into Session Quality.
  }

  // ─── Power of 3 Combo Bonus (+1.0) ─────────────────────────────────────────
  // ICT Power of 3: Consolidation (accumulation) → Fakeout (manipulation/Judas) → Trend (distribution)
  // Awards +1.0 when AMD phase is distribution + sweep/Judas confirmed + trend direction aligned.
  {
    const findFactor = (name: string) => factors.find(f => f.name === name);
    const amdF = findFactor("AMD Phase");
    const sweepF = findFactor("Liquidity Sweep");
    const judasF = findFactor("Judas Swing");
    const msF = findFactor("Market Structure");

    const amdPresent = amdF && amdF.present;
    const sweepOrJudas = (sweepF && sweepF.present) || (judasF && judasF.present);
    const trendAligned = msF && msF.present;

    if (amdPresent && sweepOrJudas && trendAligned) {
      const po3Bonus = 1.0;
      score += po3Bonus;
      factors.push({
        name: "Power of 3 Combo",
        present: true,
        weight: po3Bonus,
        detail: `Full ICT sequence: Accumulation → Manipulation (${sweepF?.present ? "sweep" : "Judas"}) → Distribution — high-probability setup`,
        group: "AMD / Power of 3",
      });
    } else {
      factors.push({
        name: "Power of 3 Combo",
        present: false,
        weight: 0,
        detail: `Incomplete: AMD=${amdPresent ? "✓" : "✗"} Sweep/Judas=${sweepOrJudas ? "✓" : "✗"} Structure=${trendAligned ? "✓" : "✗"}`,
        group: "AMD / Power of 3",
      });
    }
  }

  // ─── Tiered Factor Classification ─────────────────────────────────────────────
  // No group caps. Factors are classified into tiers for scoring:
  // Tier 1 (Core Setup ×2): Must have at least 2 to consider a trade
  // Tier 2 (Confirmation ×1): Adds confidence to the setup
  // Tier 3 (Bonus ×0.5): Nice to have, never required
  const TIER_1_FACTORS = new Set(["Market Structure", "Order Block", "Fair Value Gap", "Premium/Discount & Fib"]);
  const TIER_2_FACTORS = new Set(["PD/PW Levels", "Liquidity Sweep", "Displacement", "Reversal Candle", "Session Quality", "Confluence Stack", "Pullback Health", "HTF POI Alignment", "HTF Fib + PD + Liquidity"]);
  // Everything else is Tier 3: Currency Strength, SMT Divergence, Daily Bias, Breaker Block,
  // Unicorn Model*, Volume Profile, AMD Phase, Judas Swing
  // *Unicorn is promoted to Tier 1 when FVG is absent (see anti-double-count Rule 1)
  // (Regime Alignment and Spread Quality are separate gates, not scored)

  // Tag each factor with its tier for display
  for (const f of factors) {
    if (TIER_1_FACTORS.has(f.name)) {
      (f as any).tier = 1;
    } else if (TIER_2_FACTORS.has(f.name)) {
      (f as any).tier = 2;
    } else {
      (f as any).tier = 3;
    }
  }

  // Unicorn Tier 1 promotion: when FVG is absent but Unicorn fires,
  // promote Unicorn from Tier 3 → Tier 1 so it fills the FVG's core slot.
  // A Unicorn IS an FVG + Breaker overlap, so it qualifies as a core setup factor.
  {
    const uniF = factors.find(f => f.name === "Unicorn Model");
    if (uniF && (uniF as any)._promotedToTier1) {
      (uniF as any).tier = 1;
      uniF.detail += " [promoted to Tier 1: filling FVG core slot]";
    }
  }

  // Fix C: Demote FVG from Tier 1 → Tier 2 when the matched FVG was NOT created by displacement.
  // The FVG's `hasDisplacement` property is tagged at detection time by tagDisplacementQuality(),
  // so it correctly reflects whether displacement existed when the FVG was created (regardless of
  // how many candles ago that was). Without displacement, an FVG is just a random gap — it still
  // scores points but should not satisfy the "3 core factors" Tier 1 gate.
  {
    const fvgF = factors.find(f => f.name === "Fair Value Gap");
    if (fvgF && fvgF.present && (fvgF as any).tier === 1) {
      // Check if the FVG that was scored had displacement. We stash this during Factor 3 scoring.
      if (!(fvgF as any)._hasDisplacement) {
        (fvgF as any).tier = 2;
        fvgF.detail += " [demoted to Tier 2: no displacement confirmation]";
      }
    }
  }

  // ─── Regime Gate & Multi-TF Alignment (uses early-computed regimeInfo/regime4HInfo) ──────
  // regimeInfo and regime4HInfo were computed early (before Factor 4) for Fib 0.236 scoring.
  // This section handles the regime gate logic and multi-TF alignment adjustments.
  let regimeGatePassed = true;
  let regimeGateReason = "";
  {
    if (regimeInfo) {

      // ── Multi-TF Alignment Adjustment ──
      // When both timeframes are available, adjust the effective regime based on agreement/disagreement.
      // Daily is the primary regime; 4H provides confirmation or caution.
      const { adjustment, detail } = regimeAlignmentAdjustment(
        regimeInfo.regime, regimeInfo.confidence, direction, factors, regimeInfo.bias
      );

      // Multi-TF modifier: if 4H disagrees with daily, reduce confidence in the alignment
      let multiTFModifier = 0;
      let multiTFDetail = "";
      if (regime4HInfo) {
        const dailyTrending = regimeInfo.regime === "strong_trend" || regimeInfo.regime === "mild_trend";
        const dailyRanging = regimeInfo.regime === "choppy_range" || regimeInfo.regime === "mild_range";
        const h4Trending = regime4HInfo.regime === "strong_trend" || regime4HInfo.regime === "mild_trend";
        const h4Ranging = regime4HInfo.regime === "choppy_range" || regime4HInfo.regime === "mild_range";

        if ((dailyTrending && h4Trending) || (dailyRanging && h4Ranging)) {
          // Both timeframes agree — strengthen the signal
          multiTFModifier = 0.15;
          multiTFDetail = `Multi-TF AGREE: Daily ${regimeInfo.regime.replace("_", " ")} + 4H ${regime4HInfo.regime.replace("_", " ")} → +0.15 confidence boost`;
        } else if ((dailyTrending && h4Ranging) || (dailyRanging && h4Trending)) {
          // Timeframes disagree — caution, reduce confidence
          multiTFModifier = -0.25;
          multiTFDetail = `Multi-TF DISAGREE: Daily ${regimeInfo.regime.replace("_", " ")} vs 4H ${regime4HInfo.regime.replace("_", " ")} → -0.25 confidence reduction`;
        } else {
          // One is transitional — mild uncertainty
          multiTFModifier = -0.1;
          multiTFDetail = `Multi-TF MIXED: Daily ${regimeInfo.regime.replace("_", " ")} + 4H ${regime4HInfo.regime.replace("_", " ")} → -0.1 mild uncertainty`;
        }
      }

      // Apply multi-TF modifier to the alignment adjustment
      const effectiveAdjustment = adjustment + multiTFModifier;

      // Regime is now info-only for the score — but we track it for the gate
      // If effective adjustment is heavily negative (< -1.0), regime gate fails
      if (effectiveAdjustment < -1.0) {
        regimeGatePassed = false;
        regimeGateReason = `Regime mismatch: ${regimeInfo.regime.replace("_", " ")} — ${detail}${multiTFDetail ? " | " + multiTFDetail : ""}`;
      } else {
        regimeGateReason = `Regime OK: ${regimeInfo.regime.replace("_", " ")} — ${detail}${multiTFDetail ? " | " + multiTFDetail : ""}`;
      }

      // Include the 7-check indicator breakdown in the factor detail
      const indicatorSummary = regimeInfo.indicators.length > 0
        ? " | Checks: " + regimeInfo.indicators.join(" | ")
        : "";
      // Transition info
      const transitionSummary = regimeInfo.transition
        ? ` | Transition: ${regimeInfo.transition.state} (${(regimeInfo.transition.confidence * 100).toFixed(0)}% conf, momentum ${regimeInfo.transition.momentum > 0 ? "+" : ""}${regimeInfo.transition.momentum.toFixed(3)}/candle)`
        : "";
      // 4H regime summary
      const h4Summary = regime4HInfo
        ? ` | 4H Regime: ${regime4HInfo.regime.replace("_", " ")} (${(regime4HInfo.confidence * 100).toFixed(0)}% conf, bias ${regime4HInfo.bias})`
        : "";

      factors.push({
        name: "Regime Alignment",
        present: true,
        weight: 0, // No score impact — info only
        detail: `${regimeInfo.regime.replace("_", " ")} (${(regimeInfo.confidence * 100).toFixed(0)}% conf, ATR ${regimeInfo.atrTrend}, bias ${regimeInfo.bias}) — ${detail} [info-only gate]${transitionSummary}${h4Summary}${multiTFDetail ? " | " + multiTFDetail : ""}${indicatorSummary}`,
        group: "Macro Confirmation",
      });
    } else {
      factors.push({
        name: "Regime Alignment",
        present: false,
        weight: 0,
        detail: regimeScoringEnabled ? "Insufficient daily candles for regime classification" : "Regime scoring disabled",
        group: "Macro Confirmation",
      });
    }
  }

  // ─── Spread Quality (INFO-ONLY — never rejects a trade) ─────────────────────
  // Compares the instrument's typical spread against its ATR.
  // This is informational only — the bot uses market data provider indicative spreads,
  // not the user's actual broker spread (which is typically near-zero on ECN accounts).
  // The live spread check at execution time (via broker API) remains as the real guard.
  let spreadGatePassed = true; // Always true — info-only, never blocks
  let spreadGateReason = "";
  {
    const spreadSymbol = config._currentSymbol || "EUR/USD";
    const spreadSpec = SPECS[spreadSymbol] || SPECS["EUR/USD"];
    const typicalSpreadPrice = (spreadSpec.typicalSpread ?? 1) * spreadSpec.pipSize;
    const spreadATR = calculateATR(candles, 14);
    let spreadDetail = "";
    if (spreadATR > 0) {
      const spreadToATR = typicalSpreadPrice / spreadATR;
      if (spreadToATR < 0.05) {
        spreadDetail = `Excellent: spread ${spreadSpec.typicalSpread}p = ${(spreadToATR * 100).toFixed(1)}% of ATR`;
      } else if (spreadToATR < 0.10) {
        spreadDetail = `Acceptable: spread ${spreadSpec.typicalSpread}p = ${(spreadToATR * 100).toFixed(1)}% of ATR`;
      } else if (spreadToATR < 0.20) {
        spreadDetail = `Mediocre: spread ${spreadSpec.typicalSpread}p = ${(spreadToATR * 100).toFixed(1)}% of ATR`;
      } else {
        spreadDetail = `Wide (indicative): spread ${spreadSpec.typicalSpread}p = ${(spreadToATR * 100).toFixed(1)}% of ATR — info only, not blocking`;
        // spreadGatePassed remains true — info-only, does not reject
        spreadGateReason = `Spread wide (indicative): ${(spreadToATR * 100).toFixed(1)}% of ATR — info only`;
      }
      if (!spreadGateReason) {
        spreadGateReason = `Spread OK: ${(spreadToATR * 100).toFixed(1)}% of ATR`;
      }
    } else {
      spreadDetail = "ATR unavailable — no spread quality assessment";
    }
    factors.push({
      name: "Spread Quality",
      present: false, // Always false — info-only, never contributes to score
      weight: 0, // No score impact — info only
      detail: `${spreadDetail} [info-only — broker spread used at execution]`,
      group: "Macro Confirmation",
    });
  }

  // ─── Tiered Scoring Model ─────────────────────────────────────────────────
  // Replaces the old percentage-of-weighted-max system with a clear tiered model:
  //   Tier 1 (Core Setup): Market Structure, Order Block, FVG, Premium/Discount
  //     → Each present Tier 1 factor scores 2 points
  //     → Must have at least 2 Tier 1 factors to consider a trade
  //   Tier 2 (Confirmation): PD/PW Levels, Liquidity Sweep, Displacement, Reversal Candle, Session Quality
  //     → Each present Tier 2 factor scores 1 point
  //   Tier 3 (Bonus): Everything else (Currency Strength, SMT, Daily Bias, Breaker, Unicorn*, Volume, AMD, Judas)
  //     → Each present Tier 3 factor scores 0.5 points
  //   *Unicorn is promoted to Tier 1 when FVG is absent (it IS an FVG + Breaker overlap)
  //   Regime and Spread are separate pass/fail gates — they do NOT affect the score.
  //
  // Max possible = (4 × 2) + (5 × 1) + (8 × 0.5) + Po3 bonus (1.0) + OR bonus (2.0) = 20
  // Score percentage = tiered points / max possible × 100

  const TIER_POINTS = { 1: 2, 2: 1, 3: 0.5 } as const;

  // Max possible raw weight per factor (used for quality scaling)
  // Each factor's weight is divided by its max to get a 0–1 quality ratio
  const FACTOR_MAX_WEIGHT: Record<string, number> = {
    "Market Structure": 2.5,
    "Order Block": 2.0,
    "Fair Value Gap": 2.0,
    "Premium/Discount & Fib": 2.0,
    "Session Quality": 1.5,
    "Judas Swing": 0.75,
    "PD/PW Levels": 1.5,
    "Reversal Candle": 1.5,
    "Liquidity Sweep": 1.5,
    "Displacement": 1.0,
    "Breaker Block": 1.0,
    "Unicorn Model": 1.5,
    "SMT Divergence": 1.0,
    "Volume Profile": 0.75,
    "AMD Phase": 1.5,
    "Currency Strength": 1.5,
    "Daily Bias": 1.5,
    "Confluence Stack": 1.5,
    "Pullback Health": 0.5,
    "HTF POI Alignment": 2.0,
    "HTF Fib + PD + Liquidity": 2.5,
  };

  // Count tier 1 factors present (for the minimum gate)
  let tier1Count = 0;
  let tier1Max = 0;
  let tier2Count = 0;
  let tier2Max = 0;
  let tier3Count = 0;
  let tier3Max = 0;
  let tieredScore = 0;

  // Factor toggle map to check if factors are disabled
  const FACTOR_TOGGLE_MAP: Record<string, string> = {
    marketStructure: "enableStructureBreak",
    orderBlock: "enableOB",
    fairValueGap: "enableFVG",
    liquiditySweep: "enableLiquiditySweep",
    displacement: "useDisplacement",
    breakerBlock: "useBreakerBlocks",
    unicornModel: "useUnicornModel",
    smtDivergence: "useSMT",
    volumeProfile: "useVolumeProfile",
    amdPhase: "useAMD",
    currencyStrength: "useFOTSI",
    dailyBias: "useDailyBias",
  };

  const NAME_TO_KEY: Record<string, string> = {
    "Market Structure": "marketStructure",
    "Order Block": "orderBlock",
    "Fair Value Gap": "fairValueGap",
    "Premium/Discount & Fib": "premiumDiscountFib",
    "Session Quality": "sessionQuality",
    "Judas Swing": "judasSwing",
    "PD/PW Levels": "pdPwLevels",
    "Reversal Candle": "reversalCandle",
    "Liquidity Sweep": "liquiditySweep",
    "Displacement": "displacement",
    "Breaker Block": "breakerBlock",
    "Unicorn Model": "unicornModel",
    "SMT Divergence": "smtDivergence",
    "Volume Profile": "volumeProfile",
    "AMD Phase": "amdPhase",
    "Currency Strength": "currencyStrength",
    "Daily Bias": "dailyBias",
  };

  for (const f of factors) {
    const tier = (f as any).tier as number | undefined;
    if (!tier) continue; // Skip Regime, Spread, Po3, OR — they're not tiered

    // Check if factor is disabled via toggle
    const key = NAME_TO_KEY[f.name];
    if (key) {
      const toggleKey = FACTOR_TOGGLE_MAP[key];
      if (toggleKey && (config as any)[toggleKey] === false) continue;
    }

    const pts = TIER_POINTS[tier as keyof typeof TIER_POINTS] || 0.5;

    // Quality scaling: scale tier points by how good this factor's weight is
    // relative to its maximum possible weight. A pristine OB (2.0/2.0 = 1.0)
    // gets full tier points; a nearly-broken OB (0.3/2.0 = 0.15) gets 15%.
    // Floor at 0.2 so a present-but-weak factor still contributes something.
    const maxW = FACTOR_MAX_WEIGHT[f.name] || 1.0;
    const qualityRatio = Math.min(1.0, Math.max(0.2, f.weight / maxW));

    if (tier === 1) {
      tier1Max++;
      if (f.present && f.weight > 0) {
        tier1Count++;
        const scaled = Math.round(pts * qualityRatio * 100) / 100;
        tieredScore += scaled;
        f.detail += ` [Tier 1: +${scaled}/${pts}pts, Q:${(qualityRatio * 100).toFixed(0)}%]`;
      }
    } else if (tier === 2) {
      tier2Max++;
      if (f.present && f.weight > 0) {
        tier2Count++;
        const scaled = Math.round(pts * qualityRatio * 100) / 100;
        tieredScore += scaled;
        f.detail += ` [Tier 2: +${scaled}/${pts}pt, Q:${(qualityRatio * 100).toFixed(0)}%]`;
      }
    } else {
      tier3Max++;
      if (f.present && f.weight > 0) {
        tier3Count++;
        const scaled = Math.round(pts * qualityRatio * 100) / 100;
        tieredScore += scaled;
        f.detail += ` [Tier 3: +${scaled}/${pts}pts, Q:${(qualityRatio * 100).toFixed(0)}%]`;
      }
    }
  }

  // Add Po3 combo bonus if present
  const po3Factor = factors.find(f => f.name === "Power of 3 Combo" && f.present);
  if (po3Factor) tieredScore += 1.0;

  // Add Opening Range bonus if present
  const orFactor = factors.find(f => f.name && f.name.includes("Opening Range") && f.present);
  if (orFactor) tieredScore += Math.min(2.0, orFactor.weight);

  // Calculate max possible from enabled tiers + bonuses
  let tieredMax = (tier1Max * 2) + (tier2Max * 1) + (tier3Max * 0.5);
  // Add Po3 potential if prerequisites are enabled
  const po3Possible = (config as any).enableStructureBreak !== false
    && (config as any).useAMD !== false
    && (config as any).enableLiquiditySweep !== false;
  if (po3Possible) tieredMax += 1.0;
  if (config.openingRange?.enabled) tieredMax += 2.0;

  // ─── HTF Tier 1 Gate Enhancement ──────────────────────────────────────────
  // HTF zones (FVG, OB, Fib) can satisfy the corresponding Tier 1 slot
  // when the entry-TF factor is absent AND price is currently inside the HTF zone.
  // This allows higher-timeframe institutional zones to substitute for missing
  // entry-timeframe triggers, recognizing that a 4H FVG is MORE significant than a 15m FVG.
  {
    const htfPOIs: { timeframe: string; type: "fvg" | "ob" | "breaker"; high: number; low: number; direction: "bullish" | "bearish" }[] | null = (config as any)._htfPOIs || null;
    const htfFibDataForGate: { h4: FibLevels | null; h1: FibLevels | null } | null = (config as any)._htfFibLevels || null;
    const atrForGate = calculateATR(candles, 14);
    const fibToleranceGate = atrForGate * 0.3;

    // Check FVG slot: if entry-TF FVG is absent, can HTF FVG fill it?
    const fvgFactor = factors.find(f => f.name === "Fair Value Gap");
    const fvgAbsent = !fvgFactor || !fvgFactor.present || fvgFactor.weight <= 0 || (fvgFactor as any).tier !== 1;
    if (fvgAbsent && htfPOIs) {
      const htfFVGContainingPrice = htfPOIs.find(poi => poi.type === "fvg" && lastPrice >= poi.low && lastPrice <= poi.high);
      if (htfFVGContainingPrice) {
        tier1Count++;
        tier1Max++;
        // Add a synthetic Tier 1 contribution to tieredScore
        tieredScore += 2.0 * 0.8; // 80% quality since it's HTF substitute
        const htfFvgDetail = `HTF ${htfFVGContainingPrice.timeframe} FVG [${htfFVGContainingPrice.low.toFixed(5)}-${htfFVGContainingPrice.high.toFixed(5)}] satisfying Tier 1 FVG slot`;
        // Tag the HTF POI factor with the promotion info
        const htfPoiFactor = factors.find(f => f.name === "HTF POI Alignment");
        if (htfPoiFactor) {
          htfPoiFactor.detail += ` [HTF FVG promoted to Tier 1: ${htfFvgDetail}]`;
          (htfPoiFactor as any)._htfTier1FVG = true;
        }
      }
    }

    // Check OB slot: if entry-TF OB is absent, can HTF OB fill it?
    const obFactor = factors.find(f => f.name === "Order Block");
    const obAbsent = !obFactor || !obFactor.present || obFactor.weight <= 0 || (obFactor as any).tier !== 1;
    if (obAbsent && htfPOIs) {
      const htfOBContainingPrice = htfPOIs.find(poi => poi.type === "ob" && lastPrice >= poi.low && lastPrice <= poi.high);
      if (htfOBContainingPrice) {
        tier1Count++;
        tier1Max++;
        tieredScore += 2.0 * 0.8;
        const htfObDetail = `HTF ${htfOBContainingPrice.timeframe} OB [${htfOBContainingPrice.low.toFixed(5)}-${htfOBContainingPrice.high.toFixed(5)}] satisfying Tier 1 OB slot`;
        const htfPoiFactor = factors.find(f => f.name === "HTF POI Alignment");
        if (htfPoiFactor) {
          htfPoiFactor.detail += ` [HTF OB promoted to Tier 1: ${htfObDetail}]`;
          (htfPoiFactor as any)._htfTier1OB = true;
        }
      }
    }

    // Check Fib slot: if entry-TF Premium/Discount & Fib is absent, can HTF Fib fill it?
    const fibFactor = factors.find(f => f.name === "Premium/Discount & Fib");
    const fibAbsent = !fibFactor || !fibFactor.present || fibFactor.weight <= 0 || (fibFactor as any).tier !== 1;
    if (fibAbsent && htfFibDataForGate) {
      // Check if price is near a 4H Fib level (strongest HTF Fib)
      let htfFibSatisfied = false;
      let htfFibDetail = "";
      const checkFibForGate = (fibs: FibLevels | null, tfLabel: string) => {
        if (!fibs || !fibs.retracements || htfFibSatisfied) return;
        for (const level of fibs.retracements) {
          if (Math.abs(lastPrice - level.price) <= fibToleranceGate) {
            // Only key Fib levels qualify for Tier 1 (38.2%, 50%, 61.8%, 70.5%, 78.6%)
            if (level.ratio >= 0.382) {
              htfFibSatisfied = true;
              htfFibDetail = `HTF ${tfLabel} Fib ${level.label} at ${level.price.toFixed(5)} satisfying Tier 1 Fib slot`;
              break;
            }
          }
        }
      };
      checkFibForGate(htfFibDataForGate.h4, "4H");
      if (!htfFibSatisfied) checkFibForGate(htfFibDataForGate.h1, "1H");
      if (htfFibSatisfied) {
        tier1Count++;
        tier1Max++;
        tieredScore += 2.0 * 0.7; // 70% quality for Fib substitute (less precise than FVG/OB)
        const htfFibFactor = factors.find(f => f.name === "HTF Fib + PD + Liquidity");
        if (htfFibFactor) {
          htfFibFactor.detail += ` [HTF Fib promoted to Tier 1: ${htfFibDetail}]`;
          (htfFibFactor as any)._htfTier1Fib = true;
        }
      }
    }
  }

  // Recalculate tieredMax after potential HTF Tier 1 additions
  tieredMax = (tier1Max * 2) + (tier2Max * 1) + (tier3Max * 0.5);
  const po3Possible2 = (config as any).enableStructureBreak !== false
    && (config as any).useAMD !== false
    && (config as any).enableLiquiditySweep !== false;
  if (po3Possible2) tieredMax += 1.0;
  if (config.openingRange?.enabled) tieredMax += 2.0;

  // Recalculate score percentage after HTF Tier 1 adjustments
  const rawScore = Math.round(tieredScore * 100) / 100;
  const enabledMax = Math.round(tieredMax * 100) / 100;
  if (tieredMax > 0) {
    score = Math.round((tieredScore / tieredMax) * 1000) / 10;
  } else {
    score = 0;
  }

  // Tier 1 minimum gate: need at least 3 core factors
  // Raised from 2→3 to prevent low-quality entries that only have
  // Market Structure + Premium/Discount (directional bias without
  // an institutional entry trigger like OB or FVG).
  const tier1GatePassed = tier1Count >= 3;
  // Build display list: include Unicorn when it was promoted to Tier 1, and HTF-promoted slots
  const tier1DisplayNames = ["Market Structure", "Order Block", "Fair Value Gap", "Premium/Discount & Fib", "Unicorn Model"];
  const tier1PresentNames = tier1DisplayNames.filter(n => {
    const f = factors.find(ff => ff.name === n);
    return f && f.present && f.weight > 0 && (f as any).tier === 1;
  });
  // Add HTF-promoted slots to display
  const htfPoiF = factors.find(f => f.name === "HTF POI Alignment");
  if (htfPoiF && (htfPoiF as any)._htfTier1FVG) tier1PresentNames.push("HTF FVG (Tier 1)");
  if (htfPoiF && (htfPoiF as any)._htfTier1OB) tier1PresentNames.push("HTF OB (Tier 1)");
  const htfFibF = factors.find(f => f.name === "HTF Fib + PD + Liquidity");
  if (htfFibF && (htfFibF as any)._htfTier1Fib) tier1PresentNames.push("HTF Fib (Tier 1)");
  const tier1GateReason = tier1GatePassed
    ? `Tier 1 gate passed: ${tier1Count} core factors (${tier1PresentNames.join(", ")})`
    : `Tier 1 gate FAILED: only ${tier1Count} core factors — need at least 3 of: Market Structure, Order Block, Fair Value Gap, Premium/Discount & Fib${factors.find(f => f.name === "Unicorn Model" && (f as any)._promotedToTier1) ? ", Unicorn Model" : ""}, HTF FVG/OB/Fib`;

  // Strong factor count = Tier 1 + Tier 2 present (Tier 3 are bonuses, not "strong")
  const strongFactorCount = tier1Count + tier2Count;

  // Calculate SL/TP using configurable methods
  const symbolForSL = config._currentSymbol || "EUR/USD";
  const specSL = SPECS[symbolForSL] || SPECS["EUR/USD"];
  const pipSize = specSL.pipSize;
  const swings = structure.swingPoints;

  // Compute ATR for ATR-based methods (use entry candles)
  const atrValue = calculateATR(candles, config.slATRPeriod || 14);

  const { stopLoss, takeProfit } = calculateSLTP({
    direction, lastPrice, pipSize, config, swings, orderBlocks, liquidityPools, pdLevels, atrValue, fvgs,
    fibExtensions: fibLevels?.extensions,
  });

  const presentFactors = factors.filter(f => f.present);
  const enabledFactors = factors.filter(f => f.weight !== 0 || f.present);
  const bias = direction === "long" ? "bullish" : direction === "short" ? "bearish" : "neutral";

  // Build grouped summary
  const groupNames = [...new Set(factors.filter(f => f.group).map(f => f.group!))];
  const activeGroups = groupNames.filter(g => factors.some(f => f.group === g && f.present));
  const groupSummaryParts = activeGroups.map(g => {
    const gFactors = factors.filter(f => f.group === g && f.present);
    return `${g}: ${gFactors.map(f => f.name).join("+")}`;
  });

  const fotsiSummary = _fotsiAlignment ? ` | FOTSI: ${_fotsiAlignment.label}` : "";
  // Build gate summary for the scan output
  const gatesSummary = [
    tier1GatePassed ? null : "TIER1_GATE_FAIL",
    regimeGatePassed ? null : "REGIME_GATE_FAIL",
    // Spread gate is info-only — never blocks
  ].filter(Boolean);
  const gatesStr = gatesSummary.length > 0 ? ` | Gates: ${gatesSummary.join(", ")}` : "";

  const summary = direction
    ? `${direction === "long" ? "BUY" : "SELL"}: ${score}% confluence (T1:${tier1Count}/4, T2:${tier2Count}/5, T3:${tier3Count} bonus, ${strongFactorCount} strong). ${groupSummaryParts.join(" | ")}${fotsiSummary}${gatesStr}`
    : `No signal: ${score}% confluence (T1:${tier1Count}/4, T2:${tier2Count}/5, T3:${tier3Count} bonus)${fotsiSummary}${gatesStr}`;

  return {
    score, rawScore, normalizedScoring: true, enabledMax,
    strongFactorCount, direction, bias, summary, factors,
    structure, orderBlocks, fvgs, liquidityPools, judasSwing, reversalCandle,
    pd, session, pdLevels, lastPrice, stopLoss, takeProfit, displacement, breakerBlocks, unicornSetups, silverBullet, macroWindow, smt: smtResult, vwap, amd,
    fotsiAlignment: _fotsiAlignment, volumeProfile, regimeInfo, regime4HInfo,
    // Confluence stacking, sweep reclaim, pullback decay
    confluenceStacks, sweepReclaims, pullbackDecay,
    // HTF POI alignment data
    htfPOIs: (config as any)._htfPOIs || null,
    // ZigZag-based Fibonacci levels (retracements + extensions)
    fibLevels,
    // Cached daily structure (computed once, reusable by gates)
    cachedDailyStructure,
    // New tiered scoring metadata
    tieredScoring: {
      tier1Count, tier1Max, tier2Count, tier2Max, tier3Count, tier3Max,
      tieredScore, tieredMax,
      tier1GatePassed, tier1GateReason,
      regimeGatePassed, regimeGateReason,
      spreadGatePassed, spreadGateReason,
    },
  };
}
