/**
 * gamePlan.ts — Premarket Game Plan Engine
 *
 * Generates an automatic pre-session game plan for each instrument by analyzing:
 *   1. HTF bias (D1/4H structure — trend, BOS/CHoCH, premium/discount)
 *   2. Draw on Liquidity (DOL) — nearest unmitigated liquidity pools
 *   3. Key levels — PD H/L/O/C, PW H/L, significant OBs, FVGs, liquidity pools
 *   4. AMD phase — accumulation/manipulation/distribution cycle
 *   5. Regime classification — trending/ranging/volatile/quiet
 *   6. Scenario planning — conditional "if X then Y" trade plans
 *
 * The game plan is generated once before each session (London, NY, Asian)
 * and used by the scanner to filter trades that don't align with the thesis.
 */

import {
  type Candle,
  SPECS,
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFVGs,
  detectLiquidityPools,
  calculatePDLevels,
  calculatePremiumDiscount,
  calculateATR,
  detectAMDPhase,
  classifyInstrumentRegime,
  detectSwingPoints,
  toNYTime,
} from "./smcAnalysis.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SessionName = "London" | "New York" | "Asian";
export type BiasDirection = "bullish" | "bearish" | "neutral";

export interface DOLTarget {
  price: number;
  type: "buy-side" | "sell-side";
  description: string;
  /** Distance from current price in pips */
  distancePips: number;
  /** Strength: how many touches / how significant */
  strength: number;
}

export interface KeyLevel {
  price: number;
  label: string;
  type: "support" | "resistance" | "pd_level" | "ob" | "fvg" | "liquidity";
  significance: "high" | "medium" | "low";
}

export interface Scenario {
  condition: string;
  action: string;
  direction: "long" | "short";
  targetLevel?: number;
  invalidation?: string;
}

export interface InstrumentGamePlan {
  symbol: string;
  session: SessionName;
  /** Overall directional bias for this session */
  bias: BiasDirection;
  /** Confidence in the bias (0-100) */
  biasConfidence: number;
  /** Reasoning for the bias determination */
  biasReasoning: string[];
  /** Draw on Liquidity — where price is likely heading */
  dol: DOLTarget | null;
  /** Key levels to watch during the session */
  keyLevels: KeyLevel[];
  /** Conditional trade scenarios */
  scenarios: Scenario[];
  /** Current market regime */
  regime: string;
  /** AMD phase at time of analysis */
  amdPhase: string;
  /** Premium/discount zone */
  zone: string;
  zonePercent: number;
  /** HTF trend from daily structure */
  htfTrend: string;
  /** 4H trend */
  h4Trend: string;
  /** ATR for volatility context */
  atr: number;
  /** Whether to trade this instrument this session */
  tradeable: boolean;
  /** Reason if not tradeable */
  skipReason?: string;
  /** Last price at time of analysis */
  lastPrice: number;
  /** Timestamp of game plan generation */
  generatedAt: string;
}

export interface SessionGamePlan {
  session: SessionName;
  generatedAt: string;
  /** Instruments with clear bias — focus pairs for the session */
  focusPairs: string[];
  /** All instrument plans */
  plans: InstrumentGamePlan[];
  /** High-impact news events (populated separately) */
  newsEvents: NewsEvent[];
  /** Summary text for Telegram */
  summary: string;
}

export interface NewsEvent {
  time: string;
  currency: string;
  event: string;
  impact: "high" | "medium" | "low";
  forecast?: string;
  previous?: string;
}

// ─── Session Timing (NY time) ───────────────────────────────────────────────

/** Session open times in NY hours — game plan runs 30 min before */
const SESSION_TIMES: Record<SessionName, { preMarketNYHour: number; openNYHour: number; closeNYHour: number }> = {
  "Asian":    { preMarketNYHour: 19.5, openNYHour: 20, closeNYHour: 2 },
  "London":   { preMarketNYHour: 1.5,  openNYHour: 2,  closeNYHour: 8.5 },
  "New York": { preMarketNYHour: 8,    openNYHour: 8.5, closeNYHour: 16 },
};

/**
 * Determine which session is upcoming (within 30 min of open).
 * Returns null if no session is about to open.
 */
