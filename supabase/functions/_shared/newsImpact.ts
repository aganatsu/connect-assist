// ─── News Impact Analysis Engine ────────────────────────────────────
// Goes beyond time-based avoidance: understands WHAT news means for currencies.
//
// Three layers:
//   1. Event Classification — maps event titles to known economic indicators
//   2. Impact Interpretation — when actual/forecast/previous are available,
//      determines if the result is bullish/bearish for the currency
//   3. Bias Adjustment — provides a directional signal that the game plan
//      and scanner can use to adjust session bias
//
// Usage:
//   import { analyzeNewsImpact, getNewsDirectionalBias } from "./newsImpact.ts";
//   const impact = analyzeNewsImpact(events);
//   const bias = getNewsDirectionalBias("USD", impact);
// ────────────────────────────────────────────────────────────────────

export interface NewsEvent {
  id?: string;
  name: string;
  title?: string;
  currency: string;
  country?: string;
  impact: string; // "high" | "medium" | "low" | "holiday"
  scheduledTime: string;
  forecast?: string | null;
  previous?: string | null;
  actual?: string | null;
  affectedPairs?: string[];
}

export interface NewsImpactResult {
  event: NewsEvent;
  category: EventCategory;
  interpretation: EventInterpretation;
  directionalImpact: "bullish" | "bearish" | "neutral" | "unknown";
  confidence: number; // 0-100
  reasoning: string;
}

export interface EventInterpretation {
  hasActual: boolean;
  hasForecast: boolean;
  hasPrevious: boolean;
  beatExpectation: boolean | null; // null if no forecast to compare
  betterThanPrevious: boolean | null;
  magnitude: "major" | "moderate" | "minor" | "unknown";
}

export type EventCategory =
  | "interest_rate"
  | "inflation"
  | "employment"
  | "gdp"
  | "trade_balance"
  | "consumer_sentiment"
  | "manufacturing"
  | "housing"
  | "central_bank_speech"
  | "retail_sales"
  | "pmi"
  | "monetary_policy"
  | "fiscal_policy"
  | "geopolitical"
  | "holiday"
  | "other";

// ─── Event Title → Category Mapping ────────────────────────────────
// Maps known ForexFactory event titles to categories for interpretation.
// Uses keyword matching — order matters (first match wins).

interface CategoryRule {
  keywords: string[];
  category: EventCategory;
  // How higher-than-expected values affect the currency:
  //   "bullish" = higher is good for currency (e.g., GDP, employment)
  //   "bearish" = higher is bad for currency (e.g., unemployment claims)
  //   "complex" = depends on context (e.g., inflation — moderate is good, too high is bad)
  higherIsBullish: boolean | "complex";
}

