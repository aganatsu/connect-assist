/**
 * Trader-defined IPO state machine. RESEARCH ONLY.
 *
 * WHAT IS NEW HERE, AND WHY IT MATTERS. Every previous model asked a single
 * question — "which candle is the IPO" — and answered it from local geometry.
 * This specification says validity is a STATE, reached over time:
 *
 *   last opposite candle -> CANDIDATE -> (trend clears the opposite side of the
 *   prior contraction) -> VALID
 *
 * That distinction is the substance. A candle can look exactly like an IPO and
 * not be one yet, which is something no earlier hypothesis could express.
 *
 * TWO POINTS WHERE THIS CONTRADICTS FROZEN RESEARCH, DELIBERATELY:
 *
 *   MOVE ONSET. The frozen candidate was O4_FIRST_FVG_SEQ. The trader says the
 *   move begins at the FIRST DIRECTIONAL CANDLE however small —
 *   red -> small green -> huge green gives onset = the small green. FVG becomes
 *   a quality marker, not the onset. Implemented as stated, not as previously
 *   frozen; the comparison is the point of the exercise.
 *
 *   BOS. Not required for IPO existence. Only the opposite-side clearance of the
 *   prior contraction promotes a candidate.
 *
 * WHAT IT CONFIRMS. Invalidation is a close beyond the ORIGINAL CANDLE's far
 * extreme, not beyond the zone — which is exactly the frozen
 * geometry.extentIsInvalidationOnly lifecycle rule, arrived at independently.
 *
 * CONTRACTION MEMBERSHIP IS INCLUSIVE AT BOTH ENDS. Trader clarification: if an
 * IPO candle is the FIRST BAR of a contraction, that candle IS part of the
 * contraction. Offset 0 is INSIDE, not a boundary, and the opening bar is not
 * special-cased. Under that rule BTC/USD 1D 2020-05-11 is CORRECTLY suppressed
 * while its contraction is active — its IPO sits at offset 0. Do not "fix" the
 * inclusive comparison into an exclusive one; a test pins this.
 *
 * Nothing here is wired to production.
 */

import { ipoGeometry, type IPODirection } from "./ipoZones.ts";
import type { Candle } from "./smcAnalysis.ts";

export type IPOState =
  | "VALID_EXTERNAL_IPO"
  | "MOVE_AWAY"
  | "CONTRACTION_ACTIVE"
  | "EXPANSION_TO_IPO"
  | "IPO_TOUCH"
  | "TREND_FROM_IPO"
  | "OPPOSITE_SIDE_CLEARED"
  | "NEW_IPO_PENDING"
  | "NEW_IPO_VALID"
  | "IPO_INVALIDATED";

export const IPO_STATES: IPOState[] = [
  "VALID_EXTERNAL_IPO", "MOVE_AWAY", "CONTRACTION_ACTIVE", "EXPANSION_TO_IPO",
  "IPO_TOUCH", "TREND_FROM_IPO", "OPPOSITE_SIDE_CLEARED", "NEW_IPO_PENDING",
  "NEW_IPO_VALID", "IPO_INVALIDATED",
];

export interface Contraction { start: number; end: number; high: number; low: number }

export interface Transition {
  at: number;
  datetime: string;
  from: IPOState;
  to: IPOState;
  why: string;
}

export interface StateRun {
  ipoIndex: number;
  direction: IPODirection;
  zoneLow: number;
  zoneHigh: number;
  /** The ORIGINAL candle extreme whose breach invalidates. Not the zone edge. */
  invalidationLevel: number;
  transitions: Transition[];
  finalState: IPOState;
  candidateIndex: number | null;
  candidatePromotedAt: number | null;
  touchedAt: number | null;
  invalidatedAt: number | null;
  /** The trend re-derived the tracked IPO itself; no new IPO was minted. */
  selfReferenced: boolean;
}

const isUp = (c: Candle) => c.close >= c.open;

/** Overlap with the IPO zone. A touch, not a close-through, per the spec. */
const touches = (c: Candle, lo: number, hi: number) => c.low <= hi && c.high >= lo;

/**
 * Invalidation: a candle CLOSES fully beyond the original IPO candle's far
 * extreme. Penetration of the zone does not invalidate, and repeated touches
 * do not invalidate.
 */
function invalidated(c: Candle, direction: IPODirection, level: number): boolean {
  return direction === "demand" ? c.close < level : c.close > level;
}

/**
 * MOVE ONSET AS SPECIFIED BY THE TRADER: the first candle travelling the
 * departure direction, however small.
 *
 * Deliberately NOT O4_FIRST_FVG_SEQ. Scanning forward from `from`, the first
 * candle whose colour matches the departure is the onset.
 */
export function firstDirectionalOnset(
  s: Candle[], from: number, up: boolean, limit: number,
): number | null {
  for (let k = from; k <= Math.min(limit, s.length - 1); k++) {
    if (isUp(s[k]) === up) return k;
  }
  return null;
}

/** The frozen candle rule: last opposite-colour candle immediately before onset. */
export function lastOppositeBefore(
  s: Candle[], onset: number, up: boolean, floor = 0,
): number | null {
  for (let k = onset - 1; k >= floor; k--) if (isUp(s[k]) !== up) return k;
  return null;
}