export function getUpcomingSession(): SessionName | null {
  const ny = toNYTime(new Date());
  const t = ny.t;
  for (const [name, times] of Object.entries(SESSION_TIMES)) {
    if (t >= times.preMarketNYHour && t < times.openNYHour) {
      return name as SessionName;
    }
  }
  return null;
}

/**
 * Determine the current active session.
 */
export function getCurrentSession(): SessionName {
  const ny = toNYTime(new Date());
  const t = ny.t;
  if (t >= 20 || t < 2) return "Asian";
  if (t >= 2 && t < 8.5) return "London";
  if (t >= 8.5 && t < 16) return "New York";
  // Off-hours — return the next upcoming session
  if (t >= 16 && t < 20) return "Asian";
  return "Asian";
}

// ─── DOL Identification ─────────────────────────────────────────────────────

/**
 * Identify the Draw on Liquidity — the nearest significant unmitigated
 * liquidity pool that price is likely targeting.
 *
 * ICT concept: price always seeks liquidity. The DOL tells us WHERE
 * price is heading, not just what pattern exists.
 */
function identifyDOL(
  lastPrice: number,
  liquidityPools: Array<{ price: number; type: "buy-side" | "sell-side"; strength: number; swept: boolean; state: string }>,
  pdLevels: ReturnType<typeof calculatePDLevels>,
  swingPoints: Array<{ type: "high" | "low"; price: number; significance?: string }>,
  htfTrend: string,
  pipSize: number,
): DOLTarget | null {
  const candidates: DOLTarget[] = [];

  // 1. Unmitigated liquidity pools (equal highs/lows)
  for (const pool of liquidityPools) {
    if (pool.swept || pool.state !== "active") continue;
    const dist = Math.abs(pool.price - lastPrice) / pipSize;
    if (dist < 5) continue; // too close to be a meaningful target
    candidates.push({
      price: pool.price,
      type: pool.type,
      description: `${pool.type === "buy-side" ? "Buy-side" : "Sell-side"} liquidity (${pool.strength} touches)`,
      distancePips: dist,
      strength: pool.strength * 2, // liquidity pools are high priority
    });
  }

  // 2. PD levels as DOL targets (PDH, PDL, PWH, PWL)
  if (pdLevels) {
    const pdTargets = [
      { price: pdLevels.pdh, type: "buy-side" as const, label: "Previous Day High" },
      { price: pdLevels.pdl, type: "sell-side" as const, label: "Previous Day Low" },
      { price: pdLevels.pwh, type: "buy-side" as const, label: "Previous Week High" },
      { price: pdLevels.pwl, type: "sell-side" as const, label: "Previous Week Low" },
    ];
    for (const t of pdTargets) {
      const dist = Math.abs(t.price - lastPrice) / pipSize;
      if (dist < 5) continue;
      // Only add if price hasn't already swept past this level
      const isAbove = lastPrice > t.price;
      const isBelow = lastPrice < t.price;
      if ((t.type === "buy-side" && isAbove) || (t.type === "sell-side" && isBelow)) continue;
      candidates.push({
        price: t.price,
        type: t.type,
        description: t.label,
        distancePips: dist,
        strength: t.label.includes("Week") ? 4 : 3,
      });
    }
  }

  // 3. External swing highs/lows as DOL
  const externalSwings = swingPoints.filter(s => s.significance === "external");
  for (const sw of externalSwings.slice(-6)) {
    const dist = Math.abs(sw.price - lastPrice) / pipSize;
    if (dist < 10) continue;
    const isAbove = sw.price > lastPrice;
    candidates.push({
      price: sw.price,
      type: isAbove ? "buy-side" : "sell-side",
      description: `External swing ${sw.type === "high" ? "high" : "low"}`,
      distancePips: dist,
      strength: 2,
    });
  }

  if (candidates.length === 0) return null;

  // Score candidates: prefer closer targets with higher strength, aligned with HTF trend
  for (const c of candidates) {
    let score = c.strength;
    // Trend alignment bonus
    if (htfTrend === "bullish" && c.type === "buy-side") score += 3;
    if (htfTrend === "bearish" && c.type === "sell-side") score += 3;
    // Proximity bonus (closer = more likely to be reached this session)
    if (c.distancePips < 50) score += 2;
    else if (c.distancePips < 100) score += 1;
    // Penalize very far targets
    if (c.distancePips > 200) score -= 2;
    c.strength = score;
  }

  // Return the highest-scoring DOL
  candidates.sort((a, b) => b.strength - a.strength);
  return candidates[0];
}

