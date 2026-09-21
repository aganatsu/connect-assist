/**
 * Contraction DISCOVERY from raw bars. RESEARCH ONLY.
 *
 * WHAT MAKES THIS DIFFERENT FROM ipoContraction.ts. That module measures a
 * window someone else already located. This one has to FIND the window, which is
 * the part that decides whether any of this is usable. A detector handed the
 * answer's boundaries will always look good.
 *
 * NO FITTED PARAMETER IS INTRODUCED HERE. Three things could have been cutoffs
 * and deliberately are not:
 *
 *   bodyComp < 1.0   DEFINITIONAL. 1.0 means "bodies the same size as the
 *                    preceding context". It is where the ratio changes sign, not
 *                    a value read off the 13 marked boxes.
 *   volatility       RELATIVE. Compared against the equal-length window
 *                    immediately before it. No constant.
 *   level repetition RELATIVE. Same comparison. No constant.
 *
 * Two numbers are inherited rather than chosen: the 14-bar context, which is the
 * ATR period already used throughout this project, and the 2-bar minimum, which
 * is the smallest thing that can be called a range. Both predate the marked
 * sample. They are declared in DETECTOR_INHERITED_CONSTANTS so a reader can
 * disagree with them explicitly.
 *
 * NO VARIANT IS PREFERRED. D1..D4 are reported side by side. Picking the one
 * that scores best on the 13 development boxes would be fitting by selection,
 * which is the thing the threshold rule exists to prevent.
 *
 * Nothing here is wired to the detector or to trading.
 */

import { measureContraction } from "./ipoContraction.ts";
import type { Candle } from "./smcAnalysis.ts";

/** Numbers taken from existing project convention, NOT from the marked sample. */
export const DETECTOR_INHERITED_CONSTANTS = {
  contextBars: { value: 14, why: "the ATR period already used project-wide; predates the marked boxes" },
  minWindowBars: { value: 2, why: "the smallest span that can be called a range; used by every other definition here" },
} as const;

export type DetectorKey = "D1_BODY" | "D2_BODY_VOLATILITY" | "D3_BODY_REPETITION" | "D4_ALL_THREE";

export interface DiscoveredWindow {
  start: number;
  end: number;
  bars: number;
  startDatetime: string;
  endDatetime: string;
  bodyCompression: number;
  /** Window range/ATR minus that of the equal-length window before it. */
  volatilityDelta: number | null;
  /** Window level density minus that of the equal-length window before it. */
  repetitionDelta: number | null;
  passes: Record<DetectorKey, boolean>;
}

const body = (c: Candle) => Math.abs(c.close - c.open);

function meanBody(candles: Candle[], from: number, to: number): number | null {
  let s = 0, n = 0;
  for (let k = Math.max(0, from); k <= to; k++) {
    if (!candles[k]) continue;
    s += body(candles[k]); n++;
  }
  return n ? s / n : null;
}

/**
 * Maximal runs of bars that are EACH individually smaller than the mean body of
 * the 14 bars preceding the run.
 *
 * WHY PER-BAR AND NOT THE RUNNING MEAN. The first version extended while the
 * CUMULATIVE mean stayed below the prior, and on a fixture of 15 quiet bars
 * followed by 20 trending bars it returned a single window covering all 35: the
 * average stayed under the bar even as the expansion resumed. A window that
 * absorbs the expansion it is supposed to precede is worthless, and it is
 * exactly the over-extension the evaluation is meant to catch.
 *
 * Testing each bar against the same 14-bar context keeps the boundary
 * definitional — still "smaller than the preceding context", still 1.0, no
 * constant added — while making the run terminate where compression actually
 * stops. The cost is that one large bar inside a genuine contraction splits it,
 * which is reported as overlappingCount rather than hidden.
 */
