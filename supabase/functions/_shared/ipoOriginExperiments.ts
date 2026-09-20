/**
 * Origin-model contradiction probe and shadow experiments. RESEARCH ONLY.
 *
 * THE CONTRADICTION. On four demonstrated IPOs the two halves of our own model
 * disagree. The confirmation model says the candle could be an IPO — it has a
 * valid first relevant confirmation and is among the handful of candidates for
 * that event. The origin model cannot propose it at all: no anchor, no offset,
 * no break reaches it.
 *
 * Both halves are ours and both are OPERATIONAL_INTERPRETATION, so before
 * changing either one we need to know exactly which line of which stage the
 * demonstrated candle falls out at — and whether all four fall out at the same
 * one.
 *
 * NOTHING HERE IS WIRED TO THE DETECTOR. The alternative origin definitions
 * below are measurements of what a different rule WOULD have selected. The
 * production path still runs EXTREME_OF_LEG and this file cannot change that.
 */

import { analyzeMarketStructureCanonical } from "./smcAnalysis.ts";
import type { Candle } from "./smcAnalysis.ts";
import {
  DEFAULTS,
  selectIPOCandle,
  resolveKnownCandleIndex,
  type DetectIPOOptions,
  type IPODirection,
} from "./ipoZones.ts";

const isUp = (c: Candle) => c.close >= c.open;

/**
 * Where in the pipeline an expected candle was lost.
 *
 * The distinction drives completely different fixes, which is why it is a
 * classification and not a single boolean. A candle that never entered cannot
 * be recovered by relaxing a filter, and one that lost a ranking cannot be
 * recovered by widening a search.
 */
export type ExpectedOutcome =
  /** A — the pipeline never constructed it. No rule rejected it; nothing proposed it. */
  | "NEVER_ENTERED"
  /** B — proposed, then refused by a qualification rule. */
  | "ENTERED_THEN_REJECTED"
  /** C — qualified, but another candidate was preferred. */
  | "QUALIFIED_LOST_RANKING"
  /** D — created, then removed by a later filter or invalidation. */
  | "CREATED_THEN_REMOVED"
  /** E — present in the inventory; the coverage matcher failed to associate it. */
  | "PRESENT_MATCHER_FAILED"
  | "PRESENT_AND_MATCHED";

export type PipelineStage =
  | "structural-leg-construction"
  | "origin-search"
  | "candidate-qualification"
  | "candidate-ranking"
  | "post-origin-filtering"
  | "inventory-persistence"
  | "none";

// ─── alternative origin definitions ──────────────────────────────────────────
//
// Each takes the same inputs the production detector has at the moment it picks
// an origin, and returns a bar index. They are named hypotheses about where the
// departure actually starts. None of them is applied anywhere.

export interface OriginContext {
  candles: Candle[];
  /** Index of the swing level that broke — the left edge of the current leg. */
  swingIdx: number;
  /** Index of the bar that closed through it. */
  breakIdx: number;
  direction: IPODirection;
}

export type OriginDefinitionKey =
  | "EXTREME_OF_LEG"
  | "LAST_OPPOSITE_BEFORE_BREAK"
  | "DISPLACEMENT_RUN_START"
  | "FIRST_OPPOSITE_AFTER_EXTREME"
  | "LAST_OPPOSITE_BEFORE_DISPLACEMENT"
  | "LAST_OF_WANTED_RUN_AT_EXTREME";

export interface OriginDefinition {
  key: OriginDefinitionKey;
  /** The modelling assumption this encodes, stated so it can be argued with. */
  assumption: string;
  find(ctx: OriginContext): number | null;
}

/** The extreme of the leg: production behaviour, reproduced exactly. */
function extremeOfLeg(ctx: OriginContext): number {
  const { candles, swingIdx, breakIdx, direction } = ctx;
  const bullish = direction === "demand";
  let idx = swingIdx;
  for (let k = swingIdx; k <= breakIdx; k++) {
    if (!candles[k]) continue;
    if (bullish ? candles[k].low <= candles[idx].low
                : candles[k].high >= candles[idx].high) idx = k;
  }
  return idx;
}

