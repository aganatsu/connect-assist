/**
 * _shared/sessionAffinity.ts — Session-Pair Affinity Scoring
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module provides intelligence about WHICH pairs trade best during WHICH
 * sessions. It answers the question: "Given the current session, how good is
 * this pair to trade right now?"
 *
 * The affinity scores are derived from:
 *   - BIS 2025 Triennial Survey (global FX volume distribution)
 *   - BabyPips empirical pip-range data per pair per session (2025)
 *   - ICT methodology (Power of 3, Silver Bullet, Kill Zones)
 *   - Institutional flow research (London-NY overlap concentration)
 *
 * USAGE:
 *   import { getSessionAffinity, SessionAffinityResult } from "./sessionAffinity.ts";
 *   const affinity = getSessionAffinity("EUR/USD", session, { atMs, atrTrend, nyDay });
 *   // affinity.score → 0.0 to 1.15 (base + overlap bonus)
 *   // affinity.tier → "prime" | "good" | "marginal" | "avoid"
 *   // affinity.detail → human-readable explanation
 *
 * BEHAVIOR IMPACT: This module is INFORMATIONAL ONLY. It does not modify
 * any gates, factor weights, or scoring in confluenceScoring.ts.
 * It exports pure functions that the scanner can call to annotate results.
 *
 * To promote to a scoring factor, add it to confluenceScoring.ts as Factor 26
 * with a weight key "sessionAffinity" in DEFAULT_FACTOR_WEIGHTS.
 */

import { type SessionName, type SessionFilterKey, toNYTime, toNYTimeAt } from "./sessions.ts";

// ─── Types ────────────────────────────────────────────────────────────

export interface SessionAffinityResult {
  /** Base affinity score for this pair in the current session (0.0 - 1.0) */
  baseScore: number;
  /** Overlap bonus applied (0.0 - 0.15) */
  overlapBonus: number;
  /** Day-of-week modifier applied (0.7 - 1.1) */
  dayModifier: number;
  /** ATR trend modifier applied (0.7 - 1.1) */
  atrModifier: number;
  /** Final composite score after all modifiers */
  score: number;
  /** Quality tier based on final score */
  tier: "prime" | "good" | "marginal" | "avoid";
  /** Human-readable explanation */
  detail: string;
  /** Whether the pair is in its primary session */
  isPrimarySession: boolean;
  /** Whether we're currently in the London-NY overlap window */
  isOverlap: boolean;
}

export interface AffinityOptions {
  /** UTC timestamp (ms) — defaults to Date.now() */
  atMs?: number;
  /** ATR trend from regime detection: "expanding" | "contracting" | "stable" */
  atrTrend?: "expanding" | "contracting" | "stable" | string;
  /** NY day of week (0=Sun, 1=Mon … 6=Sat) — auto-detected from atMs if not provided */
  nyDay?: number;
}

// ─── Affinity Map ─────────────────────────────────────────────────────
/**
 * Base affinity scores per pair per session.
 * Derived from BabyPips 2025 pip-range data + ICT session methodology.
 *
 * Score meaning:
 *   1.0 = pair's PRIMARY session (highest pip range, tightest spreads, most reliable patterns)
 *   0.7-0.9 = SECONDARY session (still viable, good volume)
 *   0.4-0.6 = TERTIARY (reduced quality, wider spreads, less reliable)
 *   0.1-0.3 = AVOID (low liquidity, wide spreads, unreliable patterns)
 *
 * "overlap" = bonus applied during London-NY overlap (08:00-12:00 ET)
 */
export interface PairAffinityProfile {
  asian: number;
  london: number;
  newyork: number;
  offhours: number;
  /** Bonus applied during London-NY overlap (08:30-12:00 ET) */
  overlapBonus: number;
  /** Which session is the primary (highest quality) for this pair */
  primarySession: SessionFilterKey;
  /** Brief rationale */
  rationale: string;
}

/**
 * The affinity map. Covers all 36 instruments in SPECS.
 * Scores are based on empirical pip-range ratios and institutional flow data.
 */