function bodyCompressedSpans(candles: Candle[], from: number, to: number): Array<[number, number]> {
  const CTX = DETECTOR_INHERITED_CONSTANTS.contextBars.value;
  const MIN = DETECTOR_INHERITED_CONSTANTS.minWindowBars.value;
  const spans: Array<[number, number]> = [];
  for (let a = Math.max(from, CTX); a <= to; a++) {
    const prior = meanBody(candles, a - CTX, a - 1);
    if (!prior) continue;
    let best = -1;
    for (let b = a; b <= to; b++) {
      if (!candles[b] || !(body(candles[b]) < prior)) break;
      if (b - a + 1 >= MIN) best = b;
    }
    if (best >= 0) spans.push([a, best]);
  }
  // Drop any span fully contained in another; keep the longest at each extent.
  spans.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]));
  const kept: Array<[number, number]> = [];
  for (const s of spans) {
    if (!kept.some((k) => s[0] >= k[0] && s[1] <= k[1])) kept.push(s);
  }
  return kept.sort((x, y) => x[0] - y[0]);
}

/** Runs discovery and evaluates all four variants on every candidate span. */
export function discoverContractions(
  candles: Candle[], from = 0, to = candles.length - 1,
): DiscoveredWindow[] {
  const CTX = DETECTOR_INHERITED_CONSTANTS.contextBars.value;
  const out: DiscoveredWindow[] = [];
  for (const [a, b] of bodyCompressedSpans(candles, from, to)) {
    const n = b - a + 1;
    const prior = meanBody(candles, a - CTX, a - 1);
    const here = meanBody(candles, a, b);
    if (prior === null || here === null || prior === 0) continue;
    const bodyComp = here / prior;

    const m = measureContraction(candles, a, b);
    // The comparison context is the equal-length window immediately before.
    // Relative, so no constant enters.
    let volDelta: number | null = null, repDelta: number | null = null;
    if (a - n >= 0 && candles[a - n]) {
      const q = measureContraction(candles, a - n, a - 1);
      if (m.rangeInAtr !== null && q.rangeInAtr !== null) volDelta = m.rangeInAtr - q.rangeInAtr;
      if (m.equalLevelDensity !== null && q.equalLevelDensity !== null) {
        repDelta = m.equalLevelDensity - q.equalLevelDensity;
      }
    }
    const d1 = bodyComp < 1;
    const d2 = d1 && volDelta !== null && volDelta < 0;
    const d3 = d1 && repDelta !== null && repDelta > 0;
    out.push({
      start: a, end: b, bars: n,
      startDatetime: candles[a].datetime, endDatetime: candles[b].datetime,
      bodyCompression: bodyComp, volatilityDelta: volDelta, repetitionDelta: repDelta,
      passes: {
        D1_BODY: d1,
        D2_BODY_VOLATILITY: d2,
        D3_BODY_REPETITION: d3,
        D4_ALL_THREE: d2 && d3,
      },
    });
  }
  return out;
}

export const DETECTOR_KEYS: DetectorKey[] = [
  "D1_BODY", "D2_BODY_VOLATILITY", "D3_BODY_REPETITION", "D4_ALL_THREE",
];

export const windowsFor = (all: DiscoveredWindow[], k: DetectorKey) => all.filter((w) => w.passes[k]);

// ─── evaluation against a hand-marked window ─────────────────────────────────

export interface DiscoveryMatch {
  matched: boolean;
  bestIoU: number;
  startError: number | null;
  endError: number | null;
  overExtends: boolean;
  /** Discovered windows overlapping the marked box at all — >1 means a split. */
  overlappingCount: number;
  /** The best window also covers a DIFFERENT marked box, i.e. two were merged. */
  mergesAnother: boolean;
}

/**
 * Intersection over union against a marked box.
 *
 * IoU is used rather than "did it overlap at all" because a detector that
 * returns one enormous window overlaps everything and is useless. Over-extension
 * is reported separately for the same reason.
 */
export function evaluateDiscovery(
  discovered: DiscoveredWindow[], marked: { start: number; end: number },
  otherMarked: Array<{ start: number; end: number }> = [],
): DiscoveryMatch {
  const overlaps = discovered.filter((w) => w.end >= marked.start && w.start <= marked.end);
  let best: DiscoveredWindow | null = null, bestIoU = 0;
  for (const w of overlaps) {
    const inter = Math.min(w.end, marked.end) - Math.max(w.start, marked.start) + 1;
    const union = Math.max(w.end, marked.end) - Math.min(w.start, marked.start) + 1;
    const iou = union > 0 ? inter / union : 0;
    if (iou > bestIoU) { bestIoU = iou; best = w; }
  }
  return {
    matched: best !== null,
    bestIoU,
    startError: best ? best.start - marked.start : null,
    endError: best ? best.end - marked.end : null,
    overExtends: best ? (best.end - best.start) > (marked.end - marked.start) : false,
    overlappingCount: overlaps.length,
    mergesAnother: best !== null &&
      otherMarked.some((o) => best!.end >= o.start && best!.start <= o.end),
  };
}

