/**
 * Structural Order Blocks (V2) — shadow mode.
 *
 * Detects the base that produced a validated structural impulse, rather than
 * "the last opposite-coloured candle before a break". The existing
 * detectOrderBlocks() does the latter (smcAnalysis.ts findLastBearishCandle),
 * which is the rule this engine deliberately replaces.
 *
 * Runs DOWNSTREAM of the impulse engine: it never decides whether a move
 * mattered, it only locates where a move that already qualified came from.
 *
 * ── Geometry ─────────────────────────────────────────────────────────────────
 * The zone is the PROXIMAL HALF of the base, measured wick to wick.
 *
 *   proximal  the wick extreme price meets first
 *   distal    the 50% of the base's full wick range
 *   extent    the far wick extreme
 *
 * MEASURED vs MODELLED, and the difference matters.
 *
 *   measured   proximal and distal. Read off TradingView's coordinates for two
 *              hand-drawn AUD/USD daily boxes — both directions, four edges,
 *              every one within 1.4 pips:
 *
 *                supply 19 Mar  low  0.70007 / 50% 0.70548   box 0.70002 / 0.70534
 *                demand 30 Mar  high 0.68758 / 50% 0.685525  box 0.68761 / 0.68549
 *
 *              The 30 March high was PREDICTED at 0.68761 from the drawn box
 *              and came back 0.68758 from the raw candle, so the rule was
 *              derived rather than fitted.
 *
 *   modelled   extent as the invalidation level, with two consecutive body
 *              closes beyond it. This does NOT follow from those measurements.
 *              distal is the midpoint, so closing past it is deep mitigation
 *              rather than full-base failure — but where failure actually sits
 *              is a lifecycle choice, still provisional, and it must not
 *              inherit the confidence the geometry earned.
 *
 * This replaces a body-based rule inferred from a single zoomed screenshot of
 * one box on one side, generalised past what that evidence supported.
 *
 * Base LOCATION is a separate, still-open question: V2 builds from candles at
 * the swing origin, while the charts use the last opposing candle before
 * displacement. Those coincided on the 30 March box and diverged on 19 March.
 *
 * ── Shadow mode ──────────────────────────────────────────────────────────────
 * Nothing consumes this. It detects, scores and stores. Displaying its output
 * is allowed; acting on it is not, until it has been validated against the
 * reference charts.
 */

import type { Candle, SwingPoint } from "./smcAnalysis.ts";
import type { ImpulseLeg } from "./impulseZoneEngine.ts";

export type OBStatus =
  | "CANDIDATE"     // base found, structural confirmation incomplete
  | "NEW"           // confirmed, price has not yet travelled away
  | "ACTIVE"        // price moved away, zone untouched
  | "MITIGATED"     // price has returned into the zone at least once
  | "OLD"           // a newer valid block exists; this one is still valid
  | "INVALIDATED";  // decisive acceptance beyond the distal boundary

export type MitigationBand =
  | "none" | "shallow" | "normal" | "deep" | "near_complete";

export interface StructuralOrderBlock {
  /** Deterministic natural key, so a scan can upsert without loading state. */
  id: string;
  symbol: string;
  timeframe: "D" | "4H" | "1H";
  direction: "bullish" | "bearish";

  /** Edge price meets first. Bullish = wick high, bearish = wick low. */
  proximal: number;
  /** Far edge of the tradeable zone: the 50% of the base's full wick range. */
  distal: number;
  /** The far wick extreme. Price closing beyond THIS invalidates the block —
   *  not beyond distal, which is only the midpoint. */
  extent: number;

  baseStartIndex: number;
  baseEndIndex: number;
  baseCandleCount: number;
  /** Candle that confirmed the block (the impulse's structure break). */
  confirmedIndex: number;
  originTime: string;
  confirmedTime: string;

  significance: "internal" | "external";
  /** The impulse that created this block has since had its origin exceeded.
   *  Recorded, not acted on: the block's own lifecycle decides when it dies. */
  parentImpulseBroken: boolean;

  displacementAtrMultiple: number;
  directionalBodyRatio: number;
  directionalCandleRatio: number;
  pathEfficiency: number;
  baseCompactnessAtr: number;

  touches: number;
  maxPenetrationPercent: number;
  mitigationBand: MitigationBand;
  firstTouchIndex?: number;
  lastTouchIndex?: number;

