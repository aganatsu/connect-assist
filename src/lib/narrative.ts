/**
 * narrative.ts — Rule-based narrative sentence generation for the SMC trading bot.
 *
 * Generates plain-English sentences that describe what the bot sees and what it's waiting for.
 * No LLM needed — purely deterministic string construction from available data fields.
 */

// ── Types ──

interface FactorInfo {
  name: string;
  weight: number;
  tier?: string;
}

interface WatchlistNarrativeInput {
  symbol: string;
  direction: "long" | "short";
  current_score: number;
  watch_threshold: number;
  current_factors: FactorInfo[];
  missing_factors: FactorInfo[];
  tier1_count: number;
  tier2_count: number;
  setup_type: string | null;
  analysis_snapshot?: any;
}

interface DetailNarrativeInput {
  pair: string;
  direction: string;
  score: number;
  status: string;
  factors?: FactorInfo[];
  tieredScoring?: { tier1: any; tier2: any; tier3: any };
  regimeData?: { daily?: { regime?: string; bias?: string }; h4?: { regime?: string; bias?: string } };
  rejectionReasons?: string[];
  gates?: Array<{ passed: boolean; reason: string }>;
  staging?: { action?: string; cycles?: number; initialScore?: number };
  limitOrder?: { entry_price?: number; zone_type?: string };
}

interface PendingOrderNarrativeInput {
  symbol: string;
  direction: "long" | "short";
  entry_price: number;
  current_price: number | null;
  entry_zone_type: string;
  order_type: "limit_ob" | "limit_fvg";
  expires_at: string;
  signal_score: number;
  setup_type: string | null;
  from_watchlist: boolean;
}

interface TradeEntryNarrativeInput {
  pair: string;
  direction: string;
  score: number;
  factors?: FactorInfo[];
  tieredScoring?: { tier1: any; tier2: any; tier3: any };
  regimeData?: { daily?: { regime?: string; bias?: string }; h4?: { regime?: string; bias?: string } };
  staging?: { action?: string; cycles?: number; initialScore?: number };
  limitOrder?: { entry_price?: number; zone_type?: string };
}

// ── Helpers ──

function dirLabel(dir: string): string {
  return dir === "long" ? "LONG" : dir === "short" ? "SHORT" : dir.toUpperCase();
}

function zoneDescription(regimeData: any, direction: string): string {
  const h4 = regimeData?.h4;
  const daily = regimeData?.daily;
  if (!h4 && !daily) return "";

  // Check for premium/discount from regime bias
  const bias = h4?.bias || daily?.bias || "";
  if (direction === "short" && bias === "bearish") return "in premium zone";
  if (direction === "long" && bias === "bullish") return "in discount zone";
  if (direction === "short") return "in premium zone";
  if (direction === "long") return "in discount zone";
  return "";
}

function regimeLabel(regimeData: any): string {
  const h4 = regimeData?.h4;
  const daily = regimeData?.daily;
  const regime = h4?.regime || daily?.regime || "";
  if (regime.includes("strong_trend")) return "strong trend";
  if (regime.includes("trend")) return "trending";
  if (regime.includes("range")) return "ranging";
  if (regime.includes("choppy")) return "choppy";
  return regime.replace(/_/g, " ") || "unknown";
}

function topFactorNames(factors: FactorInfo[], limit = 3): string {
  if (!factors || factors.length === 0) return "";
  const sorted = [...factors].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return sorted.slice(0, limit).map(f => f.name).join(" + ");
}

function missingTier1Names(missing: FactorInfo[]): string[] {
  return missing.filter(f => f.tier === "T1").map(f => f.name);
}

function minutesRemaining(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
}

// ── Public Generators ──

/**
 * Watchlist card narrative — describes the thesis and what's needed to trigger.
 * Example: "SHORT setup in 4H premium. Score 58.7% → needs OB or FVG at level to trigger."
 */