// ─── base rate, which decides whether the detector means anything ────────────

export interface BaseRate {
  bars: number;
  windows: number;
  windowsPer1000Bars: number;
  medianWindowBars: number | null;
  pctBarsInsideAWindow: number;
  /** Windows whose span is covered by another window — the same region twice. */
  redundantWindows: number;
  /** Windows whose directional efficiency exceeds the series median: trend, mislabelled. */
  trendLikeWindows: number;
}

export function baseRate(candles: Candle[], windows: DiscoveredWindow[]): BaseRate {
  const covered = new Set<number>();
  for (const w of windows) for (let k = w.start; k <= w.end; k++) covered.add(k);
  const lens = windows.map((w) => w.bars).sort((a, b) => a - b);
  const med = lens.length
    ? (lens.length % 2 ? lens[(lens.length - 1) / 2] : (lens[lens.length / 2 - 1] + lens[lens.length / 2]) / 2)
    : null;
  let redundant = 0;
  for (const w of windows) {
    if (windows.some((v) => v !== w && w.start >= v.start && w.end <= v.end)) redundant++;
  }
  // "Trend mislabelled as contraction", measured relatively: efficiency above
  // the median efficiency of all equal-length windows in the same series.
  const effs: number[] = [];
  for (const w of windows) {
    const m = measureContraction(candles, w.start, w.end);
    if (m.directionalEfficiency !== null) effs.push(m.directionalEfficiency);
  }
  const sorted = [...effs].sort((a, b) => a - b);
  const medEff = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const allEff: number[] = [];
  for (let a = 14; a + 10 < candles.length; a += 10) {
    const m = measureContraction(candles, a, a + 10);
    if (m.directionalEfficiency !== null) allEff.push(m.directionalEfficiency);
  }
  const allSorted = [...allEff].sort((a, b) => a - b);
  const seriesMed = allSorted.length ? allSorted[Math.floor(allSorted.length / 2)] : 0;
  const trendLike = effs.filter((e) => e > seriesMed).length;
  return {
    bars: candles.length,
    windows: windows.length,
    windowsPer1000Bars: candles.length ? (windows.length * 1000) / candles.length : 0,
    medianWindowBars: med,
    pctBarsInsideAWindow: candles.length ? (100 * covered.size) / candles.length : 0,
    redundantWindows: redundant,
    trendLikeWindows: trendLike,
  };
}

/** Where a candidate IPO sits relative to a DISCOVERED window. */
export type IPORelation = "OUTSIDE_BEFORE" | "BOUNDARY" | "INSIDE" | "OUTSIDE_AFTER";

/**
 * INSIDE is reported, never rewarded. DIRECT_TEACHING (15:52-16:21): "the IPO
 * inside of a contraction, I don't like it ... usually I don't get IPOs from the
 * contraction." Nothing in this file tunes on this relation.
 */
export function ipoRelation(ipo: number, w: { start: number; end: number }): IPORelation {
  if (ipo < w.start) return "OUTSIDE_BEFORE";
  if (ipo > w.end) return "OUTSIDE_AFTER";
  if (ipo === w.start || ipo === w.end) return "BOUNDARY";
  return "INSIDE";
}

// ─── A. session-aware comparison context ─────────────────────────────────────

/**
 * The modal bar interval in milliseconds, read off the series itself.
 *
 * Inferred, not configured, so the same code works on 30m FX and 1h crypto and
 * nothing instrument-specific is introduced.
 */