  status: OBStatus;
  invalidationCount: number;
  invalidatedIndex?: number;

  score: number;
  /** Per-factor award. A factor whose input was unavailable is absent, NOT 0 —
   *  an unmeasured factor must never read as a measured zero. */
  scoreBreakdown: Record<string, number>;
  /** Factors that could not be evaluated for want of inputs. */
  scoreUnavailable: string[];
}

export interface DetectOptions {
  symbol: string;
  timeframe: "D" | "4H" | "1H";
  /** Max candles in a base. */
  maxBaseCandles?: number;
  /** A base is "compact" while its body range stays within this × ATR. */
  maxBaseAtr?: number;
  /** Consecutive closes beyond distal required to invalidate. */
  invalidationCloses?: number;
  /** Swings for the same candles, used for origin significance. */
  swings?: SwingPoint[];
  /** Higher-timeframe blocks, for the alignment factor. Omit → factor unscored. */
  htfBlocks?: StructuralOrderBlock[];
  /** EMA series aligned to candles, for the trend factor. Omit → unscored. */
  emaFast?: (number | undefined)[];
  emaSlow?: (number | undefined)[];
}

/** Exported so callers and diagnostics cannot drift from the detector's own
 *  default. A debug path that widened its search by a hardcoded 5 would go
 *  quietly wrong the moment this changed. */
export const DEFAULT_MAX_BASE_CANDLES = 5;

const DEFAULTS = {
  maxBaseCandles: DEFAULT_MAX_BASE_CANDLES,
  maxBaseAtr: 1.0,
  invalidationCloses: 2,
};

// ─── helpers ─────────────────────────────────────────────────────────────────

const bodyHigh = (c: Candle) => Math.max(c.open, c.close);
const bodyLow = (c: Candle) => Math.min(c.open, c.close);

function atrAt(candles: Candle[], index: number, period = 14): number {
  const from = Math.max(0, index - period);
  const slice = candles.slice(from, index);
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + (c.high - c.low), 0) / slice.length;
}

/**
 * Net displacement divided by the distance actually travelled. 1.0 = a straight
 * line; 0.3 = the leg wandered three times further than it progressed.
 */
export function pathEfficiency(candles: Candle[], from: number, to: number): number {
  if (to <= from) return 0;
  const net = Math.abs(candles[to].close - candles[from].open);
  let travelled = 0;
  for (let i = from; i <= to; i++) travelled += candles[i].high - candles[i].low;
  return travelled > 0 ? net / travelled : 0;
}

function directionalRatios(candles: Candle[], from: number, to: number, dir: "bullish" | "bearish") {
  let bodySum = 0, rangeSum = 0, withDir = 0, n = 0;
  for (let i = from; i <= to && i < candles.length; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    bodySum += body; rangeSum += range; n++;
    if (dir === "bullish" ? c.close > c.open : c.close < c.open) withDir++;
  }
  return {
    directionalBodyRatio: rangeSum > 0 ? bodySum / rangeSum : 0,
    directionalCandleRatio: n > 0 ? withDir / n : 0,
  };
}

// ─── base detection (spec §4) ────────────────────────────────────────────────

export interface Base {
  startIndex: number;
  endIndex: number;
  bodyHigh: number;
  bodyLow: number;
  wickHigh: number;
  wickLow: number;
  compactnessAtr: number;
}

/**
 * Walk backwards from the impulse origin and collect the compact area the
 * expansion actually came from.
 *
 * Deliberately NOT "the last opposite candle". That rule is right often enough
 * to look correct and wrong whenever the base is a two-to-five candle
 * consolidation, which is most of the time on Daily and 4H.
 *
 * Accumulation stops at the first of: max candles, body range exceeding
 * maxBaseAtr × ATR, or a candle whose body does not overlap the base built so
 * far — an overlap break means a different price area, not the same base.
 */