// ─── Bias Determination ─────────────────────────────────────────────────────

/**
 * Determine the directional bias for an instrument by combining:
 * - Daily structure trend (BOS/CHoCH)
 * - 4H structure trend
 * - Premium/discount zone
 * - AMD phase
 * - DOL direction
 * - Regime classification
 */
function determineBias(
  dailyTrend: string,
  h4Trend: string,
  zone: string,
  zonePercent: number,
  amd: { phase: string; bias: string | null },
  dol: DOLTarget | null,
  regime: { regime: string; directionalBias: string; confidence: number },
): { bias: BiasDirection; confidence: number; reasoning: string[] } {
  let bullishVotes = 0;
  let bearishVotes = 0;
  const reasoning: string[] = [];

  // 1. Daily trend (weight: 3)
  if (dailyTrend === "bullish") {
    bullishVotes += 3;
    reasoning.push("D1 structure: bullish (HH/HL)");
  } else if (dailyTrend === "bearish") {
    bearishVotes += 3;
    reasoning.push("D1 structure: bearish (LH/LL)");
  } else {
    reasoning.push("D1 structure: ranging — no clear trend");
  }

  // 2. 4H trend (weight: 2)
  if (h4Trend === "bullish") {
    bullishVotes += 2;
    reasoning.push("4H structure: bullish");
  } else if (h4Trend === "bearish") {
    bearishVotes += 2;
    reasoning.push("4H structure: bearish");
  } else {
    reasoning.push("4H structure: ranging");
  }

  // 3. Premium/Discount zone (weight: 2)
  if (zone === "discount" && zonePercent < 40) {
    bullishVotes += 2;
    reasoning.push(`Price in discount zone (${zonePercent.toFixed(0)}%) — look for longs`);
  } else if (zone === "premium" && zonePercent > 60) {
    bearishVotes += 2;
    reasoning.push(`Price in premium zone (${zonePercent.toFixed(0)}%) — look for shorts`);
  } else {
    reasoning.push(`Price in equilibrium (${zonePercent.toFixed(0)}%)`);
  }

  // 4. AMD phase (weight: 2)
  if (amd.bias === "bullish") {
    bullishVotes += 2;
    reasoning.push(`AMD: ${amd.phase} — bullish bias (sell-side swept)`);
  } else if (amd.bias === "bearish") {
    bearishVotes += 2;
    reasoning.push(`AMD: ${amd.phase} — bearish bias (buy-side swept)`);
  } else {
    reasoning.push(`AMD: ${amd.phase} — no clear sweep bias`);
  }

  // 5. DOL direction (weight: 1)
  if (dol) {
    if (dol.type === "buy-side") {
      bullishVotes += 1;
      reasoning.push(`DOL: buy-side at ${dol.price.toFixed(5)} (${dol.description})`);
    } else {
      bearishVotes += 1;
      reasoning.push(`DOL: sell-side at ${dol.price.toFixed(5)} (${dol.description})`);
    }
  }

  // 6. Regime directional bias (weight: 1)
  if (regime.directionalBias === "bullish") {
    bullishVotes += 1;
    reasoning.push(`Regime: ${regime.regime} (bullish bias, ${regime.confidence}% conf)`);
  } else if (regime.directionalBias === "bearish") {
    bearishVotes += 1;
    reasoning.push(`Regime: ${regime.regime} (bearish bias, ${regime.confidence}% conf)`);
  } else {
    reasoning.push(`Regime: ${regime.regime} (neutral)`);
  }

  // Calculate final bias
  const totalVotes = bullishVotes + bearishVotes;
  const maxPossible = 11; // 3+2+2+2+1+1
  let bias: BiasDirection;
  let confidence: number;

  if (totalVotes === 0) {
    bias = "neutral";
    confidence = 0;
  } else if (bullishVotes > bearishVotes) {
    bias = "bullish";
    confidence = Math.round((bullishVotes / maxPossible) * 100);
  } else if (bearishVotes > bullishVotes) {
    bias = "bearish";
    confidence = Math.round((bearishVotes / maxPossible) * 100);
  } else {
    // Tie — neutral
    bias = "neutral";
    confidence = Math.round(((bullishVotes + bearishVotes) / maxPossible) * 50);
  }

  return { bias, confidence, reasoning };
}

