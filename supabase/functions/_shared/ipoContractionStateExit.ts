/**
 * Contraction STATE EXIT. RESEARCH ONLY.
 *
 * THE DEFECT THIS ADDRESSES. One detected episode can swallow
 * contraction -> expansion -> trend -> new contraction. On BTC/USD 1D that
 * produced a 28-bar window whose interior contains an external BOS and a
 * 0.83-efficiency trend leg. Under the trader's rule a candle inside an active
 * contraction is not a valid IPO, so a stale contraction state SUPPRESSES A
 * GENUINE IPO. That is why this is a blocking dependency and not a tidiness
 * issue.
 *
 * WHY EXIT AND NOT BAND. Four band initialisations were already tested and all
 * failed: when the band is inherited from a volatile confirmation segment it is
 * too wide for any price-based exit to fire. The band is the wrong lever. What
 * is needed is a condition that says THE MARKET HAS LEFT THE SIDEWAYS STATE,
 * expressed structurally rather than by price distance.
 *
 * FORBIDDEN AND ABSENT: maximum contraction length, fitted bar tolerance,
 * timeframe-specific cutoffs, arbitrary breakout counts. Every condition below
 * compares against the contraction's OWN established state or uses existing
 * swing primitives.
 */

import { confirmedSwings } from "./ipoZones.ts";
import { directionalEvents } from "./ipoOriginExperiments.ts";
import { structureStalls } from "./ipoContractionSeeds.ts";
import type { Candle } from "./smcAnalysis.ts";

export type StateExit =
  | "NONE"
  | "S1_DIRECTIONAL_STATE_RESTART"
  | "S2_EFFICIENCY_REGIME_SHIFT"
  | "S3_EXPANSION_THEN_STRUCTURE"
  | "S4_NEW_STATE_FORMATION";

export const STATE_EXITS: StateExit[] = [
  "NONE", "S1_DIRECTIONAL_STATE_RESTART", "S2_EFFICIENCY_REGIME_SHIFT",
  "S3_EXPANSION_THEN_STRUCTURE", "S4_NEW_STATE_FORMATION",
];

export interface Episode { start: number; end: number; sidewaysAtIndex: number }

function efficiency(s: Candle[], a: number, b: number): number | null {
  if (b <= a) return null;
  let path = 0;
  for (let k = a + 1; k <= b; k++) path += Math.abs(s[k].close - s[k - 1].close);
  return path > 0 ? Math.abs(s[b].close - s[a].close) / path : null;
}

export interface ExitResult {
  end: number;
  exitedBy: StateExit | "NO_EXIT";
  /** Bar where a prior-swing break confirmed the trend, where applicable. */
  confirmedAt: number | null;
}

/**
 * Applies one state-exit condition to a frozen episode.
 *
 * Scanning starts AFTER sideways confirmation, so the sideways state has been
 * established before anything can end it.
 */
export function applyStateExit(
  s: Candle[], ep: Episode, rule: StateExit,
): ExitResult {
  if (rule === "NONE") return { end: ep.end, exitedBy: "NO_EXIT", confirmedAt: null };

  const sw = confirmedSwings(s).internal.slice().sort((a, b) => a.index - b.index);
  const evs = (directionalEvents(s, {}) as any[]);
  const stalls = structureStalls(s);

  // The contraction's OWN established state, used as every baseline.
  const baseEff = efficiency(s, ep.start, ep.sidewaysAtIndex);
  let hi = -Infinity, lo = Infinity;
  for (let k = ep.start; k <= ep.sidewaysAtIndex; k++) {
    hi = Math.max(hi, s[k].high); lo = Math.min(lo, s[k].low);
  }

  let sawExpansion = false;
  let lastSwingHigh: number | null = null, lastSwingLow: number | null = null;
  for (const x of sw) {
    if (x.index >= ep.start) break;
    if (x.type === "high") lastSwingHigh = x.price; else lastSwingLow = x.price;
  }

  for (let k = ep.sidewaysAtIndex + 1; k <= ep.end; k++) {
    const c = s[k];

    if (rule === "S1_DIRECTIONAL_STATE_RESTART") {
      // Directional structure resumes: a confirmed swing that EXTENDS beyond the
      // sideways state's own range in the direction it is travelling.
      const hit = sw.find((x) => x.index === k);
      if (hit && (hit.type === "high" ? hit.price > hi : hit.price < lo)) {
        return { end: k - 1, exitedBy: rule, confirmedAt: null };
      }
      continue;
    }

    if (rule === "S2_EFFICIENCY_REGIME_SHIFT") {
      // Efficiency since confirmation rises above the sideways state's own value.
      if (baseEff === null) continue;
      const now = efficiency(s, ep.sidewaysAtIndex, k);
      if (now !== null && k - ep.sidewaysAtIndex >= 2 && now > baseEff) {
        return { end: k - 1, exitedBy: rule, confirmedAt: null };
      }
      continue;
    }

    if (rule === "S3_EXPANSION_THEN_STRUCTURE") {
      // Part 1: directional expansion away from the sideways range.
      if (!sawExpansion && (c.close > hi || c.close < lo)) {
        const up = c.close > hi;
        // Part 2: the trader's trend confirmation — a break of the relevant
        // PREVIOUS high/low in the same direction.
        let conf: number | null = null;
        const level = up ? lastSwingHigh : lastSwingLow;
        for (let j = k; j <= ep.end; j++) {
          if (level !== null && (up ? s[j].close > level : s[j].close < level)) { conf = j; break; }
          if (evs.some((e) => e.index === j && (e.direction === "bullish") === up)) { conf = j; break; }
        }
        if (conf !== null) return { end: k - 1, exitedBy: rule, confirmedAt: conf };
        sawExpansion = true;
      }
      continue;
    }

    if (rule === "S4_NEW_STATE_FORMATION") {
      // An expansion must occur first; the NEXT stall then opens a new
      // contraction instead of extending this one.
      if (!sawExpansion && (c.close > hi || c.close < lo)) { sawExpansion = true; continue; }
      if (sawExpansion && stalls.some((x) => x.index === k)) {
        return { end: k - 1, exitedBy: rule, confirmedAt: null };
      }
      continue;
    }
  }
  return { end: ep.end, exitedBy: "NO_EXIT", confirmedAt: null };
}

/**
 * Re-segments a series into episodes under one exit rule.
 *
 * After an episode is closed, the remainder is NOT re-scanned here — the frozen
 * two-stage generator already emits an episode per stall, so a later stall
 * already has its own episode. This only prevents an existing episode from
 * extending across states it should not own.
 */
export function segmentEpisodes(
  s: Candle[], eps: Episode[], rule: StateExit,
): Array<Episode & ExitResult> {
  return eps
    .map((e) => ({ ...e, ...applyStateExit(s, e, rule) }))
    .filter((e) => e.end > e.start);
}
