/**
 * narrative.ts — Rule-based narrative sentence generation for the SMC trading bot.
 *
 * Generates plain-English sentences that describe what the bot sees and what it's waiting for.
 * No LLM needed — purely deterministic string construction from available data fields.
 */

// ── Types ──

interface FactorInfo {
  name: string;
  present?: boolean;
  weight?: number;
}

interface DetailNarrativeInput {
  pair: string;
  direction: string;
  status: string;
  factors?: FactorInfo[];
  regimeData?: { daily?: { regime?: string; bias?: string }; h4?: { regime?: string; bias?: string } };
  rejectionReasons?: string[];
  gates?: Array<{ passed: boolean; reason: string }>;
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
  setup_type: string | null;
}

interface TradeEntryNarrativeInput {
  pair: string;
  direction: string;
  factors?: FactorInfo[];
  regimeData?: { daily?: { regime?: string; bias?: string }; h4?: { regime?: string; bias?: string } };
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

/** Present per the recorded flag; rows written before it existed fall back to a positive weight. */
const isPresent = (f: FactorInfo) => (typeof f.present === "boolean" ? f.present : (f.weight || 0) > 0);

function minutesRemaining(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
}

// ── Public Generators ──

/**
 * Detail breakdown header narrative — describes the overall thesis for the scan result.
 * Example: "Bearish continuation — 2 BOS confirmed, price in premium, waiting for entry zone."
 */
export function generateDetailNarrative(input: DetailNarrativeInput): string {
  const { direction, status, factors, regimeData, rejectionReasons, gates } = input;

  // Determine if it's a trade, a zone setup, or a rejection
  const isTraded = status === "trade_placed";
  const isLimit = status === "limit_order_placed" || status === "zone_setup_active";
  const isRejected = status === "rejected";

  const dir = dirLabel(direction);
  const zone = zoneDescription(regimeData, direction);
  const regime = regimeLabel(regimeData);

  // Key structure factors
  const factorNames = (factors || []).filter(isPresent).map(f => f.name);
  const hasMS = factorNames.includes("Market Structure");
  const hasOB = factorNames.includes("Order Block");
  const hasFVG = factorNames.includes("Fair Value Gap");
  const hasSweep = factorNames.includes("Liquidity Sweep");

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
    narrative += ".";
  } else if (isLimit) {
    const zoneType = input.limitOrder?.zone_type || "OB/FVG";
    narrative = `${dir} zone setup at ${zoneType}`;
    if (zone) narrative += ` ${zone}`;
    narrative += ". Watching for retrace → 5m CHoCH confirmation.";
  } else if (isRejected) {
    const failedGates = (gates || []).filter(g => !g.passed);
    if (failedGates.length > 0) {
      narrative = `${dir} rejected — ${failedGates[0].reason}.`;
    } else if (rejectionReasons && rejectionReasons.length > 0) {
      narrative = `${dir} rejected — ${rejectionReasons[0]}.`;
    } else {
      narrative = `${dir} setup rejected.`;
    }
  } else {
    // Generic / watching
    narrative = `${dir} setup`;
    if (zone) narrative += ` ${zone}`;
    if (regime !== "unknown") narrative += `, market ${regime}`;
    narrative += ".";
  }

  return narrative;
}

/**
 * Zone setup narrative — describes what the bot is watching for.
 * Example: "Watching for price to reach OB zone at 157.82 → will hunt 5m CHoCH. Expires in 45 min."
 */
export function generatePendingOrderNarrative(input: PendingOrderNarrativeInput): string {
  const { direction, entry_price, entry_zone_type, order_type, expires_at } = input;

  const dir = dirLabel(direction);
  const zoneLabel = order_type === "limit_ob" ? "Order Block" : "FVG";
  const mins = minutesRemaining(expires_at);
  const confirmType = direction === "long" ? "bullish" : "bearish";

  let narrative = `Watching for price to reach ${zoneLabel} zone`;
  if (entry_zone_type && entry_zone_type !== "unknown") {
    narrative = `Watching for price to reach ${entry_zone_type} zone`;
  }
  narrative += ` at ${Number(entry_price).toFixed(entry_price > 100 ? 2 : 5)}`;
  narrative += ` → will hunt ${confirmType} CHoCH on 5m`;

  if (mins > 0) {
    const timeStr = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    narrative += `. Zone watch expires in ${timeStr}.`;
  } else {
    narrative += `. Zone watch expired.`;
  }

  return narrative;
}

/**
 * Trade entry narrative — describes why the bot entered.
 * Example: "Entered SHORT: 4H premium + 1H bearish CHoCH + OB at level + FVG confluence."
 */
export function generateTradeEntryNarrative(input: TradeEntryNarrativeInput): string {
  const { direction, factors, regimeData } = input;

  const dir = dirLabel(direction);
  const zone = zoneDescription(regimeData, direction);

  // Key confluences, structure first
  const confluences: string[] = [];
  if (zone) confluences.push(zone);

  const present = new Set((factors || []).filter(isPresent).map(f => f.name));
  const LABELS: [string, string][] = [
    ["Market Structure", "structure confirmed"],
    ["Order Block", "OB at level"],
    ["Fair Value Gap", "FVG confluence"],
    ["Premium/Discount & Fib", "Fib/PD zone"],
    ["Liquidity Sweep", "liquidity swept"],
    ["Displacement", "displacement"],
    ["Reversal Candle", "reversal candle"],
    ["HTF POI Alignment", "HTF alignment"],
    ["HTF Fib + PD + Liquidity", "HTF Fib+PD"],
  ];
  for (const [name, label] of LABELS) if (present.has(name)) confluences.push(label);

  let narrative = `Entered ${dir}`;
  if (confluences.length > 0) {
    narrative += `: ${confluences.join(" + ")}`;
  }
  narrative += ".";

  return narrative;
}