// ─── Key Level Extraction ───────────────────────────────────────────────────

function extractKeyLevels(
  lastPrice: number,
  pdLevels: ReturnType<typeof calculatePDLevels>,
  orderBlocks: Array<{ type: string; high: number; low: number; isActive: boolean }>,
  fvgs: Array<{ type: string; high: number; low: number; filled: boolean }>,
  liquidityPools: Array<{ price: number; type: string; swept: boolean; state: string; strength: number }>,
  pipSize: number,
): KeyLevel[] {
  const levels: KeyLevel[] = [];
  const maxDistPips = 300; // only show levels within 300 pips

  // PD levels
  if (pdLevels) {
    const pdEntries: Array<{ price: number; label: string; sig: "high" | "medium" }> = [
      { price: pdLevels.pdh, label: "PDH", sig: "high" },
      { price: pdLevels.pdl, label: "PDL", sig: "high" },
      { price: pdLevels.pwh, label: "PWH", sig: "high" },
      { price: pdLevels.pwl, label: "PWL", sig: "high" },
      { price: pdLevels.dailyOpen, label: "Daily Open", sig: "medium" },
      { price: pdLevels.weeklyOpen, label: "Weekly Open", sig: "medium" },
      { price: pdLevels.monthlyOpen, label: "Monthly Open", sig: "medium" },
    ];
    for (const e of pdEntries) {
      if (Math.abs(e.price - lastPrice) / pipSize <= maxDistPips) {
        levels.push({
          price: e.price,
          label: e.label,
          type: "pd_level",
          significance: e.sig,
        });
      }
    }
  }

  // Active Order Blocks (nearest 3 above + 3 below)
  const activeOBs = orderBlocks.filter(ob => ob.isActive);
  const obAbove = activeOBs.filter(ob => ob.low > lastPrice).sort((a, b) => a.low - b.low).slice(0, 3);
  const obBelow = activeOBs.filter(ob => ob.high < lastPrice).sort((a, b) => b.high - a.high).slice(0, 3);
  for (const ob of [...obAbove, ...obBelow]) {
    const mid = (ob.high + ob.low) / 2;
    if (Math.abs(mid - lastPrice) / pipSize <= maxDistPips) {
      levels.push({
        price: mid,
        label: `${ob.type === "bullish" ? "Bullish" : "Bearish"} OB (${ob.low.toFixed(5)}-${ob.high.toFixed(5)})`,
        type: "ob",
        significance: "high",
      });
    }
  }

  // Unfilled FVGs (nearest 2 above + 2 below)
  const activeFVGs = fvgs.filter(f => !f.filled);
  const fvgAbove = activeFVGs.filter(f => f.low > lastPrice).sort((a, b) => a.low - b.low).slice(0, 2);
  const fvgBelow = activeFVGs.filter(f => f.high < lastPrice).sort((a, b) => b.high - a.high).slice(0, 2);
  for (const f of [...fvgAbove, ...fvgBelow]) {
    const mid = (f.high + f.low) / 2;
    if (Math.abs(mid - lastPrice) / pipSize <= maxDistPips) {
      levels.push({
        price: mid,
        label: `${f.type === "bullish" ? "Bullish" : "Bearish"} FVG (${f.low.toFixed(5)}-${f.high.toFixed(5)})`,
        type: "fvg",
        significance: "medium",
      });
    }
  }

  // Active liquidity pools
  for (const pool of liquidityPools) {
    if (pool.swept || pool.state !== "active") continue;
    if (Math.abs(pool.price - lastPrice) / pipSize <= maxDistPips) {
      levels.push({
        price: pool.price,
        label: `${pool.type === "buy-side" ? "Buy-side" : "Sell-side"} liquidity (${pool.strength}x)`,
        type: "liquidity",
        significance: pool.strength >= 3 ? "high" : "medium",
      });
    }
  }

  // Sort by distance from current price
  levels.sort((a, b) => Math.abs(a.price - lastPrice) - Math.abs(b.price - lastPrice));
  return levels;
}

