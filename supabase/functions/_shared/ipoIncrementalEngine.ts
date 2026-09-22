/**
 * Incremental IPO engine. RESEARCH ONLY. Phase B.
 *
 * WHY THIS EXISTS. `ipoLiveEngine` re-runs the frozen whole-series functions on
 * a growing prefix every bar. That makes it impossible to drift from the frozen
 * rules, which is why it stays as the reference oracle — but it is O(n^2) and a
 * single 1,200-bar instrument exceeds the 150s Edge budget. This engine produces
 * the same decisions in roughly linear time.
 *
 * THE ORACLE IS THE SPEC. Everything here is a performance restatement of
 * `runLifecycle` + `episodesFor`, and the equivalence test is what makes that
 * claim checkable rather than asserted. If the two ever disagree, THIS file is
 * wrong. The oracle is never adjusted to match it.
 *
 * TWO EXACT OPTIMISATIONS, both measured before they were built:
 *
 *   EPISODES. `segmentEpisodes` maps each episode through `applyStateExit`
 *   independently, and `applyStateExit` recomputes `confirmedSwings`,
 *   `directionalEvents` and `structureStalls` over the WHOLE series on every
 *   call — so a 20-episode list does that work 20 times. Measured separately,
 *   an episode whose `end < K-1` never changes again: over 640 prefixes there
 *   were 0 vanished episodes and every mutation had a lag of exactly 1 bar.
 *   Frozen episodes are therefore cached and only the tail is recomputed.
 *   Passing a subset is exact precisely because the mapping is per-episode.
 *
 *   LIFECYCLE. `runLifecycle` rescans every candidate's forward history on
 *   every bar. Each tracked candidate instead advances by one bar.
 *
 * WHAT IS NOT OPTIMISED. `twoStageContractions` is still called in full each
 * bar. It is the cheaper half and splitting it would mean reimplementing seed
 * detection, which is exactly the drift this design avoids.
 *
 * Nothing here is wired to production.
 */

import { segmentEpisodes } from "./ipoContractionStateExit.ts";
import { twoStageContractions } from "./ipoContractionTwoStage.ts";
import { ipoGeometry, fvgsNear } from "./ipoZones.ts";
import { LiveVolatility, isEligible, type VolatilityState } from "./ipoLiveVolatility.ts";
import type { Episode } from "./ipoLifecycle.ts";
import type { VolBucket } from "./ipoRegimeDescriptors.ts";
import type { Candle } from "./smcAnalysis.ts";
import type { EngineConfig, LiveEvent, LiveTrade, RefusalReason } from "./ipoLiveEngine.ts";

const isUp = (c: Candle) => c.close >= c.open;
const overlaps = (c: Candle, lo: number, hi: number) => c.low <= hi && c.high >= lo;

/**
 * Every frozen parameter this engine applies, in one place.
 *
 * Collected so a runtime-state fingerprint can be DERIVED from the rules rather
 * than hand-maintained beside them: change any value here and persisted state
 * created under the old value stops being restorable, automatically. The values
 * themselves are unchanged from the frozen spec.
 */
export const FROZEN_RULES = {
  fvgWindow: 10,
  fvgDetectionReachExtra: 21,
  contraction: {
    seedFamily: "E1_STRUCTURE_STALL",
    sideways: "W2_ALTERNATION_RISE",
    start: "S_AFTER_STALL",
    exit: "X_BODY_EXPANSION",
  },
  stateExit: "S2_EFFICIENCY_REGIME_SHIFT",
} as const;

/** The forward window `runLifecycle` scans for an aligned FVG. */
const FVG_WINDOW = FROZEN_RULES.fvgWindow;

/**
 * How far past `k + FVG_WINDOW` the answer can still change.
 *
 * `fvgsNear(s, i)` slices `[i-5, i+21)`, so scanning j up to k+FVG_WINDOW reads
 * bars as far as k+FVG_WINDOW+20. An FVG sitting INSIDE the window is therefore
 * not necessarily DETECTABLE until those later bars exist — measured on
 * candidate 764, which read false at k+10 and true at k+17. Settling at k+10
 * silently drops real setups.
 */