export function generateWatchlistNarrative(input: WatchlistNarrativeInput): string {
  const { direction, current_score, current_factors, missing_factors, tier1_count, setup_type } = input;

  // Build thesis part
  const dir = dirLabel(direction);
  const setupDesc = setup_type ? `${setup_type} ` : "";
  const topFactors = topFactorNames(current_factors, 2);

  let thesis = `${dir} ${setupDesc}setup`;
  if (topFactors) thesis += ` — ${topFactors}`;
  thesis += `. Score ${current_score.toFixed(1)}%`;

  // Build "needs" part
  const missingT1 = missingTier1Names(missing_factors);
  if (missingT1.length > 0) {
    thesis += ` → needs ${missingT1.slice(0, 2).join(" or ")} to trigger.`;
  } else if (missing_factors.length > 0) {
    const topMissing = missing_factors.slice(0, 2).map(f => f.name).join(" or ");
    thesis += ` → needs ${topMissing} to strengthen.`;
  } else {
    thesis += ` → approaching trigger threshold.`;
  }

  return thesis;
}

/**
 * Detail breakdown header narrative — describes the overall thesis for the scan result.
 * Example: "Bearish continuation — 2 BOS confirmed, price in premium, waiting for entry zone."
 */
export function generateDetailNarrative(input: DetailNarrativeInput): string {
  const { direction, score, status, factors, regimeData, rejectionReasons, gates } = input;

  // Determine if it's a trade, watchlist, or rejection
  const isTraded = status === "trade_placed" || status === "trade_placed_from_watchlist";
  const isLimit = status === "limit_order_placed" || status === "limit_order_from_watchlist";
  const isRejected = status === "rejected";
  const isSkipped = status === "below_threshold";

  const dir = dirLabel(direction);
  const zone = zoneDescription(regimeData, direction);
  const regime = regimeLabel(regimeData);

  // Count key structure factors
  const factorNames = (factors || []).filter(f => (f.weight || 0) > 0).map(f => f.name);
  const hasMS = factorNames.includes("Market Structure");
  const hasOB = factorNames.includes("Order Block");
  const hasFVG = factorNames.includes("Fair Value Gap");
  const hasPD = factorNames.includes("Premium/Discount & Fib");
  const hasSweep = factorNames.includes("Liquidity Sweep");

  // Build narrative
  let narrative = "";

  if (isTraded) {
    narrative = `Entered ${dir}`;
    const confluences: string[] = [];
    if (zone) confluences.push(zone);
    if (hasMS) confluences.push("structure confirmed");
    if (hasOB) confluences.push("OB at level");
    if (hasFVG) confluences.push("FVG confluence");
    if (hasSweep) confluences.push("liquidity swept");
    if (confluences.length > 0) narrative += `: ${confluences.join(", ")}`;
    narrative += `. Score ${score.toFixed(1)}%.`;
  } else if (isLimit) {
    const zoneType = input.limitOrder?.zone_type || "OB/FVG";
    narrative = `${dir} limit placed at ${zoneType}`;
    if (zone) narrative += ` ${zone}`;
    narrative += `. Waiting for price retrace. Score ${score.toFixed(1)}%.`;
  } else if (isRejected) {
    const failedGates = (gates || []).filter(g => !g.passed);
    if (failedGates.length > 0) {
      narrative = `${dir} rejected — ${failedGates[0].reason}.`;
    } else if (rejectionReasons && rejectionReasons.length > 0) {
      narrative = `${dir} rejected — ${rejectionReasons[0]}.`;
    } else {
      narrative = `${dir} setup rejected at ${score.toFixed(1)}%.`;
    }
  } else if (isSkipped) {
    const missingFactors = (factors || []).filter(f => (f.weight || 0) <= 0);
    const missingT1 = missingFactors.filter(f => f.tier === "T1");
    if (missingT1.length > 0) {
      narrative = `${dir} below threshold — missing ${missingT1.slice(0, 2).map(f => f.name).join(", ")}. Score ${score.toFixed(1)}%.`;
    } else {
      narrative = `${dir} below threshold (${score.toFixed(1)}%). ${regime !== "unknown" ? `Market is ${regime}.` : ""}`;
    }
  } else {
    // Generic / watching
    narrative = `${dir} setup`;
    if (zone) narrative += ` ${zone}`;
    if (regime !== "unknown") narrative += `, market ${regime}`;
    narrative += `. Score ${score.toFixed(1)}%.`;
  }

  return narrative;
}