// ─── Scenario Generation ────────────────────────────────────────────────────

function generateScenarios(
  symbol: string,
  bias: BiasDirection,
  dol: DOLTarget | null,
  keyLevels: KeyLevel[],
  lastPrice: number,
  amd: { phase: string; bias: string | null; asianHigh: number | null; asianLow: number | null },
  pipSize: number,
): Scenario[] {
  const scenarios: Scenario[] = [];

  if (bias === "neutral") {
    scenarios.push({
      condition: "No clear directional bias — wait for structure to develop",
      action: "Sit out or reduce size. Only trade clear setups with high confluence.",
      direction: "long",
      invalidation: "If price breaks above or below the range with displacement, reassess bias",
    });
    return scenarios;
  }

  // Primary scenario: aligned with bias
  if (bias === "bullish") {
    // Look for longs from discount/OB/FVG
    const supportLevels = keyLevels.filter(l =>
      l.price < lastPrice && (l.type === "ob" || l.type === "fvg" || l.type === "pd_level")
    ).slice(0, 2);

    if (supportLevels.length > 0) {
      const entryZone = supportLevels[0];
      scenarios.push({
        condition: `Price pulls back to ${entryZone.label} at ${entryZone.price.toFixed(5)}`,
        action: `Look for bullish reaction (OB/FVG entry, displacement candle) for long entry`,
        direction: "long",
        targetLevel: dol?.type === "buy-side" ? dol.price : undefined,
        invalidation: `Close below ${entryZone.price.toFixed(5)} with displacement`,
      });
    }

    // AMD-based scenario
    if (amd.asianLow != null) {
      scenarios.push({
        condition: `Price sweeps Asian low (${amd.asianLow.toFixed(5)}) during London`,
        action: "Wait for reclaim above Asian low, then enter long targeting Asian high and beyond",
        direction: "long",
        targetLevel: amd.asianHigh ?? undefined,
        invalidation: "Price fails to reclaim Asian low within 30 minutes of sweep",
      });
    }

    // Counter-trend scenario (defensive)
    scenarios.push({
      condition: `Price breaks below key support with strong displacement`,
      action: "Bias invalidated — switch to neutral, do not force longs",
      direction: "short",
      invalidation: "Bullish CHoCH on 4H restores bullish bias",
    });
  } else {
    // Bearish bias — look for shorts from premium/OB/FVG
    const resistanceLevels = keyLevels.filter(l =>
      l.price > lastPrice && (l.type === "ob" || l.type === "fvg" || l.type === "pd_level")
    ).slice(0, 2);

    if (resistanceLevels.length > 0) {
      const entryZone = resistanceLevels[0];
      scenarios.push({
        condition: `Price rallies to ${entryZone.label} at ${entryZone.price.toFixed(5)}`,
        action: `Look for bearish reaction (OB/FVG rejection, displacement candle) for short entry`,
        direction: "short",
        targetLevel: dol?.type === "sell-side" ? dol.price : undefined,
        invalidation: `Close above ${entryZone.price.toFixed(5)} with displacement`,
      });
    }

    // AMD-based scenario
    if (amd.asianHigh != null) {
      scenarios.push({
        condition: `Price sweeps Asian high (${amd.asianHigh.toFixed(5)}) during London`,
        action: "Wait for rejection below Asian high, then enter short targeting Asian low and beyond",
        direction: "short",
        targetLevel: amd.asianLow ?? undefined,
        invalidation: "Price holds above Asian high for 30+ minutes after sweep",
      });
    }

    // Counter-trend scenario (defensive)
    scenarios.push({
      condition: `Price breaks above key resistance with strong displacement`,
      action: "Bias invalidated — switch to neutral, do not force shorts",
      direction: "long",
      invalidation: "Bearish CHoCH on 4H restores bearish bias",
    });
  }

  return scenarios;
}