const FVG_DETECTION_REACH = FVG_WINDOW + FROZEN_RULES.fvgDetectionReachExtra;

/**
 * One candidate IPO, advanced a bar at a time.
 *
 * Mirrors a `LifecycleIPO` but keeps only what the engine's decision needs.
 * `hasBos` is deliberately absent: the frozen lifecycle records it and then
 * gates nothing on it, so computing it here would cost a 20-bar scan per
 * candidate to produce a value nobody reads.
 */
interface Tracked {
  k: number;
  up: boolean;
  direction: "demand" | "supply";
  zoneLow: number;
  zoneHigh: number;
  invalidationLevel: number;
  priorHigh: number | null;
  priorLow: number | null;
  /**
   * SUPPRESSION IS NOT MONOTONE. A contraction detected later can cover a
   * candidate that was previously clear, which retroactively invalidates it —
   * measured directly: candidate 109 was VALID at prefix 110 and suppressed at
   * prefix 115 once episode [107-115] appeared. The frozen lifecycle re-derives
   * this every bar, so the episode context is stored and compared, and any
   * change forces a full re-derivation of that candidate.
   */
  suppressed: boolean;
  epContext: string;
  hasFvg: boolean;
  /** True once the answer can no longer change. See FVG_DETECTION_REACH. */
  fvgSettled: boolean;
  validAt: number | null;
  invalidatedAt: number | null;
  /** Died before clearing the prior contraction: it can never be promoted. */
  promotionDead: boolean;
  lastTouch: number | null;
  /** Set when this bar is the first bar of a fresh visit to the zone. */
  touchedThisBar: boolean;
}

/**
 * The complete continuation state of an engine. See `IncrementalEngine.snapshot`
 * for why each field is present and why `refusals` is not.
 */
export interface EngineSnapshot {
  bars: Candle[];
  vol: VolatilityState;
  tracked: Tracked[];
  frozenEpisodes: Episode[];
  episodes: Episode[];
  open: LiveTrade | null;
  lastExitIndex: number;
  lastVol: VolBucket;
  trades: LiveTrade[];
}

export class IncrementalEngine {
  private bars: Candle[] = [];
  private vol = new LiveVolatility();
  private open: LiveTrade | null = null;
  private lastExitIndex = -1;
  private tracked: Tracked[] = [];
  private lastVol: VolBucket = "UNCLASSIFIED";
  /** Episodes whose `end` can no longer change, keyed by start index. */
  private frozenEpisodes: Episode[] = [];
  private episodes: Episode[] = [];

  readonly trades: LiveTrade[] = [];
  readonly refusals: Array<{ index: number; reason: RefusalReason }> = [];

  constructor(private cfg: EngineConfig) {}

  get openTrade(): LiveTrade | null { return this.open; }
  get barCount(): number { return this.bars.length; }

  /**
   * Everything a continuation needs, and deliberately nothing else.
   *
   * This is an ENUMERATED list, not a dump of the instance. Each field is here
   * because some later bar reads it:
   *
   *   bars             every whole-series call — twoStageContractions,
   *                    segmentEpisodes, fvgsNear — rescans the full prefix
   *   vol              the percentile reference the next bar is ranked against
   *   tracked          candidate lifecycles mid-flight
   *   frozenEpisodes   the cache whose absence would change nothing in theory
   *                    and is persisted anyway, because "in theory" is not the
   *                    standard for a restart
   *   episodes         the context string each candidate is compared against
   *   open/lastExitIndex/lastVol   sequencing and management
   *   trades           consumed by the paper layer's reconciliation
   *
   * `refusals` is deliberately ABSENT. It is written and never read — a
   * diagnostic accumulator, not state — so persisting it would grow the payload
   * without being able to change a decision. A test pins that it stays unread.
   *
   * Everything is copied, so a snapshot cannot be mutated by continued feeding.
   */
  snapshot(): EngineSnapshot {
    return {
      bars: this.bars.map((b) => ({ ...b })),
      vol: this.vol.exportState(),
      tracked: this.tracked.map((t) => ({ ...t })),
      frozenEpisodes: this.frozenEpisodes.map((e) => ({ ...e })),
      episodes: this.episodes.map((e) => ({ ...e })),
      open: this.open ? { ...this.open } : null,
      lastExitIndex: this.lastExitIndex,
      lastVol: this.lastVol,
      trades: this.trades.map((t) => ({ ...t })),
    };
  }

