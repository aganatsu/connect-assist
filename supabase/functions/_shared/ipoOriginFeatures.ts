/**
 * Contextual features of origin candidates. RESEARCH ONLY, MEASUREMENT ONLY.
 *
 * WHY THIS EXISTS. Five leg-geometric origin definitions were measured against
 * the twelve stored demonstrations and none beat production: every one trades
 * one group of examples for another. That is evidence the origin is not a
 * function of the leg's shape, so the next question is what ELSE the
 * demonstrated candle has that its nearer competitors do not.
 *
 * WHAT A "COMPETITOR" IS. Every IPO-coloured candle inside the same
 * swing-to-break leg. Those are the candles any origin rule of this family
 * could have chosen. Calling them competitors is a statement about the SEARCH,
 * not about the market: a competitor is not a false positive, it is simply a
 * bar the rule had to pass over.
 *
 * NO SCORING. Each feature is reported on its own and nothing is combined into
 * a formula. With twelve demonstrations a weighted score would fit the sample
 * and tell us nothing, which is the failure that ended three earlier selector
 * rules. Counts per feature, demonstrated versus competitor, and no more.
 *
 * Nothing here is wired to the detector.
 */

import { fvgsNear, ipoGeometry, DEFAULTS, type IPODirection } from "./ipoZones.ts";
import { calculateATR } from "./smcAnalysis.ts";
import type { Candle } from "./smcAnalysis.ts";

const isUp = (c: Candle) => c.close >= c.open;
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Window used for "did this candle take prior liquidity".
 *
 * Reuses DEFAULTS.liquidityWindow rather than inventing a second number, so the
 * measurement is on the same footing as the detector's own liquidity context.
 * It is still an OPERATIONAL_INTERPRETATION and still ours.
 */
const SWEEP_WINDOW = DEFAULTS.liquidityWindow;

export interface OriginCandidateFeatures {
  index: number;
  datetime: string;
  ohlc: { o: number; h: number; l: number; c: number };
  colour: "up" | "down";
  isDemonstrated: boolean;
  isProductionSelected: boolean;

  // ── shape ────────────────────────────────────────────────────────────────
  bodyPct: number;          // |close-open| / (high-low)
  fullRange: number;
  rangeAtr: number;
  bodyAtr: number;

  // ── location within the leg ──────────────────────────────────────────────
  barsFromSwing: number;
  /** Signed: negative = before the leg extreme, positive = after it. */
  barsFromExtreme: number;
  isExtreme: boolean;
  barsToBreak: number;

  // ── run structure ────────────────────────────────────────────────────────
  runLength: number;
  positionInRun: "only" | "first" | "middle" | "last";

  // ── fair value gaps ──────────────────────────────────────────────────────
  /** An aligned FVG whose middle bar is the candle itself or the next one. */
  fvgImmediatelyAfter: boolean;
  barsToNextAlignedFvg: number | null;
  /** The candle is one of the three bars forming an aligned FVG. */
  participatesInFvg: boolean;
  /** An aligned FVG whose price range overlaps the candle's own zone. */
  fvgSpansCandidateZone: boolean;

  // ── liquidity ────────────────────────────────────────────────────────────
  /** Took the extreme of the prior SWEEP_WINDOW bars on the IPO side. */
  sweptPriorLocalExtreme: boolean;
  /** Took it with the wick only — closed back inside. */
  sweepWickOnly: boolean | null;
  /** The bar IMMEDIATELY before it did the sweeping instead. */
  precededBySweep: boolean;

  // ── departure quality measured FROM this candle ──────────────────────────
  displacementAtr: number;
  pathEfficiency: number;
  strongestSubsequentBodyAtr: number;
  immediateDisplacement: boolean;

  // ── what happens between the candle and the break ────────────────────────
  interveningBars: number;
  interveningReenterCount: number;
  mitigatedBeforeBreak: boolean;
}

export interface LegCandidateSet {
  direction: IPODirection;
  swingIndex: number;
  breakIndex: number;
  breakDatetime: string;
  extremeIndex: number;
  extremeDatetime: string;
  demonstratedIndex: number;
  productionSelectedIndex: number | null;
  candidates: OriginCandidateFeatures[];
}

