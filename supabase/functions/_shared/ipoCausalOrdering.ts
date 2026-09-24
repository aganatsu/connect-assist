/**
 * Causal event ordering for IPO execution. PURE — no database, no network, no clock.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. Every IPO execution path derived the entry
 * from one extreme of an HTF bar and then evaluated the brand-new position
 * against the WHOLE of that same bar. An OHLC bar carries no path ordering, so
 * an extreme that occurred BEFORE the entry touch could resolve a position that
 * did not yet exist. The recorded incident: BTC/USD 1h 2026-09-23T14:00Z opened
 * at 85792.01 — already above the 85159.525 target — and the engine booked
 * TARGET_2R on a trade that entered at 84473.315 later in the same hour. The
 * true path, from 1-minute data, was an S2 close invalidation.
 *
 * WHAT THIS MODULE DOES, AND ONLY THIS. It answers one question per HTF bar:
 * given the bar, whether it is the fill bar, and whatever lower-timeframe tape
 * is available, WHICH of target / S2-close / neither actually happened first
 * after the entry. It computes no prices, no R, no sizing, and it never decides
 * whether a setup is valid.
 *
 * WHAT IT DOES NOT CHANGE. S2 stays HTF close-confirmed: a wick through S2 is
 * not an exit at any resolution, and the invalidating event is always the HTF
 * bar's own close. The target stays 2R. The entry stays E2. Lower-timeframe data
 * is used for CHRONOLOGY ONLY.
 *
 * THE ONE ORDERING RULE. Within a single HTF bar the close is, by definition,
 * the last event. So if the target was reached at any post-entry moment inside
 * the bar, it happened BEFORE that bar's close — target wins. That is not
 * optimism; it is what "close" means. The blanket "assume stop first" convention
 * exists only because HTF data cannot order the two, and it is now used only
 * where the lower timeframe genuinely cannot either.
 *
 * NO GUESSING. When ordering cannot be proven the answer is UNRESOLVED and the
 * observation is voided, never fabricated.
 */

/**
 * NO IMPORTS, DELIBERATELY. The browser-facing read path imports the version
 * constant below, and `ipoFunctionReachability` pins that path's whole import
 * closure. Pulling in `smcAnalysis` for a type alone would put a 4,200-line
 * analysis module inside a read API that is guaranteed not to be able to run
 * one. The bar shape is therefore declared here; it is structurally identical to
 * `Candle`, so callers pass `Candle` values unchanged in both directions.
 */