export function findImpulseBase(
  candles: Candle[],
  impulse: ImpulseLeg,
  opts: { maxBaseCandles?: number; maxBaseAtr?: number } = {},
): Base | null {
  const maxCandles = opts.maxBaseCandles ?? DEFAULTS.maxBaseCandles;
  const maxAtr = opts.maxBaseAtr ?? DEFAULTS.maxBaseAtr;
  const origin = impulse.startIndex;
  if (origin < 0 || origin >= candles.length) return null;

  const atr = atrAt(candles, origin);
  if (!(atr > 0)) return null;
  const limit = atr * maxAtr;

  let bHigh = bodyHigh(candles[origin]);
  let bLow = bodyLow(candles[origin]);
  let wHigh = candles[origin].high;
  let wLow = candles[origin].low;
  let start = origin;

  for (let i = origin - 1; i >= 0 && (origin - i) < maxCandles; i--) {
    const c = candles[i];
    // Overlap test: the candidate body must intersect the base body range.
    const overlaps = bodyHigh(c) >= bLow && bodyLow(c) <= bHigh;
    if (!overlaps) break;
    const nextHigh = Math.max(bHigh, bodyHigh(c));
    const nextLow = Math.min(bLow, bodyLow(c));
    if (nextHigh - nextLow > limit) break;   // no longer compact
    bHigh = nextHigh; bLow = nextLow;
    wHigh = Math.max(wHigh, c.high);
    wLow = Math.min(wLow, c.low);
    start = i;
  }

  // A zero-height base (a perfect doji run) cannot produce a zone.
  if (!(bHigh > bLow)) return null;

  return {
    startIndex: start,
    endIndex: origin,
    bodyHigh: bHigh,
    bodyLow: bLow,
    wickHigh: wHigh,
    wickLow: wLow,
    compactnessAtr: (bHigh - bLow) / atr,
  };
}

// ─── scoring (spec §10) ──────────────────────────────────────────────────────

const WEIGHTS = {
  meaningfulBOS: 25,
  strongDisplacement: 20,
  confirmedSwingOrigin: 15,
  compactBase: 10,
  fresh: 10,
  htfAlignment: 10,
  trendAlignment: 5,
  srConfluence: 5,
};

function scoreBlock(
  ob: StructuralOrderBlock,
  impulse: ImpulseLeg,
  opts: DetectOptions,
): { score: number; breakdown: Record<string, number>; unavailable: string[] } {
  const breakdown: Record<string, number> = {};
  const unavailable: string[] = [];

  // Every block here came from a confirmed impulse, so the break is real.
  // External breaks carry the full weight; internal ones two thirds.
  breakdown.meaningfulBOS = ob.significance === "external"
    ? WEIGHTS.meaningfulBOS
    : Math.round(WEIGHTS.meaningfulBOS * 0.66);

  const d = impulse.displacement;
  if (d) {
    const strong = d.strength === "strong" ? 1 : d.strength === "moderate" ? 0.6 : 0.2;
    breakdown.strongDisplacement = Math.round(WEIGHTS.strongDisplacement * strong);
  } else {
    unavailable.push("strongDisplacement");
  }

  if (opts.swings && opts.swings.length > 0) {
    const atOrigin = opts.swings.some(s => Math.abs(s.index - ob.baseEndIndex) <= 1);
    breakdown.confirmedSwingOrigin = atOrigin ? WEIGHTS.confirmedSwingOrigin : 0;
  } else {
    unavailable.push("confirmedSwingOrigin");
  }

  // Tighter base = cleaner origin. 0.25 ATR or less takes the full award.
  const tightness = Math.max(0, Math.min(1, 1 - (ob.baseCompactnessAtr - 0.25) / 0.75));
  breakdown.compactBase = Math.round(WEIGHTS.compactBase * tightness);

  breakdown.fresh = ob.touches === 0 ? WEIGHTS.fresh : 0;

  if (opts.htfBlocks) {
    const overlapping = opts.htfBlocks.some(h =>
      h.direction === ob.direction &&
      Math.min(h.proximal, h.distal) <= Math.max(ob.proximal, ob.distal) &&
      Math.max(h.proximal, h.distal) >= Math.min(ob.proximal, ob.distal));
    breakdown.htfAlignment = overlapping ? WEIGHTS.htfAlignment : 0;
  } else {
    unavailable.push("htfAlignment");
  }

  if (opts.emaFast && opts.emaSlow) {
    const f = opts.emaFast[ob.confirmedIndex];
    const s = opts.emaSlow[ob.confirmedIndex];
    if (typeof f === "number" && typeof s === "number") {
      const aligned = ob.direction === "bullish" ? f > s : f < s;
      breakdown.trendAlignment = aligned ? WEIGHTS.trendAlignment : 0;
    } else unavailable.push("trendAlignment");
  } else {
    unavailable.push("trendAlignment");
  }

  // Not computed in shadow mode — recorded as unavailable rather than zero.
  unavailable.push("srConfluence");

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, breakdown, unavailable };
}