function legExtreme(candles: Candle[], swingIdx: number, breakIdx: number, direction: IPODirection) {
  const bullish = direction === "demand";
  let idx = swingIdx;
  for (let k = swingIdx; k <= breakIdx; k++) {
    if (!candles[k]) continue;
    if (bullish ? candles[k].low <= candles[idx].low : candles[k].high >= candles[idx].high) idx = k;
  }
  return idx;
}

/**
 * Features for one candidate bar.
 *
 * `direction` is the IPO direction, so "favourable" below always means the way
 * the departure moves: up for a demand IPO, down for a supply IPO.
 */
export function candidateFeatures(
  candles: Candle[],
  i: number,
  direction: IPODirection,
  ctx: { swingIdx: number; breakIdx: number; extremeIdx: number; demonstratedIdx: number; productionIdx: number | null },
): OriginCandidateFeatures {
  const c = candles[i];
  const demand = direction === "demand";
  const wantUp = direction === "supply";
  const atr = calculateATR(candles.slice(0, i), 14) || 1;
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);

  // run: contiguous bars of the same colour as this one
  let runStart = i, runEnd = i;
  while (runStart - 1 >= ctx.swingIdx && candles[runStart - 1] &&
         isUp(candles[runStart - 1]) === isUp(c)) runStart--;
  while (runEnd + 1 <= ctx.breakIdx && candles[runEnd + 1] &&
         isUp(candles[runEnd + 1]) === isUp(c)) runEnd++;
  const runLength = runEnd - runStart + 1;
  const positionInRun: OriginCandidateFeatures["positionInRun"] =
    runLength === 1 ? "only" : i === runStart ? "first" : i === runEnd ? "last" : "middle";

  // aligned FVGs near the candle
  const aligned = fvgsNear(candles, i).filter((f) => f.type === (demand ? "bullish" : "bearish"));
  const after = aligned.filter((f) => f.absIndex >= i).sort((a, b) => a.absIndex - b.absIndex);
  const nextFvg = after[0] ?? null;
  const g = ipoGeometry(c, direction);

  // liquidity: did this bar take the prior window's extreme on the IPO side?
  const ws = Math.max(0, i - SWEEP_WINDOW), we = i - 1;
  let priorHi = -Infinity, priorLo = Infinity;
  for (let k = ws; k <= we; k++) {
    if (!candles[k]) continue;
    if (candles[k].high > priorHi) priorHi = candles[k].high;
    if (candles[k].low < priorLo) priorLo = candles[k].low;
  }
  const hasPrior = Number.isFinite(priorHi) && Number.isFinite(priorLo);
  // A demand IPO forms at a low, so the sweep that matters takes prior LOWS.
  const swept = !hasPrior ? false : demand ? c.low < priorLo : c.high > priorHi;
  const sweepWickOnly = !swept ? null : demand ? c.close > priorLo : c.close < priorHi;
  const prev = candles[i - 1];
  const precededBySweep = !hasPrior || !prev ? false : (() => {
    let pHi = -Infinity, pLo = Infinity;
    for (let k = Math.max(0, i - 1 - SWEEP_WINDOW); k <= i - 2; k++) {
      if (!candles[k]) continue;
      if (candles[k].high > pHi) pHi = candles[k].high;
      if (candles[k].low < pLo) pLo = candles[k].low;
    }
    if (!Number.isFinite(pHi)) return false;
    return demand ? prev.low < pLo : prev.high > pHi;
  })();

  // departure quality from this candle to the break
  let best = demand ? -Infinity : Infinity;
  let sumRange = 0, strongestBody = 0;
  for (let k = i + 1; k <= ctx.breakIdx; k++) {
    const b = candles[k];
    if (!b) continue;
    best = demand ? Math.max(best, b.high) : Math.min(best, b.low);
    sumRange += b.high - b.low;
    strongestBody = Math.max(strongestBody, Math.abs(b.close - b.open));
  }
  const anchor = demand ? c.low : c.high;
  const displacementAtr = Number.isFinite(best) ? Math.abs(best - anchor) / atr : 0;
  const pathEfficiency = sumRange > 0 && Number.isFinite(best) ? Math.abs(best - anchor) / sumRange : 0;
  const nxt = candles[i + 1];
  const immediateDisplacement = !!nxt &&
    isUp(nxt) === demand && Math.abs(nxt.close - nxt.open) / atr >= 1;

  // re-entry into the candle's own zone before the break
  let reenter = 0;
  for (let k = i + 1; k <= ctx.breakIdx; k++) {
    const b = candles[k];
    if (b && b.low <= g.zoneHigh && b.high >= g.zoneLow) reenter++;
  }

  return {
    index: i, datetime: c.datetime,
    ohlc: { o: c.open, h: c.high, l: c.low, c: c.close },
    colour: isUp(c) ? "up" : "down",
    isDemonstrated: i === ctx.demonstratedIdx,
    isProductionSelected: i === ctx.productionIdx,
    bodyPct: range > 0 ? r2(body / range) : 0,
    fullRange: range,
    rangeAtr: r2(range / atr),
    bodyAtr: r2(body / atr),
    barsFromSwing: i - ctx.swingIdx,
    barsFromExtreme: i - ctx.extremeIdx,
    isExtreme: i === ctx.extremeIdx,
    barsToBreak: ctx.breakIdx - i,
    runLength, positionInRun,
    fvgImmediatelyAfter: !!nextFvg && nextFvg.absIndex - i <= 1,
    barsToNextAlignedFvg: nextFvg ? nextFvg.absIndex - i : null,
    participatesInFvg: aligned.some((f) => Math.abs(f.absIndex - i) <= 1),
    fvgSpansCandidateZone: aligned.some((f) => f.low <= g.zoneHigh && f.high >= g.zoneLow),
    sweptPriorLocalExtreme: swept,
    sweepWickOnly,
    precededBySweep,
    displacementAtr: r2(displacementAtr),
    pathEfficiency: r2(pathEfficiency),
    strongestSubsequentBodyAtr: r2(strongestBody / atr),
    immediateDisplacement,
    interveningBars: ctx.breakIdx - i - 1,
    interveningReenterCount: reenter,
    mitigatedBeforeBreak: reenter > 0,
  };
}

