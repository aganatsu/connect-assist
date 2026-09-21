/**
 * Full IPO lifecycle over a series. RESEARCH ONLY.
 *
 * `ipoStateMachine.ts` walks ONE given IPO forward. This runs the population:
 * every candidate that forms, whether it is promoted, how long it lives, how
 * often it is touched, and when it dies. That is what the lifecycle rules can
 * actually be checked against.
 *
 * THE FROZEN RULES, implemented exactly and not re-litigated here:
 *   - move onset = FIRST DIRECTIONAL CANDLE, however small
 *   - candidate = last opposite-colour candle immediately before that onset
 *   - a candidate inside an ACTIVE contraction is invalid (offset 0 counts as inside)
 *   - PENDING -> VALID only when the trend clears the OPPOSITE side of the prior contraction
 *   - a touch is any overlap with the zone; repeated touches never invalidate
 *   - invalidation only on a full candle CLOSE beyond the original candle's far extreme
 *   - FVG and BOS are recorded as quality markers, never required
 *
 * NO THRESHOLD, NO RANKING, NO CONFLUENCE SCORE. Correctness of the lifecycle is
 * the only thing under test.
 */

import { ipoGeometry, fvgsNear } from "./ipoZones.ts";
import { directionalEvents } from "./ipoOriginExperiments.ts";
import type { Candle } from "./smcAnalysis.ts";

export interface Episode { start: number; end: number; high: number; low: number }

export type LifecycleOutcome = "PENDING_NEVER_VALIDATED" | "VALID_LIVE" | "VALID_INVALIDATED";

export interface LifecycleIPO {
  candidateIndex: number;
  direction: "demand" | "supply";
  onsetIndex: number;
  zoneLow: number;
  zoneHigh: number;
  invalidationLevel: number;
  /** The contraction whose opposite side must be cleared to promote. */
  priorContraction: Episode | null;
  clearedAt: number | null;
  validAt: number | null;
  touches: number[];
  invalidatedAt: number | null;
  outcome: LifecycleOutcome;
  /** Quality markers only. Neither gates anything. */
  hasFvg: boolean;
  hasBos: boolean;
  /** Set when the candidate was refused for sitting in an active contraction. */
  suppressedByContraction: boolean;
}

const isUp = (c: Candle) => c.close >= c.open;
const overlaps = (c: Candle, lo: number, hi: number) => c.low <= hi && c.high >= lo;

/** Inclusive at BOTH ends — offset 0 is inside, per trader clarification. */
const insideEpisode = (i: number, e: Episode) => i >= e.start && i <= e.end;

export function runLifecycle(
  s: Candle[], episodes: Episode[],
): LifecycleIPO[] {
  const evs = (directionalEvents(s, {}) as any[]);
  const out: LifecycleIPO[] = [];

  for (let k = 1; k < s.length - 1; k++) {
    // A candidate forms where the next bar starts a move the other way.
    for (const up of [true, false]) {
      if (isUp(s[k]) === up) continue;          // candidate is the OPPOSITE colour
      if (isUp(s[k + 1]) !== up) continue;      // k+1 is the first directional candle
      const direction = up ? "demand" : "supply";
      const g = ipoGeometry(s[k], direction);
      const active = episodes.find((e) => insideEpisode(k, e)) ?? null;
      const prior = episodes.filter((e) => e.end < k).sort((a, b) => b.end - a.end)[0] ?? null;

      const rec: LifecycleIPO = {
        candidateIndex: k, direction, onsetIndex: k + 1,
        zoneLow: g.zoneLow, zoneHigh: g.zoneHigh,
        invalidationLevel: direction === "demand" ? s[k].low : s[k].high,
        priorContraction: prior, clearedAt: null, validAt: null,
        touches: [], invalidatedAt: null, outcome: "PENDING_NEVER_VALIDATED",
        hasFvg: false, hasBos: false,
        suppressedByContraction: active !== null,
      };

      // Quality markers, recorded whatever happens.
      for (let j = k; j <= Math.min(s.length - 1, k + 10); j++) {
        for (const f of fvgsNear(s, j) as any[]) {
          if (f.type === (up ? "bullish" : "bearish") && f.absIndex >= k && f.absIndex <= k + 10) rec.hasFvg = true;
        }
      }
      rec.hasBos = evs.some((e) => e.index > k && e.index <= k + 20 &&
        (e.direction === "bullish") === up);

      if (rec.suppressedByContraction) { out.push(rec); continue; }

      // PROMOTION: the trend must clear the OPPOSITE side of the prior contraction.
      if (prior) {
        for (let j = k + 1; j < s.length; j++) {
          if (up ? s[j].close > prior.high : s[j].close < prior.low) {
            rec.clearedAt = j; rec.validAt = j; break;
          }
          // A candidate that dies before clearing never validates.
          if (up ? s[j].close < rec.invalidationLevel : s[j].close > rec.invalidationLevel) break;
        }
      }

      if (rec.validAt !== null) {
        rec.outcome = "VALID_LIVE";
        // Touches and death, tracked only from validation onward.
        for (let j = rec.validAt; j < s.length; j++) {
          const c = s[j];
          if (up ? c.close < rec.invalidationLevel : c.close > rec.invalidationLevel) {
            rec.invalidatedAt = j; rec.outcome = "VALID_INVALIDATED"; break;
          }
          if (overlaps(c, rec.zoneLow, rec.zoneHigh)) {
            // one touch per distinct visit
            const last = rec.touches[rec.touches.length - 1];
            if (last === undefined || j > last + 1) rec.touches.push(j);
          }
        }
      }
      out.push(rec);
    }
  }
  return out;
}