const CATEGORY_RULES: CategoryRule[] = [
  // Interest rates — higher = stronger currency (attracts capital)
  { keywords: ["policy rate", "interest rate", "cash rate", "overnight rate", "base rate", "repo rate", "refinancing rate"],
    category: "interest_rate", higherIsBullish: true },

  // Inflation — complex: moderate inflation is healthy, but too high forces rate hikes
  // For trading: higher CPI usually = bullish (markets expect rate hikes)
  { keywords: ["cpi", "consumer price", "inflation", "pce price", "core pce", "rpi"],
    category: "inflation", higherIsBullish: "complex" },

  // Employment — higher employment = bullish
  { keywords: ["non-farm", "nonfarm", "nfp", "employment change", "jobs", "payroll", "adp"],
    category: "employment", higherIsBullish: true },
  // Unemployment — higher = bearish (inverse)
  { keywords: ["unemployment", "jobless", "claimant"],
    category: "employment", higherIsBullish: false },

  // GDP — higher = bullish
  { keywords: ["gdp", "gross domestic"],
    category: "gdp", higherIsBullish: true },

  // Trade balance — higher surplus = bullish
  { keywords: ["trade balance", "current account", "goods trade"],
    category: "trade_balance", higherIsBullish: true },

  // Consumer sentiment — higher = bullish
  { keywords: ["consumer confidence", "consumer sentiment", "michigan", "gfk", "westpac"],
    category: "consumer_sentiment", higherIsBullish: true },

  // Manufacturing — higher = bullish
  { keywords: ["manufacturing", "industrial production", "factory orders", "durable goods"],
    category: "manufacturing", higherIsBullish: true },

  // PMI — higher = bullish (above 50 = expansion)
  { keywords: ["pmi", "purchasing manager", "ivey", "ism"],
    category: "pmi", higherIsBullish: true },

  // Housing — higher = bullish
  { keywords: ["housing", "building permits", "home sales", "house price", "construction"],
    category: "housing", higherIsBullish: true },

  // Retail sales — higher = bullish
  { keywords: ["retail sales", "core retail"],
    category: "retail_sales", higherIsBullish: true },

  // Central bank speeches — directional based on hawkish/dovish tone (can't determine from data alone)
  { keywords: ["speaks", "speech", "press conference", "testimony", "boj governor", "fed chair", "ecb president", "boe governor", "rba governor"],
    category: "central_bank_speech", higherIsBullish: "complex" },

  // Monetary policy statements
  { keywords: ["monetary policy", "rate statement", "meeting minutes", "fomc", "outlook report", "mpc"],
    category: "monetary_policy", higherIsBullish: "complex" },

  // Fiscal policy
  { keywords: ["budget", "fiscal", "government spending", "debt"],
    category: "fiscal_policy", higherIsBullish: "complex" },

  // Geopolitical
  { keywords: ["trump", "president", "summit", "election", "referendum", "tariff", "sanction", "war"],
    category: "geopolitical", higherIsBullish: "complex" },

  // Holidays
  { keywords: ["holiday", "bank holiday"],
    category: "holiday", higherIsBullish: "complex" },
];

// ─── Parse Numeric Value from ForexFactory Format ──────────────────
// Handles: "1.3%", "-0.5%", "234K", "1.23M", "<0.75%", ">2.0%", "0.50%"
function parseNumericValue(val: string | null | undefined): number | null {
  if (!val || val.trim() === "") return null;
  let cleaned = val.trim().replace(/[<>≤≥]/g, "").replace(/,/g, "");
  let multiplier = 1;
  if (cleaned.endsWith("K")) { multiplier = 1000; cleaned = cleaned.slice(0, -1); }
  else if (cleaned.endsWith("M")) { multiplier = 1000000; cleaned = cleaned.slice(0, -1); }
  else if (cleaned.endsWith("B")) { multiplier = 1000000000; cleaned = cleaned.slice(0, -1); }
  else if (cleaned.endsWith("T")) { multiplier = 1000000000000; cleaned = cleaned.slice(0, -1); }
  else if (cleaned.endsWith("%")) { cleaned = cleaned.slice(0, -1); }
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num * multiplier;
}

// ─── Classify Event ────────────────────────────────────────────────
function classifyEvent(event: NewsEvent): { category: EventCategory; rule: CategoryRule | null } {
  const title = (event.name || event.title || "").toLowerCase();
  const impact = (event.impact || "").toLowerCase();

  if (impact === "holiday") return { category: "holiday", rule: null };

  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some(kw => title.includes(kw))) {
      return { category: rule.category, rule };
    }
  }
  return { category: "other", rule: null };
}

