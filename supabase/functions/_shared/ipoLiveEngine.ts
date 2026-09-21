/**
 * Bar-by-bar live engine for the frozen IPO candidate.
 *
 * THE DESIGN DECISION THIS RESTS ON. It would be natural to re-implement the
 * lifecycle incrementally for speed. That is how a live system silently stops
 * matching its backtest: two copies of a rule drift, and the drift is invisible
 * until money is lost. This engine therefore RE-RUNS THE FROZEN FUNCTIONS over a
 * growing prefix and acts on what they say about the newest bar. It contains no
 * copy of any rule. If the frozen rules change, this changes with them.
 *
 * WHAT MAKES IT LIVE-SAFE. `feed()` appends one CLOSED bar and evaluates using
 * `bars[0..k]` only. Nothing downstream can see a later bar, because no later
 * bar exists in the array yet. Causality is structural, not a convention the
 * code has to remember.
 *
 * WHY IT IS ALLOWED TO DISAGREE WITH THE BACKTEST. The batch pipeline evaluates
 * a whole series at once, so it can use information a live system would not
 * have had — an FVG that forms after the entry bar, or a contraction whose
 * extent is only detectable later. Every such disagreement is a REAL defect in
 * the backtest, not a bug here. `compareToBatch` exists to measure them rather
 * than assume they are absent.
 *
 * COST. Re-running the frozen stack per bar is O(n) per bar. At 1-2k bars per
 * window that is seconds, and correctness is worth more than the milliseconds.
 *
 * Nothing here is wired to production.
 */

import { runLifecycle, type Episode } from "./ipoLifecycle.ts";
import { segmentEpisodes } from "./ipoContractionStateExit.ts";
import { twoStageContractions } from "./ipoContractionTwoStage.ts";
import { simulate, type Setup, type Costs } from "./ipoRawBacktest.ts";
import { LiveVolatility, isEligible } from "./ipoLiveVolatility.ts";
import type { VolBucket } from "./ipoRegimeDescriptors.ts";
import type { Candle } from "./smcAnalysis.ts";

export interface EngineConfig {
  instrument: string;
  timeframe: string;
  /** BTC is the only volatility-gated instrument in the frozen spec. */
  highVolOnly: boolean;
  /** One-way cost in price units, from the bar's own price. */
  costPerSide: (price: number) => number;
}

export type LiveEvent =
  | { kind: "NO_CANDIDATE"; index: number }
  | { kind: "REFUSED"; index: number; reason: RefusalReason; vol: VolBucket }
  | { kind: "ENTERED"; index: number; trade: LiveTrade }
  | { kind: "EXITED"; index: number; trade: LiveTrade };

export type RefusalReason =
  | "VOLATILITY_NOT_ELIGIBLE"
  | "PRICE_DID_NOT_REACH_50_PERCENT"
  | "POSITION_ALREADY_OPEN";

export interface LiveTrade {
  instrument: string;
  direction: "demand" | "supply";
  ipoIndex: number;
  entryIndex: number;
  entry: number;
  stop: number;
  target: number;
  risk: number;
  vol: VolBucket;
  /** Round-trip cost in R, FIXED AT ENTRY. See manageOpen. */
  costR: number;
  exitIndex: number | null;
  exitPrice: number | null;
  netR: number | null;
  mae: number;
  mfe: number;
}

/** The frozen contraction stack, applied identically to whatever prefix it is given. */
export function episodesFor(s: Candle[]): Episode[] {
  return segmentEpisodes(
    s,
    twoStageContractions(s, {
      seedFamily: "E1_STRUCTURE_STALL",
      sideways: "W2_ALTERNATION_RISE",
      start: "S_AFTER_STALL",
      exit: "X_BODY_EXPANSION",
    }).map((e) => ({ start: e.start, end: e.end, sidewaysAtIndex: e.sidewaysAtIndex })),
    "S2_EFFICIENCY_REGIME_SHIFT",
  ).map((e) => {
    let hi = -Infinity, lo = Infinity;
    for (let k = e.start; k <= e.end; k++) { hi = Math.max(hi, s[k].high); lo = Math.min(lo, s[k].low); }
    return { start: e.start, end: e.end, high: hi, low: lo };
  });
}