  /**
   * Rebuilds an engine that will decide exactly what the original would have.
   *
   * `cfg` is supplied by the caller and NOT taken from the snapshot: it carries
   * `costPerSide`, a function, which cannot cross a serialisation boundary. That
   * is the one piece of the engine's identity a payload cannot prove, which is
   * why `ipoEngineState` records a cost-model id beside the state and refuses a
   * restore whose id does not match.
   */
  static fromSnapshot(cfg: EngineConfig, s: EngineSnapshot): IncrementalEngine {
    const e = new IncrementalEngine(cfg);
    e.bars = s.bars.map((b) => ({ ...b }));
    e.vol = LiveVolatility.restore(e.bars, s.vol);
    e.tracked = s.tracked.map((t) => ({ ...t }));
    e.frozenEpisodes = s.frozenEpisodes.map((x) => ({ ...x }));
    e.episodes = s.episodes.map((x) => ({ ...x }));
    e.open = s.open ? { ...s.open } : null;
    e.lastExitIndex = s.lastExitIndex;
    e.lastVol = s.lastVol;
    for (const t of s.trades) e.trades.push({ ...t });
    return e;
  }

  /**
   * Read-only view of every tracked candidate, for observation.
   *
   * Returns copies so an observer cannot mutate engine state, and adds nothing
   * to the decision path — the equivalence tests cover the same code with and
   * without this being called.
   */
  inspect(): ReadonlyArray<Readonly<Tracked>> {
    return this.tracked.map((t) => ({ ...t }));
  }

  /** The current bar index, or -1 before any bar has been fed. */
  get currentIndex(): number { return this.bars.length - 1; }

  /** Bar at an index, for resolving timestamps in an observation. */
  barAt(i: number): Candle | undefined { return this.bars[i]; }

  /** Volatility bucket of the newest bar. */
  get currentVol(): VolBucket { return this.lastVol; }

  /** Set to `POSITION_ALREADY_OPEN` while a trade occupies the instrument. */
  get sequencingBlocked(): boolean {
    return this.open !== null || this.currentIndex <= this.lastExitIndex;
  }

  /**
   * Recomputes the episode list for the current prefix.
   *
   * Episodes ending before K-1 are frozen and reused verbatim. Only the raw
   * episodes that could still move are passed through `segmentEpisodes`, which
   * is sound because that function maps each episode independently.
   */
  private refreshEpisodes(): void {
    const s = this.bars;
    const K = s.length - 1;
    const raw = twoStageContractions(s, { ...FROZEN_RULES.contraction })
      .map((e) => ({ start: e.start, end: e.end, sidewaysAtIndex: e.sidewaysAtIndex }));

    const frozenStarts = new Set(this.frozenEpisodes.map((e) => e.start));
    const pending = raw.filter((e) => !frozenStarts.has(e.start));

    const settled = pending.length
      ? segmentEpisodes(s, pending, FROZEN_RULES.stateExit).map((e) => {
          let hi = -Infinity, lo = Infinity;
          for (let i = e.start; i <= e.end; i++) { hi = Math.max(hi, s[i].high); lo = Math.min(lo, s[i].low); }
          return { start: e.start, end: e.end, high: hi, low: lo };
        })
      : [];

    this.episodes = [...this.frozenEpisodes, ...settled].sort((a, b) => a.start - b.start);
    // Promote to frozen only once the bar after its end has been seen.
    this.frozenEpisodes = this.episodes.filter((e) => e.end < K - 1);
  }