// ─── Main Game Plan Generator ───────────────────────────────────────────────

/**
 * Generate a game plan for a single instrument.
 *
 * @param symbol - Instrument symbol (e.g., "EUR/USD")
 * @param dailyCandles - D1 candles (at least 20)
 * @param h4Candles - 4H candles (at least 20)
 * @param entryCandles - Entry timeframe candles (15m/1H)
 * @param hourlyCandles - 1H candles for AMD detection
 * @param session - Which session this plan is for
 */
export function generateInstrumentGamePlan(
  symbol: string,
  dailyCandles: Candle[],
  h4Candles: Candle[],
  entryCandles: Candle[],
  hourlyCandles: Candle[],
  session: SessionName,
): InstrumentGamePlan {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const lastPrice = entryCandles.length > 0
    ? entryCandles[entryCandles.length - 1].close
    : (dailyCandles.length > 0 ? dailyCandles[dailyCandles.length - 1].close : 0);

  // ── HTF Analysis ──
  const dailyStructure = dailyCandles.length >= 10
    ? analyzeMarketStructure(dailyCandles.slice(-50))
    : null;
  const h4Structure = h4Candles.length >= 10
    ? analyzeMarketStructure(h4Candles.slice(-50))
    : null;

  const htfTrend = dailyStructure?.trend || "ranging";
  const h4Trend = h4Structure?.trend || "ranging";

  // ── Premium/Discount ──
  const pd = calculatePremiumDiscount(entryCandles.length > 0 ? entryCandles : dailyCandles);

  // ── PD Levels ──
  const pdLevels = dailyCandles.length >= 10 ? calculatePDLevels(dailyCandles) : null;

  // ── Order Blocks & FVGs (from 4H for game plan — bigger picture) ──
  const h4StructureBreaks = h4Structure
    ? [...h4Structure.bos, ...h4Structure.choch]
    : [];
  const orderBlocks = h4Candles.length >= 10
    ? detectOrderBlocks(h4Candles, h4StructureBreaks)
    : [];
  const fvgs = h4Candles.length >= 10
    ? detectFVGs(h4Candles, h4StructureBreaks)
    : [];

  // ── Liquidity Pools (from daily for bigger targets) ──
  const liquidityPools = dailyCandles.length >= 10
    ? detectLiquidityPools(dailyCandles, 0.001, 2)
    : [];

  // ── Swing Points ──
  const dailySwings = dailyCandles.length >= 10
    ? detectSwingPoints(dailyCandles, 5)
    : [];

  // ── AMD Phase ──
  const amd = hourlyCandles.length >= 5
    ? detectAMDPhase(hourlyCandles)
    : { phase: "unknown" as const, bias: null, asianHigh: null, asianLow: null, sweptSide: null, detail: "" };

  // ── Regime Classification ──
  const regimeResult = dailyCandles.length >= 20
    ? classifyInstrumentRegime(dailyCandles)
    : { regime: "unknown", confidence: 0, directionalBias: "neutral", atrTrend: "stable", indicators: [], atr14: 0, rangePercent: 0 };

  // ── ATR ──
  const atr = dailyCandles.length >= 15
    ? calculateATR(dailyCandles, 14)
    : 0;

  // ── DOL Identification ──
  const dol = identifyDOL(
    lastPrice,
    liquidityPools,
    pdLevels,
    dailySwings,
    htfTrend,
    spec.pipSize,
  );

  // ── Bias Determination ──
  const { bias, confidence, reasoning } = determineBias(
    htfTrend,
    h4Trend,
    pd.currentZone,
    pd.zonePercent,
    amd,
    dol,
    regimeResult,
  );

  // ── Key Levels ──
  const keyLevels = extractKeyLevels(
    lastPrice,
    pdLevels,
    orderBlocks,
    fvgs,
    liquidityPools,
    spec.pipSize,
  );

  // ── Scenarios ──
  const scenarios = generateScenarios(
    symbol,
    bias,
    dol,
    keyLevels,
    lastPrice,
    amd,
    spec.pipSize,
  );

  // ── Tradeable Assessment ──
  let tradeable = true;
  let skipReason: string | undefined;

  // Skip if regime is too volatile or quiet
  if (regimeResult.regime === "volatile" && regimeResult.confidence > 70) {
    tradeable = false;
    skipReason = "High volatility regime — increased risk of whipsaws";
  }
  // Skip if no clear bias and regime is ranging
  if (bias === "neutral" && regimeResult.regime === "ranging") {
    tradeable = false;
    skipReason = "No clear bias in ranging market — wait for structure development";
  }
  // Skip crypto during FX sessions (unless it's the Asian session)
  if (spec.type === "crypto" && session !== "Asian" && session !== "New York") {
    // Crypto trades all sessions, but note reduced volume
  }

  return {
    symbol,
    session,
    bias,
    biasConfidence: confidence,
    biasReasoning: reasoning,
    dol,
    keyLevels,
    scenarios,
    regime: regimeResult.regime,
    amdPhase: amd.phase,
    zone: pd.currentZone,
    zonePercent: pd.zonePercent,
    htfTrend,
    h4Trend,
    atr,
    tradeable,
    skipReason,
    lastPrice,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Session Game Plan (all instruments) ────────────────────────────────────

/**
 * Generate a full session game plan for all enabled instruments.
 * This is the main entry point called by the bot scanner.
 */
export function buildSessionGamePlan(
  session: SessionName,
  instrumentPlans: InstrumentGamePlan[],
): SessionGamePlan {
  const focusPairs = instrumentPlans
    .filter(p => p.tradeable && p.bias !== "neutral" && p.biasConfidence >= 30)
    .sort((a, b) => b.biasConfidence - a.biasConfidence)
    .map(p => p.symbol);

  // Build summary
  const summaryLines: string[] = [];
  summaryLines.push(`📋 <b>Game Plan — ${session} Session</b>\n`);

  if (focusPairs.length === 0) {
    summaryLines.push("⚠️ No high-confidence setups — reduced exposure recommended\n");
  } else {
    summaryLines.push(`<b>Focus:</b> ${focusPairs.length} pair(s)\n`);
  }

  for (const plan of instrumentPlans) {
    const emoji = plan.bias === "bullish" ? "🟢" : plan.bias === "bearish" ? "🔴" : "⚪";
    const tradeLabel = plan.tradeable ? "" : " [SKIP]";
    summaryLines.push(
      `${emoji} <b>${plan.symbol}:</b> ${plan.bias.toUpperCase()} (${plan.biasConfidence}%)${tradeLabel}`
    );
    if (plan.dol) {
      summaryLines.push(`   DOL: ${plan.dol.description} @ ${plan.dol.price.toFixed(5)}`);
    }
    if (plan.scenarios.length > 0 && plan.tradeable) {
      summaryLines.push(`   Plan: ${plan.scenarios[0].condition}`);
    }
    if (plan.skipReason) {
      summaryLines.push(`   Skip: ${plan.skipReason}`);
    }
  }

  return {
    session,
    generatedAt: new Date().toISOString(),
    focusPairs,
    plans: instrumentPlans,
    newsEvents: [], // populated separately by economic calendar
     summary: summaryLines.join("\n"),
  };
}

/**
 * Fetch today's high-impact economic events from the fundamentals function.
 * Called by bot-scanner after building the game plan to enrich it with news awareness.
 *
 * @param supabaseUrl - The Supabase project URL
 * @param serviceRoleKey - The Supabase service role key
 * @param instruments - List of instrument symbols to check news for
 * @returns Array of high-impact news events relevant to the instruments
 */
export async function fetchNewsForGamePlan(
  supabaseUrl: string,
  serviceRoleKey: string,
  instruments: string[],
): Promise<NewsEvent[]> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/fundamentals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ action: "data" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    const todayEvents: any[] = data.todayEvents || [];

    // Extract currencies from instruments
    const currencies = new Set<string>();
    for (const sym of instruments) {
      const parts = sym.split("/");
      if (parts.length === 2) {
        currencies.add(parts[0]);
        currencies.add(parts[1]);
      }
    }

    // Filter to high/medium impact events relevant to our instruments
    return todayEvents
      .filter((e: any) => {
        const impact = e.impact || "low";
        return (impact === "high" || impact === "medium") && currencies.has(e.currency);
      })
      .map((e: any) => ({
        time: e.scheduledTime || e.date || "",
        currency: e.currency || "",
        event: e.name || e.title || "Unknown event",
        impact: e.impact as "high" | "medium" | "low",
        forecast: e.forecast || undefined,
        previous: e.previous || undefined,
      }))
      .sort((a: NewsEvent, b: NewsEvent) => new Date(a.time).getTime() - new Date(b.time).getTime());
  } catch {
    return [];
  }
}