export class LiveEngine {
  private bars: Candle[] = [];
  private vol = new LiveVolatility();
  private open: LiveTrade | null = null;
  /**
   * Bar on which the last position closed. A new entry must come STRICTLY after
   * it, matching the frozen `sequential()` rule (`touchIndex > free`). Allowing
   * same-bar re-entry would also assume an intrabar ordering — that the new fill
   * happened after the old exit — which the bar data cannot support.
   */
  private lastExitIndex = -1;
  readonly trades: LiveTrade[] = [];
  readonly refusals: Array<{ index: number; reason: RefusalReason }> = [];

  constructor(private cfg: EngineConfig) {}

  get openTrade(): LiveTrade | null { return this.open; }
  get barCount(): number { return this.bars.length; }

  /**
   * Appends one CLOSED bar and returns what happened on it.
   *
   * Order matters and mirrors reality: an open position is managed on this bar
   * BEFORE a new one may be taken, so the engine can never hold two at once and
   * can free itself on the same bar it exits.
   */
  feed(bar: Candle): LiveEvent[] {
    this.bars.push(bar);
    const k = this.bars.length - 1;
    const bucket = this.vol.push(bar).vol;
    const out: LiveEvent[] = [];

    if (this.open) {
      const done = this.manageOpen(k);
      if (done) out.push({ kind: "EXITED", index: k, trade: done });
    }
    if (this.open || k <= this.lastExitIndex) {
      this.refusals.push({ index: k, reason: "POSITION_ALREADY_OPEN" });
      out.push({ kind: "REFUSED", index: k, reason: "POSITION_ALREADY_OPEN", vol: bucket });
      return out;
    }

    // A1, evaluated on the prefix. The frozen lifecycle decides; this does not.
    const prefix = this.bars;
    const life = runLifecycle(prefix, episodesFor(prefix))
      .filter((x) => x.validAt !== null && x.hasFvg);
    const hit = life.find((x) => x.touches.includes(k));
    if (!hit) { out.push({ kind: "NO_CANDIDATE", index: k }); return out; }

    if (!isEligible(bucket, this.cfg.highVolOnly)) {
      this.refusals.push({ index: k, reason: "VOLATILITY_NOT_ELIGIBLE" });
      out.push({ kind: "REFUSED", index: k, reason: "VOLATILITY_NOT_ELIGIBLE", vol: bucket });
      return out;
    }

    const long = hit.direction === "demand";
    const entry = long ? hit.zoneLow : hit.zoneHigh;      // the frozen E2 level
    const reached = long ? bar.low <= entry : bar.high >= entry;
    if (!reached) {
      this.refusals.push({ index: k, reason: "PRICE_DID_NOT_REACH_50_PERCENT" });
      out.push({ kind: "REFUSED", index: k, reason: "PRICE_DID_NOT_REACH_50_PERCENT", vol: bucket });
      return out;
    }

    const stop = hit.invalidationLevel;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) { out.push({ kind: "NO_CANDIDATE", index: k }); return out; }

    this.open = {
      instrument: this.cfg.instrument, direction: hit.direction, ipoIndex: hit.candidateIndex,
      entryIndex: k, entry, stop, target: long ? entry + 2 * risk : entry - 2 * risk,
      risk, vol: bucket, costR: (2 * this.cfg.costPerSide(bar.close)) / risk,
      exitIndex: null, exitPrice: null, netR: null, mae: 0, mfe: 0,
    };
    // The entry bar is part of the holding period, so it counts toward excursion
    // and can itself resolve the trade.
    const sameBar = this.manageOpen(k);
    out.push({ kind: "ENTERED", index: k, trade: this.open ?? sameBar! });
    if (sameBar) out.push({ kind: "EXITED", index: k, trade: sameBar });
    return out;
  }

  /**
   * Applies T_2R and S2 to the open position on bar `k`.
   *
   * AMBIGUITY IS RESOLVED STOP-FIRST, matching the frozen backtest: if a bar
   * both reaches the target and closes beyond the invalidation level, the loss
   * is taken. Optimism here would be optimism the backtest never claimed.
   *
   * COST IS THE ENTRY BAR'S, NOT THE EXIT BAR'S. The frozen `simulate` fixes it
   * at the touch price. On a price-proportional fee (BTC) an exit-priced cost
   * silently disagrees with the backtest by a few thousandths of an R — small,
   * but a divergence this engine exists to detect, so it must not create one.
   */
  private manageOpen(k: number): LiveTrade | null {
    const t = this.open!;
    const c = this.bars[k];
    const long = t.direction === "demand";

    const adverse = long ? t.entry - c.low : c.high - t.entry;
    const favourable = long ? c.high - t.entry : t.entry - c.low;
    if (adverse / t.risk > t.mae) t.mae = adverse / t.risk;
    if (favourable / t.risk > t.mfe) t.mfe = favourable / t.risk;

    const hitTarget = long ? c.high >= t.target : c.low <= t.target;
    const closedBeyond = long ? c.close < t.stop : c.close > t.stop;
    const costR = t.costR;

    if (closedBeyond) {
      const gross = (long ? c.close - t.entry : t.entry - c.close) / t.risk;
      return this.close(k, c.close, gross - costR);
    }
    if (hitTarget) {
      const gross = Math.abs(t.target - t.entry) / t.risk;
      return this.close(k, t.target, gross - costR);
    }
    return null;
  }

  private close(k: number, price: number, netR: number): LiveTrade {
    const t = this.open!;
    t.exitIndex = k; t.exitPrice = price; t.netR = netR;
    this.trades.push(t);
    this.open = null;
    this.lastExitIndex = k;
    return t;
  }
}