  /** hasFvg over `[k, min(K, k + FVG_WINDOW)]`, exactly as the frozen lifecycle scans it. */
  private computeFvg(t: Tracked): boolean {
    const s = this.bars;
    const end = Math.min(s.length - 1, t.k + FVG_WINDOW);
    const want = t.up ? "bullish" : "bearish";
    for (let j = t.k; j <= end; j++) {
      for (const f of fvgsNear(s, j) as Array<{ type: string; absIndex: number }>) {
        if (f.type === want && f.absIndex >= t.k && f.absIndex <= t.k + FVG_WINDOW) return true;
      }
    }
    return false;
  }

  /**
   * Appends one CLOSED bar and returns what happened on it.
   *
   * Order matches the oracle exactly: manage an open position first, refuse if
   * still occupied, then evaluate candidates.
   */
  feed(bar: Candle): LiveEvent[] {
    this.bars.push(bar);
    const s = this.bars;
    const K = s.length - 1;
    const bucket = this.vol.push(bar).vol;
    this.lastVol = bucket;
    const out: LiveEvent[] = [];

    if (this.open) {
      const done = this.manageOpen(K);
      if (done) out.push({ kind: "EXITED", index: K, trade: done });
    }

    this.refreshEpisodes();
    this.advance(K);

    if (this.open || K <= this.lastExitIndex) {
      this.refusals.push({ index: K, reason: "POSITION_ALREADY_OPEN" });
      out.push({ kind: "REFUSED", index: K, reason: "POSITION_ALREADY_OPEN", vol: bucket });
      return out;
    }

    // `runLifecycle` emits candidates in ascending k, and the oracle takes the
    // first match, so ties at one bar resolve to the earliest IPO.
    const hit = this.tracked.find((t) =>
      t.touchedThisBar && t.validAt !== null && t.hasFvg &&
      (t.invalidatedAt === null || t.invalidatedAt > K));
    if (!hit) { out.push({ kind: "NO_CANDIDATE", index: K }); return out; }

    if (!isEligible(bucket, this.cfg.highVolOnly)) {
      this.refusals.push({ index: K, reason: "VOLATILITY_NOT_ELIGIBLE" });
      out.push({ kind: "REFUSED", index: K, reason: "VOLATILITY_NOT_ELIGIBLE", vol: bucket });
      return out;
    }

    const long = hit.direction === "demand";
    const entry = long ? hit.zoneLow : hit.zoneHigh;
    const reached = long ? bar.low <= entry : bar.high >= entry;
    if (!reached) {
      this.refusals.push({ index: K, reason: "PRICE_DID_NOT_REACH_50_PERCENT" });
      out.push({ kind: "REFUSED", index: K, reason: "PRICE_DID_NOT_REACH_50_PERCENT", vol: bucket });
      return out;
    }

    const stop = hit.invalidationLevel;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) { out.push({ kind: "NO_CANDIDATE", index: K }); return out; }