/**
 * Enrich a session game plan with news events and update the summary.
 */
export function enrichGamePlanWithNews(
  gamePlan: SessionGamePlan,
  newsEvents: NewsEvent[],
): SessionGamePlan {
  gamePlan.newsEvents = newsEvents;

  if (newsEvents.length > 0) {
    // Add news section to summary
    const newsLines: string[] = ["\n\n\ud83d\udcf0 <b>Today's Events:</b>"];
    for (const ev of newsEvents.slice(0, 8)) {
      const timeStr = new Date(ev.time).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", timeZone: "America/New_York",
      });
      const impactEmoji = ev.impact === "high" ? "\ud83d\udfe5" : "\ud83d\udfe7";
      newsLines.push(`${impactEmoji} ${timeStr} ET — ${ev.currency}: ${ev.event}`);
    }
    gamePlan.summary += newsLines.join("\n");
  }

  return gamePlan;
}

// ── Game Plan Trade Filter ─────────────────────────────────────────────────

export interface GamePlanFilterResult {
  allowed: boolean;
  reason: string;
  gamePlanBias: BiasDirection;
  signalDirection: string;
  biasConfidence: number;
}

/**
 * Check if a trade signal aligns with the game plan.
 * Used by the scanner to gate trades.
 *
 * @param gamePlan - The current session game plan (or null if none)
 * @param symbol - The instrument being traded
 * @param signalDirection - "long" or "short"
 * @returns Whether the trade is allowed and why
 */
