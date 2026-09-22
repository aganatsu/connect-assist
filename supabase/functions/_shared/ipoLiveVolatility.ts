/**
 * Live-causal volatility classification for the frozen IPO candidate.
 *
 * WHY THIS EXISTS. The volatility descriptor is frozen and correct, but the
 * validation runs ranked each bar against a reference distribution built from
 * the WHOLE window set. A live system does not have that distribution. This is
 * the same descriptor — ATR(14)/price, distributional thirds — with the
 * reference restricted to history the bar could actually have seen.
 *
 * NOTHING ABOUT THE MEASURE OR THE THIRDS CHANGED. No new cutoff, no new
 * indicator, no instrument-specific boundary. The only change is which
 * observations the percentile is taken against. That is the minimum edit needed
 * to make an already-frozen rule live-safe, and it is the whole of this module.
 *
 * TWO ENTRY POINTS, PINNED TO EACH OTHER BY TEST:
 *   `classifyCausal(bars)` — batch, delegates straight to the frozen
 *     `labelSeriesCausal`. Use for backtests and the ledger replay.
 *   `LiveVolatility` — streaming, one bar at a time, for the forward runner.
 * A test asserts the two produce identical labels bar for bar. If they ever
 * diverge, the streaming path is wrong, because the batch path is the frozen one.
 *
 * WARMUP IS NOT A FAILURE MODE. Until `MIN_REFERENCE` observations exist the
 * bucket is UNCLASSIFIED. For BTC — the only instrument gated on volatility —
 * UNCLASSIFIED means NO TRADE, exactly as MID_VOL and LOW_VOL do. It must never
 * be silently treated as eligible.
 */

import {
  measureSeries, classify, labelSeriesCausal, MIN_REFERENCE,
  type Regime, type VolBucket,
} from "./ipoRegimeDescriptors.ts";
import type { Candle } from "./smcAnalysis.ts";

export { MIN_REFERENCE };

/** Batch path. Identical to the frozen causal labeller, re-exported by name. */
export function classifyCausal(bars: Candle[]): Regime[] {
  return labelSeriesCausal(bars);
}

/**
 * The single eligibility question the live system asks of this module.
 *
 * Only HIGH_VOL is tradable for a volatility-gated instrument. UNCLASSIFIED is
 * NOT eligible — during warmup the system stands down rather than guessing.
 */
export function isEligible(v: VolBucket, highVolOnly: boolean): boolean {
  return highVolOnly ? v === "HIGH_VOL" : true;
}

/**
 * The percentile reference, as persisted.
 *
 * Both arrays are kept SORTED ASCENDING by `insert`, and the sort order is part
 * of the contract — `classify` ranks against them directly. They are stored
 * rather than recomputed because recomputing means re-deriving `measureSeries`
 * over the prefix, which is most of the bootstrap cost this state exists to
 * avoid, and because a recomputation is a second implementation of the frozen
 * rule and therefore something that can drift.
 */
export interface VolatilityState {
  effSeen: number[];
  atrSeen: number[];
}

/**
 * Streaming classifier.
 *
 * Bars are appended in order and the regime for the newest bar is returned. The
 * percentile reference contains only observations from STRICTLY EARLIER bars —
 * the current bar's own measurement is ranked first and inserted afterwards, so
 * a bar never helps rank itself.
 */
export class LiveVolatility {
  private bars: Candle[] = [];
  private effSeen: number[] = [];
  private atrSeen: number[] = [];

  /** Exact copy of the reference distribution. Copies, so a holder cannot mutate it. */
  exportState(): VolatilityState {
    return { effSeen: [...this.effSeen], atrSeen: [...this.atrSeen] };
  }

  /**
   * Rebuilds a classifier that will behave exactly as the original would have.
   *
   * `bars` must be the SAME prefix the original consumed: `push` recomputes
   * `measureSeries` over it, so a different prefix produces a different
   * measurement for the next bar even with an identical reference.
   */
  static restore(bars: Candle[], s: VolatilityState): LiveVolatility {
    const v = new LiveVolatility();
    v.bars = [...bars];
    v.effSeen = [...s.effSeen];
    v.atrSeen = [...s.atrSeen];
    return v;
  }

  /** Bars accepted so far. */
  get length(): number { return this.bars.length; }

  /** Observations in the reference; below MIN_REFERENCE nothing is classified. */
  get referenceSize(): number { return this.atrSeen.length; }

  private static insert(arr: number[], v: number): void {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
    arr.splice(lo, 0, v);
  }

  /**
   * Appends one closed bar and returns its regime.
   *
   * ONLY CLOSED BARS. An in-progress bar has no final close, so its ATR and
   * efficiency would both change before the bar ends — feeding one would leak a
   * value that does not exist yet.
   */
  push(bar: Candle): Regime {
    this.bars.push(bar);
    const k = this.bars.length - 1;
    // Recomputed on the prefix rather than incrementally: the frozen
    // `measureSeries` is the definition, and a hand-rolled incremental copy of
    // it is exactly the kind of drift this module exists to prevent.
    const m = measureSeries(this.bars)[k];
    const r = classify(this.bars, k, m, { efficiency: this.effSeen, atrPct: this.atrSeen });
    if (m.efficiency !== null && Number.isFinite(m.efficiency)) LiveVolatility.insert(this.effSeen, m.efficiency);
    if (m.atrPct !== null && Number.isFinite(m.atrPct)) LiveVolatility.insert(this.atrSeen, m.atrPct);
    return r;
  }

  /** Convenience for seeding from history before going live. */
  pushAll(bars: Candle[]): Regime[] {
    return bars.map((b) => this.push(b));
  }
}