/** Runs a whole series through the engine, one closed bar at a time. */
export function replay(s: Candle[], cfg: EngineConfig): LiveEngine {
  const e = new LiveEngine(cfg);
  for (const b of s) e.feed(b);
  return e;
}

export interface BatchTrade { ipoIndex: number; entryIndex: number; netR: number }

/**
 * Reproduces the batch pipeline exactly as the validation runs did, for
 * comparison. Kept here so the two paths are defined side by side and neither
 * can quietly drift from what was actually validated.
 */
export function batchTrades(
  s: Candle[], highVolOnly: boolean, cost: (price: number) => number,
  volAt: (i: number) => VolBucket,
): BatchTrade[] {
  const life = runLifecycle(s, episodesFor(s)).filter((x) => x.validAt !== null && x.hasFvg);
  const cand: Array<BatchTrade & { exitIndex: number }> = [];
  for (const x of life) {
    for (const ti of x.touches) {
      if (highVolOnly && volAt(ti) !== "HIGH_VOL") continue;
      const su: Setup = {
        ipoIndex: x.candidateIndex, direction: x.direction, zoneLow: x.zoneLow,
        zoneHigh: x.zoneHigh, extreme: x.invalidationLevel, touchIndex: ti,
        touchNumber: 1, hasFvg: true, afterContraction: true, structuralTarget: null,
      };
      const costs: Costs = { perSide: cost(s[ti].close), label: "" };
      const t = simulate(s, su, "E2_50_PERCENT", "S2_CLOSE_INVALIDATION", "T_2R", costs);
      if (t.outcome !== "WIN" && t.outcome !== "LOSS") continue;
      cand.push({ ipoIndex: x.candidateIndex, entryIndex: ti, netR: t.netR!, exitIndex: t.exitIndex! });
    }
  }
  cand.sort((a, b) => a.entryIndex - b.entryIndex);
  const out: BatchTrade[] = [];
  let free = -1;
  for (const c of cand) if (c.entryIndex > free) { out.push(c); free = c.exitIndex; }
  return out;
}

export interface Divergence {
  liveOnly: BatchTrade[];
  batchOnly: BatchTrade[];
  matched: number;
  /** Matched by (ipoIndex, entryIndex) but disagreeing on realized R. */
  valueMismatches: Array<{ key: string; live: number; batch: number }>;
}

const key = (t: { ipoIndex: number; entryIndex: number }) => `${t.ipoIndex}:${t.entryIndex}`;

export function compareToBatch(live: LiveTrade[], batch: BatchTrade[]): Divergence {
  const L = new Map(live.map((t) => [key(t), t.netR ?? 0]));
  const B = new Map(batch.map((t) => [key(t), t.netR]));
  const valueMismatches: Divergence["valueMismatches"] = [];
  let matched = 0;
  for (const [k, lv] of L) {
    if (!B.has(k)) continue;
    matched++;
    const bv = B.get(k)!;
    if (Math.abs(lv - bv) > 1e-9) valueMismatches.push({ key: k, live: lv, batch: bv });
  }
  return {
    liveOnly: live.filter((t) => !B.has(key(t)))
      .map((t) => ({ ipoIndex: t.ipoIndex, entryIndex: t.entryIndex, netR: t.netR ?? 0 })),
    batchOnly: batch.filter((t) => !L.has(key(t))),
    matched,
    valueMismatches,
  };
}