export const SESSION_AFFINITY_MAP: Record<string, PairAffinityProfile> = {
  // ─── USD Majors ─────────────────────────────────────────────────────
  "EUR/USD": {
    asian: 0.30, london: 1.00, newyork: 0.85, offhours: 0.10,
    overlapBonus: 0.15, primarySession: "london",
    rationale: "London moves 50% more than Tokyo (114 vs 76 pips). Peak during London open KZ.",
  },
  "GBP/USD": {
    asian: 0.30, london: 1.00, newyork: 0.85, offhours: 0.10,
    overlapBonus: 0.15, primarySession: "london",
    rationale: "London moves 38% more than Tokyo (127 vs 92 pips). GBP is London's home currency.",
  },
  "USD/JPY": {
    asian: 0.65, london: 0.85, newyork: 0.90, offhours: 0.15,
    overlapBonus: 0.10, primarySession: "newyork",
    rationale: "Active in Asian (Tokyo flow) but peaks in NY (59 pips vs 51 Asian). BOJ interventions in Asian.",
  },
  "AUD/USD": {
    asian: 0.80, london: 0.90, newyork: 0.90, offhours: 0.20,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "All-session pair. Tokyo is 93% of London (77 vs 83 pips). AUD is Asian timezone.",
  },
  "NZD/USD": {
    asian: 0.70, london: 0.85, newyork: 0.85, offhours: 0.15,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "Similar to AUD — active in Asian (86% of London). NZ economic data in Asian session.",
  },
  "USD/CAD": {
    asian: 0.20, london: 0.75, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "newyork",
    rationale: "NY equals London (96 vs 96 pips). Both USD and CAD are North American. Oil correlation.",
  },
  "USD/CHF": {
    asian: 0.30, london: 1.00, newyork: 0.80, offhours: 0.10,
    overlapBonus: 0.15, primarySession: "london",
    rationale: "London moves 52% more than Tokyo (102 vs 67 pips). CHF is European timezone.",
  },

  // ─── EUR Crosses ────────────────────────────────────────────────────
  "EUR/GBP": {
    asian: 0.40, london: 1.00, newyork: 0.50, offhours: 0.10,
    overlapBonus: 0.05, primarySession: "london",
    rationale: "Both European currencies. Paradoxically active in Asian (78 pips) but London is primary for institutional flow.",
  },
  "EUR/JPY": {
    asian: 0.60, london: 1.00, newyork: 0.85, offhours: 0.15,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "Cross of European + Asian currencies. Active in Tokyo (79% of London). Risk-on proxy.",
  },
  "EUR/AUD": {
    asian: 0.55, london: 1.00, newyork: 0.75, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "EUR is London-dominant, AUD is Asian-active. London provides the institutional flow.",
  },
  "EUR/CAD": {
    asian: 0.25, london: 0.90, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "newyork",
    rationale: "EUR peaks in London, CAD peaks in NY. Overlap and NY are strongest.",
  },
  "EUR/CHF": {
    asian: 0.30, london: 1.00, newyork: 0.80, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "Both European. London moves 38% more than Tokyo (109 vs 79 pips). SNB activity in London.",
  },
  "EUR/NZD": {
    asian: 0.50, london: 1.00, newyork: 0.75, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "EUR is London-dominant. NZD adds some Asian activity. London is primary.",
  },

  // ─── GBP Crosses ────────────────────────────────────────────────────
  "GBP/JPY": {
    asian: 0.55, london: 1.00, newyork: 0.90, offhours: 0.10,
    overlapBonus: 0.15, primarySession: "london",
    rationale: "London moves 28% more than Tokyo (151 vs 118 pips). Extremely volatile cross. JPY adds Asian activity.",
  },
  "GBP/AUD": {
    asian: 0.45, london: 1.00, newyork: 0.80, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "GBP is London-dominant. AUD adds some Asian activity. High volatility cross.",
  },
  "GBP/CAD": {
    asian: 0.25, london: 0.90, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "newyork",
    rationale: "GBP peaks in London, CAD peaks in NY. Overlap is the sweet spot.",
  },
  "GBP/CHF": {
    asian: 0.25, london: 1.00, newyork: 0.80, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "Both European currencies. London is dominant for both.",
  },
  "GBP/NZD": {
    asian: 0.45, london: 1.00, newyork: 0.75, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "GBP is London-dominant. NZD adds some Asian activity. Very volatile cross.",
  },

  // ─── AUD/NZD/CAD Crosses ───────────────────────────────────────────
  "AUD/CAD": {
    asian: 0.60, london: 0.80, newyork: 1.00, offhours: 0.15,
    overlapBonus: 0.10, primarySession: "newyork",
    rationale: "AUD is Asian-active, CAD is NY-dominant. NY session provides the most movement.",
  },
  "AUD/JPY": {
    asian: 0.80, london: 0.90, newyork: 0.90, offhours: 0.15,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "Both Asian currencies. Tokyo is 92% of London (98 vs 107 pips). All-session pair.",
  },
  "AUD/NZD": {
    asian: 0.85, london: 0.80, newyork: 0.70, offhours: 0.20,
    overlapBonus: 0.05, primarySession: "asian",
    rationale: "Both Oceanic currencies in Asian timezone. Most active during their home session.",
  },
  "AUD/CHF": {
    asian: 0.55, london: 1.00, newyork: 0.80, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "AUD is Asian-active, CHF is London-active. London provides the institutional flow.",
  },
  "NZD/JPY": {
    asian: 0.75, london: 0.85, newyork: 0.80, offhours: 0.15,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "Both Asian currencies. Active across Asian and London. Risk-on proxy.",
  },
  "NZD/CAD": {
    asian: 0.55, london: 0.80, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "newyork",
    rationale: "NZD is Asian-active, CAD is NY-dominant. NY provides the most movement.",
  },
  "NZD/CHF": {
    asian: 0.50, london: 1.00, newyork: 0.75, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "NZD is Asian-active, CHF is London-active. London is primary.",
  },
  "CAD/JPY": {
    asian: 0.50, london: 0.80, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "newyork",
    rationale: "CAD is NY-dominant, JPY adds Asian activity. NY session is strongest.",
  },
  "CAD/CHF": {
    asian: 0.25, london: 0.85, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "newyork",
    rationale: "CAD peaks in NY, CHF peaks in London. Overlap and NY are strongest.",
  },
  "CHF/JPY": {
    asian: 0.50, london: 1.00, newyork: 0.80, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "london",
    rationale: "CHF is London-active, JPY adds Asian activity. London is primary.",
  },

  // ─── Commodities ────────────────────────────────────────────────────
  "XAU/USD": {
    asian: 0.30, london: 0.85, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.15, primarySession: "newyork",
    rationale: "Gold peaks during NY (COMEX hours). London is strong secondary. Asian is quiet.",
  },
  "XAG/USD": {
    asian: 0.25, london: 0.85, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.15, primarySession: "newyork",
    rationale: "Silver follows gold's session pattern. COMEX hours (NY) are dominant.",
  },
  "US Oil": {
    asian: 0.20, london: 0.70, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.10, primarySession: "newyork",
    rationale: "WTI Crude peaks during NYMEX hours (NY). EIA data releases in NY session.",
  },

  // ─── Indices ────────────────────────────────────────────────────────
  "US30": {
    asian: 0.15, london: 0.60, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.15, primarySession: "newyork",
    rationale: "Dow Jones — US equity market hours. Pre-market activity in London overlap.",
  },
  "NAS100": {
    asian: 0.15, london: 0.60, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.15, primarySession: "newyork",
    rationale: "NASDAQ — US equity market hours. ICT Silver Bullet designed for NQ during NY AM.",
  },
  "SPX500": {
    asian: 0.15, london: 0.60, newyork: 1.00, offhours: 0.10,
    overlapBonus: 0.15, primarySession: "newyork",
    rationale: "S&P 500 — US equity market hours. Highest volume during NY regular trading hours.",
  },

  // ─── Crypto ─────────────────────────────────────────────────────────
  "BTC/USD": {
    asian: 0.60, london: 0.75, newyork: 0.85, offhours: 0.50,
    overlapBonus: 0.05, primarySession: "newyork",
    rationale: "24/7 market but US institutional flow peaks in NY. Asian is active (Asia retail). Off-hours still viable.",
  },
  "ETH/USD": {
    asian: 0.60, london: 0.75, newyork: 0.85, offhours: 0.50,
    overlapBonus: 0.05, primarySession: "newyork",
    rationale: "Follows BTC session pattern. US institutional flow peaks in NY. DeFi activity adds Asian volume.",
  },
};