/**
 * Every IPO-coloured candidate in the leg that contains a demonstrated origin,
 * with the demonstrated one flagged.
 *
 * The leg is chosen as the FIRST directional break after the demonstrated
 * candle whose swing-to-break window actually contains it. That is the leg the
 * detector would have had to use to find it, so it is the only one where a
 * competitor comparison means anything.
 */
export function legCandidateSet(
  candles: Candle[],
  demonstratedIdx: number,
  direction: IPODirection,
  events: Array<{ index: number; direction: string; swingIndex?: number }>,
  productionSelectedIdx: number | null,
): LegCandidateSet | null {
  const wantDir = direction === "demand" ? "bullish" : "bearish";
  const ev = events.find((e) => {
    if (e.direction !== wantDir || e.index <= demonstratedIdx) return false;
    const sw = e.swingIndex ?? Math.max(0, e.index - 10);
    return demonstratedIdx >= sw && demonstratedIdx <= e.index;
  });
  if (!ev) return null;
  const swingIdx = ev.swingIndex ?? Math.max(0, ev.index - 10);
  const breakIdx = ev.index;
  const extremeIdx = legExtreme(candles, swingIdx, breakIdx, direction);
  const wantUp = direction === "supply";
  const ctx = { swingIdx, breakIdx, extremeIdx, demonstratedIdx, productionIdx: productionSelectedIdx };

  const candidates: OriginCandidateFeatures[] = [];
  for (let i = swingIdx; i <= breakIdx; i++) {
    if (!candles[i] || isUp(candles[i]) !== wantUp) continue;
    candidates.push(candidateFeatures(candles, i, direction, ctx));
  }
  return {
    direction, swingIndex: swingIdx, breakIndex: breakIdx,
    breakDatetime: candles[breakIdx].datetime,
    extremeIndex: extremeIdx, extremeDatetime: candles[extremeIdx].datetime,
    demonstratedIndex: demonstratedIdx,
    productionSelectedIndex: productionSelectedIdx,
    candidates,
  };
}

// ─── aggregation ─────────────────────────────────────────────────────────────