export interface LifecycleStats {
  bars: number;
  validPer1000: number;
  pendingPer1000: number;
  pctPendingBecomingValid: number;
  avgBarsPendingToValid: number | null;
  avgTouchesPerValid: number | null;
  avgLifespanBars: number | null;
  invalidationsPer1000: number;
  maxSimultaneousActive: number;
  avgSimultaneousActive: number;
  bullishActive: number;
  bearishActive: number;
  suppressedInsideContraction: number;
}

export function lifecycleStats(s: Candle[], all: LifecycleIPO[]): LifecycleStats {
  const eligible = all.filter((x) => !x.suppressedByContraction);
  const valid = eligible.filter((x) => x.validAt !== null);
  const dead = valid.filter((x) => x.invalidatedAt !== null);
  const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;

  // Simultaneous active = validated and not yet invalidated at each bar.
  let maxSim = 0, sumSim = 0;
  for (let k = 0; k < s.length; k++) {
    const n = valid.filter((x) => x.validAt! <= k && (x.invalidatedAt === null || x.invalidatedAt > k)).length;
    if (n > maxSim) maxSim = n;
    sumSim += n;
  }
  const per1000 = (n: number) => (n * 1000) / s.length;
  return {
    bars: s.length,
    validPer1000: per1000(valid.length),
    pendingPer1000: per1000(eligible.length),
    pctPendingBecomingValid: eligible.length ? (100 * valid.length) / eligible.length : 0,
    avgBarsPendingToValid: mean(valid.map((x) => x.validAt! - x.candidateIndex)),
    avgTouchesPerValid: mean(valid.map((x) => x.touches.length)),
    avgLifespanBars: mean(dead.map((x) => x.invalidatedAt! - x.validAt!)),
    invalidationsPer1000: per1000(dead.length),
    maxSimultaneousActive: maxSim,
    avgSimultaneousActive: sumSim / s.length,
    bullishActive: valid.filter((x) => x.direction === "demand").length,
    bearishActive: valid.filter((x) => x.direction === "supply").length,
    suppressedInsideContraction: all.filter((x) => x.suppressedByContraction).length,
  };
}

export interface SanityReport {
  validWithoutClearance: number;
  validInsideActiveContraction: number;
  invalidationOnWickOnly: number;
  touchCausedInvalidation: number;
  duplicateFromSameMove: number;
  pendingNeverValidated: number;
}

/** Every one of these should be zero except the last two, which are descriptive. */
export function sanityChecks(s: Candle[], all: LifecycleIPO[], episodes: Episode[]): SanityReport {
  const valid = all.filter((x) => x.validAt !== null);
  let wickOnly = 0, touchKilled = 0;
  for (const x of valid) {
    if (x.invalidatedAt === null) continue;
    const c = s[x.invalidatedAt];
    const closeBeyond = x.direction === "demand"
      ? c.close < x.invalidationLevel : c.close > x.invalidationLevel;
    if (!closeBeyond) wickOnly++;
    if (x.touches.includes(x.invalidatedAt)) touchKilled++;
  }
  // Duplicates: more than one validated IPO sharing an onset bar.
  const byOnset = new Map<number, number>();
  for (const x of valid) byOnset.set(x.onsetIndex, (byOnset.get(x.onsetIndex) ?? 0) + 1);
  return {
    validWithoutClearance: valid.filter((x) => x.clearedAt === null).length,
    validInsideActiveContraction: valid.filter((x) =>
      episodes.some((e) => insideEpisode(x.candidateIndex, e))).length,
    invalidationOnWickOnly: wickOnly,
    touchCausedInvalidation: touchKilled,
    duplicateFromSameMove: [...byOnset.values()].filter((n) => n > 1).length,
    pendingNeverValidated: all.filter((x) => !x.suppressedByContraction && x.validAt === null).length,
  };
}