/**
 * The first bar of the unbroken directional run that ends at the break.
 *
 * Walks back from the break bar while price keeps making progress toward it —
 * higher highs for a bullish break, lower lows for a bearish one — and returns
 * the bar before that run begins. This is "where the impulse left", as opposed
 * to "the lowest point of the whole leg", which may sit well before any impulse.
 */
function displacementRunStart(ctx: OriginContext): number {
  const { candles, swingIdx, breakIdx, direction } = ctx;
  const bullish = direction === "demand";
  let k = breakIdx;
  while (k - 1 >= swingIdx) {
    const cur = candles[k], prev = candles[k - 1];
    if (!cur || !prev) break;
    const progressing = bullish ? cur.high > prev.high : cur.low < prev.low;
    if (!progressing) break;
    k--;
  }
  return Math.max(swingIdx, k);
}

export const ORIGIN_DEFINITIONS: OriginDefinition[] = [
  {
    key: "EXTREME_OF_LEG",
    assumption:
      "PRODUCTION. The departure starts at the extreme of the swing-to-break window, " +
      "so the IPO is at or before that extreme.",
    find: extremeOfLeg,
  },
  {
    key: "LAST_OPPOSITE_BEFORE_BREAK",
    assumption:
      "The IPO is simply the last opposite-colour candle before the break, wherever it sits.",
    find: (ctx) => {
      const wantUp = ctx.direction === "supply";
      for (let k = ctx.breakIdx - 1; k >= ctx.swingIdx; k--) {
        if (ctx.candles[k] && isUp(ctx.candles[k]) === wantUp) return k;
      }
      return null;
    },
  },
  {
    key: "DISPLACEMENT_RUN_START",
    assumption:
      "The departure starts where the impulse starts, not at the extreme of the leg. " +
      "The extreme can be the low of an accumulation that price then chops in for " +
      "several bars before anything leaves.",
    find: displacementRunStart,
  },
  {
    key: "FIRST_OPPOSITE_AFTER_EXTREME",
    assumption:
      "The extreme marks the turn; the IPO is the first opposite-colour candle AFTER it.",
    find: (ctx) => {
      const ex = extremeOfLeg(ctx);
      const wantUp = ctx.direction === "supply";
      for (let k = ex; k <= ctx.breakIdx; k++) {
        if (ctx.candles[k] && isUp(ctx.candles[k]) === wantUp) return k;
      }
      return null;
    },
  },
  {
    key: "LAST_OPPOSITE_BEFORE_DISPLACEMENT",
    assumption:
      "Combines the two: the impulse start locates the departure, and the IPO is the " +
      "last opposite-colour candle before THAT — not before the leg's extreme.",
    find: displacementRunStart,
  },
  {
    key: "LAST_OF_WANTED_RUN_AT_EXTREME",
    assumption:
      "H1. The extreme locates the TURN, not the IPO. The IPO is the LAST bar of the " +
      "contiguous IPO-coloured run that touches that extreme — the final opposite " +
      "candle before price leaves — rather than the first such bar found walking " +
      "backward from it. Where the extreme is not IPO-coloured, the run is the first " +
      "IPO-coloured run beginning after it. Introduces NO new numeric parameter.",
    find: (ctx) => {
      const { candles, breakIdx, direction } = ctx;
      const wantUp = direction === "supply";
      const ex = extremeOfLeg(ctx);
      // Find where the relevant run starts: the extreme itself if it is the
      // right colour, otherwise the next IPO-coloured bar after it.
      let start = ex;
      while (start <= breakIdx && candles[start] && isUp(candles[start]) !== wantUp) start++;
      if (start > breakIdx || !candles[start]) return null;
      // ...then walk to the END of that contiguous run.
      let end = start;
      while (end + 1 <= breakIdx && candles[end + 1] && isUp(candles[end + 1]) === wantUp) end++;
      return end;
    },
  },
];

const DEF_BY_KEY: Record<string, OriginDefinition> =
  Object.fromEntries(ORIGIN_DEFINITIONS.map((d) => [d.key, d]));