// ─── Interpret Single Event ────────────────────────────────────────
function interpretEvent(event: NewsEvent, category: EventCategory, rule: CategoryRule | null): {
  interpretation: EventInterpretation;
  directionalImpact: "bullish" | "bearish" | "neutral" | "unknown";
  confidence: number;
  reasoning: string;
} {
  const actual = parseNumericValue(event.actual);
  const forecast = parseNumericValue(event.forecast);
  const previous = parseNumericValue(event.previous);

  const interpretation: EventInterpretation = {
    hasActual: actual !== null,
    hasForecast: forecast !== null,
    hasPrevious: previous !== null,
    beatExpectation: actual !== null && forecast !== null ? actual > forecast : null,
    betterThanPrevious: actual !== null && previous !== null ? actual > previous : null,
    magnitude: "unknown",
  };

  // If no actual data yet, we can still provide pre-event analysis
  if (actual === null) {
    return interpretPreEvent(event, category, rule, forecast, previous, interpretation);
  }

  // We have actual data — interpret the result
  return interpretPostEvent(event, category, rule, actual, forecast, previous, interpretation);
}

// ─── Pre-Event Interpretation (no actual data yet) ─────────────────
function interpretPreEvent(
  event: NewsEvent, category: EventCategory, rule: CategoryRule | null,
  forecast: number | null, previous: number | null,
  interpretation: EventInterpretation,
): { interpretation: EventInterpretation; directionalImpact: "bullish" | "bearish" | "neutral" | "unknown"; confidence: number; reasoning: string } {

  // Speeches and policy statements — can't predict direction
  if (category === "central_bank_speech" || category === "monetary_policy" || category === "geopolitical") {
    return {
      interpretation,
      directionalImpact: "unknown",
      confidence: 15,
      reasoning: `${event.name}: Upcoming — direction unpredictable (speech/policy). Increased volatility expected for ${event.currency}.`,
    };
  }

  // Holiday — no impact
  if (category === "holiday") {
    return {
      interpretation,
      directionalImpact: "neutral",
      confidence: 90,
      reasoning: `${event.currency} bank holiday — reduced liquidity, wider spreads expected.`,
    };
  }

  // If forecast differs significantly from previous, we can anticipate direction
  if (forecast !== null && previous !== null && rule) {
    const diff = forecast - previous;
    const pctChange = previous !== 0 ? Math.abs(diff / previous) * 100 : 0;

    if (pctChange > 10) {
      interpretation.magnitude = "major";
    } else if (pctChange > 3) {
      interpretation.magnitude = "moderate";
    } else {
      interpretation.magnitude = "minor";
    }

    if (Math.abs(diff) > 0.001) {
      const forecastHigher = diff > 0;
      let impact: "bullish" | "bearish" | "neutral";

      if (rule.higherIsBullish === true) {
        impact = forecastHigher ? "bullish" : "bearish";
      } else if (rule.higherIsBullish === false) {
        impact = forecastHigher ? "bearish" : "bullish";
      } else {
        // Complex — for inflation, higher forecast usually = bullish (rate hike expectations)
        if (category === "inflation") {
          impact = forecastHigher ? "bullish" : "bearish";
        } else {
          impact = "neutral";
        }
      }

      return {
        interpretation,
        directionalImpact: impact,
        confidence: 30, // Low confidence — forecast isn't always right
        reasoning: `${event.name}: Forecast ${event.forecast} vs previous ${event.previous} — ${forecastHigher ? "higher" : "lower"} expected, potentially ${impact} for ${event.currency}.`,
      };
    }
  }

  // No forecast or same as previous
  const impactLevel = (event.impact || "").toLowerCase();
  return {
    interpretation,
    directionalImpact: "unknown",
    confidence: 10,
    reasoning: `${event.name}: Upcoming ${impactLevel}-impact event for ${event.currency}. No forecast available — expect volatility.`,
  };
}