    this.open = {
      instrument: this.cfg.instrument, direction: hit.direction, ipoIndex: hit.k,
      entryIndex: K, entry, stop, target: long ? entry + 2 * risk : entry - 2 * risk,
      risk, vol: bucket, costR: (2 * this.cfg.costPerSide(bar.close)) / risk,
      exitIndex: null, exitPrice: null, netR: null, mae: 0, mfe: 0,
    };
    const sameBar = this.manageOpen(K);
    out.push({ kind: "ENTERED", index: K, trade: this.open ?? sameBar! });
    if (sameBar) out.push({ kind: "EXITED", index: K, trade: sameBar });
    return out;
  }

  /** Forms the candidate at K-1 and advances every tracked record by one bar. */
  private advance(K: number): void {
    const s = this.bars;

    // A candidate sits at k where the colour flips between k and k+1, so it
    // becomes knowable only once bar k+1 exists. runLifecycle stops at n-2,
    // which is the same bound.
    const k = K - 1;
    if (k >= 1 && isUp(s[k]) !== isUp(s[K])) {
      const up = isUp(s[K]);
      const direction = up ? "demand" : "supply";
      const g = ipoGeometry(s[k], direction);
      const active = this.episodes.find((e) => k >= e.start && k <= e.end) ?? null;
      const prior = this.episodes.filter((e) => e.end < k).sort((a, b) => b.end - a.end)[0] ?? null;
      this.tracked.push({
        k, up, direction, zoneLow: g.zoneLow, zoneHigh: g.zoneHigh,
        invalidationLevel: direction === "demand" ? s[k].low : s[k].high,
        priorHigh: prior ? prior.high : null, priorLow: prior ? prior.low : null,
        suppressed: active !== null,
        epContext: `${active ? `${active.start}-${active.end}` : "-"}|${prior ? `${prior.start}-${prior.end}` : "-"}`,
        hasFvg: false, fvgSettled: false,
        validAt: null, invalidatedAt: null, promotionDead: prior === null,
        lastTouch: null, touchedThisBar: false,
      });
    }

    for (const t of this.tracked) {
      t.touchedThisBar = false;

      if (!t.fvgSettled) {
        t.hasFvg = this.computeFvg(t);
        // Sticky once true: the scan is an OR over a fixed window, so more bars
        // can only reveal an FVG, never retract one.
        if (t.hasFvg || K >= t.k + FVG_DETECTION_REACH) t.fvgSettled = true;
      }

      // Re-read the episode context. If it moved, everything derived from it is
      // stale and this candidate must be rebuilt from k+1.
      const active = this.episodes.find((e) => t.k >= e.start && t.k <= e.end) ?? null;
      const prior = this.episodes.filter((e) => e.end < t.k).sort((a, b) => b.end - a.end)[0] ?? null;
      const ctx = `${active ? `${active.start}-${active.end}` : "-"}|${prior ? `${prior.start}-${prior.end}` : "-"}`;
      if (ctx !== t.epContext) {
        t.epContext = ctx;
        t.suppressed = active !== null;
        t.priorHigh = prior ? prior.high : null;
        t.priorLow = prior ? prior.low : null;
        t.promotionDead = prior === null;
        this.rederive(t, K);
        continue;
      }

      if (t.suppressed || t.invalidatedAt !== null) continue;
      this.step(t, K);
    }
  }

  /** Advances one candidate by exactly one bar. */
  private step(t: Tracked, j: number): void {
    const c = this.bars[j];
    if (t.validAt === null) {
      if (t.promotionDead || j <= t.k) return;
      const cleared = t.up ? c.close > (t.priorHigh as number) : c.close < (t.priorLow as number);
      if (cleared) t.validAt = j;
      else if (t.up ? c.close < t.invalidationLevel : c.close > t.invalidationLevel) {
        t.promotionDead = true;
        return;
      }
      if (t.validAt === null) return;
    }
    if (t.up ? c.close < t.invalidationLevel : c.close > t.invalidationLevel) {
      t.invalidatedAt = j;
      return;
    }
    if (overlaps(c, t.zoneLow, t.zoneHigh)) {
      // The frozen rule compares against the last RECORDED touch, not the last
      // overlapping bar: `last = touches[touches.length-1]`. Advancing the
      // marker on every overlap shifts the window forward and swallows the next
      // genuine visit — bar 147 overlapping would hide the touch at 148.
      if (t.lastTouch === null || j > t.lastTouch + 1) {
        t.touchedThisBar = true;
        t.lastTouch = j;
      }
    }
  }

  /**
   * Rebuilds a candidate from scratch after its episode context changed.
   *
   * Only ever triggered by a contraction appearing or extending near the tail,
   * so it is rare and bounded; correctness matters more than the cost.
   */
  private rederive(t: Tracked, K: number): void {
    t.validAt = null; t.invalidatedAt = null; t.lastTouch = null; t.touchedThisBar = false;
    t.promotionDead = t.priorHigh === null && t.priorLow === null;
    if (t.suppressed) return;
    for (let j = t.k + 1; j <= K; j++) {
      t.touchedThisBar = false;
      if (t.invalidatedAt !== null) break;
      this.step(t, j);
    }
  }

  /** Identical to the oracle's exit logic: stop-first on an ambiguous bar. */
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

    if (closedBeyond) {
      const gross = (long ? c.close - t.entry : t.entry - c.close) / t.risk;
      return this.close(k, c.close, gross - t.costR);
    }
    if (hitTarget) {
      const gross = Math.abs(t.target - t.entry) / t.risk;
      return this.close(k, t.target, gross - t.costR);
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

/** Runs a whole series through the incremental engine, one closed bar at a time. */
export function replayIncremental(s: Candle[], cfg: EngineConfig): IncrementalEngine {
  const e = new IncrementalEngine(cfg);
  for (const b of s) e.feed(b);
  return e;
}

export type { Tracked };

export interface EquivalenceReport {
  matched: number;
  oracleOnly: Array<{ ipoIndex: number; entryIndex: number }>;
  incrementalOnly: Array<{ ipoIndex: number; entryIndex: number }>;
  fieldMismatches: Array<{ key: string; field: string; oracle: unknown; incremental: unknown }>;
  /** The earliest disagreement of any kind, so a failure names one bar. */
  firstDivergence: string | null;
}

const key = (t: { ipoIndex: number; entryIndex: number }) => `${t.ipoIndex}@${t.entryIndex}`;

/**
 * Compares two trade sets field by field.
 *
 * Every field the strategy decides is compared, not just realized R: a matching
 * R with a different exit bar would be two bugs cancelling, which is exactly
 * the kind of thing an equivalence harness exists to refuse.
 */
export function compareEngines(
  oracle: LiveTrade[], incremental: LiveTrade[], rTolerance = 1e-9,
): EquivalenceReport {
  const O = new Map(oracle.map((t) => [key(t), t]));
  const I = new Map(incremental.map((t) => [key(t), t]));
  const fieldMismatches: EquivalenceReport["fieldMismatches"] = [];
  let matched = 0;

  for (const [k, o] of O) {
    const i = I.get(k);
    if (!i) continue;
    matched++;
    const num: Array<keyof LiveTrade> = ["entry", "stop", "target", "risk", "mae", "mfe", "costR"];
    for (const f of num) {
      if (Math.abs((o[f] as number) - (i[f] as number)) > 1e-9) {
        fieldMismatches.push({ key: k, field: f as string, oracle: o[f], incremental: i[f] });
      }
    }
    if (Math.abs((o.netR ?? 0) - (i.netR ?? 0)) > rTolerance) {
      fieldMismatches.push({ key: k, field: "netR", oracle: o.netR, incremental: i.netR });
    }
    for (const f of ["direction", "exitIndex", "exitPrice", "vol", "entryIndex", "ipoIndex"] as const) {
      if (o[f] !== i[f]) fieldMismatches.push({ key: k, field: f, oracle: o[f], incremental: i[f] });
    }
  }

  const oracleOnly = oracle.filter((t) => !I.has(key(t)))
    .map((t) => ({ ipoIndex: t.ipoIndex, entryIndex: t.entryIndex }));
  const incrementalOnly = incremental.filter((t) => !O.has(key(t)))
    .map((t) => ({ ipoIndex: t.ipoIndex, entryIndex: t.entryIndex }));

  const candidates = [
    ...oracleOnly.map((t) => ({ at: t.entryIndex, msg: `oracle-only trade ipo${t.ipoIndex}@${t.entryIndex}` })),
    ...incrementalOnly.map((t) => ({ at: t.entryIndex, msg: `incremental-only trade ipo${t.ipoIndex}@${t.entryIndex}` })),
    ...fieldMismatches.map((m) => ({
      at: Number(m.key.split("@")[1]),
      msg: `${m.key} field ${m.field}: oracle ${String(m.oracle)} vs incremental ${String(m.incremental)}`,
    })),
  ].sort((a, b) => a.at - b.at);

  return {
    matched, oracleOnly, incrementalOnly, fieldMismatches,
    firstDivergence: candidates.length ? `bar ${candidates[0].at}: ${candidates[0].msg}` : null,
  };
}