/** Deduped directional break events, exactly as detectAllIPOCandidates builds them. */
export function directionalEvents(candles: Candle[], opts: DetectIPOOptions = {}) {
  const canon = analyzeMarketStructureCanonical(candles, {
    policy: "latest_unbroken_structural",
    maxEventAgeBars: opts.maxEventAgeBars === undefined ? DEFAULTS.maxEventAgeBars : opts.maxEventAgeBars,
  });
  const byBarDir = new Map<string, any>();
  for (const lb of ((canon as any).swingLevelBreaks as any[])) {
    const k = `${lb.index}|${lb.direction}`;
    const cur = byBarDir.get(k);
    if (!cur) { byBarDir.set(k, lb); continue; }
    const better =
      (lb.significance === "external" && cur.significance !== "external") ||
      (lb.significance === cur.significance &&
        (lb.direction === "bullish" ? lb.level > cur.level : lb.level < cur.level));
    if (better) byBarDir.set(k, lb);
  }
  return [...byBarDir.values()].sort((a, b) => a.index - b.index);
}

/**
 * Walks the expected candle through every stage the production detector runs,
 * for every break that could plausibly confirm it, and says where it is lost.
 */
export function probeOriginPipeline(
  candles: Candle[],
  knownDate: string,
  direction: IPODirection,
  opts: DetectIPOOptions = {},
) {
  const resolved = resolveKnownCandleIndex(candles, knownDate);
  if (resolved.index < 0) {
    return { knownDate, direction, error: "candle not resolvable", detail: resolved };
  }
  if (resolved.ambiguous) {
    return {
      knownDate, direction, error: "DATE_ONLY_AMBIGUOUS",
      barsOnThatDay: resolved.barsOnThatDay, candidateDatetimes: resolved.candidateDatetimes,
    };
  }
  const ei = resolved.index;
  const expected = candles[ei];
  const wantUp = direction === "supply";
  const wantDir = direction === "demand" ? "bullish" : "bearish";
  const events = directionalEvents(candles, opts).filter(
    (e) => e.direction === wantDir && e.index > ei,
  );

  const perBreak = events.map((ev) => {
    const j = ev.index;
    const swingIdx = ev.swingIndex ?? Math.max(0, j - 10);
    const ctx: OriginContext = { candles, swingIdx, breakIdx: j, direction };
    const originIdx = extremeOfLeg(ctx);
    const sel = selectIPOCandle(candles, originIdx, direction, {
      maxIntervening: opts.maxIntervening,
      interveningMaxRangeAtr: opts.interveningMaxRangeAtr,
      maxLookback: opts.maxLookback,
    });
    const maxBack = opts.maxLookback ?? DEFAULTS.maxLookbackForIPO;

    // Reachability of the expected candle under the production walk, which runs
    // BACKWARD from the origin. Two distinct ways to be unreachable.
    const afterOrigin = ei > originIdx;
    const beyondLookback = !afterOrigin && ei < originIdx - maxBack;

    return {
      breakIndex: j,
      breakDatetime: candles[j].datetime,
      significance: ev.significance,
      level: ev.level,
      swingIndex: swingIdx,
      swingDatetime: candles[swingIdx]?.datetime ?? null,
      searchWindow: { from: swingIdx, to: j, fromDatetime: candles[swingIdx]?.datetime ?? null, toDatetime: candles[j].datetime },
      expectedInsideSearchWindow: ei >= swingIdx && ei <= j,
      originIndex: originIdx,
      originDatetime: candles[originIdx].datetime,
      expectedRelativeToOrigin: ei - originIdx,
      expectedReachableByBackwardWalk: !afterOrigin && !beyondLookback,
      unreachableBecause: afterOrigin
        ? "AFTER_ORIGIN — the walk only runs backward from the origin"
        : beyondLookback
        ? `BEYOND_MAX_LOOKBACK (${maxBack})`
        : null,
      selectedIndex: sel?.index ?? null,
      selectedDatetime: sel ? candles[sel.index].datetime : null,
      selectedIsExpected: sel?.index === ei,
      interveningSkipped: sel?.interveningSkipped ?? null,
      interveningDetail: sel?.intervening ?? [],
      // What each alternative definition would have produced for THIS break.
      alternatives: Object.fromEntries(ORIGIN_DEFINITIONS.map((d) => {
        const o = d.find(ctx);
        if (o === null) return [d.key, { origin: null, selected: null, hitsExpected: false }];
        const s = selectIPOCandle(candles, o, direction, {
          maxIntervening: opts.maxIntervening,
          interveningMaxRangeAtr: opts.interveningMaxRangeAtr,
          maxLookback: opts.maxLookback,
        });
        return [d.key, {
          origin: o, originDatetime: candles[o].datetime,
          selected: s?.index ?? null,
          selectedDatetime: s ? candles[s.index].datetime : null,
          hitsExpected: s?.index === ei,
        }];
      })),
    };
  });

  const everSelected = perBreak.some((b) => b.selectedIsExpected);
  const everReachable = perBreak.some((b) => b.expectedReachableByBackwardWalk);
  const insideAnyWindow = perBreak.some((b) => b.expectedInsideSearchWindow);

  let outcome: ExpectedOutcome;
  let stage: PipelineStage;
  let firstDivergence: string;
  if (everSelected) {
    outcome = "PRESENT_MATCHER_FAILED";
    stage = "inventory-persistence";
    firstDivergence = "the detector did select this candle — check dedup and the coverage matcher";
  } else if (!insideAnyWindow) {
    outcome = "NEVER_ENTERED";
    stage = "structural-leg-construction";
    firstDivergence = "no break's swing-to-break window contains the candle at all";
  } else if (!everReachable) {
    outcome = "NEVER_ENTERED";
    stage = "origin-search";
    firstDivergence =
      "the candle is inside the structural leg, but the origin lands before it and the " +
      "selection walk only runs backward, so it is never proposed as a candidate";
  } else {
    outcome = "QUALIFIED_LOST_RANKING";
    stage = "candidate-qualification";
    firstDivergence = "reachable from some origin, but the walk stopped at a nearer qualifying candle";
  }

  // Bars around the expected candle. Reasoning about WHY a different candle was
  // demonstrated needs the price action, not just the indices.
  const lo = Math.max(0, ei - 8), hi = Math.min(candles.length - 1, ei + 10);
  const contextBars = [];
  for (let k = lo; k <= hi; k++) {
    const c = candles[k];
    contextBars.push({
      i: k, dt: c.datetime, o: c.open, h: c.high, l: c.low, c: c.close,
      colour: isUp(c) ? "up" : "down",
      isExpected: k === ei,
      rangeAtrApprox: null as number | null,
    });
  }

  return {
    knownDate, direction,
    contextBars,
    expectedIndex: ei,
    expectedDatetime: expected.datetime,
    expectedOhlc: { o: expected.open, h: expected.high, l: expected.low, c: expected.close },
    expectedColour: isUp(expected) ? "up" : "down",
    expectedColourIsWanted: isUp(expected) === wantUp,
    directionalBreaksAfterCandle: events.length,
    outcome, stage, firstDivergence,
    perBreak,
  };
}

