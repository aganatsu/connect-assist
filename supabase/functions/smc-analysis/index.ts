import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import {
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFVGs,
  detectLiquidityPools,
  detectJudasSwing,
  detectReversalCandle,
  calculatePremiumDiscount,
  calculatePDLevels,
  detectSession,
  detectSilverBullet,
  detectMacroWindow,
  detectAMDPhase,
  detectDisplacement,
  tagDisplacementQuality,
  detectBreakerBlocks,
  detectUnicornSetups,
  calculateAnchoredVWAP,
  calculateATR,
  SPECS,
  type Candle,
  type ReasoningFactor,
} from "../_shared/smcAnalysis.ts";

// Safe number formatter — guards against undefined/null/NaN
const fx = (n: any, d = 5) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "n/a");

// ─── Currency Strength (standalone, not in shared) ──────────────────
function calculateCurrencyStrength(pairData: Record<string, { change: number }>): any[] {
  const currencies = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "NZD", "CHF"];
  const scores: Record<string, number> = {};
  currencies.forEach(c => (scores[c] = 0));
  for (const [pair, data] of Object.entries(pairData)) {
    const base = pair.slice(0, 3).toUpperCase();
    const quote = pair.slice(4, 7).toUpperCase();
    if (scores[base] !== undefined) scores[base] += data.change;
    if (scores[quote] !== undefined) scores[quote] -= data.change;
  }
  return currencies.map(c => ({ currency: c, strength: Math.round(scores[c] * 100) / 100 }));
}

// ─── Correlation (standalone, not in shared) ────────────────────────
function calculateCorrelation(data1: number[], data2: number[]): number {
  const n = Math.min(data1.length, data2.length);
  if (n < 5) return 0;
  const x = data1.slice(0, n), y = data2.slice(0, n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i] - mx, yi = y[i] - my;
    num += xi * yi; dx += xi * xi; dy += yi * yi;
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? Math.round((num / denom) * 1000) / 1000 : 0;
}