export function filterTradeByGamePlan(
  gamePlan: SessionGamePlan | null,
  symbol: string,
  signalDirection: string,
): GamePlanFilterResult {
  // No game plan — allow all trades (backward compatible)
  if (!gamePlan) {
    return { allowed: true, reason: "No game plan active — using confluence scoring only", gamePlanBias: "neutral", signalDirection, biasConfidence: 0 };
  }

  const plan = gamePlan.plans.find(p => p.symbol === symbol);
  if (!plan) {
    return { allowed: true, reason: `No game plan for ${symbol} — using confluence scoring only`, gamePlanBias: "neutral", signalDirection, biasConfidence: 0 };
  }

  // If instrument is marked as not tradeable, reject
  if (!plan.tradeable) {
    return { allowed: false, reason: `Game plan: ${symbol} marked as skip — ${plan.skipReason}`, gamePlanBias: plan.bias, signalDirection, biasConfidence: plan.biasConfidence };
  }

  // Neutral bias — allow but with reduced confidence
  if (plan.bias === "neutral") {
    return { allowed: true, reason: `Game plan: neutral bias — trade allowed but with caution`, gamePlanBias: "neutral", signalDirection, biasConfidence: plan.biasConfidence };
  }

  // Check alignment
  const biasDirection = plan.bias === "bullish" ? "long" : "short";
  if (signalDirection === biasDirection) {
    return { allowed: true, reason: `Game plan: ${signalDirection} aligns with ${plan.bias} bias (${plan.biasConfidence}%)`, gamePlanBias: plan.bias, signalDirection, biasConfidence: plan.biasConfidence };
  }

  // Misaligned — reject
  return {
    allowed: false,
    reason: `Game plan: ${signalDirection} REJECTED — bias is ${plan.bias} (${plan.biasConfidence}%), signal is ${signalDirection}`,
    gamePlanBias: plan.bias,
    signalDirection,
    biasConfidence: plan.biasConfidence,
  };
}