// ─── shadow experiment ───────────────────────────────────────────────────────

/**
 * The IPO set a given origin definition would produce over a whole series.
 *
 * Mirrors detectAllIPOCandidates' loop — same events, same dedup, same
 * selectIPOCandle — and swaps ONLY the origin choice. Everything downstream of
 * selection (geometry, liquidity, FVG, consolidation, lifecycle) is irrelevant
 * to which candle is chosen, so it is not recomputed here.
 */
export function shadowOriginInventory(
  candles: Candle[],
  definitionKey: OriginDefinitionKey,
  opts: DetectIPOOptions = {},
): Array<{ index: number; datetime: string; direction: IPODirection; breakIndex: number }> {
  const def = DEF_BY_KEY[definitionKey];
  if (!def) throw new Error(`unknown origin definition ${definitionKey}`);
  const out: Array<{ index: number; datetime: string; direction: IPODirection; breakIndex: number }> = [];
  const seen = new Set<string>();
  for (const ev of directionalEvents(candles, opts)) {
    const direction: IPODirection = ev.direction === "bullish" ? "demand" : "supply";
    const j = ev.index;
    const swingIdx = ev.swingIndex ?? Math.max(0, j - 10);
    const o = def.find({ candles, swingIdx, breakIdx: j, direction });
    if (o === null) continue;
    const sel = selectIPOCandle(candles, o, direction, {
      maxIntervening: opts.maxIntervening,
      interveningMaxRangeAtr: opts.interveningMaxRangeAtr,
      maxLookback: opts.maxLookback,
    });
    if (!sel) continue;
    const key = `${direction}|${sel.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ index: sel.index, datetime: candles[sel.index].datetime, direction, breakIndex: j });
  }
  return out.sort((a, b) => a.index - b.index);
}
