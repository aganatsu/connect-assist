import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// ─── Types ─────────────────────────────────────────────────────────
interface Candle { datetime: string; open: number; high: number; low: number; close: number; volume?: number; }
interface SwingPoint { index: number; price: number; type: "high" | "low"; datetime: string; }
interface OrderBlock { index: number; high: number; low: number; type: "bullish" | "bearish"; datetime: string; mitigated: boolean; mitigatedPercent: number; }
interface FairValueGap { index: number; high: number; low: number; type: "bullish" | "bearish"; datetime: string; mitigated: boolean; }
interface LiquidityPool { price: number; type: "buy-side" | "sell-side"; strength: number; datetime: string; swept: boolean; }
interface MarketStructure { trend: "bullish" | "bearish" | "ranging"; swingPoints: SwingPoint[]; bos: any[]; choch: any[]; }
interface PDLevels { pdh: number; pdl: number; pdo: number; pdc: number; pwh: number; pwl: number; pwo: number; pwc: number; }
interface JudasSwing { detected: boolean; type: "bullish" | "bearish" | null; midnightOpen: number; sweepLow: number | null; sweepHigh: number | null; reversalConfirmed: boolean; description: string; }
interface SessionInfo { name: string; active: boolean; isKillZone: boolean; sessionHigh: number; sessionLow: number; sessionOpen: number; }
interface PremiumDiscount { swingHigh: number; swingLow: number; equilibrium: number; currentZone: "premium" | "discount" | "equilibrium"; zonePercent: number; oteZone: boolean; }
interface CurrencyStrength { currency: string; strength: number; rank: number; }
interface CorrelationPair { pair1: string; pair2: string; coefficient: number; }

// ─── Analysis Functions ─────────────────────────────────────────────
function detectSwingPoints(candles: Candle[], lookback = 3): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: candles[i].high, type: "high", datetime: candles[i].datetime });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: "low", datetime: candles[i].datetime });
  }
  return swings;
}

function analyzeMarketStructure(candles: Candle[], lookback = 3): MarketStructure {
  const swings = detectSwingPoints(candles, lookback);
  const bos: any[] = [], choch: any[] = [];
  const highs = swings.filter(s => s.type === "high"), lows = swings.filter(s => s.type === "low");
  let currentTrend = "ranging";
  for (let i = 1; i < highs.length; i++) {
    if (highs[i].price > highs[i - 1].price) {
      if (currentTrend === "bearish") choch.push({ index: highs[i].index, type: "bullish", price: highs[i].price, datetime: highs[i].datetime });
      else bos.push({ index: highs[i].index, type: "bullish", price: highs[i].price, datetime: highs[i].datetime });
      currentTrend = "bullish";
    }
  }
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price < lows[i - 1].price) {
      if (currentTrend === "bullish") choch.push({ index: lows[i].index, type: "bearish", price: lows[i].price, datetime: lows[i].datetime });
      else bos.push({ index: lows[i].index, type: "bearish", price: lows[i].price, datetime: lows[i].datetime });
      currentTrend = "bearish";
    }
  }
  let trend: "bullish" | "bearish" | "ranging" = "ranging";
  if (highs.length >= 2 && lows.length >= 2) {
    const rH = highs.slice(-2), rL = lows.slice(-2);
    if (rH[1].price > rH[0].price && rL[1].price > rL[0].price) trend = "bullish";
    else if (rH[1].price < rH[0].price && rL[1].price < rL[0].price) trend = "bearish";
  }
  return { trend, swingPoints: swings, bos, choch };
}