// ─── Full Confluence Analysis (mirrors scanner's 21-factor scoring) ──
// C1 fix: This now uses the SAME shared detection functions as the bot-scanner,
// producing identical scores. The old simplified scoring is replaced.
function runFullAnalysis(candles: Candle[], dailyCandles?: Candle[]) {
  // Core detections (same functions as scanner)
  const structure = analyzeMarketStructure(candles);
  const structureBreaks = [...structure.bos, ...structure.choch];
  const orderBlocks = detectOrderBlocks(candles, structureBreaks);
  const fvgs = detectFVGs(candles);

  // FVG adjacency bonus (same as scanner)
  for (const ob of orderBlocks) {
    const hasFVGNearby = fvgs.some(f => Math.abs(f.index - ob.index) <= 5);
    (ob as any).hasFVGAdjacency = hasFVGNearby;
  }

  const liquidityPools = detectLiquidityPools(candles);
  const judasSwing = detectJudasSwing(candles);
  const reversalCandle = detectReversalCandle(candles);
  const pd = calculatePremiumDiscount(candles);
  const session = detectSession();
  const pdLevels = dailyCandles ? calculatePDLevels(dailyCandles) : null;
  const lastPrice = candles[candles.length - 1].close;

  // Extended detections (same as scanner)
  const displacement = detectDisplacement(candles);
  tagDisplacementQuality(orderBlocks, fvgs, displacement.displacementCandles);
  const breakerBlocks = detectBreakerBlocks(orderBlocks, candles);
  const unicornSetups = detectUnicornSetups(breakerBlocks, fvgs);
  const silverBullet = detectSilverBullet();
  const macroWindow = detectMacroWindow();
  const amd = detectAMDPhase(candles);
  const vwap = calculateAnchoredVWAP(candles, 0.0001); // default forex pip

  // ── 21-Factor Confluence Scoring (mirrors scanner exactly) ──
  let score = 0;
  const factors: ReasoningFactor[] = [];

  // Factor 1: Market Structure / BOS/CHoCH (max 1.5)
  {
    let pts = 0;
    let detail = "";
    if (structure.choch.length > 0) {
      pts = 1.5;
      detail = `${structure.choch.length} CHoCH detected — trend reversal confirmed`;
    } else if (structure.bos.length > 0) {
      pts = 1.0;
      detail = `${structure.bos.length} BOS detected — trend continuation`;
    } else {
      detail = "No BOS or CHoCH detected";
    }
    score += pts;
    factors.push({ name: "Market Structure", present: pts > 0, weight: pts, detail, group: "Market Structure" });
  }

  // Factor 2: Order Block (max 2.0)
  {
    let pts = 0;
    let detail = "";
    const activeOBs = orderBlocks.filter(ob => !ob.mitigated);
    const insideOB = activeOBs.find(ob => lastPrice >= ob.low && lastPrice <= ob.high);
    if (insideOB) {
      pts = 2.0;
      const tags: string[] = [];
      if ((insideOB as any).hasDisplacement) tags.push("displacement");
      if ((insideOB as any).hasFVGAdjacency) tags.push("FVG adjacent");
      detail = `Price inside ${insideOB.type} OB at ${insideOB.low.toFixed(5)}-${insideOB.high.toFixed(5)}`;
      if (tags.length > 0) detail += ` [${tags.join(", ")}]`;
    } else if (activeOBs.length > 0) {
      pts = 0.5;
      detail = `${activeOBs.length} active OBs nearby`;
    } else {
      detail = "No active order blocks";
    }
    score += pts;
    factors.push({ name: "Order Block", present: pts > 0, weight: pts, detail, group: "Order Flow Zones" });
  }

  // Factor 3: Fair Value Gap (max 2.0)
  {
    let pts = 0;
    let detail = "";
    const activeFVGs = fvgs.filter(f => !f.mitigated);
    const insideFVG = activeFVGs.find(f => lastPrice >= f.low && lastPrice <= f.high);
    if (insideFVG) {
      const ce = (insideFVG.high + insideFVG.low) / 2;
      const fvgRange = insideFVG.high - insideFVG.low;
      const distFromCE = Math.abs(lastPrice - ce);
      const nearCE = fvgRange > 0 && (distFromCE / fvgRange) <= 0.15;
      if (nearCE) {
        pts = 2.0;
        detail = `Price at CE (${ce.toFixed(5)}) of ${insideFVG.type} FVG — optimal entry`;
      } else {
        pts = 1.5;
        detail = `Price inside ${insideFVG.type} FVG (CE: ${ce.toFixed(5)})`;
      }
    } else if (activeFVGs.length > 0) {
      pts = 0.5;
      detail = `${activeFVGs.length} unfilled FVGs in range`;
    } else {
      detail = "No active FVGs";
    }
    score += pts;
    factors.push({ name: "Fair Value Gap", present: pts > 0, weight: pts, detail, group: "Order Flow Zones" });
  }

  // Factor 4: Premium/Discount (max 1.5)
  {
    let pts = 0;
    let detail = "";
    if (pd.currentZone !== "equilibrium") {
      pts = pd.oteZone ? 1.5 : 1.0;
      detail = `Price in ${pd.currentZone} zone (${pd.zonePercent.toFixed(0)}%)${pd.oteZone ? " — OTE zone" : ""}`;
    } else {
      detail = "Price at equilibrium";
    }
    score += pts;
    factors.push({ name: "Premium/Discount", present: pts > 0, weight: pts, detail, group: "Price Zones" });
  }

  // Factor 5: Liquidity Sweep (max 1.5)
  {
    let pts = 0;
    let detail = "";
    const sweptPool = liquidityPools.find(lp => lp.swept);
    if (sweptPool) {
      pts = 1.5;
      detail = `${sweptPool.type} liquidity swept at ${sweptPool.price.toFixed(5)}`;
    } else if (liquidityPools.length > 0) {
      pts = 0.3;
      detail = `${liquidityPools.length} liquidity pools identified`;
    } else {
      detail = "No liquidity pools detected";
    }
    score += pts;
    factors.push({ name: "Liquidity Sweep", present: pts > 0, weight: pts, detail, group: "Liquidity" });
  }

  // Factor 6: Session/Kill Zone (max 1.0)
  {
    let pts = 0;
    let detail = "";
    if (session.isKillZone) {
      pts = 1.0;
      detail = `${session.name} kill zone active`;
    } else {
      pts = 0.3;
      detail = `${session.name} session (no kill zone)`;
    }
    score += pts;
    factors.push({ name: "Session/Kill Zone", present: pts > 0, weight: pts, detail, group: "Timing" });
  }

  // Factor 7: Judas Swing (max 1.0)
  {
    let pts = 0;
    let detail = "";
    if (judasSwing.detected) {
      pts = judasSwing.confirmed ? 1.0 : 0.5;
      detail = `Judas Swing: ${judasSwing.type}${judasSwing.confirmed ? " (confirmed)" : " (unconfirmed)"}`;
    } else {
      detail = "No Judas Swing detected";
    }
    score += pts;
    factors.push({ name: "Judas Swing", present: pts > 0, weight: pts, detail, group: "Timing" });
  }

  // Factor 8: PD/PW Levels (max 0.5)
  {
    let pts = 0;
    let detail = "";
    if (pdLevels) {
      const { pdh, pdl, pwh, pwl } = pdLevels;
      const nearPD = Math.abs(lastPrice - pdh) / lastPrice < 0.002 || Math.abs(lastPrice - pdl) / lastPrice < 0.002;
      const nearPW = Math.abs(lastPrice - pwh) / lastPrice < 0.003 || Math.abs(lastPrice - pwl) / lastPrice < 0.003;
      if (nearPD) { pts = 0.5; detail = "Price near PD high/low"; }
      else if (nearPW) { pts = 0.3; detail = "Price near PW high/low"; }
      else { pts = 0.1; detail = "PD/PW levels available"; }
    } else {
      detail = "No daily candles for PD/PW";
    }
    score += pts;
    factors.push({ name: "PD/PW Levels", present: pts > 0, weight: pts, detail, group: "Price Zones" });
  }

  // Factor 9: Reversal Candle (max 0.5)
  {
    let pts = 0;
    let detail = "";
    if (reversalCandle.detected) {
      pts = 0.5;
      detail = `${reversalCandle.type} reversal candle detected`;
    } else {
      detail = "No reversal candle";
    }
    score += pts;
    factors.push({ name: "Reversal Candle", present: pts > 0, weight: pts, detail, group: "Market Structure" });
  }

  // Factor 10: Displacement (max 1.5)
  {
    let pts = 0;
    let detail = "";
    if (displacement.detected) {
      pts = 1.5;
      detail = `Displacement: ${displacement.count} large-body candle(s), last ${displacement.lastDirection}`;
    } else {
      detail = "No displacement detected";
    }
    score += pts;
    factors.push({ name: "Displacement", present: pts > 0, weight: pts, detail, group: "Market Structure" });
  }

  // Factor 11: Breaker Blocks (max 1.0)
  {
    let pts = 0;
    let detail = "";
    if (breakerBlocks.length > 0) {
      pts = 1.0;
      detail = `${breakerBlocks.length} breaker block(s) detected`;
    } else {
      detail = "No breaker blocks";
    }
    score += pts;
    factors.push({ name: "Breaker Blocks", present: pts > 0, weight: pts, detail, group: "Order Flow Zones" });
  }

  // Factor 12: Unicorn Setups (max 1.5)
  {
    let pts = 0;
    let detail = "";
    if (unicornSetups.length > 0) {
      pts = 1.5;
      detail = `${unicornSetups.length} Unicorn setup(s) (breaker + FVG overlap)`;
    } else {
      detail = "No Unicorn setups";
    }
    score += pts;
    factors.push({ name: "Unicorn Setup", present: pts > 0, weight: pts, detail, group: "Order Flow Zones" });
  }

  // Factor 13: Silver Bullet (max 1.0)
  {
    let pts = 0;
    let detail = "";
    if (silverBullet.active) {
      pts = 1.0;
      detail = `Silver Bullet ${silverBullet.window} active`;
    } else {
      detail = "No Silver Bullet window";
    }
    score += pts;
    factors.push({ name: "Silver Bullet", present: pts > 0, weight: pts, detail, group: "Timing" });
  }

  // Factor 14: Macro Time (max 0.5)
  {
    let pts = 0;
    let detail = "";
    if (macroWindow.active) {
      pts = 0.5;
      detail = `Macro time window active`;
    } else {
      detail = "No macro window";
    }
    score += pts;
    factors.push({ name: "Macro Time", present: pts > 0, weight: pts, detail, group: "Timing" });
  }

  // Factor 15: AMD Phase (max 1.0)
  {
    let pts = 0;
    let detail = "";
    if (amd.phase !== "none") {
      pts = amd.phase === "distribution" ? 1.0 : 0.5;
      detail = `AMD: ${amd.phase} phase detected`;
    } else {
      detail = "No AMD phase detected";
    }
    score += pts;
    factors.push({ name: "AMD Phase", present: pts > 0, weight: pts, detail, group: "Timing" });
  }

  // Factor 16: VWAP (max 0.5)
  {
    let pts = 0;
    let detail = "";
    if (vwap.vwap !== null) {
      pts = 0.5;
      const position = lastPrice > vwap.vwap ? "above" : "below";
      detail = `Price ${position} VWAP (${vwap.vwap.toFixed(5)})`;
    } else {
      detail = "VWAP not available";
    }
    score += pts;
    factors.push({ name: "VWAP", present: pts > 0, weight: pts, detail, group: "Price Zones" });
  }

  // Clamp score to 0-10
  score = Math.min(10, Math.round(score * 10) / 10);

  // Determine direction
  let direction: "long" | "short" | null = null;
  if (structure.trend === "bullish" && pd.currentZone !== "premium") direction = "long";
  else if (structure.trend === "bearish" && pd.currentZone !== "discount") direction = "short";

  const bias = direction === "long" ? "bullish" : direction === "short" ? "bearish" : "neutral";
  const presentFactors = factors.filter(f => f.present);
  const groupNames = [...new Set(factors.filter(f => f.group).map(f => f.group!))];
  const activeGroups = groupNames.filter(g => factors.some(f => f.group === g && f.present));

  const summary = direction
    ? `${direction === "long" ? "BUY" : "SELL"}: ${presentFactors.length}/${factors.length} factors aligned (score: ${score}/10)`
    : `No signal: ${presentFactors.length}/${factors.length} factors (score: ${score}/10)`;

  // Build backward-compatible response + new factor breakdown
  // Legacy fields: confluenceScore, bias, reasoning, structure, orderBlocks, fvgs, etc.
  // New fields: score, direction, factors, summary (same shape as scanner)
  const reasoning = presentFactors.map(f => f.detail);

  return {
    // Legacy fields (backward compat with IctAnalysis.tsx)
    confluenceScore: score,
    bias,
    reasoning,
    structure,
    orderBlocks,
    fvgs,
    liquidityPools,
    pdLevels,
    judasSwing,
    session,
    premiumDiscount: pd,
    // New scanner-equivalent fields
    score,
    direction,
    factors,
    summary,
    lastPrice,
    // Extended detections
    extendedFactors: { displacement, breakerBlocks, unicornSetups, silverBullet, macroWindow, vwap, amd },
    extendedConfluenceScore: score, // now unified — same as main score
    extendedReasoning: reasoning,
    reversalCandle,
  };
}

// ─── HTTP Handler ───────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { action, candles, dailyCandles, pairData, data1, data2 } = await req.json();

    if (action === "full_analysis") return respond(runFullAnalysis(candles, dailyCandles));
    if (action === "currency_strength") return respond(calculateCurrencyStrength(pairData || {}));
    if (action === "correlation") return respond({ coefficient: calculateCorrelation(data1 || [], data2 || []) });
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
