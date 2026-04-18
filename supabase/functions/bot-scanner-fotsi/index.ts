// ═══════════════════════════════════════════════════════════════════
// Bot #2 — FOTSI Mean Reversion Scanner
// ═══════════════════════════════════════════════════════════════════
// Strategy: Magala-style currency strength mean reversion.
//
// 1. Compute FOTSI for all 8 currencies
// 2. Find pairs with widest divergence (one strong, one weak)
// 3. Wait for the "hook" — TSI line curving back from extremes
// 4. Enter mean-reversion trade: SELL overbought, BUY oversold
// 5. TP at EMA 50 (partial) and EMA 100 (full)
// 6. SL at structure or ATR-based
//
// This runs as a SEPARATE Edge Function alongside the SMC bot-scanner.
// Both bots share paper_positions (tagged with bot_id) and the same
// paper-trading exit engine.
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  computeFOTSI,
  CURRENCIES,
  Currency,
  detectCurve,
  FOTSI_NEUTRAL_LOWER,
  FOTSI_NEUTRAL_UPPER,
  FOTSI_OVERBOUGHT,
  FOTSI_OVERSOLD,
  FOTSI_PAIRS,
  FOTSIResult,
  parsePairCurrencies,
} from "../_shared/fotsi.ts";
import {
  fetchCandlesWithFallback,
  type Candle,
} from "../_shared/candleSource.ts";

// ─── Constants ─────────────────────────────────────────────────────

const BOT_ID = "fotsi_mr";
const BOT_NAME = "FOTSI Mean Reversion";

/** Default config for Bot #2 */
const DEFAULTS = {
  // FOTSI thresholds
  minDivergenceSpread: 40,       // Min TSI spread between base and quote
  hookRequired: true,             // Require hook signal for entry
  hookBars: 3,                    // Bars to detect hook (matches trigger bar = 3)
  minExtremeLevel: 25,            // Currency must be outside ±25 neutral zone

  // Risk management
  riskPerTrade: 1.0,              // % of balance per trade
  maxConcurrent: 3,               // Max open positions
  cooldownMinutes: 240,           // 4 hours between trades on same pair
  maxDailyLoss: 3.0,              // % max daily loss
  maxDailyTrades: 5,              // Max trades per day

  // SL/TP
  slMethod: "atr" as "structure" | "atr" | "fixed",
  slATRMultiplier: 2.0,           // ATR multiplier for SL
  slFixedPips: 50,                // Fixed SL pips (fallback)
  slBufferPips: 2,                // Buffer above/below SL level
  minRR: 2.0,                     // Minimum risk:reward ratio
  tp1Method: "ema50" as "ema50" | "fixed_rr",
  tp2Method: "ema100" as "ema100" | "fixed_rr",
  tp1RR: 1.5,                     // R:R for TP1 if fixed_rr
  tp2RR: 3.0,                     // R:R for TP2 if fixed_rr
  partialClosePercent: 50,        // % to close at TP1

  // Exit management
  maxHoldHours: 48,               // Max hold time
  breakEvenAfterTP1: true,        // Move SL to entry after TP1

  // Session filter
  sessions: {
    london: true,
    newYork: true,
    asian: false,
    sydney: false,
  },
  killZoneOnly: false,

  // EMA periods for TP calculation
  ema50Period: 50,
  ema100Period: 100,

  // Candle timeframe
  entryTimeframe: "4h" as "1h" | "4h",
};

type Config = typeof DEFAULTS;

// ─── Instrument specs (pip values, min lot, etc.) ──────────────────