// ─── Overlap Detection ────────────────────────────────────────────────
/**
 * The London-NY overlap window: 08:30 - 12:00 ET.
 * This is when both London and NY desks are active simultaneously.
 * Volume is ~2x the 24-hour average. Spreads are tightest.
 */
const OVERLAP_START_NY = 8.5;  // 08:30 ET (NY session starts)
const OVERLAP_END_NY = 12.0;   // 12:00 ET (London closes at 12:30 but volume drops by 12:00)

export function isInLondonNYOverlap(atMs?: number): boolean {
  const ny = atMs != null ? toNYTimeAt(atMs) : toNYTime(new Date());
  return ny.t >= OVERLAP_START_NY && ny.t < OVERLAP_END_NY;
}

// ─── Day-of-Week Modifiers ────────────────────────────────────────────
/**
 * Day-of-week quality modifiers based on weekly profile research.
 * Index: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
 */
const DAY_MODIFIERS: Record<number, number> = {
  0: 0.0,   // Sunday — market closed
  1: 0.90,  // Monday — accumulation, 80-90% of ADR
  2: 1.00,  // Tuesday — manipulation begins, 100-110% of ADR
  3: 1.10,  // Wednesday — distribution/trend day, 110-130% of ADR (BEST)
  4: 1.05,  // Thursday — continuation/reversal, 100-120% of ADR
  5: 0.85,  // Friday — profit-taking/rebalancing, 70-90% of ADR
  6: 0.0,   // Saturday — market closed
};

