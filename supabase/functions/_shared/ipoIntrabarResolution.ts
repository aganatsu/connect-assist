/**
 * Resolves the ENTRY BAR of an IPO trade at 1-minute resolution. PURE.
 *
 * RESEARCH ONLY. Nothing here is wired to the live engine, the paper runner or
 * the backtest. It exists to re-derive what actually happened inside one HTF
 * bar, so the 82 causally-unsupported trades found by the intrabar audit can be
 * re-measured against evidence instead of an assumption.
 *
 * SCOPE IS DELIBERATELY ONE BAR. The audit established that multi-bar trades are
 * unaffected: once a position survives its entry bar, every later bar is
 * evaluated causally and correctly. The whole defect lives in the entry bar, so
 * that is the only thing resolved here. If no exit occurs within it, the trade
 * is handed back to HTF management from the next bar unchanged.
 *
 * S2 REMAINS CLOSE-CONFIRMED. This is the rule the BTC incident turns on, and
 * finer resolution must not quietly weaken it:
 *
 *   a 1m LOW through S2              is a touch, and is NOT an exit
 *   a completed 1m bar CLOSING beyond S2   IS an invalidation
 *
 * The 14:23 touch did not invalidate; the 14:30 close did.
 *
 * PROVENANCE IS PART OF THE RESULT, NOT A FOOTNOTE. Every resolution carries the
 * feed it was computed from and whether that feed is the one that produced the
 * original HTF bar. Resolving a Twelve Data bar with Bitstamp minutes is a
 * useful second opinion, but it is NOT a reconstruction of the original path,
 * and a result that cannot say which it is has replaced one uncertainty with
 * another.
 */

import type { Candle } from "./smcAnalysis.ts";

// ── provenance ───────────────────────────────────────────────────────────────

/**
 * How the 1-minute feed relates to the feed that produced the HTF bar.
 *
 * `SOURCE_MATCHED` is the only class that reconstructs the original path. The
 * others are evidence, clearly labelled as coming from somewhere else.
 */
export type ResolutionProvenance =
  /** Same provider AND same venue as the HTF bar, proven, not assumed. */
  | "SOURCE_MATCHED"
  /** A named venue's own tape. Honest about being a different tape. */
  | "VENUE_SPECIFIC"
  /** The HTF provider is unknown, so no match can be claimed either way. */
  | "HTF_SOURCE_UNKNOWN"
  /** Deliberately a different feed, used as a cross-check. */
  | "CROSS_FEED_REFERENCE";

export interface FeedIdentity {
  /** e.g. "bitstamp", "twelvedata", "polygon", "metaapi". */
  provider: string;
  /** The venue the prices come from, where that is a meaningful distinction. */
  venue: string;
  /** Provider's symbol, verbatim. */
  symbol: string;
  provenance: ResolutionProvenance;
  /** Free text: how the provenance was established, or why it could not be. */
  basis: string;
}

// ── resolution ───────────────────────────────────────────────────────────────

export type ResolvedOutcome =
  /** Target reached strictly after the entry, within the entry bar. */
  | "TARGET_AFTER_ENTRY"
  /** A 1m bar closed beyond S2 after entry, within the entry bar. */
  | "S2_CLOSE_AFTER_ENTRY"
  /** Entered and still open when the HTF bar ended. Hand back to HTF. */
  | "STILL_OPEN_AT_BAR_END"
  /** The entry level was never touched at 1m. Contradicts the HTF fill. */
  | "NO_ENTRY_AT_1M"
  /** One 1m bar contains both entry and target; 1m cannot order them. */
  | "UNRESOLVED_AT_1M";

export interface Resolution {
  outcome: ResolvedOutcome;
  /** Index into the supplied 1m series where entry first occurred. */
  entryMinuteIndex: number | null;
  entryMinuteTime: string | null;
  /** First post-entry minute reaching target, if any. */
  targetMinuteTime: string | null;
  /** First post-entry minute whose LOW crossed S2. Informational only. */
  s2TouchMinuteTime: string | null;
  /** First post-entry minute whose CLOSE crossed S2. This is the exit. */
  s2CloseMinuteTime: string | null;
  /** Best excursion in R measured only from the entry minute onward. */
  postEntryMfeR: number;
  /** Worst excursion in R measured only from the entry minute onward. */
  postEntryMaeR: number;
  /** Set when the outcome is UNRESOLVED_AT_1M — the minute that needs ticks. */
  ambiguousMinuteTime: string | null;
  feed: FeedIdentity;
  /** Minutes supplied for the HTF bar. Below the expected count, coverage is partial. */
  minutesSeen: number;
}