/**
 * Walks the state machine forward from an already-valid external IPO.
 *
 * The machine does not search for an IPO; it is GIVEN one and asks what happens
 * next. A new IPO can only appear as a CANDIDATE during the trend leg away from
 * the touched IPO, and is promoted only by opposite-side clearance.
 */
export function runStateMachine(
  s: Candle[],
  ipoIndex: number,
  direction: IPODirection,
  contractions: Contraction[],
  horizon = 400,
): StateRun {
  const g = ipoGeometry(s[ipoIndex], direction);
  const zoneLow = g.zoneLow, zoneHigh = g.zoneHigh;
  const invalidationLevel = direction === "demand" ? s[ipoIndex].low : s[ipoIndex].high;
  const demand = direction === "demand";

  const tr: Transition[] = [];
  let state: IPOState = "VALID_EXTERNAL_IPO";
  const push = (at: number, to: IPOState, why: string) => {
    tr.push({ at, datetime: s[at].datetime, from: state, to, why });
    state = to;
  };

  let activeContraction: Contraction | null = null;
  let touchedAt: number | null = null;
  let candidateIndex: number | null = null;
  let promotedAt: number | null = null;
  let invalidatedAt: number | null = null;
  let trendOnset: number | null = null;
  let selfReferenced = false;

  const end = Math.min(s.length - 1, ipoIndex + horizon);
  for (let k = ipoIndex + 1; k <= end; k++) {
    const c = s[k];

    // Invalidation outranks every other transition and ends the run.
    if (invalidated(c, direction, invalidationLevel)) {
      invalidatedAt = k;
      push(k, "IPO_INVALIDATED",
        `close ${c.close} beyond the original candle's ${demand ? "LOW" : "HIGH"} ${invalidationLevel}`);
      break;
    }

    if (state === "VALID_EXTERNAL_IPO") {
      if (!touches(c, zoneLow, zoneHigh)) push(k, "MOVE_AWAY", "price left the IPO zone");
      continue;
    }

    if (state === "MOVE_AWAY") {
      const ct = contractions.find((x) => x.start <= k && k <= x.end);
      if (ct) { activeContraction = ct; push(k, "CONTRACTION_ACTIVE", `inside contraction ${ct.start}-${ct.end}`); }
      else if (touches(c, zoneLow, zoneHigh)) { touchedAt = k; push(k, "IPO_TOUCH", "returned to the IPO zone with no contraction in between"); }
      continue;
    }

    if (state === "CONTRACTION_ACTIVE") {
      if (activeContraction && k > activeContraction.end) {
        const towardIPO = demand ? c.close < activeContraction.low : c.close > activeContraction.high;
        if (towardIPO) push(k, "EXPANSION_TO_IPO", "left the contraction travelling toward the IPO");
      }
      continue;
    }

    if (state === "EXPANSION_TO_IPO") {
      if (touches(c, zoneLow, zoneHigh)) { touchedAt = k; push(k, "IPO_TOUCH", "price touched the IPO zone"); }
      continue;
    }

    if (state === "IPO_TOUCH") {
      // The trend leg away from the IPO. Onset = FIRST DIRECTIONAL CANDLE.
      const up = demand;                       // demand IPO -> bullish trend away
      const on = firstDirectionalOnset(s, k, up, Math.min(end, k + 40));
      if (on !== null) {
        trendOnset = on;
        const derived = lastOppositeBefore(s, on, up, Math.max(0, on - 40));
        push(on, "TREND_FROM_IPO", `trend leg begins at the first ${up ? "bullish" : "bearish"} candle`);
        // SELF_REFERENCE. A later trend can derive the very candle we are already
        // tracking — on BTC/USD 1D 2020-04-20 the leg after the touch resolves
        // back to 04-20 itself. That is identity, not a new signal: keep the
        // existing IPO's lifecycle running and do not mint a duplicate.
        if (derived !== null && derived === ipoIndex) {
          selfReferenced = true;
          candidateIndex = null;
        } else {
          candidateIndex = derived;
          if (candidateIndex !== null) {
            push(on, "NEW_IPO_PENDING",
              `candidate = last ${up ? "bearish" : "bullish"} candle at ${candidateIndex}; NOT valid yet`);
          }
        }
        k = on;
      }
      continue;
    }

    if (state === "NEW_IPO_PENDING" || state === "TREND_FROM_IPO") {
      // PROMOTION GATE: the trend must clear the OPPOSITE side of the prior
      // contraction. Without this the candidate stays pending forever.
      if (activeContraction) {
        const cleared = demand ? c.close > activeContraction.high : c.close < activeContraction.low;
        if (cleared) {
          push(k, "OPPOSITE_SIDE_CLEARED",
            `close ${c.close} beyond the contraction's ${demand ? "high" : "low"} ${demand ? activeContraction.high : activeContraction.low}`);
          promotedAt = k;
          push(k, "NEW_IPO_VALID", `candidate at ${candidateIndex} promoted`);
          break;
        }
      }
      continue;
    }
  }

  return {
    ipoIndex, direction, zoneLow, zoneHigh, invalidationLevel,
    transitions: tr, finalState: state,
    candidateIndex, candidatePromotedAt: promotedAt, touchedAt, invalidatedAt,
    selfReferenced,
  };
}