/**
 * Late Friday penalty: after 12:00 ET on Friday, quality drops further
 * because London has closed and NY is winding down.
 */
const LATE_FRIDAY_MODIFIER = 0.70;

// ─── Main Function ────────────────────────────────────────────────────

/**
 * Get the session-pair affinity score for a given instrument and session.
 *
 * @param symbol - The instrument symbol (e.g., "EUR/USD", "XAU/USD")
 * @param session - The current session result from detectSession()
 * @param options - Optional modifiers (atMs, atrTrend, nyDay)
 * @returns SessionAffinityResult with score, tier, and explanation
 */
export function getSessionAffinity(
  symbol: string,
  session: { name: SessionName; filterKey: SessionFilterKey; isKillZone: boolean },
  options: AffinityOptions = {},
): SessionAffinityResult {
  const { atMs, atrTrend } = options;

  // Get NY time for overlap and day-of-week detection
  const ny = atMs != null ? toNYTimeAt(atMs) : toNYTime(new Date());
  const nyDay = options.nyDay ?? ny.nyDay;

  // Look up the pair's affinity profile
  const profile = SESSION_AFFINITY_MAP[symbol];
  if (!profile) {
    // Unknown instrument — return neutral
    return {
      baseScore: 0.5,
      overlapBonus: 0,
      dayModifier: 1.0,
      atrModifier: 1.0,
      score: 0.5,
      tier: "marginal",
      detail: `Unknown instrument "${symbol}" — no affinity data available`,
      isPrimarySession: false,
      isOverlap: false,
    };
  }

  // ── Step 1: Base score from affinity map ──
  const baseScore = profile[session.filterKey] ?? 0.1;

  // ── Step 2: Overlap bonus ──
  const isOverlap = isInLondonNYOverlap(atMs);
  const overlapBonus = isOverlap ? profile.overlapBonus : 0;

  // ── Step 3: Day-of-week modifier ──
  let dayModifier = DAY_MODIFIERS[nyDay] ?? 1.0;
  // Late Friday penalty
  if (nyDay === 5 && ny.t >= 12.0) {
    dayModifier = LATE_FRIDAY_MODIFIER;
  }

  // ── Step 4: ATR trend modifier ──
  let atrModifier = 1.0;
  if (atrTrend === "expanding") {
    atrModifier = 1.10; // Volatility already high — good for any session
  } else if (atrTrend === "contracting" && baseScore < 0.5) {
    atrModifier = 0.70; // Double penalty: low affinity + contracting volatility
  }

  // ── Step 5: Composite score ──
  const rawScore = (baseScore + overlapBonus) * dayModifier * atrModifier;
  // Clamp to 0-1.5 range (overlap + expanding can push above 1.0)
  const score = Math.min(1.5, Math.max(0, rawScore));

  // ── Step 6: Tier classification ──
  let tier: "prime" | "good" | "marginal" | "avoid";
  if (score >= 0.80) {
    tier = "prime";
  } else if (score >= 0.55) {
    tier = "good";
  } else if (score >= 0.30) {
    tier = "marginal";
  } else {
    tier = "avoid";
  }

  // ── Step 7: Detail string ──
  const isPrimarySession = session.filterKey === profile.primarySession;
  const parts: string[] = [];
  parts.push(`${symbol} in ${session.name}: base=${baseScore.toFixed(2)}`);
  if (overlapBonus > 0) parts.push(`overlap+${overlapBonus.toFixed(2)}`);
  if (dayModifier !== 1.0) parts.push(`day×${dayModifier.toFixed(2)}`);
  if (atrModifier !== 1.0) parts.push(`atr×${atrModifier.toFixed(2)}`);
  parts.push(`→ ${score.toFixed(2)} [${tier}]`);
  if (isPrimarySession) parts.push("(PRIMARY session)");
  const detail = parts.join(" | ");

  return {
    baseScore,
    overlapBonus,
    dayModifier,
    atrModifier,
    score,
    tier,
    detail,
    isPrimarySession,
    isOverlap,
  };
}