// ─── Post-Event Interpretation (actual data available) ─────────────
function interpretPostEvent(
  event: NewsEvent, category: EventCategory, rule: CategoryRule | null,
  actual: number, forecast: number | null, previous: number | null,
  interpretation: EventInterpretation,
): { interpretation: EventInterpretation; directionalImpact: "bullish" | "bearish" | "neutral" | "unknown"; confidence: number; reasoning: string } {

  // Determine magnitude of surprise
  let surpriseDirection: "above" | "below" | "inline" = "inline";
  let surpriseMagnitude = 0;

  if (forecast !== null) {
    const diff = actual - forecast;
    surpriseMagnitude = forecast !== 0 ? Math.abs(diff / forecast) * 100 : Math.abs(diff);

    if (surpriseMagnitude > 15) {
      interpretation.magnitude = "major";
      surpriseDirection = diff > 0 ? "above" : "below";
    } else if (surpriseMagnitude > 5) {
      interpretation.magnitude = "moderate";
      surpriseDirection = diff > 0 ? "above" : "below";
    } else if (surpriseMagnitude > 1) {
      interpretation.magnitude = "minor";
      surpriseDirection = diff > 0 ? "above" : "below";
    } else {
      interpretation.magnitude = "minor";
      surpriseDirection = "inline";
    }
  } else if (previous !== null) {
    // No forecast — compare to previous
    const diff = actual - previous;
    surpriseMagnitude = previous !== 0 ? Math.abs(diff / previous) * 100 : Math.abs(diff);
    surpriseDirection = diff > 0 ? "above" : diff < 0 ? "below" : "inline";
    interpretation.magnitude = surpriseMagnitude > 15 ? "major" : surpriseMagnitude > 5 ? "moderate" : "minor";
  }

  // No rule — can't determine direction
  if (!rule) {
    return {
      interpretation,
      directionalImpact: "neutral",
      confidence: 20,
      reasoning: `${event.name}: Actual ${event.actual} — unknown event type, can't determine impact.`,
    };
  }

  // Determine directional impact based on surprise and rule
  let impact: "bullish" | "bearish" | "neutral";
  let confidence: number;

  if (surpriseDirection === "inline") {
    impact = "neutral";
    confidence = 60;
    return {
      interpretation,
      directionalImpact: impact,
      confidence,
      reasoning: `${event.name}: Actual ${event.actual} in line with ${forecast !== null ? `forecast ${event.forecast}` : `previous ${event.previous}`} — neutral for ${event.currency}.`,
    };
  }

  const isAbove = surpriseDirection === "above";

  if (rule.higherIsBullish === true) {
    impact = isAbove ? "bullish" : "bearish";
  } else if (rule.higherIsBullish === false) {
    // Inverse indicators (unemployment, jobless claims)
    impact = isAbove ? "bearish" : "bullish";
  } else {
    // Complex — inflation
    if (category === "inflation") {
      // Higher inflation → markets expect rate hikes → bullish for currency
      // But extremely high inflation → economic concern → could be bearish
      // For simplicity: higher = bullish (rate hike expectation dominates short-term)
      impact = isAbove ? "bullish" : "bearish";
    } else {
      impact = "neutral";
    }
  }

  // Confidence based on magnitude and impact level
  const impactLevel = (event.impact || "").toLowerCase();
  const baseConfidence = impactLevel === "high" ? 70 : impactLevel === "medium" ? 50 : 30;
  const magnitudeBonus = interpretation.magnitude === "major" ? 20 : interpretation.magnitude === "moderate" ? 10 : 0;
  confidence = Math.min(90, baseConfidence + magnitudeBonus);

  const comparedTo = forecast !== null ? `forecast ${event.forecast}` : `previous ${event.previous}`;
  const surpriseLabel = interpretation.magnitude === "major" ? "MAJOR surprise" : interpretation.magnitude === "moderate" ? "moderate surprise" : "slight deviation";

  return {
    interpretation,
    directionalImpact: impact,
    confidence,
    reasoning: `${event.name}: Actual ${event.actual} ${isAbove ? "above" : "below"} ${comparedTo} (${surpriseLabel}) — ${impact} for ${event.currency}.`,
  };
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Analyze an array of news events and return impact assessments.
 * Filters to only high/medium impact events by default.
 */
export function analyzeNewsImpact(events: NewsEvent[], includeAll = false): NewsImpactResult[] {
  const filtered = includeAll ? events : events.filter(e => {
    const imp = (e.impact || "").toLowerCase();
    return imp === "high" || imp === "medium";
  });

  return filtered.map(event => {
    const { category, rule } = classifyEvent(event);
    const { interpretation, directionalImpact, confidence, reasoning } = interpretEvent(event, category, rule);
    return { event, category, interpretation, directionalImpact, confidence, reasoning };
  });
}

/**
 * Get the net directional bias for a specific currency based on recent news.
 * Aggregates all events for that currency and produces a weighted bias.
 *
 * Returns:
 *   bias: "bullish" | "bearish" | "neutral"
 *   strength: 0-100 (how strong the news signal is)
 *   events: the individual event analyses
 *   summary: human-readable summary
 */
export function getNewsDirectionalBias(currency: string, impacts: NewsImpactResult[]): {
  bias: "bullish" | "bearish" | "neutral";
  strength: number;
  events: NewsImpactResult[];
  summary: string;
} {
  const currencyEvents = impacts.filter(i => i.event.currency === currency);

  if (currencyEvents.length === 0) {
    return { bias: "neutral", strength: 0, events: [], summary: `No news events for ${currency}.` };
  }

  // Weight each event by confidence and impact level
  let bullishScore = 0;
  let bearishScore = 0;

  for (const impact of currencyEvents) {
    const weight = impact.confidence / 100;
    const impactMultiplier = (impact.event.impact || "").toLowerCase() === "high" ? 2 : 1;

    if (impact.directionalImpact === "bullish") {
      bullishScore += weight * impactMultiplier;
    } else if (impact.directionalImpact === "bearish") {
      bearishScore += weight * impactMultiplier;
    }
  }

  const totalScore = bullishScore + bearishScore;
  const netScore = bullishScore - bearishScore;

  let bias: "bullish" | "bearish" | "neutral";
  let strength: number;

  if (totalScore === 0) {
    bias = "neutral";
    strength = 0;
  } else {
    const ratio = Math.abs(netScore) / totalScore;
    strength = Math.round(ratio * 100);

    if (strength < 20) {
      bias = "neutral";
    } else {
      bias = netScore > 0 ? "bullish" : "bearish";
    }
  }

  // Build summary
  const bullishEvents = currencyEvents.filter(e => e.directionalImpact === "bullish");
  const bearishEvents = currencyEvents.filter(e => e.directionalImpact === "bearish");
  const unknownEvents = currencyEvents.filter(e => e.directionalImpact === "unknown");

  let summary = `${currency} news bias: ${bias.toUpperCase()} (${strength}% strength). `;
  if (bullishEvents.length > 0) {
    summary += `Bullish: ${bullishEvents.map(e => e.event.name).join(", ")}. `;
  }
  if (bearishEvents.length > 0) {
    summary += `Bearish: ${bearishEvents.map(e => e.event.name).join(", ")}. `;
  }
  if (unknownEvents.length > 0) {
    summary += `Volatility risk: ${unknownEvents.map(e => e.event.name).join(", ")}.`;
  }

  return { bias, strength, events: currencyEvents, summary: summary.trim() };
}

/**
 * Get news bias for a trading pair (e.g., "EUR/USD").
 * Combines the bias of both currencies to determine net effect on the pair.
 *
 * For EUR/USD:
 *   - Bullish EUR news = bullish for EUR/USD (EUR strengthens)
 *   - Bullish USD news = bearish for EUR/USD (USD strengthens, pair drops)
 *
 * Returns:
 *   pairBias: "bullish" | "bearish" | "neutral" (for the pair direction)
 *   baseBias: bias for the base currency
 *   quoteBias: bias for the quote currency
 *   netStrength: combined strength
 *   summary: human-readable explanation
 */
export function getNewsPairBias(pair: string, impacts: NewsImpactResult[]): {
  pairBias: "bullish" | "bearish" | "neutral";
  baseBias: ReturnType<typeof getNewsDirectionalBias>;
  quoteBias: ReturnType<typeof getNewsDirectionalBias>;
  netStrength: number;
  summary: string;
} {
  const parts = pair.split("/");
  if (parts.length !== 2) {
    return {
      pairBias: "neutral",
      baseBias: { bias: "neutral", strength: 0, events: [], summary: "" },
      quoteBias: { bias: "neutral", strength: 0, events: [], summary: "" },
      netStrength: 0,
      summary: `Cannot parse pair: ${pair}`,
    };
  }

  const [base, quote] = parts;

  // Handle non-forex pairs (XAU, BTC, etc.)
  const baseCurrency = base === "XAU" ? "XAU" : base === "XAG" ? "XAG" : base === "BTC" ? "BTC" : base === "ETH" ? "ETH" : base;
  const quoteCurrency = quote;

  const baseBias = getNewsDirectionalBias(baseCurrency, impacts);
  const quoteBias = getNewsDirectionalBias(quoteCurrency, impacts);

  // Net effect on pair:
  // Bullish base + bearish quote = strongly bullish pair
  // Bearish base + bullish quote = strongly bearish pair
  let pairScore = 0;

  // Base currency bullish = pair bullish
  if (baseBias.bias === "bullish") pairScore += baseBias.strength;
  else if (baseBias.bias === "bearish") pairScore -= baseBias.strength;

  // Quote currency bullish = pair bearish (inverse)
  if (quoteBias.bias === "bullish") pairScore -= quoteBias.strength;
  else if (quoteBias.bias === "bearish") pairScore += quoteBias.strength;

  const netStrength = Math.min(100, Math.abs(pairScore));
  let pairBias: "bullish" | "bearish" | "neutral";

  if (netStrength < 15) {
    pairBias = "neutral";
  } else {
    pairBias = pairScore > 0 ? "bullish" : "bearish";
  }

  let summary = `${pair} news bias: ${pairBias.toUpperCase()} (${netStrength}% strength). `;
  if (baseBias.bias !== "neutral") summary += `${base}: ${baseBias.bias} (${baseBias.strength}%). `;
  if (quoteBias.bias !== "neutral") summary += `${quote}: ${quoteBias.bias} (${quoteBias.strength}%). `;
  if (baseBias.events.length === 0 && quoteBias.events.length === 0) {
    summary += "No significant news for either currency.";
  }

  return { pairBias, baseBias, quoteBias, netStrength, summary: summary.trim() };
}

/**
 * Determine if a trade direction aligns with the news bias for a pair.
 * Used as an advisory signal (not a hard gate by itself).
 *
 * Returns:
 *   aligned: true if trade direction matches news bias (or news is neutral)
 *   conflicting: true if trade direction opposes strong news bias
 *   advisory: human-readable advisory message
 */
export function checkNewsAlignment(pair: string, direction: "long" | "short", impacts: NewsImpactResult[]): {
  aligned: boolean;
  conflicting: boolean;
  advisory: string;
  pairBias: string;
  strength: number;
} {
  const { pairBias, netStrength, summary } = getNewsPairBias(pair, impacts);

  // Neutral news = always aligned
  if (pairBias === "neutral" || netStrength < 15) {
    return {
      aligned: true,
      conflicting: false,
      advisory: `News neutral for ${pair} — no directional conflict.`,
      pairBias,
      strength: netStrength,
    };
  }

  const tradeAligned = (direction === "long" && pairBias === "bullish") ||
                       (direction === "short" && pairBias === "bearish");

  if (tradeAligned) {
    return {
      aligned: true,
      conflicting: false,
      advisory: `News supports ${direction} ${pair}: ${summary}`,
      pairBias,
      strength: netStrength,
    };
  }

  // Trade conflicts with news
  return {
    aligned: false,
    conflicting: netStrength >= 40, // Only flag as conflicting if strong signal
    advisory: `⚠ News opposes ${direction} ${pair}: ${summary}`,
    pairBias,
    strength: netStrength,
  };
}