// ─── lifecycle (spec §8, §11, §12) ───────────────────────────────────────────

function mitigationBand(pct: number): MitigationBand {
  if (pct <= 0) return "none";
  if (pct < 25) return "shallow";
  if (pct < 50) return "normal";
  if (pct < 75) return "deep";
  return "near_complete";
}

/**
 * Replay candles after confirmation to derive touches, penetration depth and
 * invalidation. Deterministic from the candle series, so no prior state is
 * loaded and a rescan reproduces the same result.
 *
 * A wick beyond distal is NOT invalidation — it is the sweep the zone exists to
 * absorb. Only consecutive BODY CLOSES beyond distal invalidate, and a single
 * close back inside resets the count.
 */
function replayLifecycle(
  ob: StructuralOrderBlock,
  candles: Candle[],
  requiredCloses: number,
): void {
  const height = Math.abs(ob.proximal - ob.distal);
  if (!(height > 0)) return;
  const bullish = ob.direction === "bullish";
  let consecutive = 0;
  let movedAway = false;

  for (let i = ob.confirmedIndex + 1; i < candles.length; i++) {
    const c = candles[i];

    // Has price travelled a full zone height beyond proximal? That is what
    // separates NEW (just formed) from ACTIVE (left behind, waiting).
    if (!movedAway) {
      const away = bullish ? c.high - ob.proximal : ob.proximal - c.low;
      if (away >= height) movedAway = true;
    }

    // Touch = price reached the proximal edge.
    //
    // Penetration is measured across the TRADEABLE HALF (proximal -> distal),
    // so it clamps at 100% once price passes the midpoint even though extent
    // may still be some way off. 100% now means "reached the 50% refinement",
    // NOT "traversed the whole base". The bands below inherit that meaning.
    const reached = bullish ? c.low <= ob.proximal : c.high >= ob.proximal;
    if (reached) {
      const deepest = bullish ? c.low : c.high;
      const pen = Math.max(0, Math.min(100, (Math.abs(ob.proximal - deepest) / height) * 100));
      if (pen > ob.maxPenetrationPercent) ob.maxPenetrationPercent = pen;
      ob.touches++;
      if (ob.firstTouchIndex === undefined) ob.firstTouchIndex = i;
      ob.lastTouchIndex = i;
    }

    // Acceptance beyond EXTENT — the far edge of the whole candle, not the
    // midpoint. distal is the far edge of the tradeable half; closing past it
    // is deep mitigation, which the bands already record. Bodies only: a wick
    // through extent is the sweep the zone exists to absorb.
    const closedBeyond = bullish ? c.close < ob.extent : c.close > ob.extent;
    if (closedBeyond) {
      consecutive++;
      if (consecutive >= requiredCloses) {
        ob.status = "INVALIDATED";
        ob.invalidationCount = consecutive;
        ob.invalidatedIndex = i;
        ob.mitigationBand = mitigationBand(ob.maxPenetrationPercent);
        return;
      }
    } else {
      consecutive = 0;
    }
  }

  ob.invalidationCount = consecutive;
  ob.mitigationBand = mitigationBand(ob.maxPenetrationPercent);
  ob.status = ob.touches > 0 ? "MITIGATED" : movedAway ? "ACTIVE" : "NEW";
}

// ─── overlap suppression (spec §13) ──────────────────────────────────────────

/**
 * Within ONE timeframe only. A Daily block and a 4H block may overlap and still
 * carry different structural information, so cross-timeframe merging is
 * deliberately not done.
 */
function suppressDuplicates(blocks: StructuralOrderBlock[]): StructuralOrderBlock[] {
  const kept: StructuralOrderBlock[] = [];
  const sorted = [...blocks].sort((a, b) => b.score - a.score);
  for (const b of sorted) {
    const bLo = Math.min(b.proximal, b.distal), bHi = Math.max(b.proximal, b.distal);
    const dup = kept.some(k => {
      if (k.direction !== b.direction || k.timeframe !== b.timeframe) return false;
      const kLo = Math.min(k.proximal, k.distal), kHi = Math.max(k.proximal, k.distal);
      const overlap = Math.min(bHi, kHi) - Math.max(bLo, kLo);
      if (overlap <= 0) return false;
      // Functional duplicate = the smaller zone is ~entirely inside the larger.
      return overlap / Math.min(bHi - bLo, kHi - kLo) >= 0.8;
    });
    if (!dup) kept.push(b);
  }
  return kept.sort((a, b) => a.confirmedIndex - b.confirmedIndex);
}

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * Build blocks from already-validated impulse legs.
 *
 * The caller supplies the legs; this never decides whether a move was
 * impulsive. Pass every leg you have for the timeframe — oldest first is not
 * required, the result is sorted by confirmation.
 */