// ─── Utility: Get Best Pairs for Current Session ──────────────────────

/**
 * Returns all instruments sorted by their affinity score for the current session.
 * Useful for the game plan to prioritize which pairs to scan first.
 */
export function rankPairsBySessionAffinity(
  session: { name: SessionName; filterKey: SessionFilterKey; isKillZone: boolean },
  options: AffinityOptions = {},
): Array<{ symbol: string; affinity: SessionAffinityResult }> {
  const results: Array<{ symbol: string; affinity: SessionAffinityResult }> = [];

  for (const symbol of Object.keys(SESSION_AFFINITY_MAP)) {
    const affinity = getSessionAffinity(symbol, session, options);
    results.push({ symbol, affinity });
  }

  // Sort descending by score
  results.sort((a, b) => b.affinity.score - a.affinity.score);
  return results;
}

/**
 * Quick check: should this pair be scanned at all during this session?
 * Returns false if affinity is in "avoid" tier AND no special conditions apply.
 */
export function shouldScanPair(
  symbol: string,
  session: { name: SessionName; filterKey: SessionFilterKey; isKillZone: boolean },
  options: AffinityOptions = {},
): { scan: boolean; reason: string } {
  const affinity = getSessionAffinity(symbol, session, options);

  if (affinity.tier === "avoid") {
    return {
      scan: false,
      reason: `${symbol} affinity is "avoid" (${affinity.score.toFixed(2)}) during ${session.name} — ${affinity.detail}`,
    };
  }

  return {
    scan: true,
    reason: `${symbol} affinity is "${affinity.tier}" (${affinity.score.toFixed(2)}) during ${session.name}`,
  };
}

// ─── Utility: Convert Affinity to Scoring Factor Points ───────────────

/**
 * Converts an affinity result into a scoring factor adjustment.
 * This is the recommended integration point for confluenceScoring.ts.
 *
 * Returns points in range [-1.0, +1.5]:
 *   prime (>= 0.80): +0.5 to +1.5
 *   good (0.55-0.79): 0.0 (neutral)
 *   marginal (0.30-0.54): -0.5
 *   avoid (< 0.30): -1.0
 */
export function affinityToScoringPoints(affinity: SessionAffinityResult): number {
  if (affinity.tier === "prime") {
    // Scale linearly from +0.5 (at 0.80) to +1.5 (at 1.15+)
    return Math.min(1.5, 0.5 + (affinity.score - 0.80) * (1.0 / 0.35));
  } else if (affinity.tier === "good") {
    return 0.0; // Neutral — no bonus, no penalty
  } else if (affinity.tier === "marginal") {
    return -0.5;
  } else {
    return -1.0;
  }
}