const SPECS: Record<string, { pipSize: number; pipValue: number; minLot: number; maxLot: number }> = {
  "EUR/USD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "GBP/USD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "AUD/USD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "NZD/USD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "USD/CAD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "USD/CHF": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "EUR/GBP": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "EUR/CHF": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "EUR/JPY": { pipSize: 0.01, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "EUR/AUD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "EUR/CAD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "EUR/NZD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "GBP/JPY": { pipSize: 0.01, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "GBP/CHF": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "GBP/AUD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "GBP/CAD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "GBP/NZD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "AUD/JPY": { pipSize: 0.01, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "AUD/CAD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "AUD/CHF": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "AUD/NZD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "CAD/JPY": { pipSize: 0.01, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "CAD/CHF": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "CHF/JPY": { pipSize: 0.01, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "NZD/JPY": { pipSize: 0.01, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "NZD/CAD": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
  "NZD/CHF": { pipSize: 0.0001, pipValue: 10, minLot: 0.01, maxLot: 100 },
};

// ─── EMA calculation ───────────────────────────────────────────────

function calculateEMA(candles: Candle[], period: number): number[] {
  if (candles.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [candles[0].close];
  for (let i = 1; i < candles.length; i++) {
    out.push(candles[i].close * k + out[i - 1] * (1 - k));
  }
  return out;
}

/** Get the current EMA value (last element) */
function currentEMA(candles: Candle[], period: number): number | null {
  const emaValues = calculateEMA(candles, period);
  return emaValues.length > 0 ? emaValues[emaValues.length - 1] : null;
}

// ─── ATR calculation ───────────────────────────────────────────────

function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trs.push(tr);
  }
  // Simple average of last `period` TRs
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ─── Swing detection (for structure-based SL) ──────────────────────

function findRecentSwingHigh(candles: Candle[], lookback: number = 20): number {
  const slice = candles.slice(-lookback);
  let highest = -Infinity;
  for (const c of slice) {
    if (c.high > highest) highest = c.high;
  }
  return highest;
}

function findRecentSwingLow(candles: Candle[], lookback: number = 20): number {
  const slice = candles.slice(-lookback);
  let lowest = Infinity;
  for (const c of slice) {
    if (c.low < lowest) lowest = c.low;
  }
  return lowest;
}

// ─── Session detection ─────────────────────────────────────────────

function toNYTime(date: Date): Date {
  const utcMs = date.getTime();
  const nyOffset = -4 * 60 * 60 * 1000; // EDT (simplified)
  return new Date(utcMs + nyOffset);
}

function detectSession(now: Date): { london: boolean; newYork: boolean; asian: boolean; sydney: boolean } {
  const ny = toNYTime(now);
  const h = ny.getUTCHours();
  return {
    sydney: h >= 17 || h < 2,    // 5pm - 2am NY
    asian: h >= 19 || h < 4,     // 7pm - 4am NY
    london: h >= 3 && h < 12,    // 3am - 12pm NY
    newYork: h >= 8 && h < 17,   // 8am - 5pm NY
  };
}

// ─── Position sizing ───────────────────────────────────────────────

function calculatePositionSize(
  balance: number,
  riskPercent: number,
  slPips: number,
  pipValue: number,
  minLot: number,
  maxLot: number,
): number {
  if (slPips <= 0 || pipValue <= 0) return minLot;
  const riskAmount = balance * (riskPercent / 100);
  const rawLots = riskAmount / (slPips * pipValue);
  // Round to 2 decimal places (0.01 lot increments)
  const rounded = Math.round(rawLots * 100) / 100;
  return Math.max(minLot, Math.min(maxLot, rounded));
}

// ─── Hook detection (enhanced) ─────────────────────────────────────

interface HookSignal {
  detected: boolean;
  direction: "hooking_down" | "hooking_up" | "none";
  strength: "strong" | "moderate" | "weak" | "none";
  tsiValue: number;
  tsiPrevious: number;
  delta: number;
}

/**
 * Detect the "hook" signal — a currency's TSI line curving back from extremes.
 * This is the primary entry trigger for the FOTSI mean-reversion strategy.
 *
 * A "hook" means:
 * - For overbought (TSI > +25): the line was rising but is now falling or flattening
 * - For oversold (TSI < -25): the line was falling but is now rising or flattening
 *
 * The hook must occur while the currency is OUTSIDE the neutral zone (±25).
 */
function detectHook(
  currency: Currency,
  fotsi: FOTSIResult,
  config: Config,
): HookSignal {
  const tsi = fotsi.strengths[currency] ?? 0;
  const series = fotsi.series[currency];
  const noSignal: HookSignal = { detected: false, direction: "none", strength: "none", tsiValue: tsi, tsiPrevious: 0, delta: 0 };

  if (!series || series.length < config.hookBars + 1) return noSignal;

  const n = series.length;
  const current = series[n - 1];
  const prev1 = series[n - 2];
  const prev2 = series[n - 3];

  const delta1 = prev1 - prev2;  // Previous bar's change
  const delta2 = current - prev1; // Current bar's change

  // Currency must be outside neutral zone
  if (Math.abs(current) < config.minExtremeLevel) return noSignal;

  // Hooking DOWN: was rising (delta1 > 0), now falling or flat (delta2 < delta1)
  if (current > config.minExtremeLevel && delta1 > 0.2 && delta2 < delta1 * 0.5) {
    const strength = delta2 < 0 ? "strong" : delta2 < delta1 * 0.3 ? "moderate" : "weak";
    return {
      detected: true,
      direction: "hooking_down",
      strength,
      tsiValue: current,
      tsiPrevious: prev1,
      delta: delta2,
    };
  }

  // Hooking UP: was falling (delta1 < 0), now rising or flat (delta2 > delta1)
  if (current < -config.minExtremeLevel && delta1 < -0.2 && delta2 > delta1 * 0.5) {
    const strength = delta2 > 0 ? "strong" : delta2 > delta1 * 0.3 ? "moderate" : "weak";
    return {
      detected: true,
      direction: "hooking_up",
      strength,
      tsiValue: current,
      tsiPrevious: prev1,
      delta: delta2,
    };
  }

  // Also detect if already past the hook — TSI was extreme and is now moving back toward zero
  // This catches entries slightly after the initial hook
  if (current > config.minExtremeLevel && delta2 < -0.3) {
    return {
      detected: true,
      direction: "hooking_down",
      strength: "moderate",
      tsiValue: current,
      tsiPrevious: prev1,
      delta: delta2,
    };
  }
  if (current < -config.minExtremeLevel && delta2 > 0.3) {
    return {
      detected: true,
      direction: "hooking_up",
      strength: "moderate",
      tsiValue: current,
      tsiPrevious: prev1,
      delta: delta2,
    };
  }

  return noSignal;
}

// ─── Pair ranking by divergence ────────────────────────────────────

interface RankedPair {
  pair: string;
  base: Currency;
  quote: Currency;
  baseTSI: number;
  quoteTSI: number;
  spread: number;           // Absolute divergence
  direction: "SELL" | "BUY"; // Mean-reversion direction
  baseHook: HookSignal;
  quoteHook: HookSignal;
  hookScore: number;         // 0-4: both strong = 4, one strong = 3, etc.
  reason: string;
}

/**
 * Rank all tradeable pairs by FOTSI divergence and hook quality.
 * Returns pairs sorted by best opportunity first.
 */
function rankPairsByDivergence(
  fotsi: FOTSIResult,
  config: Config,
): RankedPair[] {
  const ranked: RankedPair[] = [];

  for (const [pair, base, quote] of FOTSI_PAIRS) {
    // Skip if pair not in SPECS (we can't trade it)
    if (!SPECS[pair]) continue;

    const baseTSI = fotsi.strengths[base] ?? 0;
    const quoteTSI = fotsi.strengths[quote] ?? 0;
    const spread = Math.abs(baseTSI - quoteTSI);

    // Skip if divergence too small
    if (spread < config.minDivergenceSpread) continue;

    // Both currencies must be outside neutral zone
    if (Math.abs(baseTSI) < config.minExtremeLevel && Math.abs(quoteTSI) < config.minExtremeLevel) continue;

    // At least one currency must be outside neutral zone
    // Prefer pairs where BOTH are outside
    const baseOutside = Math.abs(baseTSI) >= config.minExtremeLevel;
    const quoteOutside = Math.abs(quoteTSI) >= config.minExtremeLevel;
    if (!baseOutside && !quoteOutside) continue;

    // Determine direction: sell the overbought, buy the oversold
    // If base is stronger than quote → base is relatively overbought → SELL the pair
    // If quote is stronger than base → base is relatively oversold → BUY the pair
    const direction: "BUY" | "SELL" = baseTSI > quoteTSI ? "SELL" : "BUY";

    // Detect hooks
    const baseHook = detectHook(base, fotsi, config);
    const quoteHook = detectHook(quote, fotsi, config);

    // Hook score: reward when currencies are converging
    let hookScore = 0;
    if (direction === "SELL") {
      // Selling: want base hooking DOWN (overbought reversing) and quote hooking UP (oversold recovering)
      if (baseHook.detected && baseHook.direction === "hooking_down") {
        hookScore += baseHook.strength === "strong" ? 2 : baseHook.strength === "moderate" ? 1.5 : 1;
      }
      if (quoteHook.detected && quoteHook.direction === "hooking_up") {
        hookScore += quoteHook.strength === "strong" ? 2 : quoteHook.strength === "moderate" ? 1.5 : 1;
      }
    } else {
      // Buying: want base hooking UP (oversold recovering) and quote hooking DOWN (overbought reversing)
      if (baseHook.detected && baseHook.direction === "hooking_up") {
        hookScore += baseHook.strength === "strong" ? 2 : baseHook.strength === "moderate" ? 1.5 : 1;
      }
      if (quoteHook.detected && quoteHook.direction === "hooking_down") {
        hookScore += quoteHook.strength === "strong" ? 2 : quoteHook.strength === "moderate" ? 1.5 : 1;
      }
    }

    // If hook is required and no hook detected, skip
    if (config.hookRequired && hookScore === 0) continue;

    const hookDesc = hookScore >= 3 ? "Strong dual hook" : hookScore >= 2 ? "Good hook" : hookScore >= 1 ? "Mild hook" : "No hook";

    ranked.push({
      pair,
      base,
      quote,
      baseTSI,
      quoteTSI,
      spread,
      direction,
      baseHook,
      quoteHook,
      hookScore,
      reason: `${direction} ${pair}: ${base} TSI ${baseTSI.toFixed(1)} ${baseHook.direction !== "none" ? "↩" : "→"} | ${quote} TSI ${quoteTSI.toFixed(1)} ${quoteHook.direction !== "none" ? "↩" : "→"} | Spread ${spread.toFixed(1)} | ${hookDesc}`,
    });
  }

  // Sort by: hookScore DESC, then spread DESC
  ranked.sort((a, b) => {
    if (b.hookScore !== a.hookScore) return b.hookScore - a.hookScore;
    return b.spread - a.spread;
  });

  return ranked;
}

// ─── SL/TP calculation ─────────────────────────────────────────────

interface SLTPResult {
  sl: number;
  tp1: number;
  tp2: number;
  slPips: number;
  tp1Pips: number;
  tp2Pips: number;
  rr1: number;
  rr2: number;
}

function calculateSLTP(
  direction: "BUY" | "SELL",
  entryPrice: number,
  candles: Candle[],
  config: Config,
  pipSize: number,
): SLTPResult | null {
  // ── Stop Loss ──
  let sl: number;
  const atr = calculateATR(candles, 14);
  const bufferPrice = config.slBufferPips * pipSize;

  if (config.slMethod === "structure") {
    if (direction === "BUY") {
      const swingLow = findRecentSwingLow(candles, 20);
      sl = swingLow - bufferPrice;
    } else {
      const swingHigh = findRecentSwingHigh(candles, 20);
      sl = swingHigh + bufferPrice;
    }
  } else if (config.slMethod === "atr") {
    const atrSL = atr * config.slATRMultiplier;
    sl = direction === "BUY" ? entryPrice - atrSL : entryPrice + atrSL;
  } else {
    // Fixed pips
    const fixedSL = config.slFixedPips * pipSize;
    sl = direction === "BUY" ? entryPrice - fixedSL : entryPrice + fixedSL;
  }

  const slPips = Math.abs(entryPrice - sl) / pipSize;

  // ── Take Profit 1 (EMA 50 or fixed R:R) ──
  let tp1: number;
  if (config.tp1Method === "ema50") {
    const ema50 = currentEMA(candles, config.ema50Period);
    if (ema50 === null) return null;
    tp1 = ema50;
  } else {
    const tp1Distance = slPips * config.tp1RR * pipSize;
    tp1 = direction === "BUY" ? entryPrice + tp1Distance : entryPrice - tp1Distance;
  }

  // ── Take Profit 2 (EMA 100 or fixed R:R) ──
  let tp2: number;
  if (config.tp2Method === "ema100") {
    const ema100 = currentEMA(candles, config.ema100Period);
    if (ema100 === null) return null;
    tp2 = ema100;
  } else {
    const tp2Distance = slPips * config.tp2RR * pipSize;
    tp2 = direction === "BUY" ? entryPrice + tp2Distance : entryPrice - tp2Distance;
  }

  // Validate TP direction
  if (direction === "BUY") {
    // For a BUY mean-reversion: price should move toward EMAs
    // EMA should be BELOW current price for a proper mean-reversion target
    // Actually: we're buying an oversold pair, expecting it to rise toward the mean
    // So TP should be ABOVE entry
    if (tp1 <= entryPrice || tp2 <= entryPrice) {
      // EMAs are below entry — price is already above the mean
      // Fall back to R:R-based TP
      const tp1Distance = slPips * config.tp1RR * pipSize;
      const tp2Distance = slPips * config.tp2RR * pipSize;
      tp1 = entryPrice + tp1Distance;
      tp2 = entryPrice + tp2Distance;
    }
  } else {
    // For a SELL: TP should be BELOW entry
    if (tp1 >= entryPrice || tp2 >= entryPrice) {
      const tp1Distance = slPips * config.tp1RR * pipSize;
      const tp2Distance = slPips * config.tp2RR * pipSize;
      tp1 = entryPrice - tp1Distance;
      tp2 = entryPrice - tp2Distance;
    }
  }

  const tp1Pips = Math.abs(tp1 - entryPrice) / pipSize;
  const tp2Pips = Math.abs(tp2 - entryPrice) / pipSize;
  const rr1 = slPips > 0 ? tp1Pips / slPips : 0;
  const rr2 = slPips > 0 ? tp2Pips / slPips : 0;

  return { sl, tp1, tp2, slPips, tp1Pips, tp2Pips, rr1, rr2 };
}

// ─── Config loader ─────────────────────────────────────────────────

function loadConfig(raw: Record<string, unknown> | null): Config {
  if (!raw) return { ...DEFAULTS };
  const c = raw as Record<string, unknown>;
  return {
    minDivergenceSpread: Number(c.minDivergenceSpread ?? DEFAULTS.minDivergenceSpread),
    hookRequired: c.hookRequired !== undefined ? Boolean(c.hookRequired) : DEFAULTS.hookRequired,
    hookBars: Number(c.hookBars ?? DEFAULTS.hookBars),
    minExtremeLevel: Number(c.minExtremeLevel ?? DEFAULTS.minExtremeLevel),
    riskPerTrade: Number(c.riskPerTrade ?? DEFAULTS.riskPerTrade),
    maxConcurrent: Number(c.maxConcurrent ?? DEFAULTS.maxConcurrent),
    cooldownMinutes: Number(c.cooldownMinutes ?? DEFAULTS.cooldownMinutes),
    maxDailyLoss: Number(c.maxDailyLoss ?? DEFAULTS.maxDailyLoss),
    maxDailyTrades: Number(c.maxDailyTrades ?? DEFAULTS.maxDailyTrades),
    slMethod: (c.slMethod as Config["slMethod"]) ?? DEFAULTS.slMethod,
    slATRMultiplier: Number(c.slATRMultiplier ?? DEFAULTS.slATRMultiplier),
    slFixedPips: Number(c.slFixedPips ?? DEFAULTS.slFixedPips),
    slBufferPips: Number(c.slBufferPips ?? DEFAULTS.slBufferPips),
    minRR: Number(c.minRR ?? DEFAULTS.minRR),
    tp1Method: (c.tp1Method as Config["tp1Method"]) ?? DEFAULTS.tp1Method,
    tp2Method: (c.tp2Method as Config["tp2Method"]) ?? DEFAULTS.tp2Method,
    tp1RR: Number(c.tp1RR ?? DEFAULTS.tp1RR),
    tp2RR: Number(c.tp2RR ?? DEFAULTS.tp2RR),
    partialClosePercent: Number(c.partialClosePercent ?? DEFAULTS.partialClosePercent),
    maxHoldHours: Number(c.maxHoldHours ?? DEFAULTS.maxHoldHours),
    breakEvenAfterTP1: c.breakEvenAfterTP1 !== undefined ? Boolean(c.breakEvenAfterTP1) : DEFAULTS.breakEvenAfterTP1,
    sessions: {
      london: (c.sessions as Record<string, boolean>)?.london ?? DEFAULTS.sessions.london,
      newYork: (c.sessions as Record<string, boolean>)?.newYork ?? DEFAULTS.sessions.newYork,
      asian: (c.sessions as Record<string, boolean>)?.asian ?? DEFAULTS.sessions.asian,
      sydney: (c.sessions as Record<string, boolean>)?.sydney ?? DEFAULTS.sessions.sydney,
    },
    killZoneOnly: c.killZoneOnly !== undefined ? Boolean(c.killZoneOnly) : DEFAULTS.killZoneOnly,
    ema50Period: Number(c.ema50Period ?? DEFAULTS.ema50Period),
    ema100Period: Number(c.ema100Period ?? DEFAULTS.ema100Period),
    entryTimeframe: (c.entryTimeframe as Config["entryTimeframe"]) ?? DEFAULTS.entryTimeframe,
  };
}

// ─── Main handler ──────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "scan";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── Get user ──
    const userId = body.userId;
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "scan") {
      return await runScan(supabase, userId, body, corsHeaders);
    } else if (action === "status") {
      return await getStatus(supabase, userId, corsHeaders);
    } else if (action === "scan_logs") {
      return await getScanLogs(supabase, userId, corsHeaders);
    } else {
      return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (err) {
    console.error("[bot-scanner-fotsi] Fatal error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
    });
  }
});