export interface TradeSpec {
  direction: "long" | "short";
  entry: number;
  target: number;
  s2: number;
  risk: number;
}

/**
 * Re-derives the entry bar from its constituent minutes.
 *
 * `minutes` must be the 1m bars covering exactly one HTF bar, in ascending
 * order. Bars outside the HTF window must not be passed: including the minute
 * after the bar would reintroduce lookahead of a different kind.
 */
export function resolveEntryBar(
  spec: TradeSpec, minutes: readonly Candle[], feed: FeedIdentity,
): Resolution {
  const long = spec.direction === "long";
  const base: Resolution = {
    outcome: "NO_ENTRY_AT_1M",
    entryMinuteIndex: null, entryMinuteTime: null,
    targetMinuteTime: null, s2TouchMinuteTime: null, s2CloseMinuteTime: null,
    postEntryMfeR: 0, postEntryMaeR: 0, ambiguousMinuteTime: null,
    feed, minutesSeen: minutes.length,
  };
  if (minutes.length === 0) return base;

  const touchedEntry = (c: Candle) => long ? c.low <= spec.entry : c.high >= spec.entry;
  const reachedTarget = (c: Candle) => long ? c.high >= spec.target : c.low <= spec.target;
  const touchedS2 = (c: Candle) => long ? c.low <= spec.s2 : c.high >= spec.s2;
  const closedBeyondS2 = (c: Candle) => long ? c.close < spec.s2 : c.close > spec.s2;

  const e = minutes.findIndex(touchedEntry);
  if (e < 0) return base;

  const entryMinute = minutes[e];
  const out: Resolution = {
    ...base, outcome: "STILL_OPEN_AT_BAR_END",
    entryMinuteIndex: e, entryMinuteTime: entryMinute.datetime,
  };

  // THE ENTRY MINUTE ITSELF IS THE RESIDUAL AMBIGUITY. If the very minute that
  // touched the entry also reached the target, 1m is no finer than 1h was for
  // this trade: the same two events sit inside one candle with no ordering.
  // Reported, never guessed — that is the tick-data fallback case.
  if (reachedTarget(entryMinute)) {
    return { ...out, outcome: "UNRESOLVED_AT_1M",
             ambiguousMinuteTime: entryMinute.datetime,
             targetMinuteTime: entryMinute.datetime };
  }

  let mfe = 0, mae = 0;
  for (let i = e; i < minutes.length; i++) {
    const c = minutes[i];
    const fav = long ? c.high - spec.entry : spec.entry - c.high;
    const adv = long ? spec.entry - c.low : c.low - spec.entry;
    const favR = (long ? c.high - spec.entry : spec.entry - c.low) / spec.risk;
    const advR = (long ? spec.entry - c.low : c.high - spec.entry) / spec.risk;
    if (favR > mfe) mfe = favR;
    if (advR > mae) mae = advR;
    void fav; void adv;

    if (out.s2TouchMinuteTime === null && touchedS2(c)) out.s2TouchMinuteTime = c.datetime;

    // Ordering within the minute: a close is the minute's LAST event, so a
    // close beyond S2 cannot precede a target high in the same minute. Target
    // therefore wins a same-minute contest — the opposite of the HTF
    // stop-first convention, and correct for the same reason.
    if (reachedTarget(c)) {
      return { ...out, outcome: "TARGET_AFTER_ENTRY", targetMinuteTime: c.datetime,
               postEntryMfeR: mfe, postEntryMaeR: mae };
    }
    if (closedBeyondS2(c)) {
      return { ...out, outcome: "S2_CLOSE_AFTER_ENTRY", s2CloseMinuteTime: c.datetime,
               postEntryMfeR: mfe, postEntryMaeR: mae };
    }
  }
  return { ...out, postEntryMfeR: mfe, postEntryMaeR: mae };
}

/**
 * What the HTF engine recorded, so the two can be compared row by row.
 *
 * Not a judgement: `AGREES` does not make the HTF result right, it means finer
 * evidence did not contradict it.
 */
export type Verdict = "AGREES" | "CONTRADICTED" | "STILL_UNRESOLVED" | "NO_1M_COVERAGE";