function detectOrderBlocks(candles: Candle[]): OrderBlock[] {
  const obs: OrderBlock[] = [];
  for (let i = 2; i < candles.length; i++) {
    const prev = candles[i - 1], curr = candles[i];
    if (prev.close < prev.open && curr.close > curr.open && curr.close > prev.high) {
      const ob: OrderBlock = { index: i - 1, high: prev.high, low: prev.low, type: "bullish", datetime: prev.datetime, mitigated: false, mitigatedPercent: 0 };
      for (let j = i + 1; j < candles.length; j++) {
        const mid = (ob.high + ob.low) / 2;
        if (candles[j].low <= mid) { ob.mitigatedPercent = Math.min(100, ((ob.high - candles[j].low) / (ob.high - ob.low)) * 100); if (ob.mitigatedPercent >= 50) ob.mitigated = true; break; }
      }
      obs.push(ob);
    }
    if (prev.close > prev.open && curr.close < curr.open && curr.close < prev.low) {
      const ob: OrderBlock = { index: i - 1, high: prev.high, low: prev.low, type: "bearish", datetime: prev.datetime, mitigated: false, mitigatedPercent: 0 };
      for (let j = i + 1; j < candles.length; j++) {
        const mid = (ob.high + ob.low) / 2;
        if (candles[j].high >= mid) { ob.mitigatedPercent = Math.min(100, ((candles[j].high - ob.low) / (ob.high - ob.low)) * 100); if (ob.mitigatedPercent >= 50) ob.mitigated = true; break; }
      }
      obs.push(ob);
    }
  }
  return obs;
}

function detectFVGs(candles: Candle[]): FairValueGap[] {
  const fvgs: FairValueGap[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    if (c3.low > c1.high && c2.close > c2.open) {
      const fvg: FairValueGap = { index: i - 1, high: c3.low, low: c1.high, type: "bullish", datetime: c2.datetime, mitigated: false };
      for (let j = i + 1; j < candles.length; j++) { if (candles[j].low <= fvg.low) { fvg.mitigated = true; break; } }
      fvgs.push(fvg);
    }
    if (c1.low > c3.high && c2.close < c2.open) {
      const fvg: FairValueGap = { index: i - 1, high: c1.low, low: c3.high, type: "bearish", datetime: c2.datetime, mitigated: false };
      for (let j = i + 1; j < candles.length; j++) { if (candles[j].high >= fvg.high) { fvg.mitigated = true; break; } }
      fvgs.push(fvg);
    }
  }
  return fvgs;
}

function detectLiquidityPools(candles: Candle[], tolerance = 0.001): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  const priceRange = Math.max(...candles.map(c => c.high)) - Math.min(...candles.map(c => c.low));
  const tol = priceRange * tolerance;
  const last = candles[candles.length - 1];
  const usedH = new Set<number>(), usedL = new Set<number>();
  for (let i = 0; i < candles.length; i++) {
    if (usedH.has(i)) continue;
    let count = 1;
    for (let j = i + 1; j < candles.length; j++) {
      if (usedH.has(j)) continue;
      if (Math.abs(candles[i].high - candles[j].high) <= tol) { count++; usedH.add(j); }
    }
    if (count >= 2) pools.push({ price: candles[i].high, type: "buy-side", strength: count, datetime: candles[i].datetime, swept: last.high > candles[i].high });
  }
  for (let i = 0; i < candles.length; i++) {
    if (usedL.has(i)) continue;
    let count = 1;
    for (let j = i + 1; j < candles.length; j++) {
      if (usedL.has(j)) continue;
      if (Math.abs(candles[i].low - candles[j].low) <= tol) { count++; usedL.add(j); }
    }
    if (count >= 2) pools.push({ price: candles[i].low, type: "sell-side", strength: count, datetime: candles[i].datetime, swept: last.low < candles[i].low });
  }
  return pools.sort((a, b) => b.strength - a.strength);
}

function calculatePDLevels(dailyCandles: Candle[]): PDLevels | null {
  if (dailyCandles.length < 10) return null;
  const prev = dailyCandles[dailyCandles.length - 2];
  const weekCandles = dailyCandles.slice(-5);
  return {
    pdh: prev.high, pdl: prev.low, pdo: prev.open, pdc: prev.close,
    pwh: Math.max(...weekCandles.map(c => c.high)), pwl: Math.min(...weekCandles.map(c => c.low)),
    pwo: weekCandles[0].open, pwc: weekCandles[weekCandles.length - 1].close,
  };
}