// ─── Scan logic ────────────────────────────────────────────────────

async function runScan(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  body: Record<string, unknown>,
  corsHeaders: Record<string, string>,
) {
  const scanId = crypto.randomUUID();
  const startTime = Date.now();
  const logs: string[] = [];
  const log = (msg: string) => {
    console.log(`[${BOT_ID}:${scanId.slice(0, 8)}] ${msg}`);
    logs.push(msg);
  };

  log("═══ FOTSI Mean Reversion Scan Started ═══");

  // ── Load account ──
  const { data: account } = await supabase
    .from("paper_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (!account) {
    log("No paper account found");
    return new Response(JSON.stringify({ error: "No paper account" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const balance = parseFloat(account.balance || "10000");

  // ── Load config ──
  // Bot #2 config is stored in bot_configs with bot_type = "fotsi_mr" in config_json
  const { data: configRow } = await supabase
    .from("bot_configs")
    .select("config_json")
    .eq("user_id", userId)
    .maybeSingle();

  let rawConfig: Record<string, unknown> | null = null;
  if (configRow?.config_json) {
    const cj = configRow.config_json as Record<string, unknown>;
    // Check if there's a fotsi_mr sub-config
    if (cj.fotsi_mr) {
      rawConfig = cj.fotsi_mr as Record<string, unknown>;
    }
  }
  const config = loadConfig(rawConfig);
  log(`Config loaded: minSpread=${config.minDivergenceSpread}, hook=${config.hookRequired}, maxConcurrent=${config.maxConcurrent}`);

  // ── Check existing positions ──
  const { data: openPositions } = await supabase
    .from("paper_positions")
    .select("*")
    .eq("user_id", userId)
    .eq("position_status", "open");

  // Filter to only Bot #2 positions (check signal_reason for bot tag)
  const botPositions = (openPositions || []).filter(p => {
    try {
      const sr = JSON.parse(p.signal_reason || "{}");
      return sr.bot === BOT_ID;
    } catch { return false; }
  });

  log(`Open positions: ${botPositions.length}/${config.maxConcurrent}`);

  if (botPositions.length >= config.maxConcurrent) {
    log("Max concurrent positions reached — skipping scan");
    await saveScanLog(supabase, userId, scanId, startTime, logs, 0, 0, 0);
    return new Response(JSON.stringify({ ok: true, message: "Max positions reached", scanId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Check daily loss limit ──
  const dailyPnlBase = parseFloat(account.daily_pnl_base || "10000");
  const dailyLoss = ((dailyPnlBase - balance) / dailyPnlBase) * 100;
  if (dailyLoss >= config.maxDailyLoss) {
    log(`Daily loss limit hit: ${dailyLoss.toFixed(2)}% >= ${config.maxDailyLoss}%`);
    await saveScanLog(supabase, userId, scanId, startTime, logs, 0, 0, 0);
    return new Response(JSON.stringify({ ok: true, message: "Daily loss limit", scanId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Session filter ──
  const now = new Date();
  const session = detectSession(now);
  const inActiveSession =
    (config.sessions.london && session.london) ||
    (config.sessions.newYork && session.newYork) ||
    (config.sessions.asian && session.asian) ||
    (config.sessions.sydney && session.sydney);

  if (!inActiveSession) {
    log("Outside active sessions — skipping scan");
    await saveScanLog(supabase, userId, scanId, startTime, logs, 0, 0, 0);
    return new Response(JSON.stringify({ ok: true, message: "Outside session", scanId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Step 1: Fetch 28 FOTSI pairs (daily candles) ──
  log("Fetching 28 FOTSI pairs for currency strength...");
  const candleMap: Record<string, Candle[]> = {};
  let fetchedCount = 0;

  for (const [pair] of FOTSI_PAIRS) {
    try {
      const result = await fetchCandlesWithFallback({
        symbol: pair,
        interval: "1d",
        limit: 180,
      });
      if (result?.candles && result.candles.length > 0) {
        candleMap[pair] = result.candles;
        fetchedCount++;
      }
    } catch (err) {
      log(`Failed to fetch ${pair}: ${err}`);
    }
    // Rate limit: small delay between batches
    if (fetchedCount % 7 === 0 && fetchedCount > 0) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  log(`Fetched ${fetchedCount}/28 FOTSI pairs`);

  if (fetchedCount < 20) {
    log("Insufficient FOTSI data (need at least 20/28 pairs)");
    await saveScanLog(supabase, userId, scanId, startTime, logs, fetchedCount, 0, 0);
    return new Response(JSON.stringify({ ok: true, message: "Insufficient data", scanId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Step 2: Compute FOTSI ──
  const fotsi = computeFOTSI(candleMap);
  log(`FOTSI computed: ${JSON.stringify(
    Object.fromEntries(CURRENCIES.map(c => [c, fotsi.strengths[c].toFixed(1)])),
  )}`);

  // ── Step 3: Rank pairs by divergence + hook ──
  const ranked = rankPairsByDivergence(fotsi, config);
  log(`Ranked pairs: ${ranked.length} qualifying (min spread ${config.minDivergenceSpread})`);

  if (ranked.length === 0) {
    log("No qualifying pairs found");
    await saveScanLog(supabase, userId, scanId, startTime, logs, fetchedCount, 0, 0);
    return new Response(JSON.stringify({ ok: true, message: "No qualifying pairs", scanId, fotsi: fotsi.strengths }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Log top 5 opportunities
  for (const r of ranked.slice(0, 5)) {
    log(`  ${r.reason}`);
  }

  // ── Step 4: Evaluate top pairs for entry ──
  let signalsGenerated = 0;
  let tradesOpened = 0;
  const slotsAvailable = config.maxConcurrent - botPositions.length;

  // Check daily trade count
  const todayStr = now.toISOString().slice(0, 10);
  const { data: todayTrades } = await supabase
    .from("paper_trade_history")
    .select("id")
    .eq("user_id", userId)
    .gte("created_at", todayStr + "T00:00:00Z");

  const botTodayTrades = (todayTrades || []).length; // Approximate — includes both bots
  if (botTodayTrades >= config.maxDailyTrades) {
    log(`Daily trade limit reached: ${botTodayTrades}/${config.maxDailyTrades}`);
    await saveScanLog(supabase, userId, scanId, startTime, logs, fetchedCount, ranked.length, 0);
    return new Response(JSON.stringify({ ok: true, message: "Daily trade limit", scanId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  for (const opportunity of ranked.slice(0, slotsAvailable + 2)) { // Check a few extra in case some fail
    if (tradesOpened >= slotsAvailable) break;

    const { pair, base, quote, direction, baseTSI, quoteTSI, spread, baseHook, quoteHook, hookScore } = opportunity;

    // ── Cooldown check ──
    const existingOnPair = botPositions.find(p => p.symbol === pair);
    if (existingOnPair) {
      log(`  ${pair}: Already have open position — skip`);
      continue;
    }

    // Check recent closes on this pair
    const { data: recentCloses } = await supabase
      .from("paper_trade_history")
      .select("closed_at")
      .eq("user_id", userId)
      .eq("symbol", pair)
      .order("closed_at", { ascending: false })
      .limit(1);

    if (recentCloses && recentCloses.length > 0) {
      const lastClose = new Date(recentCloses[0].closed_at).getTime();
      const cooldownMs = config.cooldownMinutes * 60 * 1000;
      if (now.getTime() - lastClose < cooldownMs) {
        log(`  ${pair}: Cooldown active (${config.cooldownMinutes}min) — skip`);
        continue;
      }
    }

    // ── Fetch entry timeframe candles ──
    const tf = config.entryTimeframe;
    let entryCandles: Candle[] | null = null;
    try {
      const entryResult = await fetchCandlesWithFallback({
        symbol: pair,
        interval: tf === "4h" ? "4h" : "1h",
        limit: 300,
      });
      entryCandles = entryResult?.candles ?? null;
    } catch (err) {
      log(`  ${pair}: Failed to fetch ${tf} candles: ${err}`);
      continue;
    }

    if (!entryCandles || entryCandles.length < 100) {
      log(`  ${pair}: Insufficient ${tf} candles (${entryCandles?.length || 0})`);
      continue;
    }

    const lastCandle = entryCandles[entryCandles.length - 1];
    const entryPrice = lastCandle.close;
    const spec = SPECS[pair];
    if (!spec) {
      log(`  ${pair}: No spec found — skip`);
      continue;
    }

    // ── Calculate SL/TP ──
    const sltp = calculateSLTP(direction, entryPrice, entryCandles, config, spec.pipSize);
    if (!sltp) {
      log(`  ${pair}: SL/TP calculation failed`);
      continue;
    }

    // ── Check min R:R ──
    if (sltp.rr2 < config.minRR) {
      log(`  ${pair}: R:R too low (${sltp.rr2.toFixed(2)} < ${config.minRR}) — skip`);
      continue;
    }

    signalsGenerated++;

    // ── Calculate position size ──
    const size = calculatePositionSize(
      balance,
      config.riskPerTrade,
      sltp.slPips,
      spec.pipValue,
      spec.minLot,
      spec.maxLot,
    );

    // ── Open position ──
    const positionId = `fotsi_${pair.replace("/", "")}_${Date.now()}`;
    const orderId = `fotsi_${crypto.randomUUID().slice(0, 8)}`;
    const nowStr = now.toISOString();

    const ema50Val = currentEMA(entryCandles, config.ema50Period);
    const ema100Val = currentEMA(entryCandles, config.ema100Period);

    const signalReason = {
      bot: BOT_ID,
      summary: `FOTSI MR: ${direction} ${pair} | ${base} TSI ${baseTSI.toFixed(1)} ${baseHook.direction !== "none" ? "↩" : "→"} | ${quote} TSI ${quoteTSI.toFixed(1)} ${quoteHook.direction !== "none" ? "↩" : "→"} | Spread ${spread.toFixed(1)} | Hook ${hookScore.toFixed(1)}/4 | SL ${sltp.slPips.toFixed(1)} pips | TP1 ${sltp.tp1Pips.toFixed(1)} pips (${sltp.rr1.toFixed(1)}R) | TP2 ${sltp.tp2Pips.toFixed(1)} pips (${sltp.rr2.toFixed(1)}R)`,
      baseTSI,
      quoteTSI,
      spread,
      hookScore,
      baseHook: baseHook.direction,
      quoteHook: quoteHook.direction,
      ema50: ema50Val,
      ema100: ema100Val,
      slMethod: config.slMethod,
      tp1Method: config.tp1Method,
      tp2Method: config.tp2Method,
      rr1: sltp.rr1,
      rr2: sltp.rr2,
      exitFlags: {
        trailing: false,
        trailingDistance: 0,
        trailingActivation: 0,
        breakEvenPips: 0, // Break-even handled via partial TP
        partialTP: config.partialClosePercent > 0,
        partialTPPercent: config.partialClosePercent,
        partialTPLevel: 1, // TP1 = 1x R
        maxHoldHours: config.maxHoldHours,
        tpRatio: sltp.rr2,
      },
    };

    // Use TP2 as the main take_profit (TP1 is handled via partial close)
    await supabase.from("paper_positions").insert({
      user_id: userId,
      position_id: positionId,
      symbol: pair,
      direction: direction === "BUY" ? "long" : "short",
      size: size.toString(),
      entry_price: entryPrice.toString(),
      current_price: entryPrice.toString(),
      stop_loss: sltp.sl.toString(),
      take_profit: sltp.tp2.toString(),
      open_time: nowStr,
      signal_reason: JSON.stringify(signalReason),
      signal_score: hookScore.toString(),
      order_id: orderId,
      position_status: "open",
    });

    tradesOpened++;
    log(`  ✅ OPENED: ${direction} ${pair} @ ${entryPrice} | Size ${size} | SL ${sltp.sl.toFixed(5)} | TP1 ${sltp.tp1.toFixed(5)} | TP2 ${sltp.tp2.toFixed(5)} | R:R ${sltp.rr2.toFixed(1)}`);

    // Store trade reasoning
    await supabase.from("trade_reasonings").insert({
      user_id: userId,
      position_id: positionId,
      reasoning_text: signalReason.summary,
      factors_json: {
        bot: BOT_ID,
        baseTSI,
        quoteTSI,
        spread,
        hookScore,
        baseHook: baseHook.direction,
        quoteHook: quoteHook.direction,
        slMethod: config.slMethod,
        rr: sltp.rr2,
      },
      analysis_snapshot: {
        fotsiStrengths: fotsi.strengths,
        ema50: ema50Val,
        ema100: ema100Val,
        atr: calculateATR(entryCandles, 14),
        session: session,
      },
    });
  }

  log(`═══ Scan Complete: ${signalsGenerated} signals, ${tradesOpened} trades opened ═══`);

  // ── Save scan log ──
  await saveScanLog(supabase, userId, scanId, startTime, logs, fetchedCount, signalsGenerated, tradesOpened);

  return new Response(JSON.stringify({
    ok: true,
    scanId,
    fotsi: fotsi.strengths,
    rankedPairs: ranked.slice(0, 10).map(r => ({
      pair: r.pair,
      direction: r.direction,
      spread: r.spread,
      hookScore: r.hookScore,
      reason: r.reason,
    })),
    signalsGenerated,
    tradesOpened,
    logs,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Scan log persistence ──────────────────────────────────────────

async function saveScanLog(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  scanId: string,
  startTime: number,
  logs: string[],
  pairsFetched: number,
  signals: number,
  trades: number,
) {
  const duration = Date.now() - startTime;
  await supabase.from("scan_logs").insert({
    user_id: userId,
    scan_id: scanId,
    bot_id: BOT_ID,
    status: "completed",
    instruments_scanned: pairsFetched,
    signals_generated: signals,
    positions_opened: trades,
    duration_ms: duration,
    details: JSON.stringify({ logs }),
  });
}

// ─── Status endpoint ───────────────────────────────────────────────

async function getStatus(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  corsHeaders: Record<string, string>,
) {
  const { data: positions } = await supabase
    .from("paper_positions")
    .select("*")
    .eq("user_id", userId)
    .eq("position_status", "open");

  const botPositions = (positions || []).filter(p => {
    try {
      const sr = JSON.parse(p.signal_reason || "{}");
      return sr.bot === BOT_ID;
    } catch { return false; }
  });

  const { data: recentTrades } = await supabase
    .from("paper_trade_history")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  const botTrades = (recentTrades || []).filter(t => {
    try {
      const sr = JSON.parse(t.signal_reason || "{}");
      return sr.bot === BOT_ID;
    } catch { return false; }
  });

  return new Response(JSON.stringify({
    bot: BOT_ID,
    name: BOT_NAME,
    openPositions: botPositions.length,
    positions: botPositions,
    recentTrades: botTrades.slice(0, 10),
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Scan logs endpoint ────────────────────────────────────────────

async function getScanLogs(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  corsHeaders: Record<string, string>,
) {
  const { data: logs } = await supabase
    .from("scan_logs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  // Filter to Bot #2 logs (if bot_id column exists, otherwise return all)
  const botLogs = (logs || []).filter(l => {
    // If bot_id column exists, filter by it
    if (l.bot_id) return l.bot_id === BOT_ID;
    // Otherwise check details JSON
    try {
      const d = JSON.parse(l.details || "{}");
      return d.logs?.some((log: string) => log.includes("FOTSI Mean Reversion"));
    } catch { return false; }
  });

  return new Response(JSON.stringify({ logs: botLogs }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