export function compareToHtf(
  htfExitReason: "TARGET_2R" | "S2_CLOSE_INVALIDATION" | "NONE",
  r: Resolution,
): Verdict {
  if (r.minutesSeen === 0) return "NO_1M_COVERAGE";
  switch (r.outcome) {
    case "UNRESOLVED_AT_1M": return "STILL_UNRESOLVED";
    case "NO_ENTRY_AT_1M": return "CONTRADICTED";
    case "TARGET_AFTER_ENTRY": return htfExitReason === "TARGET_2R" ? "AGREES" : "CONTRADICTED";
    case "S2_CLOSE_AFTER_ENTRY":
      return htfExitReason === "S2_CLOSE_INVALIDATION" ? "AGREES" : "CONTRADICTED";
    case "STILL_OPEN_AT_BAR_END":
      // The HTF engine closed it on the entry bar; 1m says it was still open.
      return htfExitReason === "NONE" ? "AGREES" : "CONTRADICTED";
  }
}

// ── forward continuation ─────────────────────────────────────────────────────

/**
 * What a later HTF bar did to a position that survived its entry bar.
 *
 * Bars after the entry bar are already evaluated causally by the production
 * engine — the audit established the defect is confined to the entry bar. So
 * continuation reuses the ordinary HTF rules, with one addition: a later bar
 * that contains BOTH decisive events has the same ordering problem as the entry
 * bar did, and is flagged rather than silently resolved stop-first.
 */
export type ForwardOutcome =
  | "TARGET" | "S2_CLOSE" | "STILL_OPEN_AT_END_OF_DATA" | "AMBIGUOUS_LATER_BAR";

export interface ForwardResult {
  outcome: ForwardOutcome;
  exitBarTime: string | null;
  exitPrice: number | null;
  /** HTF bars held, counting the entry bar as 0. */
  barsHeld: number;
  grossR: number | null;
  mfeR: number;
  maeR: number;
  /** Set when a later bar reached target AND closed beyond S2 on the same bar. */
  ambiguousBarTime: string | null;
}

/**
 * Continues a position through HTF bars AFTER its entry bar.
 *
 * `laterBars` must begin at the bar immediately following the entry bar.
 * `seedMfeR` / `seedMaeR` carry the post-entry excursion already measured at 1m
 * inside the entry bar, so the entry bar's PRE-entry range never re-enters the
 * figures — which is the whole point of the exercise.
 *
 * S2 STAYS CLOSE-CONFIRMED: a bar whose low pierces S2 but closes back inside
 * does not exit.
 */
export function continueAfterEntryBar(
  spec: TradeSpec, laterBars: readonly Candle[],
  seedMfeR = 0, seedMaeR = 0,
): ForwardResult {
  const long = spec.direction === "long";
  let mfe = seedMfeR, mae = seedMaeR;

  for (let i = 0; i < laterBars.length; i++) {
    const c = laterBars[i];
    const favR = (long ? c.high - spec.entry : spec.entry - c.low) / spec.risk;
    const advR = (long ? spec.entry - c.low : c.high - spec.entry) / spec.risk;
    if (favR > mfe) mfe = favR;
    if (advR > mae) mae = advR;

    const hitTarget = long ? c.high >= spec.target : c.low <= spec.target;
    const closedBeyond = long ? c.close < spec.s2 : c.close > spec.s2;
    const barsHeld = i + 1;

    // Both on one bar: exactly the ordering problem this research exists to
    // stop papering over. Flagged, not resolved by convention.
    if (hitTarget && closedBeyond) {
      return { outcome: "AMBIGUOUS_LATER_BAR", exitBarTime: c.datetime, exitPrice: null,
               barsHeld, grossR: null, mfeR: mfe, maeR: mae, ambiguousBarTime: c.datetime };
    }
    if (hitTarget) {
      return { outcome: "TARGET", exitBarTime: c.datetime, exitPrice: spec.target,
               barsHeld, grossR: Math.abs(spec.target - spec.entry) / spec.risk,
               mfeR: mfe, maeR: mae, ambiguousBarTime: null };
    }
    if (closedBeyond) {
      const gross = (long ? c.close - spec.entry : spec.entry - c.close) / spec.risk;
      return { outcome: "S2_CLOSE", exitBarTime: c.datetime, exitPrice: c.close,
               barsHeld, grossR: gross, mfeR: mfe, maeR: mae, ambiguousBarTime: null };
    }
  }
  return { outcome: "STILL_OPEN_AT_END_OF_DATA", exitBarTime: null, exitPrice: null,
           barsHeld: laterBars.length, grossR: null, mfeR: mfe, maeR: mae,
           ambiguousBarTime: null };
}