function detectJudasSwing(candles: Candle[]): JudasSwing {
  const noSwing: JudasSwing = { detected: false, type: null, midnightOpen: 0, sweepLow: null, sweepHigh: null, reversalConfirmed: false, description: "Insufficient data for Judas Swing detection" };
  if (candles.length < 20) return noSwing;
  const recent = candles.slice(-12);
  const midnightOpen = recent[0].open;
  const sessionLow = Math.min(...recent.map(c => c.low));
  const sessionHigh = Math.max(...recent.map(c => c.high));
  const currentClose = recent[recent.length - 1].close;
  if (sessionLow < midnightOpen && currentClose > midnightOpen) {
    return { detected: true, type: "bullish", midnightOpen, sweepLow: sessionLow, sweepHigh: null, reversalConfirmed: true, description: `Bullish Judas Swing: false break below midnight open ${midnightOpen.toFixed(5)}, reversed above` };
  }
  if (sessionHigh > midnightOpen && currentClose < midnightOpen) {
    return { detected: true, type: "bearish", midnightOpen, sweepLow: null, sweepHigh: sessionHigh, reversalConfirmed: true, description: `Bearish Judas Swing: false break above midnight open ${midnightOpen.toFixed(5)}, reversed below` };
  }
  return noSwing;
}

function detectSession(): SessionInfo {
  const now = new Date();
  const utcH = now.getUTCHours();
  let name = "Off-Hours", active = false, isKillZone = false;
  if (utcH >= 0 && utcH < 8) { name = "Asian"; active = true; isKillZone = utcH >= 0 && utcH < 4; }
  else if (utcH >= 7 && utcH < 16) { name = "London"; active = true; isKillZone = utcH >= 7 && utcH < 10; }
  else if (utcH >= 12 && utcH < 21) { name = "New York"; active = true; isKillZone = utcH >= 12 && utcH < 15; }
  return { name, active, isKillZone, sessionHigh: 0, sessionLow: 0, sessionOpen: 0 };
}

function calculatePremiumDiscount(candles: Candle[]): PremiumDiscount {
  const swings = detectSwingPoints(candles);
  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  const sh = highs.length > 0 ? Math.max(...highs.map(h => h.price)) : candles[candles.length - 1].high;
  const sl = lows.length > 0 ? Math.min(...lows.map(l => l.price)) : candles[candles.length - 1].low;
  const eq = (sh + sl) / 2;
  const cp = candles[candles.length - 1].close;
  const range = sh - sl;
  const zp = range > 0 ? ((cp - sl) / range) * 100 : 50;
  const zone = zp > 55 ? "premium" : zp < 45 ? "discount" : "equilibrium";
  const ote = zp >= 62 && zp <= 79;
  return { swingHigh: sh, swingLow: sl, equilibrium: eq, currentZone: zone, zonePercent: zp, oteZone: ote };
}

function calculateCurrencyStrength(pairData: Record<string, { change: number }>): CurrencyStrength[] {
  const currencies = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "NZD", "CHF"];
  const scores: Record<string, number> = {};
  currencies.forEach(c => scores[c] = 0);
  const pairMap: Record<string, [string, string]> = {
    "EUR/USD": ["EUR", "USD"], "GBP/USD": ["GBP", "USD"], "USD/JPY": ["USD", "JPY"],
    "AUD/USD": ["AUD", "USD"], "USD/CAD": ["USD", "CAD"], "EUR/GBP": ["EUR", "GBP"],
    "NZD/USD": ["NZD", "USD"], "GBP/JPY": ["GBP", "JPY"],
  };
  for (const [pair, change] of Object.entries(pairData)) {
    const map = pairMap[pair];
    if (!map) continue;
    scores[map[0]] = (scores[map[0]] || 0) + change.change;
    scores[map[1]] = (scores[map[1]] || 0) - change.change;
  }
  const sorted = currencies.map(c => ({ currency: c, strength: scores[c] || 0, rank: 0 }))
    .sort((a, b) => b.strength - a.strength);
  sorted.forEach((s, i) => s.rank = i + 1);
  return sorted;
}