export function detectStructuralOrderBlocks(
  candles: Candle[],
  impulses: ImpulseLeg[],
  opts: DetectOptions,
): StructuralOrderBlock[] {
  if (candles.length < 20 || impulses.length === 0) return [];
  const requiredCloses = opts.invalidationCloses ?? DEFAULTS.invalidationCloses;
  const out: StructuralOrderBlock[] = [];

  for (const impulse of impulses) {
    if (impulse.startIndex == null || impulse.endIndex == null) continue;
    const base = findImpulseBase(candles, impulse, opts);
    if (!base) continue;

    const bullish = impulse.direction === "bullish";
    const originCandle = candles[base.startIndex];
    const confirmCandle = candles[impulse.endIndex];
    if (!originCandle || !confirmCandle) continue;

    const swingAtOrigin = opts.swings?.find(s => Math.abs(s.index - base.endIndex) <= 1);
    const significance: "internal" | "external" = swingAtOrigin?.significance ?? "internal";

    const atr = atrAt(candles, impulse.startIndex);
    const ratios = directionalRatios(candles, impulse.startIndex, impulse.endIndex, impulse.direction);

    const ob: StructuralOrderBlock = {
      // Deterministic: the same base on the same symbol/timeframe always yields
      // the same id, so a rescan upserts instead of duplicating.
      id: `${opts.symbol}|${opts.timeframe}|${impulse.direction}|${originCandle.datetime}`,
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      direction: impulse.direction,

      proximal: bullish ? base.wickHigh : base.wickLow,
      distal: (base.wickHigh + base.wickLow) / 2,
      extent: bullish ? base.wickLow : base.wickHigh,

      baseStartIndex: base.startIndex,
      baseEndIndex: base.endIndex,
      baseCandleCount: base.endIndex - base.startIndex + 1,
      confirmedIndex: impulse.endIndex,
      originTime: originCandle.datetime,
      confirmedTime: confirmCandle.datetime,

      significance,
      parentImpulseBroken: impulse.originBroken === true,

      displacementAtrMultiple: atr > 0 ? Math.abs(impulse.high - impulse.low) / atr : 0,
      directionalBodyRatio: ratios.directionalBodyRatio,
      directionalCandleRatio: ratios.directionalCandleRatio,
      pathEfficiency: pathEfficiency(candles, impulse.startIndex, impulse.endIndex),
      baseCompactnessAtr: base.compactnessAtr,

      touches: 0,
      maxPenetrationPercent: 0,
      mitigationBand: "none",

      status: "CANDIDATE",
      invalidationCount: 0,

      score: 0,
      scoreBreakdown: {},
      scoreUnavailable: [],
    };

    replayLifecycle(ob, candles, requiredCloses);
    const s = scoreBlock(ob, impulse, opts);
    ob.score = s.score;
    ob.scoreBreakdown = s.breakdown;
    ob.scoreUnavailable = s.unavailable;

    out.push(ob);
  }

  const kept = suppressDuplicates(out);

  // NEW / OLD. The newest surviving block per direction+significance is NEW;
  // earlier ones become OLD and REMAIN VALID. A new block never deletes an
  // older one — only invalidation removes a block from consideration.
  const newestBy = new Map<string, StructuralOrderBlock>();
  for (const b of kept) {
    if (b.status === "INVALIDATED") continue;
    const key = `${b.direction}|${b.significance}`;
    const cur = newestBy.get(key);
    if (!cur || b.confirmedIndex > cur.confirmedIndex) newestBy.set(key, b);
  }
  for (const b of kept) {
    if (b.status === "INVALIDATED") continue;
    const key = `${b.direction}|${b.significance}`;
    if (newestBy.get(key) !== b && b.status !== "MITIGATED") b.status = "OLD";
  }

  return kept;
}