export interface OhlcBar {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
type Candle = OhlcBar;

/** Identity of the forward evidence produced under this ordering model. */
export const CAUSAL_EXECUTION_VERSION = "1m-ordering-v1";

export type ResolutionMethod =
  /** The HTF bar alone is sufficient — at most one resolving event occurred. */
  | "HTF_UNAMBIGUOUS"
  /** Competing events existed and 1-minute bars established their order. */
  | "ONE_MINUTE_RESOLVED"
  /** 1-minute was not enough and tick data established the order. */
  | "TICK_RESOLVED"
  /** Nothing available can order the events. The observation is void. */
  | "ORDERING_UNRESOLVED";

export type OrderingKind =
  | "HOLD"
  | "TARGET"
  | "S2_CLOSE"
  | "UNRESOLVED"
  /** The caller must supply lower-timeframe bars for this span and ask again. */
  | "NEED_MINUTES";

export interface BarOrdering {
  kind: OrderingKind;
  method: ResolutionMethod;
  /** First minute at or after which the position existed. Null on later bars. */
  entryMinute: string | null;
  /** Minute on which the target was proven reached, when 1m established it. */
  targetMinute: string | null;
  /** The HTF bar whose close invalidated, when that is the outcome. */
  s2CloseBarTime: string | null;
  /**
   * Excursions over the POST-ENTRY portion of the bar only, in price units.
   * Null when the bar was not resolved from minutes, in which case the caller
   * keeps the whole-bar figures — which are correct for every bar after the
   * fill, because the position existed for all of it.
   */
  postEntryAdverse: number | null;
  postEntryFavourable: number | null;
  /** Human-readable, written into the audit event. Never parsed. */
  detail: string;
}

export interface ResolveInput {
  direction: "long" | "short";
  entryPrice: number;
  targetPrice: number;
  s2InvalidationLevel: number;
  /** The HTF bar being applied. */
  bar: Candle;
  /** Length of one HTF bar in milliseconds, for slicing the minute tape. */
  barMs: number;
  /** True only for the bar on which the position filled. */
  isEntryBar: boolean;
  /**
   * Every minute bar available to the caller. Sliced to this HTF bar here so
   * the caller cannot get the window wrong. Null when none were fetched.
   */
  minutes: readonly Candle[] | null;
  /**
   * Tick data, when a feed for it exists. None does today, so this is always
   * null and `TICK_RESOLVED` is unreachable — declared rather than pretended
   * away, so the gap is visible in the type instead of in a comment.
   */
  ticks?: readonly { time: string; price: number }[] | null;
}

const ms = (t: string) => new Date(t).getTime();

const hold = (method: ResolutionMethod, detail: string, over: Partial<BarOrdering> = {}): BarOrdering => ({
  kind: "HOLD", method, entryMinute: null, targetMinute: null, s2CloseBarTime: null,
  postEntryAdverse: null, postEntryFavourable: null, detail, ...over,
});

/** Minutes whose open instant lies inside [bar.start, bar.start + barMs). */
export function minutesInBar(
  minutes: readonly Candle[], bar: Candle, barMs: number,
): Candle[] {
  const from = ms(bar.datetime);
  const to = from + barMs;
  return minutes
    .filter((m) => { const t = ms(m.datetime); return t >= from && t < to; })
    .sort((a, b) => ms(a.datetime) - ms(b.datetime));
}

/**
 * Resolves one HTF bar against one open (or filling) position.
 *
 * Returns `NEED_MINUTES` rather than guessing whenever the HTF bar is genuinely
 * ambiguous and no tape was supplied. The caller is expected to fetch and ask
 * again; if it cannot, it must treat that as UNRESOLVED, not as a default.
 */
export function resolveBar(input: ResolveInput): BarOrdering {
  const { direction, entryPrice, targetPrice, s2InvalidationLevel: s2, bar, barMs, isEntryBar } = input;
  const long = direction === "long";

  const barHitTarget = long ? bar.high >= targetPrice : bar.low <= targetPrice;
  const barClosedBeyond = long ? bar.close < s2 : bar.close > s2;

  // ── bars after the fill: the position existed for the whole bar ────────────
  if (!isEntryBar) {
    if (!barHitTarget && !barClosedBeyond) {
      return hold("HTF_UNAMBIGUOUS", "no resolving event on this bar");
    }
    if (barHitTarget && !barClosedBeyond) {
      return { ...hold("HTF_UNAMBIGUOUS", "target reached, bar did not close beyond S2"),
        kind: "TARGET" };
    }
    if (!barHitTarget && barClosedBeyond) {
      return { ...hold("HTF_UNAMBIGUOUS", "bar closed beyond S2, target never reached"),
        kind: "S2_CLOSE", s2CloseBarTime: bar.datetime };
    }
    // Both. The close is the bar's last event, so a target reached anywhere in
    // the bar preceded it — but only the tape can prove the target was actually
    // reached rather than merely bracketed by the bar's high.
    const mins = input.minutes ? minutesInBar(input.minutes, bar, barMs) : null;
    if (!mins || mins.length === 0) {
      return hold("ORDERING_UNRESOLVED",
        "target and S2 close on one bar and no minute tape was supplied",
        { kind: "NEED_MINUTES" });
    }
    for (const m of mins) {
      if (long ? m.high >= targetPrice : m.low <= targetPrice) {
        return { ...hold("ONE_MINUTE_RESOLVED",
          `target reached at ${m.datetime}, before the bar close that breached S2`),
          kind: "TARGET", targetMinute: m.datetime };
      }
    }
    return { ...hold("ONE_MINUTE_RESOLVED",
      "no minute reached the target; the bar close beyond S2 is the first resolving event"),
      kind: "S2_CLOSE", s2CloseBarTime: bar.datetime };
  }

  // ── the fill bar: nothing before the entry instant may resolve the trade ───
  const mins = input.minutes ? minutesInBar(input.minutes, bar, barMs) : null;

  if (!mins || mins.length === 0) {
    if (!barHitTarget && !barClosedBeyond) {
      // Nothing in the bar could have resolved anything, so when the entry
      // happened inside it does not matter.
      return hold("HTF_UNAMBIGUOUS", "entry bar contains no resolving event");
    }
    if (!barHitTarget && barClosedBeyond) {
      // A bar CLOSE is the bar's last instant, so it is necessarily after an
      // entry that occurred inside the same bar. No tape needed.
      return { ...hold("HTF_UNAMBIGUOUS",
        "entry bar closed beyond S2 and never reached the target; the close post-dates any intrabar entry"),
        kind: "S2_CLOSE", s2CloseBarTime: bar.datetime };
    }
    // The target side was touched somewhere in the fill bar. Whether that was
    // before or after the entry is exactly the contaminated question.
    return hold("ORDERING_UNRESOLVED",
      "entry bar touched the target side; ordering against the fill requires a minute tape",
      { kind: "NEED_MINUTES" });
  }

  const eIdx = mins.findIndex((m) => long ? m.low <= entryPrice : m.high >= entryPrice);
  if (eIdx < 0) {
    // The HTF bar says E2 was reached; the minutes do not. That is a feed
    // disagreement, not an outcome, and inventing one would be the same class
    // of error this module exists to remove.
    return hold("ORDERING_UNRESOLVED",
      "the HTF bar reaches E2 but no minute in it does — minute and HTF feeds disagree",
      { kind: "UNRESOLVED" });
  }

  const em = mins[eIdx];
  if (long ? em.high >= targetPrice : em.low <= targetPrice) {
    // Entry and target inside the same minute. 1m cannot order them, and there
    // is no tick feed to ask. Do not assume either way.
    return hold("ORDERING_UNRESOLVED",
      `entry and target both occur inside ${em.datetime}; 1m cannot order them and no tick feed exists`,
      { kind: "UNRESOLVED", entryMinute: em.datetime });
  }

  // Post-entry excursions only. The pre-entry portion of the bar belongs to a
  // position that did not exist.
  let adverse = 0, favourable = 0, targetMinute: string | null = null;
  for (let i = eIdx; i < mins.length; i++) {
    const m = mins[i];
    const a = long ? entryPrice - m.low : m.high - entryPrice;
    const f = long ? m.high - entryPrice : entryPrice - m.low;
    if (a > adverse) adverse = a;
    if (f > favourable) favourable = f;
    if (targetMinute === null && (long ? m.high >= targetPrice : m.low <= targetPrice)) {
      targetMinute = m.datetime;
      break;   // the trade ends here; later minutes belong to no position
    }
  }

  if (targetMinute !== null) {
    return { ...hold("ONE_MINUTE_RESOLVED",
      `entry at ${em.datetime}, target reached at ${targetMinute}`),
      kind: "TARGET", entryMinute: em.datetime, targetMinute,
      postEntryAdverse: adverse, postEntryFavourable: favourable };
  }

  if (barClosedBeyond) {
    return { ...hold("ONE_MINUTE_RESOLVED",
      `entry at ${em.datetime}; no post-entry minute reached the target and the bar closed beyond S2`),
      kind: "S2_CLOSE", entryMinute: em.datetime, s2CloseBarTime: bar.datetime,
      postEntryAdverse: adverse, postEntryFavourable: favourable };
  }

  return hold("ONE_MINUTE_RESOLVED",
    barHitTarget
      ? `entry at ${em.datetime}; the bar's target-side extreme occurred BEFORE the entry and is not the position's`
      : `entry at ${em.datetime}; no resolving event after it`,
    { entryMinute: em.datetime, postEntryAdverse: adverse, postEntryFavourable: favourable });
}

/**
 * Was the HTF-only reading of this bar different from the causal one?
 *
 * Used to mark the forward record where the frozen engine — which reads the
 * whole bar — would have booked an outcome the tape refuses. It is diagnostic
 * only; nothing downstream branches on it.
 */
export function htfWouldHaveClosed(input: ResolveInput): "TARGET" | "S2_CLOSE" | null {
  const long = input.direction === "long";
  const closedBeyond = long
    ? input.bar.close < input.s2InvalidationLevel
    : input.bar.close > input.s2InvalidationLevel;
  // The frozen engine tests S2 before the target, so a bar doing both is a loss.
  if (closedBeyond) return "S2_CLOSE";
  const hitTarget = long ? input.bar.high >= input.targetPrice : input.bar.low <= input.targetPrice;
  return hitTarget ? "TARGET" : null;
}