/** Boolean features, counted demonstrated vs competitor. No combination. */
export const BOOLEAN_FEATURES: Array<{ key: string; read: (f: OriginCandidateFeatures) => boolean }> = [
  { key: "fvgImmediatelyAfter", read: (f) => f.fvgImmediatelyAfter },
  { key: "participatesInFvg", read: (f) => f.participatesInFvg },
  { key: "fvgSpansCandidateZone", read: (f) => f.fvgSpansCandidateZone },
  { key: "sweptPriorLocalExtreme", read: (f) => f.sweptPriorLocalExtreme },
  { key: "precededBySweep", read: (f) => f.precededBySweep },
  { key: "immediateDisplacement", read: (f) => f.immediateDisplacement },
  { key: "isExtreme", read: (f) => f.isExtreme },
  { key: "atOrAfterExtreme", read: (f) => f.barsFromExtreme >= 0 },
  { key: "lastOfRun", read: (f) => f.positionInRun === "last" || f.positionInRun === "only" },
  { key: "firstOfRun", read: (f) => f.positionInRun === "first" || f.positionInRun === "only" },
  { key: "singleBarRun", read: (f) => f.positionInRun === "only" },
  { key: "mitigatedBeforeBreak", read: (f) => f.mitigatedBeforeBreak },
  { key: "bodyDominant50", read: (f) => f.bodyPct >= 0.5 },
];

/** Numeric features, summarised as medians. Ranking, never thresholds. */
export const NUMERIC_FEATURES: Array<{ key: string; read: (f: OriginCandidateFeatures) => number }> = [
  { key: "displacementAtr", read: (f) => f.displacementAtr },
  { key: "pathEfficiency", read: (f) => f.pathEfficiency },
  { key: "strongestSubsequentBodyAtr", read: (f) => f.strongestSubsequentBodyAtr },
  { key: "rangeAtr", read: (f) => f.rangeAtr },
  { key: "bodyPct", read: (f) => f.bodyPct },
  { key: "barsToBreak", read: (f) => f.barsToBreak },
  { key: "interveningReenterCount", read: (f) => f.interveningReenterCount },
];

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : r2((s[m - 1] + s[m]) / 2);
};

/**
 * Counts, not anecdotes — and a rank for the demonstrated candle within its own
 * leg, which is the only comparison that controls for the leg itself.
 */
export function summariseFeatures(sets: LegCandidateSet[]) {
  const demo = sets.map((s) => s.candidates.find((c) => c.isDemonstrated)).filter(Boolean) as OriginCandidateFeatures[];
  const comp = sets.flatMap((s) => s.candidates.filter((c) => !c.isDemonstrated));

  const booleans = BOOLEAN_FEATURES.map(({ key, read }) => {
    const d = demo.filter(read).length, c = comp.filter(read).length;
    return {
      feature: key,
      demonstrated: `${d}/${demo.length}`,
      demonstratedPct: demo.length ? r2((d / demo.length) * 100) : null,
      competitors: `${c}/${comp.length}`,
      competitorsPct: comp.length ? r2((c / comp.length) * 100) : null,
      lift: demo.length && comp.length ? r2((d / demo.length) - (c / comp.length)) : null,
    };
  }).sort((a, b) => Math.abs(b.lift ?? 0) - Math.abs(a.lift ?? 0));

  const numerics = NUMERIC_FEATURES.map(({ key, read }) => {
    // Within-leg rank of the demonstrated candle, 1 = highest in its own leg.
    const ranks = sets.map((s) => {
      const d = s.candidates.find((c) => c.isDemonstrated);
      if (!d) return null;
      const sorted = [...s.candidates].sort((a, b) => read(b) - read(a));
      return { rank: sorted.findIndex((c) => c.index === d.index) + 1, of: s.candidates.length };
    }).filter(Boolean) as Array<{ rank: number; of: number }>;
    return {
      feature: key,
      demonstratedMedian: median(demo.map(read)),
      competitorMedian: median(comp.map(read)),
      demonstratedRankedFirstInLeg: ranks.filter((r) => r.rank === 1).length,
      legsWithMoreThanOneCandidate: ranks.filter((r) => r.of > 1).length,
      medianRank: median(ranks.map((r) => r.rank)),
    };
  });

  return {
    legs: sets.length,
    demonstratedCandles: demo.length,
    competitorCandles: comp.length,
    booleans, numerics,
    note: "Counts only. Nothing is combined into a score: with this many " +
      "demonstrations a weighted formula would fit the sample and teach nothing.",
  };
}