/**
 * Pending order narrative — describes what the bot is waiting for.
 * Example: "Waiting for price to retrace to OB at 157.82. Expires in 45 min."
 */
export function generatePendingOrderNarrative(input: PendingOrderNarrativeInput): string {
  const { direction, entry_price, entry_zone_type, order_type, expires_at, from_watchlist, signal_score } = input;

  const dir = dirLabel(direction);
  const zoneLabel = order_type === "limit_ob" ? "Order Block" : "FVG";
  const mins = minutesRemaining(expires_at);

  let narrative = `Waiting for price to retrace to ${zoneLabel}`;
  if (entry_zone_type && entry_zone_type !== "unknown") {
    narrative = `Waiting for price to retrace to ${entry_zone_type}`;
  }
  narrative += ` at ${Number(entry_price).toFixed(entry_price > 100 ? 2 : 5)}`;

  if (mins > 0) {
    const timeStr = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    narrative += `. Expires in ${timeStr}.`;
  } else {
    narrative += `. Expired.`;
  }

  if (from_watchlist) {
    narrative += ` (promoted from watchlist)`;
  }

  return narrative;
}

/**
 * Trade entry narrative — describes why the bot entered.
 * Example: "Entered SHORT: 4H premium + 1H bearish CHoCH + OB at level + FVG confluence."
 */
export function generateTradeEntryNarrative(input: TradeEntryNarrativeInput): string {
  const { pair, direction, score, factors, regimeData, staging, limitOrder } = input;

  const dir = dirLabel(direction);
  const zone = zoneDescription(regimeData, direction);

  // Build list of key confluences
  const confluences: string[] = [];
  if (zone) confluences.push(zone);

  const factorNames = (factors || []).filter(f => (f.weight || 0) > 0);
  const tier1Present = factorNames.filter(f => f.tier === "T1");
  const tier2Present = factorNames.filter(f => f.tier === "T2");

  // Add T1 factors by name
  for (const f of tier1Present) {
    if (f.name === "Market Structure") confluences.push("structure confirmed");
    else if (f.name === "Order Block") confluences.push("OB at level");
    else if (f.name === "Fair Value Gap") confluences.push("FVG confluence");
    else if (f.name === "Premium/Discount & Fib") confluences.push("Fib/PD zone");
  }

  // Add notable T2 factors
  for (const f of tier2Present.slice(0, 2)) {
    if (f.name === "Liquidity Sweep") confluences.push("liquidity swept");
    else if (f.name === "Displacement") confluences.push("displacement");
    else if (f.name === "Reversal Candle") confluences.push("reversal candle");
    else if (f.name === "HTF POI Alignment") confluences.push("HTF alignment");
    else if (f.name === "HTF Fib + PD + Liquidity") confluences.push("HTF Fib+PD");
    else if (f.name === "Confluence Stack") confluences.push("stacked confluence");
    else confluences.push(f.name.toLowerCase());
  }

  let narrative = `Entered ${dir}`;
  if (confluences.length > 0) {
    narrative += `: ${confluences.join(" + ")}`;
  }
  narrative += `.`;

  // Add watchlist promotion context
  if (staging?.action === "promoted_and_traded" && staging.cycles) {
    narrative += ` Watched ${staging.cycles} cycle${staging.cycles !== 1 ? "s" : ""}.`;
  }

  return narrative;
}