function calculateCorrelation(data1: number[], data2: number[]): number {
  const n = Math.min(data1.length, data2.length);
  if (n < 5) return 0;
  const d1 = data1.slice(-n), d2 = data2.slice(-n);
  const mean1 = d1.reduce((a, b) => a + b, 0) / n;
  const mean2 = d2.reduce((a, b) => a + b, 0) / n;
  let num = 0, den1 = 0, den2 = 0;
  for (let i = 0; i < n; i++) {
    const diff1 = d1[i] - mean1, diff2 = d2[i] - mean2;
    num += diff1 * diff2; den1 += diff1 * diff1; den2 += diff2 * diff2;
  }
  const den = Math.sqrt(den1 * den2);
  return den > 0 ? num / den : 0;
}

function runFullAnalysis(candles: Candle[], dailyCandles?: Candle[]) {
  const structure = analyzeMarketStructure(candles);
  const orderBlocks = detectOrderBlocks(candles);
  const fvgs = detectFVGs(candles);
  const liquidityPools = detectLiquidityPools(candles);
  const pdLevels = dailyCandles ? calculatePDLevels(dailyCandles) : null;
  const judasSwing = detectJudasSwing(candles);
  const session = detectSession();
  const premiumDiscount = calculatePremiumDiscount(candles);

  // Confluence scoring
  let score = 0;
  const reasoning: string[] = [];
  if (structure.trend !== "ranging") { score += 2; reasoning.push(`${structure.trend} trend confirmed`); }
  const activeOBs = orderBlocks.filter(ob => !ob.mitigated);
  if (activeOBs.length > 0) { score += 2; reasoning.push(`${activeOBs.length} active order blocks`); }
  const activeFVGs = fvgs.filter(f => !f.mitigated);
  if (activeFVGs.length > 0) { score += 1.5; reasoning.push(`${activeFVGs.length} unfilled FVGs`); }
  if (premiumDiscount.currentZone !== "equilibrium") { score += 1.5; reasoning.push(`Price in ${premiumDiscount.currentZone} zone`); }
  if (session.isKillZone) { score += 1; reasoning.push(`${session.name} kill zone active`); }
  if (judasSwing.detected) { score += 1; reasoning.push(`Judas Swing: ${judasSwing.type}`); }
  if (pdLevels) { score += 0.5; reasoning.push("PD/PW levels available"); }
  const sweptPool = liquidityPools.find(lp => lp.swept);
  if (sweptPool) { score += 0.5; reasoning.push(`${sweptPool.type} liquidity swept`); }
  score = Math.min(10, Math.round(score * 10) / 10);

  const bias = structure.trend === "bullish" ? "bullish" : structure.trend === "bearish" ? "bearish" : "neutral";

  return {
    structure, orderBlocks, fvgs, liquidityPools, pdLevels, judasSwing,
    session, premiumDiscount, confluenceScore: score, bias, reasoning,
  };
}

// ─── HTTP Handler ───────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { action, candles, dailyCandles, pairData, data1, data2 } = await req.json();

    if (action === "full_analysis") {
      const result = runFullAnalysis(candles, dailyCandles);
      return respond(result);
    }

    if (action === "currency_strength") {
      return respond(calculateCurrencyStrength(pairData || {}));
    }

    if (action === "correlation") {
      return respond({ coefficient: calculateCorrelation(data1 || [], data2 || []) });
    }

    if (action === "structure") return respond(analyzeMarketStructure(candles));
    if (action === "order_blocks") return respond(detectOrderBlocks(candles));
    if (action === "fvgs") return respond(detectFVGs(candles));
    if (action === "liquidity") return respond(detectLiquidityPools(candles));
    if (action === "session") return respond(detectSession());

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function respond(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