export function modalInterval(candles: Candle[]): number | null {
  const counts = new Map<number, number>();
  for (let k = 1; k < candles.length; k++) {
    const d = Date.parse(candles[k].datetime) - Date.parse(candles[k - 1].datetime);
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: number | null = null, n = 0;
  for (const [d, c] of counts) if (c > n) { n = c; best = d; }
  return best;
}

/**
 * Indices of the 14 most recent MARKET-ACTIVE bars before `a`.
 *
 * THE DEFECT THIS FIXES. EG-2 measured bodyComp 1.96 — apparent expansion — for
 * an ordinary London session, because its 14 chronological predecessors were all
 * Sunday-night and pre-London bars. A dead baseline makes normal activity look
 * explosive, and it happens every week on every FX instrument.
 *
 * THE RULE, with no new constant. A time gap is any bar-to-bar delta larger than
 * the series' own modal interval. After a gap the market re-opens thin, so bars
 * are skipped until one posts a true range at least the MEDIAN true range of the
 * 14 bars preceding that gap — the pre-closure activity level, measured on the
 * horizon this project already uses. Everything is inherited: the 14-bar
 * horizon, a median, and the modal interval.
 *
 * FOR CRYPTO THIS IS A NO-OP. Continuous markets have no delta above the modal
 * interval, so no bar is ever excluded.
 */
export function activeContextIndices(candles: Candle[], a: number): number[] {
  const CTX = DETECTOR_INHERITED_CONSTANTS.contextBars.value;
  const modal = modalInterval(candles);
  const tr = (i: number) => {
    const c = candles[i], p = candles[i - 1];
    return p ? Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
             : c.high - c.low;
  };
  const isGapAt = (i: number) =>
    modal !== null && i > 0 &&
    (Date.parse(candles[i].datetime) - Date.parse(candles[i - 1].datetime)) > modal;

  // Bars belonging to a re-open lull: after a gap, until activity recovers to
  // the pre-gap median.
  const excluded = new Set<number>();
  for (let i = Math.max(1, a - 400); i < a; i++) {
    if (!isGapAt(i)) continue;
    const pre: number[] = [];
    for (let k = i - 1; k >= 0 && pre.length < CTX; k--) pre.push(tr(k));
    if (!pre.length) continue;
    const sorted = [...pre].sort((x, y) => x - y);
    const medPre = sorted[Math.floor(sorted.length / 2)];
    for (let k = i; k < a; k++) {
      if (tr(k) >= medPre) break;
      excluded.add(k);
    }
  }
  const out: number[] = [];
  for (let k = a - 1; k >= 0 && out.length < CTX; k--) if (!excluded.has(k)) out.push(k);
  return out.reverse();
}

/** Mean body over an explicit index list. */
export function meanBodyOf(candles: Candle[], idx: number[]): number | null {
  if (!idx.length) return null;
  let s = 0;
  for (const i of idx) s += Math.abs(candles[i].close - candles[i].open);
  return s / idx.length;
}

// ─── B/C. continuation and termination variants ──────────────────────────────

export type ContinuationKey =
  | "PER_BAR"        // the frozen v1 rule, kept for comparison
  | "C1_ROLLING"     // rolling aggregate stays compressed
  | "C2_MAJORITY"    // majority of the inherited horizon still compressed
  | "C3_STRUCTURAL"  // terminate only when price closes outside the range so far
  | "C4_HYBRID";     // body entry, range continuation, expansion termination

export const CONTINUATION_KEYS: ContinuationKey[] = [
  "PER_BAR", "C1_ROLLING", "C2_MAJORITY", "C3_STRUCTURAL", "C4_HYBRID",
];

/**
 * Extends a window from `a` under one continuation rule and returns its end.
 *
 * Every rule compares against `baseline`, the mean body of the session-aware
 * context, and every rule terminates on a condition derived from that same
 * statistic or from the window's own range. No tolerance count is introduced:
 * "allow one or two bad bars" would be a free parameter and is exactly what this
 * is written to avoid.
 */
function extendWindow(
  candles: Candle[], a: number, to: number, baseline: number, rule: ContinuationKey,
): number {
  const CTX = DETECTOR_INHERITED_CONSTANTS.contextBars.value;
  const MIN = DETECTOR_INHERITED_CONSTANTS.minWindowBars.value;
  const body = (i: number) => Math.abs(candles[i].close - candles[i].open);
  let best = -1;
  let hi = candles[a].high, lo = candles[a].low;
  const bodies: number[] = [];

  for (let b = a; b <= to; b++) {
    if (!candles[b]) break;
    const prevHi = hi, prevLo = lo;
    bodies.push(body(b));
    hi = Math.max(hi, candles[b].high); lo = Math.min(lo, candles[b].low);
    let ok: boolean;
    switch (rule) {
      case "PER_BAR":
        ok = body(b) < baseline;
        break;
      case "C1_ROLLING": {
        const win = bodies.slice(-CTX);
        ok = win.reduce((s, v) => s + v, 0) / win.length < baseline;
        break;
      }
      case "C2_MAJORITY": {
        const win = bodies.slice(-CTX);
        ok = win.filter((v) => v < baseline).length * 2 > win.length;
        break;
      }
      case "C3_STRUCTURAL":
        // Size alone never terminates. Only a close outside the range the
        // window has already established does.
        ok = b === a || (candles[b].close <= prevHi && candles[b].close >= prevLo);
        break;
      case "C4_HYBRID": {
        // Range integrity continues it; an EXPANSION ends it — a close outside
        // the range whose own body also exceeds the context baseline.
        const out = b > a && (candles[b].close > prevHi || candles[b].close < prevLo);
        ok = !(out && body(b) >= baseline);
        break;
      }
    }
    if (!ok) break;
    if (b - a + 1 >= MIN) best = b;
  }
  return best;
}

export interface DiscoverOptions {
  continuation?: ContinuationKey;
  /** Session-aware context. Default true; false reproduces the frozen v1. */
  sessionAware?: boolean;
}

/** v2 discovery: session-aware context plus a selectable continuation rule. */
export function discoverContractionsV2(
  candles: Candle[], from = 0, to = candles.length - 1, opts: DiscoverOptions = {},
): DiscoveredWindow[] {
  const rule = opts.continuation ?? "PER_BAR";
  const sessionAware = opts.sessionAware !== false;
  const CTX = DETECTOR_INHERITED_CONSTANTS.contextBars.value;
  const spans: Array<[number, number]> = [];
  for (let a = Math.max(from, CTX); a <= to; a++) {
    const idx = sessionAware
      ? activeContextIndices(candles, a)
      : Array.from({ length: CTX }, (_, i) => a - CTX + i).filter((i) => i >= 0);
    const baseline = meanBodyOf(candles, idx);
    if (!baseline) continue;
    // ENTRY is body compression under every variant, per the brief.
    if (!(Math.abs(candles[a].close - candles[a].open) < baseline)) continue;
    const end = extendWindow(candles, a, to, baseline, rule);
    if (end >= 0) spans.push([a, end]);
  }
  spans.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]));
  const kept: Array<[number, number]> = [];
  for (const s of spans) if (!kept.some((k) => s[0] >= k[0] && s[1] <= k[1])) kept.push(s);
  kept.sort((x, y) => x[0] - y[0]);

  const out: DiscoveredWindow[] = [];
  for (const [a, b] of kept) {
    const n = b - a + 1;
    const idx = sessionAware
      ? activeContextIndices(candles, a)
      : Array.from({ length: CTX }, (_, i) => a - CTX + i).filter((i) => i >= 0);
    const baseline = meanBodyOf(candles, idx);
    const here = meanBodyOf(candles, Array.from({ length: n }, (_, i) => a + i));
    if (!baseline || here === null) continue;
    const bodyComp = here / baseline;
    const m = measureContraction(candles, a, b);
    let volDelta: number | null = null, repDelta: number | null = null;
    if (a - n >= 0 && candles[a - n]) {
      const q = measureContraction(candles, a - n, a - 1);
      if (m.rangeInAtr !== null && q.rangeInAtr !== null) volDelta = m.rangeInAtr - q.rangeInAtr;
      if (m.equalLevelDensity !== null && q.equalLevelDensity !== null) {
        repDelta = m.equalLevelDensity - q.equalLevelDensity;
      }
    }
    const d1 = bodyComp < 1;
    const d2 = d1 && volDelta !== null && volDelta < 0;
    const d3 = d1 && repDelta !== null && repDelta > 0;
    out.push({
      start: a, end: b, bars: n,
      startDatetime: candles[a].datetime, endDatetime: candles[b].datetime,
      bodyCompression: bodyComp, volatilityDelta: volDelta, repetitionDelta: repDelta,
      passes: { D1_BODY: d1, D2_BODY_VOLATILITY: d2, D3_BODY_REPETITION: d3, D4_ALL_THREE: d2 && d3 },
    });
  }
  return out;
}
