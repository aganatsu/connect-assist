// ─── IPO zones — SHADOW ONLY ─────────────────────────────────────────────────
//
// An interpretation/association layer over primitives that already exist. It
// deliberately builds NO new swing detector, structure engine, FVG detector or
// liquidity detector. Nothing in production calls anything here.
//
// REUSED AS-IS
//   analyzeMarketStructureCanonical  causal first-close-through structure
//   detectSwingPoints                (via the canonical engine)
//   detectLiquidityPools             equal/clustered highs and lows
//   detectFVGs                       through a LOCAL SLICE wrapper (below)
//   calculateATR
//
// DELIBERATELY NOT REUSED, and why — each of these has a name that invites
// reuse and semantics that would be wrong here:
//
//   findImpulseBase          merges up to DEFAULT_MAX_BASE_CANDLES = 5 candles
//                            into one base. An IPO is a SINGLE candle.
//   obZoneWithWicks          body +/- 50% of each wick, roughly a third deeper
//                            than the frozen geometry.
//   analyzeMarketStructure   pairwise swing-to-swing timing. Measured 2-4 bars
//                            late and missing 13-28 breaks per symbol, so it
//                            cannot confirm an IPO.
//   enumerateImpulseLegs     transitively depends on the above.
//   ob.touches               increments PER BAR inside the zone
//                            (structuralOrderBlocks.ts:385), so three bars in
//                            the zone counts three. An IPO test is one VISIT.
//   detectBreakerBlocks      keys off legacy "mitigated". Usable only behind
//                            the IPO BROKEN gate, never to decide the flip.
//
// OPERATIONAL PARAMETERS are collected in DEFAULTS with the reasoning attached.
// They encode a taught rule, not a fitted one; none was chosen by sweeping the
// ten known boxes.
import {
  analyzeMarketStructureCanonical,
  calculateATR,
  detectFVGs,
  detectLiquidityPools,
  detectSwingPoints,
  type Candle,
  type FairValueGap,
  type LiquidityPool,
} from "./smcAnalysis.ts";

export type IPODirection = "demand" | "supply";
export type IPOStatus =
  /** Price has not yet left the zone on the departure side, so no retest can count. */
  | "UNARMED_FOR_RETEST"
  | "ACTIVE" | "TESTED" | "BROKEN" | "FLIPPED";

/** No reason is currently emitted — see consolidationInterpretation. */
export type IPORejectionReason = "INSIDE_CONSOLIDATION";

/**
 * The teaching rule "an IPO cannot be inside consolidation" remains part of the
 * target model. The IMPLEMENTATION of it is retired.
 *
 * The predicate was "any buy-side pool above and any sell-side pool below",
 * which produced ranges of 5.35, 12.56 and 13.18 ATR with ZERO alternating
 * boundary interactions, and on GBP/CAD 2026-05-08 both boundaries had zero
 * touches inside the window — levels price was not interacting with at all.
 * That is not a width mis-setting; it is not a range by any setting.
 *
 * Until a defensible local-range definition exists, consolidation is measured
 * and reported but VETOES NOTHING. Affected candidates are therefore
 * structurally and candle-valid with consolidation UNRESOLVED — neither
 * confirmed IPOs nor rejected ones.
 */
export type ConsolidationInterpretation = "UNRESOLVED";

/**
 * PASS and FAIL exist for when a defensible local-range definition arrives.
 * Today the value is always UNRESOLVED: with the predicate retired we can
 * assert neither that a candidate IS in consolidation nor that it is NOT.
 */
export type ConsolidationStatus = "PASS" | "FAIL" | "UNRESOLVED";

/**
 * CANDIDATE_ACCEPTED means no open question was raised — NOT that the candidate
 * was proven clear of consolidation. CANDIDATE_UNRESOLVED means the retired
 * heuristic flagged something, so the candidate is neither confirmed nor
 * invalid and must be reported separately. Folding the two together would turn
 * the scorecard into "5/10 detected", which the evidence does not support.
 */
export type IPOResearchStatus = "CANDIDATE_ACCEPTED" | "CANDIDATE_UNRESOLVED" | "CANDIDATE_REJECTED";

export interface IPOGeometry {
  /** Edge price meets first: HIGH for demand, LOW for supply. */
  proximal: number;
  /** 50% of the candle's full wick range. Far edge of the tradeable half. */
  distal: number;
  /** Far wick. INVALIDATION level only — never a zone boundary. */
  extent: number;
  /** The drawn zone is the proximal half: [distal, proximal] or [proximal, distal]. */
  zoneLow: number;
  zoneHigh: number;
}

export interface IPOTest {
  entryIndex: number;
  entryDatetime: string;
  exitIndex: number | null;
  exitDatetime: string | null;
  barsInside: number;
  deepestPenetrationPercent: number;
}

export interface IPOZone {
  id: string;
  symbol: string;
  timeframe: string;
  direction: IPODirection;
  candleIndex: number;
  candleDatetime: string;
  candle: { open: number; high: number; low: number; close: number };
  geometry: IPOGeometry;
  structure: {
    confirmedByBreakIndex: number;
    confirmedByBreakDatetime: string;
    /** BOS | CHoCH when a policy event exists for this bar+direction, else null. */
    kind: string | null;
    /** false = the ledger has the close-through but no policy event was emitted. */
    hasPolicyEvent: boolean;
    breakType: string;
    significance: string;
    level: number;
    barsFromCandleToBreak: number;
  };
  selection: {
    departureStartIndex: number;
    departureStartDatetime: string;
    interveningCandlesSkipped: number;
    interveningDetail: Array<{ index: number; datetime: string; rangeAtr: number }>;
  };
  liquidity: {
    priorGrabIndex: number | null;
    priorGrabDatetime: string | null;
    grabSide: "high" | "low" | null;
    alignedWithDirection: boolean | null;
    ipoIsTheGrab: boolean;
    wickOnly: boolean | null;
    extremeExcursionAtr: number | null;
    closePenetrationAtr: number | null;
    poolsNearby: number;
  };
  consolidation: {
    insideConsolidation: boolean;
    rangeHigh: number | null;
    rangeLow: number | null;
    rangeAtr: number | null;
    equalHighPools: number;
    equalLowPools: number;
    reason: string;
  };
  departureFvg: {
    exists: boolean;
    datetime: string | null;
    high: number | null;
    low: number | null;
    sizeAtr: number | null;
    barsAfterCandle: number | null;
  };
  lifecycle: {
    status: IPOStatus;
    /** Bar at which price first left the zone on the departure side. */
    armedForRetestAtIndex: number | null;
    tests: IPOTest[];
    testCount: number;
    brokenAtIndex: number | null;
    brokenAtDatetime: string | null;
    flipRetests: IPOTest[];
    flipRetestCount: number;
  };
  atrAtCandle: number;
  /**
   * An IPO formed inside consolidation is not a valid IPO. Invalid candidates
   * are still RETURNED — as rejected, never as detections — so the shadow
   * report can show that a known box was found structurally and then refused
   * by the consolidation interpretation. Deleting them would make an
   * interpretation failure indistinguishable from a detection failure.
   */
  valid: boolean;
  rejectionReason: IPORejectionReason | null;
  /**
   * Always "UNRESOLVED". The descriptive consolidation profile is retained and
   * reported; it simply does not decide validity.
   */
  consolidationInterpretation: ConsolidationInterpretation;
  consolidationStatus: ConsolidationStatus;
  /** Output of the RETIRED predicate. Kept as a marker of an open question, never as a verdict. */
  consolidationFlagRaised: boolean;
  researchStatus: IPOResearchStatus;
}

export const DEFAULTS = {
  /**
   * How many candles may sit between the IPO and the start of the departure
   * move. The taught rule tolerates a small candle or two drifting before the
   * move proper; it does not tolerate an unbounded gap, which would let any
   * earlier candle be claimed as the origin.
   */
  maxInterveningCandles: 2,
  /**
   * An intervening candle must be SMALL. Without this, a full-bodied candle in
   * the move direction would be skipped over and the IPO pushed further back.
   */
  interveningMaxRangeAtr: 0.75,
  /** How far back to look for the IPO from the departure origin. */
  maxLookbackForIPO: 12,
  /** Window used for the prior-range liquidity reference, non-circular. */
  liquidityWindow: 10,
  /** Bars after the IPO in which a departure FVG is considered associated. */
  departureFvgWithinBars: 3,
  /** Horizon for lifecycle replay. */
  lifecycleHorizon: 200,
  /**
   * Canonical event-age cap. NULL = unbounded, which is the correct default for
   * research and reference analysis.
   *
   * The shadow structure engine uses 50 for live comparison, but the reference
   * boxes are March-May 2026 dailies being examined in September: every one of
   * them is far older than 50 bars, so a 50-bar cap silently suppressed the
   * very events this detector exists to confirm. A cap belongs to live use, not
   * to historical analysis.
   */
  maxEventAgeBars: null as number | null,
} as const;

// ─── small helpers ───────────────────────────────────────────────────────────

/** Does a bar's range intersect [lo, hi]? The bar-in-range helper. */
export function barInRange(bar: Candle, lo: number, hi: number): boolean {
  return bar.low <= hi && bar.high >= lo;
}

/** Frozen single-candle geometry. Restated nowhere else in this module. */
export function ipoGeometry(c: Candle, direction: IPODirection): IPOGeometry {
  const demand = direction === "demand";
  const proximal = demand ? c.high : c.low;
  const extent = demand ? c.low : c.high;
  const distal = (c.high + c.low) / 2;
  return {
    proximal, distal, extent,
    zoneLow: demand ? distal : proximal,
    zoneHigh: demand ? proximal : distal,
  };
}

/**
 * True ATR at index i, computed only from bars STRICTLY BEFORE i.
 *
 * The first version averaged high-low range, which is not ATR: it ignores gaps
 * entirely. Every metric here is labelled "...Atr" and interveningMaxRangeAtr
 * is compared against it, so a gap-heavy instrument would have been measured
 * against a denominator that understated real volatility — and crypto, which is
 * in the reference set, gaps.
 *
 * calculateATR uses true range and reads candles[i-1] for the previous close,
 * so slicing to [0, i) keeps it causal: the ATR for bar i never sees bar i.
 */
function atrAt(candles: Candle[], i: number): number {
  if (i <= 0) return 0;
  return calculateATR(candles.slice(0, i), 14);
}

const isUp = (c: Candle) => c.close >= c.open;

// ─── FVG through the proven sliced wrapper ───────────────────────────────────

/**
 * detectFVGs caps itself at the last 50 candles (FVG_RECENCY), so passing a long
 * series returns [] for anything historical — measured as 0 of 105 candidates on
 * a previous run, which read as "no FVG" when the scanner never looked.
 *
 * Slicing to <= 26 bars collapses its internal startIdx to 2 so the whole slice
 * is scanned. detectFVGs indexes the MIDDLE candle of the three and carries its
 * datetime, so results are mapped back BY DATETIME rather than by offset
 * arithmetic. No second FVG detector is written.
 */
export function fvgsNear(candles: Candle[], i: number): Array<FairValueGap & { absIndex: number }> {
  const s0 = Math.max(0, i - 5);
  const s1 = Math.min(candles.length, i + 21);
  const slice = candles.slice(s0, s1);
  if (slice.length < 3) return [];
  const found = detectFVGs(slice) ?? [];
  return found
    .map((f) => ({ ...f, absIndex: candles.findIndex((c) => c.datetime === f.datetime) }))
    .filter((f) => f.absIndex >= 0);
}

// ─── candle selection ────────────────────────────────────────────────────────

export interface IPOSelection {
  index: number;
  departureStartIndex: number;
  interveningSkipped: number;
  intervening: Array<{ index: number; datetime: string; rangeAtr: number }>;
}

/**
 * The last opposite-coloured candle before the departure move.
 *
 * Opposite means opposite to the MOVE: a down candle before an up move gives a
 * demand IPO, an up candle before a down move gives a supply IPO.
 *
 * Intervening tolerance: candles in the move's own direction may sit between
 * the IPO and the departure start, but only a bounded number and only while
 * each is small. A full-bodied move-direction candle terminates the walk,
 * because at that point the move has already begun and anything earlier is not
 * "the candle before the move".
 */
export function selectIPOCandle(
  candles: Candle[],
  departureStartIndex: number,
  direction: IPODirection,
  opts: { maxIntervening?: number; interveningMaxRangeAtr?: number; maxLookback?: number } = {},
): IPOSelection | null {
  const maxInt = opts.maxIntervening ?? DEFAULTS.maxInterveningCandles;
  const maxRange = opts.interveningMaxRangeAtr ?? DEFAULTS.interveningMaxRangeAtr;
  const maxBack = opts.maxLookback ?? DEFAULTS.maxLookbackForIPO;
  // demand IPO is a DOWN candle; supply IPO is an UP candle
  const wantUp = direction === "supply";

  const intervening: Array<{ index: number; datetime: string; rangeAtr: number }> = [];
  for (let i = departureStartIndex; i >= Math.max(0, departureStartIndex - maxBack); i--) {
    const c = candles[i];
    if (!c) break;
    // The departure bar itself is the move, by definition, so it cannot count
    // against the intervening budget. It CAN still be the IPO: when the move
    // begins from an extreme, that extreme bar is frequently the opposite
    // colour and is the candle wanted. Charging it as "intervening" made every
    // such case fail to select at all.
    if (i === departureStartIndex && isUp(c) !== wantUp) continue;
    if (isUp(c) === wantUp) {
      return {
        index: i,
        departureStartIndex,
        interveningSkipped: intervening.length,
        intervening: [...intervening].reverse(),
      };
    }
    // Same colour as the move. Tolerate it only if small and within budget.
    const a = atrAt(candles, i) || 1;
    const rangeAtr = (c.high - c.low) / a;
    if (intervening.length >= maxInt || rangeAtr > maxRange) return null;
    intervening.push({ index: i, datetime: c.datetime, rangeAtr: Math.round(rangeAtr * 100) / 100 });
  }
  return null;
}

// ─── consolidation predicate ─────────────────────────────────────────────────

/**
 * Is the candidate sitting inside a consolidation?
 *
 * Built on detectLiquidityPools rather than a new range detector: a pool is
 * already a cluster of equal highs or equal lows within an ATR tolerance, which
 * is exactly the evidence of a range. A candidate is "inside consolidation"
 * when its own range is contained by both an overhead high pool and an
 * underlying low pool — price boxed in on both sides.
 */
export function assessConsolidation(
  candles: Candle[],
  i: number,
): IPOZone["consolidation"] {
  // CAUSAL. Pools are derived from candles[0..i] only. Passing the full series
  // would classify a historical IPO using equal highs and lows that formed
  // AFTER it — the candidate would be judged by information no one had at the
  // time, which is the lookahead this whole engine exists to avoid.
  const pools: LiquidityPool[] = detectLiquidityPools(candles.slice(0, i + 1));
  const c = candles[i];
  const a = atrAt(candles, i) || 1;
  // LiquidityPool.type is "buy-side" | "sell-side", NOT "high" | "low". The
  // first version filtered on "high"/"low", matched nothing, and so reported
  // insideConsolidation=false for every candle — a silent always-false
  // predicate that would have looked like a real finding.
  //
  //   buy-side  = resting buy stops ABOVE equal highs  (built from swing highs)
  //   sell-side = resting sell stops BELOW equal lows  (built from swing lows)
  const above = pools.filter((p) => p.type === "buy-side" && p.price >= c.high);
  const below = pools.filter((p) => p.type === "sell-side" && p.price <= c.low);
  const nearestAbove = above.length ? Math.min(...above.map((p) => p.price)) : null;
  const nearestBelow = below.length ? Math.max(...below.map((p) => p.price)) : null;
  const boxed = nearestAbove !== null && nearestBelow !== null;
  const rangeAtr = boxed ? (nearestAbove! - nearestBelow!) / a : null;
  return {
    insideConsolidation: boxed,
    rangeHigh: nearestAbove,
    rangeLow: nearestBelow,
    rangeAtr: rangeAtr === null ? null : Math.round(rangeAtr * 100) / 100,
    equalHighPools: above.length,
    equalLowPools: below.length,
    reason: boxed
      ? `bounded by an equal-high pool above and an equal-low pool below`
      : nearestAbove !== null
        ? "only an overhead pool — not boxed in"
        : nearestBelow !== null
          ? "only an underlying pool — not boxed in"
          : "no bounding pools",
  };
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

/**
 * Distinct-visit test counting, far-edge invalidation and flip retests.
 *
 * TESTS ARE VISITS, NOT BARS. The existing ob.touches counter increments once
 * per bar inside the zone, so three bars inside reads as three touches. Here a
 * test opens when price enters the drawn proximal-half zone from outside and
 * closes when it leaves; three bars inside is ONE test. Repeated tests do not
 * invalidate anything.
 *
 * INVALIDATION IS A SINGLE FULL CLOSE BEYOND EXTENT. A wick through never
 * invalidates, and no consecutive-close requirement is imposed — the existing
 * V2 lifecycle demands two consecutive body closes, which is a different rule
 * and is not used here.
 *
 * FLIP IS GATED ON BROKEN. Only once the zone is BROKEN is it evaluated as a
 * flipped retest zone: a broken demand becomes resistance approached from
 * below, a broken supply becomes support approached from above. Legacy
 * "mitigated" semantics never decide this.
 */
export function trackIPOLifecycle(
  candles: Candle[],
  fromIndex: number,
  direction: IPODirection,
  g: IPOGeometry,
  horizon: number = DEFAULTS.lifecycleHorizon,
): IPOZone["lifecycle"] {
  const demand = direction === "demand";
  const tests: IPOTest[] = [];
  const flipRetests: IPOTest[] = [];
  let open: IPOTest | null = null;
  let brokenAt: number | null = null;
  let status: IPOStatus = "UNARMED_FOR_RETEST";
  const height = Math.abs(g.proximal - g.distal) || 1;

  // A TEST IS A RETURN, NOT THE DEPARTURE. Replay begins at fromIndex + 1, and
  // the first bars of the departure move routinely still overlap the zone; the
  // previous version counted those as test #1, so a zone was "tested" by the
  // very move that created it.
  //
  // The zone therefore starts UNARMED. It arms only once price has left
  // entirely on the DEPARTURE side — fully above the zone for a demand IPO,
  // fully below for a supply IPO. Leaving on the extent side does not arm it;
  // that is price heading toward invalidation, not departing.
  //
  // Far-edge invalidation stays live throughout, armed or not.
  let armedAt: number | null = null;
  const leftOnDepartureSide = (b: Candle) =>
    demand ? b.low > g.zoneHigh : b.high < g.zoneLow;

  const end = Math.min(candles.length - 1, fromIndex + horizon);
  for (let j = fromIndex + 1; j <= end; j++) {
    const b = candles[j];

    if (brokenAt === null) {
      // A single CLOSE fully beyond extent invalidates. Wicks do not.
      const closedBeyond = demand ? b.close < g.extent : b.close > g.extent;
      if (closedBeyond) {
        if (open) {
          open.exitIndex = j; open.exitDatetime = b.datetime;
          open.barsInside = j - open.entryIndex;
          tests.push(open); open = null;
        }
        brokenAt = j; status = "BROKEN";
        continue;
      }
      if (armedAt === null) {
        if (leftOnDepartureSide(b)) { armedAt = j; status = "ACTIVE"; }
        continue;                       // nothing before arming can be a test
      }
      const inside = barInRange(b, g.zoneLow, g.zoneHigh);
      if (inside && !open) {
        open = {
          entryIndex: j, entryDatetime: b.datetime,
          exitIndex: null, exitDatetime: null, barsInside: 1,
          deepestPenetrationPercent: 0,
        };
      }
      if (inside && open) {
        const deepest = demand ? b.low : b.high;
        const pen = Math.max(0, Math.min(100, (Math.abs(g.proximal - deepest) / height) * 100));
        if (pen > open.deepestPenetrationPercent) open.deepestPenetrationPercent = Math.round(pen);
        open.barsInside = j - open.entryIndex + 1;
      }
      if (!inside && open) {
        open.exitIndex = j; open.exitDatetime = b.datetime;
        tests.push(open); open = null;
        status = "TESTED";
      }
    } else {
      // Flip phase. Approach side is inverted: a broken demand is resistance.
      const inside = barInRange(b, g.zoneLow, g.zoneHigh);
      if (inside && !open) {
        open = {
          entryIndex: j, entryDatetime: b.datetime,
          exitIndex: null, exitDatetime: null, barsInside: 1,
          deepestPenetrationPercent: 0,
        };
      } else if (inside && open) {
        open.barsInside = j - open.entryIndex + 1;
      } else if (!inside && open) {
        open.exitIndex = j; open.exitDatetime = b.datetime;
        flipRetests.push(open); open = null;
        status = "FLIPPED";
      }
    }
  }
  if (open) (brokenAt === null ? tests : flipRetests).push(open);
  if (brokenAt === null && tests.length > 0 && status === "ACTIVE") status = "TESTED";
  // A flip retest still open at the end of the data is a flip retest. Requiring
  // it to have CLOSED before reporting FLIPPED would misreport the most recent
  // and most actionable case as merely BROKEN.
  if (flipRetests.length > 0) status = "FLIPPED";

  return {
    status,
    armedForRetestAtIndex: armedAt,
    tests, testCount: tests.length,
    brokenAtIndex: brokenAt,
    brokenAtDatetime: brokenAt === null ? null : candles[brokenAt].datetime,
    flipRetests, flipRetestCount: flipRetests.length,
  };
}

// ─── detector ────────────────────────────────────────────────────────────────

export interface DetectIPOOptions {
  symbol?: string;
  timeframe?: string;
  maxIntervening?: number;
  interveningMaxRangeAtr?: number;
  maxLookback?: number;
  liquidityWindow?: number;
  lifecycleHorizon?: number;
  /** Caps the RETURNED detail rows only. Never affects any statistic. */
  detailCap?: number;
  /** null (default) = unbounded. Pass 50 only to mirror live shadow behaviour. */
  maxEventAgeBars?: number | null;
}

/**
 * SHADOW ONLY. No production consumer calls this.
 *
 * Anchored on canonical structure: every causal close-through break is a
 * candidate confirmation, the departure move that caused it is located, and the
 * single opposite-coloured candle before that move is the IPO.
 */
export interface IPOCandidates {
  /** Structurally and candle-valid. Split further by researchStatus. */
  valid: IPOZone[];
  /** Refused outright. Currently always empty — the consolidation veto is retired. */
  rejected: IPOZone[];
  /** No open question raised. */
  accepted: IPOZone[];
  /** The retired heuristic flagged consolidation: neither confirmed nor invalid. */
  unresolved: IPOZone[];
}

/**
 * Valid IPOs only. A candidate refused by interpretation — currently
 * INSIDE_CONSOLIDATION — is not returned here and must never be counted as a
 * detection. Use detectIPOCandidates() to inspect the refusals.
 */
export function detectIPOZones(candles: Candle[], opts: DetectIPOOptions = {}): IPOZone[] {
  return detectIPOCandidates(candles, opts).valid;
}

/** Valid and rejected candidates, kept separate. */
export function detectIPOCandidates(candles: Candle[], opts: DetectIPOOptions = {}): IPOCandidates {
  const all = detectAllIPOCandidates(candles, opts);
  const valid = all.filter((z) => z.valid);
  return {
    valid, rejected: all.filter((z) => !z.valid),
    accepted: valid.filter((z) => z.researchStatus === "CANDIDATE_ACCEPTED"),
    unresolved: valid.filter((z) => z.researchStatus === "CANDIDATE_UNRESOLVED"),
  };
}

function detectAllIPOCandidates(candles: Candle[], opts: DetectIPOOptions = {}): IPOZone[] {
  const symbol = opts.symbol ?? "?";
  const timeframe = opts.timeframe ?? "?";
  const W = opts.liquidityWindow ?? DEFAULTS.liquidityWindow;
  if (candles.length < 40) return [];

  const canon = analyzeMarketStructureCanonical(candles, {
    policy: "latest_unbroken_structural",
    // Unbounded by default — see DEFAULTS.maxEventAgeBars.
    maxEventAgeBars: opts.maxEventAgeBars === undefined
      ? DEFAULTS.maxEventAgeBars : opts.maxEventAgeBars,
  });
  // FACTUAL LEDGER IS THE GATE, POLICY EVENTS ARE ENRICHMENT.
  //
  // The teaching requirement is an eventual candle-close break of structure.
  // That fact lives in canon.swingLevelBreaks, which records EVERY confirmed
  // swing level's causal first close-through. canon.bos / canon.choch are a
  // POLICY VIEW of that ledger: the latest-pointer rule emits one event per
  // direction per bar and files the rest under alsoBrokenLevels. Measured
  // earlier, 39-47% of factual close-throughs produce no policy event at all.
  //
  // Gating on bos/choch would therefore have discarded roughly four in ten real
  // close-throughs before the IPO rule ever saw them. The ledger decides
  // whether the fact exists; BOS/CHoCH only classify it when a matching event
  // happens to be present.
  const policyEvents = [
    ...canon.bos.map((b: any) => ({ ...b, kind: "BOS" })),
    ...canon.choch.map((c: any) => ({ ...c, kind: "CHoCH" })),
  ];
  const policyAt = new Map<string, any>();
  for (const e of policyEvents) policyAt.set(`${e.index}|${e.type}`, e);

  // Several swing levels can break on one candle. Keep one confirmation per
  // (bar, direction), preferring EXTERNAL and then the most extreme level, so
  // the same departure is not evaluated repeatedly under different levels.
  const byBarDir = new Map<string, any>();
  for (const lb of (canon.swingLevelBreaks as any[])) {
    const k = `${lb.index}|${lb.direction}`;
    const cur = byBarDir.get(k);
    if (!cur) { byBarDir.set(k, lb); continue; }
    const better =
      (lb.significance === "external" && cur.significance !== "external") ||
      (lb.significance === cur.significance &&
        (lb.direction === "bullish" ? lb.level > cur.level : lb.level < cur.level));
    if (better) byBarDir.set(k, lb);
  }
  const events = [...byBarDir.values()].sort((a, b) => a.index - b.index);

  const zones: IPOZone[] = [];
  const seen = new Set<string>();

  for (const ev of events) {
    const bullish = ev.direction === "bullish";
    const policy = policyAt.get(`${ev.index}|${ev.direction}`) ?? null;
    const direction: IPODirection = bullish ? "demand" : "supply";
    const j = ev.index;
    const swingIdx = ev.swingIndex ?? Math.max(0, j - 10);

    // The departure move: from the extreme it began at, to the breaking bar.
    let originIdx = swingIdx;
    for (let k = swingIdx; k <= j; k++) {
      if (!candles[k]) continue;
      if (bullish ? candles[k].low <= candles[originIdx].low
                  : candles[k].high >= candles[originIdx].high) originIdx = k;
    }

    const sel = selectIPOCandle(candles, originIdx, direction, {
      maxIntervening: opts.maxIntervening,
      interveningMaxRangeAtr: opts.interveningMaxRangeAtr,
      maxLookback: opts.maxLookback,
    });
    if (!sel) continue;

    const i = sel.index;
    const key = `${direction}|${i}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const c = candles[i];
    const a = atrAt(candles, i) || 1;
    const g = ipoGeometry(c, direction);

    // Liquidity context, non-circular prior range. The IPO is NOT required to
    // be the grab; ipoIsTheGrab records whether it happened to be.
    const pS = i - 2 * W, pE = i - W - 1;
    let grabIdx = -1, grabSide: "high" | "low" | null = null;
    let exc: number | null = null, pen: number | null = null, wickOnly: boolean | null = null;
    if (pS >= 0) {
      let phi = -Infinity, plo = Infinity;
      for (let k = pS; k <= pE; k++) {
        if (candles[k].high > phi) phi = candles[k].high;
        if (candles[k].low < plo) plo = candles[k].low;
      }
      let ai = -1, bi = -1;
      for (let k = i - W; k <= i; k++) {
        if (k < 0) continue;
        if (candles[k].high > phi) ai = k;
        if (candles[k].low < plo) bi = k;
      }
      grabIdx = Math.max(ai, bi);
      if (grabIdx >= 0) {
        grabSide = grabIdx === ai ? "high" : "low";
        const gb = candles[grabIdx];
        const e = Math.max(0, grabSide === "high" ? gb.high - phi : plo - gb.low) / a;
        const p = Math.max(0, grabSide === "high" ? gb.close - phi : plo - gb.close) / a;
        exc = Math.round(e * 100) / 100;
        pen = Math.round(p * 100) / 100;
        wickOnly = p <= 0;
      }
    }

    const nearFvgs = fvgsNear(candles, i)
      .filter((f) => f.type === (bullish ? "bullish" : "bearish"))
      .filter((f) => f.absIndex >= i && f.absIndex <= i + DEFAULTS.departureFvgWithinBars)
      .sort((x, y) => x.absIndex - y.absIndex);
    const fvg = nearFvgs[0] ?? null;

    // Consolidation is MEASURED but does not veto. The previous predicate was
    // semantically invalid, so enforcing it discarded structurally sound
    // candidates on evidence that did not support the conclusion.
    const con = assessConsolidation(candles, i);
    const rejectionReason: IPORejectionReason | null = null;

    zones.push({
      id: `${symbol}|${timeframe}|${direction}|${c.datetime}`,
      symbol, timeframe, direction,
      candleIndex: i, candleDatetime: c.datetime,
      candle: { open: c.open, high: c.high, low: c.low, close: c.close },
      geometry: g,
      structure: {
        confirmedByBreakIndex: j,
        confirmedByBreakDatetime: ev.datetime,
        // null when the ledger recorded the close-through but the policy view
        // filed it under alsoBrokenLevels instead of emitting an event.
        kind: policy ? policy.kind : null,
        hasPolicyEvent: !!policy,
        breakType: ev.direction,
        significance: ev.significance, level: ev.level,
        barsFromCandleToBreak: j - i,
      },
      selection: {
        departureStartIndex: originIdx,
        departureStartDatetime: candles[originIdx].datetime,
        interveningCandlesSkipped: sel.interveningSkipped,
        interveningDetail: sel.intervening,
      },
      liquidity: {
        priorGrabIndex: grabIdx < 0 ? null : grabIdx,
        priorGrabDatetime: grabIdx < 0 ? null : candles[grabIdx].datetime,
        grabSide,
        alignedWithDirection: grabSide === null ? null
          : (direction === "demand" ? grabSide === "low" : grabSide === "high"),
        ipoIsTheGrab: grabIdx === i,
        wickOnly,
        extremeExcursionAtr: exc,
        closePenetrationAtr: pen,
        poolsNearby: con.equalHighPools + con.equalLowPools,
      },
      consolidation: con,
      departureFvg: {
        exists: !!fvg,
        datetime: fvg?.datetime ?? null,
        high: fvg?.high ?? null,
        low: fvg?.low ?? null,
        sizeAtr: fvg ? Math.round(((fvg.high - fvg.low) / a) * 100) / 100 : null,
        barsAfterCandle: fvg ? fvg.absIndex - i : null,
      },
      lifecycle: trackIPOLifecycle(candles, i, direction, g, opts.lifecycleHorizon),
      atrAtCandle: Math.round(a * 1e5) / 1e5,
      valid: rejectionReason === null,
      rejectionReason,
      consolidationInterpretation: "UNRESOLVED",
      consolidationStatus: "UNRESOLVED",
      consolidationFlagRaised: con.insideConsolidation,
      researchStatus: con.insideConsolidation ? "CANDIDATE_UNRESOLVED" : "CANDIDATE_ACCEPTED",
    });
  }
  return zones;
}

/**
 * HTF -> LTF refinement.
 *
 * Deliberately mirrors the containment approach already used by the cascade
 * engine rather than importing it: cascadeZoneEngine and impulseZoneEngine both
 * run findImpulseLeg over analyzeMarketStructure, the defective pairwise engine,
 * so importing them would drag that timing back in through the side door. The
 * scaffolding idea is reused; the inner detector is the IPO one.
 *
 * Returns child IPOs whose drawn zone is FULLY CONTAINED by the parent's drawn
 * zone. Overlap is not sufficient: a child straddling the parent boundary is
 * partly outside the HTF zone, so entering on it would place risk beyond the
 * level the parent defines. Containment is the refinement relation; overlap is
 * merely proximity.
 */
export function refineIPOToLowerTimeframe(
  parent: IPOZone,
  ltfCandles: Candle[],
  opts: DetectIPOOptions = {},
): IPOZone[] {
  if (ltfCandles.length < 40) return [];
  const children = detectIPOZones(ltfCandles, { ...opts, timeframe: opts.timeframe ?? "LTF" });
  return children.filter((ch) =>
    ch.direction === parent.direction &&
    ch.geometry.zoneLow >= parent.geometry.zoneLow &&
    ch.geometry.zoneHigh <= parent.geometry.zoneHigh
  );
}

// ─── Phase A: failure tracing ────────────────────────────────────────────────
//
// READ-ONLY. Explains why a known candle did or did not become a candidate.
// It does not alter detectIPOZones — it re-walks the same logic and narrates
// each decision, so a "not found" can be attributed to a specific step rather
// than guessed at.

export type IPOTerminalReason =
  | "NO_DIRECTIONAL_LEDGER_BREAK"
  | "ORIGIN_AFTER_KNOWN_CANDLE"
  | "ORIGIN_BEFORE_KNOWN_CANDLE"
  | "KNOWN_CANDLE_NOT_REACHED"
  | "INTERVENING_COUNT_EXCEEDED"
  | "INTERVENING_RANGE_EXCEEDED"
  | "LOOKBACK_EXCEEDED"
  | "OTHER_OPPOSITE_CANDLE_SELECTED"
  | "DEDUPED"
  | "CANDIDATE_CONSTRUCTED";

export function traceIPOCandidateFailure(
  candles: Candle[],
  knownDate: string,
  direction: IPODirection,
  opts: DetectIPOOptions = {},
) {
  const ki = candles.findIndex((c) => c.datetime.slice(0, 10) === knownDate.slice(0, 10));
  if (ki < 0) return { knownDate, direction, error: "candle not in series" };

  const kc = candles[ki];
  const wantDir = direction === "demand" ? "bullish" : "bearish";
  const wantUp = direction === "supply";            // the IPO's own colour
  const maxInt = opts.maxIntervening ?? DEFAULTS.maxInterveningCandles;
  const maxRange = opts.interveningMaxRangeAtr ?? DEFAULTS.interveningMaxRangeAtr;
  const maxBack = opts.maxLookback ?? DEFAULTS.maxLookbackForIPO;

  const canon = analyzeMarketStructureCanonical(candles, {
    policy: "latest_unbroken_structural",
    maxEventAgeBars: opts.maxEventAgeBars === undefined
      ? DEFAULTS.maxEventAgeBars : opts.maxEventAgeBars,
  });
  const policyKeys = new Set(
    [...canon.bos, ...canon.choch].map((e: any) => `${e.index}|${e.type}`),
  );

  // Section 2 — the factual ledger, reported BEFORE any selection rule is
  // applied, so a structure-association failure is visible on its own terms.
  const ledger = (canon.swingLevelBreaks as any[])
    .filter((l) => l.direction === wantDir && l.index > ki)
    .sort((a, b) => a.index - b.index)
    .map((l) => ({
      breakIndex: l.index, breakDate: String(l.datetime).slice(0, 10),
      level: l.level, significance: l.significance,
      swingIndex: l.swingIndex, swingDate: String(l.swingTime ?? "").slice(0, 10),
      barsFromKnownCandle: l.index - ki,
      hasPolicyEvent: policyKeys.has(`${l.index}|${l.direction}`),
    }));

  // The detector keeps ONE ledger break per (bar, direction); note which
  // survive, because a break removed here never reaches selection at all.
  const kept = new Map<string, any>();
  for (const l of (canon.swingLevelBreaks as any[])) {
    const k = `${l.index}|${l.direction}`;
    const cur = kept.get(k);
    if (!cur) { kept.set(k, l); continue; }
    const better = (l.significance === "external" && cur.significance !== "external") ||
      (l.significance === cur.significance &&
        (l.direction === "bullish" ? l.level > cur.level : l.level < cur.level));
    if (better) kept.set(k, l);
  }

  const perBreak: any[] = [];
  let best: IPOTerminalReason = "NO_DIRECTIONAL_LEDGER_BREAK";
  const rank: IPOTerminalReason[] = [
    "NO_DIRECTIONAL_LEDGER_BREAK", "ORIGIN_AFTER_KNOWN_CANDLE", "DEDUPED",
    "LOOKBACK_EXCEEDED", "KNOWN_CANDLE_NOT_REACHED", "INTERVENING_RANGE_EXCEEDED",
    "INTERVENING_COUNT_EXCEEDED", "ORIGIN_BEFORE_KNOWN_CANDLE",
    "OTHER_OPPOSITE_CANDLE_SELECTED", "CANDIDATE_CONSTRUCTED",
  ];
  const promote = (r: IPOTerminalReason) => {
    if (rank.indexOf(r) > rank.indexOf(best)) best = r;
  };

  for (const l of ledger) {
    const survived = kept.get(`${l.breakIndex}|${wantDir}`)?.level === l.level;
    // Section 3 — the departure origin, computed exactly as the detector does.
    const swingIdx = l.swingIndex ?? Math.max(0, l.breakIndex - 10);
    let originIdx = swingIdx;
    for (let k = swingIdx; k <= l.breakIndex; k++) {
      if (!candles[k]) continue;
      if (wantDir === "bullish"
        ? candles[k].low <= candles[originIdx].low
        : candles[k].high >= candles[originIdx].high) originIdx = k;
    }
    const inLookback = ki >= originIdx - maxBack && ki <= originIdx;

    // Section 4 — narrate the walk, one line per inspected candle.
    const walk: any[] = [];
    let terminal: IPOTerminalReason;
    let selectedIndex: number | null = null;
    if (originIdx < ki) {
      terminal = "ORIGIN_BEFORE_KNOWN_CANDLE";
    } else {
      let intervening = 0;
      terminal = "KNOWN_CANDLE_NOT_REACHED";
      for (let i = originIdx; i >= Math.max(0, originIdx - maxBack); i--) {
        const c = candles[i];
        if (!c) break;
        const a = atrAt(candles, i) || 1;
        const rangeAtr = Math.round(((c.high - c.low) / a) * 100) / 100;
        const colour = isUp(c) ? "up" : "down";
        const isIpoColour = isUp(c) === wantUp;
        if (i === originIdx && !isIpoColour) {
          walk.push({ index: i, date: c.datetime.slice(0, 10), colour, expectedIpoColour: wantUp ? "up" : "down",
                      rangeAtr, classified: "departure (exempt)", interveningCount: intervening });
          continue;
        }
        if (isIpoColour) {
          selectedIndex = i;
          walk.push({ index: i, date: c.datetime.slice(0, 10), colour, expectedIpoColour: wantUp ? "up" : "down",
                      rangeAtr, classified: "IPO selected", interveningCount: intervening });
          terminal = i === ki ? "CANDIDATE_CONSTRUCTED" : "OTHER_OPPOSITE_CANDLE_SELECTED";
          break;
        }
        if (intervening >= maxInt) {
          walk.push({ index: i, date: c.datetime.slice(0, 10), colour, expectedIpoColour: wantUp ? "up" : "down",
                      rangeAtr, classified: "terminating (intervening budget spent)", interveningCount: intervening });
          terminal = "INTERVENING_COUNT_EXCEEDED"; break;
        }
        if (rangeAtr > maxRange) {
          walk.push({ index: i, date: c.datetime.slice(0, 10), colour, expectedIpoColour: wantUp ? "up" : "down",
                      rangeAtr, classified: `terminating (range ${rangeAtr} > ${maxRange})`, interveningCount: intervening });
          terminal = "INTERVENING_RANGE_EXCEEDED"; break;
        }
        intervening++;
        walk.push({ index: i, date: c.datetime.slice(0, 10), colour, expectedIpoColour: wantUp ? "up" : "down",
                    rangeAtr, classified: "intervening (skipped)", interveningCount: intervening });
      }
      if (terminal === "KNOWN_CANDLE_NOT_REACHED" && !inLookback) terminal = "LOOKBACK_EXCEEDED";
    }
    if (terminal === "CANDIDATE_CONSTRUCTED" && !survived) terminal = "DEDUPED";
    promote(terminal);
    perBreak.push({
      ledgerBreak: l, survivedLedgerDedup: survived,
      origin: {
        index: originIdx, date: candles[originIdx]?.datetime?.slice(0, 10) ?? null,
        ohlc: candles[originIdx]
          ? { o: candles[originIdx].open, h: candles[originIdx].high,
              l: candles[originIdx].low, c: candles[originIdx].close } : null,
        whySelected: wantDir === "bullish"
          ? "lowest low between the broken swing and the break bar"
          : "highest high between the broken swing and the break bar",
        barsFromKnownCandle: originIdx - ki,
        knownCandleWithinMaxLookback: inLookback,
      },
      selectionWalk: walk,
      selectedIndex,
      selectedDate: selectedIndex === null ? null : candles[selectedIndex].datetime.slice(0, 10),
      terminalReason: terminal,
    });
  }

  // Counterfactual: is there ANY origin from which the walk would have chosen
  // the known candle? This separates "the rule cannot pick it" from "the origin
  // we computed pointed somewhere else".
  let reachableFrom: number[] = [];
  for (let o = ki; o <= Math.min(candles.length - 1, ki + maxBack); o++) {
    let intervening = 0, picked: number | null = null;
    for (let i = o; i >= Math.max(0, o - maxBack); i--) {
      const c = candles[i]; if (!c) break;
      if (i === o && isUp(c) !== wantUp) continue;
      if (isUp(c) === wantUp) { picked = i; break; }
      const a = atrAt(candles, i) || 1;
      if (intervening >= maxInt || (c.high - c.low) / a > maxRange) break;
      intervening++;
    }
    if (picked === ki) reachableFrom.push(o);
  }

  return {
    knownDate, direction,
    knownCandle: {
      index: ki, datetime: kc.datetime,
      ohlc: { o: kc.open, h: kc.high, l: kc.low, c: kc.close },
      colour: isUp(kc) ? "up" : "down",
      geometry: ipoGeometry(kc, direction),
    },
    directionalLedgerBreaks: ledger.length,
    ledger: ledger.slice(0, 12),
    perBreak: perBreak.slice(0, 12),
    terminalReason: best,
    couldBeSelectedFromOtherOrigin: reachableFrom.length > 0,
    originsThatWouldSelectIt: reachableFrom.map((o) => ({
      index: o, date: candles[o].datetime.slice(0, 10),
    })),
  };
}

// ─── Phase B: local consolidation research ───────────────────────────────────
//
// DESCRIPTIVE. Measures the local ranging condition around a candidate WITHOUT
// deciding validity. None of these becomes a gate here.
//
// The current predicate — any buy-side pool above plus any sell-side pool below
// — produced "consolidations" of 5.35, 12.56 and 13.18 ATR, which are whole
// swings rather than local ranges. It has no width, recency or containment
// requirement. These metrics exist to show what such a requirement would need
// to key on, measured only from information available at the candidate.
export function analyzeLocalConsolidation(candles: Candle[], i: number, lookback = 30) {
  const hist = candles.slice(0, i + 1);           // causal
  const c = candles[i];
  const a = atrAt(candles, i) || 1;
  const pools = detectLiquidityPools(hist);
  const buy = pools.filter((p) => p.type === "buy-side" && p.price >= c.high);
  const sell = pools.filter((p) => p.type === "sell-side" && p.price <= c.low);
  const hi = buy.length ? Math.min(...buy.map((p) => p.price)) : null;
  const lo = sell.length ? Math.max(...sell.map((p) => p.price)) : null;

  const tol = a * 0.2;
  const touchesOf = (price: number, side: "high" | "low") => {
    const idx: number[] = [];
    for (let k = Math.max(0, i - lookback); k <= i; k++) {
      const v = side === "high" ? hist[k].high : hist[k].low;
      if (Math.abs(v - price) <= tol) idx.push(k);
    }
    return idx;
  };
  const hiTouch = hi === null ? [] : touchesOf(hi, "high");
  const loTouch = lo === null ? [] : touchesOf(lo, "low");

  const start = Math.max(0, i - lookback);
  const win = hist.slice(start, i + 1);
  let contained = 0, closesOutside = 0, bodyOverlaps = 0, alternations = 0;
  let lastSide: "hi" | "lo" | null = null;
  if (hi !== null && lo !== null) {
    for (let k = 0; k < win.length; k++) {
      const b = win[k];
      if (b.high <= hi && b.low >= lo) contained++;
      if (b.close > hi || b.close < lo) closesOutside++;
      const nearHi = Math.abs(b.high - hi) <= tol;
      const nearLo = Math.abs(b.low - lo) <= tol;
      if (nearHi && lastSide !== "hi") { if (lastSide !== null) alternations++; lastSide = "hi"; }
      else if (nearLo && lastSide !== "lo") { if (lastSide !== null) alternations++; lastSide = "lo"; }
      if (k > 0) {
        const p = win[k - 1];
        const aHi = Math.max(b.open, b.close), aLo = Math.min(b.open, b.close);
        const pHi = Math.max(p.open, p.close), pLo = Math.min(p.open, p.close);
        if (aLo <= pHi && aHi >= pLo) bodyOverlaps++;
      }
    }
  }
  const r2 = (x: number | null) => x === null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
  const drift = win.length > 1 ? (win[win.length - 1].close - win[0].close) / a : null;

  return {
    index: i, date: c.datetime.slice(0, 10), atr: Math.round(a * 1e5) / 1e5,
    lookbackBars: lookback,
    nearestEqualHighCluster: hi === null ? null : {
      price: hi, touches: hiTouch.length,
      firstTouchDate: hiTouch.length ? hist[hiTouch[0]].datetime.slice(0, 10) : null,
      lastTouchDate: hiTouch.length ? hist[hiTouch[hiTouch.length - 1]].datetime.slice(0, 10) : null,
      barsBetweenFirstAndLastTouch: hiTouch.length ? hiTouch[hiTouch.length - 1] - hiTouch[0] : null,
      ageBarsFromIPO: hiTouch.length ? i - hiTouch[hiTouch.length - 1] : null,
    },
    nearestEqualLowCluster: lo === null ? null : {
      price: lo, touches: loTouch.length,
      firstTouchDate: loTouch.length ? hist[loTouch[0]].datetime.slice(0, 10) : null,
      lastTouchDate: loTouch.length ? hist[loTouch[loTouch.length - 1]].datetime.slice(0, 10) : null,
      barsBetweenFirstAndLastTouch: loTouch.length ? loTouch[loTouch.length - 1] - loTouch[0] : null,
      ageBarsFromIPO: loTouch.length ? i - loTouch[loTouch.length - 1] : null,
    },
    rangeWidthAtr: hi !== null && lo !== null ? r2((hi - lo) / a) : null,
    percentRecentCandlesContained: hi !== null && lo !== null && win.length
      ? r2((contained / win.length) * 100) : null,
    alternatingBoundaryInteractions: hi !== null && lo !== null ? alternations : null,
    closesOutsideRange: hi !== null && lo !== null ? closesOutside : null,
    directionalDriftAtr: r2(drift),
    recentBodyOverlapPercent: win.length > 1 ? r2((bodyOverlaps / (win.length - 1)) * 100) : null,
    ipoInsideLocalRange: hi !== null && lo !== null ? (c.high <= hi && c.low >= lo) : null,
    currentPredicateWouldReject: hi !== null && lo !== null,
  };
}

// ─── departure-origin hypotheses (read-only research) ────────────────────────
//
// The current origin — the absolute extreme between the broken swing and the
// break bar — is retired from research. Phase A showed all five known misses
// share one cause: that origin drifts with the AGE OF THE SWING EVENTUALLY
// BROKEN rather than tracking where the move launched. On BTC 2020-05-11 the
// broken swing dates to 2020-02-24, so the "lowest low in the span" is the
// March crash low, 59 bars from the candle wanted. Four of five origins landed
// BEHIND the known candle, which a backward walk can never recover from.
//
// Crucially, selectIPOCandle() itself is sound: all five known candles are
// selectable given an appropriate origin. So nothing about the selector, the
// intervening budget or the lookback is touched here. Only the anchor changes.
//
// Hypotheses measured, never applied:
//   ABSOLUTE_EXTREME  the failed baseline, kept for comparison
//   INTERNAL_SWING    most recent causally-confirmed opposing internal swing
//   EXTERNAL_SWING    the same at external significance
//
// The pivot bar is NOT assumed to be the IPO. AUD/USD 2026-03-19 sits AFTER the
// local extreme, so each anchor is tested from pivot, +1, +2 and +3. That is a
// diagnostic sweep of launch positions, not a proposed +3 rule.

export type OriginAnchorType = "ABSOLUTE_EXTREME" | "INTERNAL_SWING" | "EXTERNAL_SWING";

const INTERNAL_LOOKBACK = 3;
const EXTERNAL_LOOKBACK = 7;

export interface ConfirmedSwing {
  index: number; price: number; type: string; confirmedAt: number;
}

/**
 * Causally-confirmed swings, as TWO INDEPENDENT MEMBERSHIPS.
 *
 * The first version promoted any pivot also found by the external detector to
 * significance "external", which REMOVED it from the internal set. That made
 * the two hypotheses non-comparable: a pivot both scales agree on vanished
 * from INTERNAL, and genuine convergence looked like the internal anchor
 * finding nothing.
 *
 * The same pivot may legitimately belong to both sets, confirmed at different
 * times: index + 3 as an internal swing, index + 7 as an external one. The
 * canonical engine's own merge behaviour is not changed — this is the research
 * view, and it needs both scales intact to compare them.
 */
export function confirmedSwings(candles: Candle[]): {
  internal: ConfirmedSwing[]; external: ConfirmedSwing[];
} {
  const hasATR = candles.length >= 15;
  return {
    internal: detectSwingPoints(candles, INTERNAL_LOOKBACK, hasATR ? 0.2 : 0)
      .map((s) => ({ index: s.index, price: s.price, type: s.type,
                     confirmedAt: s.index + INTERNAL_LOOKBACK })),
    external: detectSwingPoints(candles, EXTERNAL_LOOKBACK, hasATR ? 0.5 : 0)
      .map((s) => ({ index: s.index, price: s.price, type: s.type,
                     confirmedAt: s.index + EXTERNAL_LOOKBACK })),
  };
}

/**
 * One representative ledger break per (bar, direction), using the SAME rule the
 * IPO detector applies: external preferred, then the most extreme level in the
 * break direction. Several levels closing through on one candle is a single
 * market event; counting each as independent overweights those bars.
 */
export function uniqueBreakEvents(ledger: any[]): any[] {
  const keep = new Map<string, any>();
  for (const l of ledger) {
    const k = `${l.index}|${l.direction}`;
    const cur = keep.get(k);
    if (!cur) { keep.set(k, l); continue; }
    const better = (l.significance === "external" && cur.significance !== "external") ||
      (l.significance === cur.significance &&
        (l.direction === "bullish" ? l.level > cur.level : l.level < cur.level));
    if (better) keep.set(k, l);
  }
  return [...keep.values()].sort((a, b) => a.index - b.index);
}

export function traceDepartureOriginHypotheses(
  candles: Candle[],
  knownDate: string,
  direction: IPODirection,
  opts: DetectIPOOptions = {},
) {
  const ki = candles.findIndex((c) => c.datetime.slice(0, 10) === knownDate.slice(0, 10));
  if (ki < 0) return { knownDate, direction, error: "candle not in series" };
  const wantDir = direction === "demand" ? "bullish" : "bearish";
  const opposingType = wantDir === "bullish" ? "low" : "high";
  const g = ipoGeometry(candles[ki], direction);
  const demand = direction === "demand";

  const canon = analyzeMarketStructureCanonical(candles, {
    policy: "latest_unbroken_structural",
    maxEventAgeBars: opts.maxEventAgeBars === undefined ? DEFAULTS.maxEventAgeBars : opts.maxEventAgeBars,
  });
  const swings = confirmedSwings(candles);
  // EVERY compatible break is evaluated. Capping the loop at 8 made the verdict
  // depend on which breaks happened to come first, and BTC known candles have
  // 195-228 compatible breaks — a cap there could report "not recovered" for a
  // candle recovered by break #50. Only the RETURNED detail is capped, after all
  // statistics are computed, so a display limit can never move the conclusion.
  const breaks = uniqueBreakEvents(
    (canon.swingLevelBreaks as any[]).filter((l) => l.direction === wantDir && l.index > ki),
  );
  const detailCap = Number(opts.detailCap ?? 24);

  const results: any[] = [];
  for (const lb of breaks) {
    const j = lb.index;

    // A — the retired baseline
    const swingIdx = lb.swingIndex ?? Math.max(0, j - 10);
    let absIdx = swingIdx;
    for (let k = swingIdx; k <= j; k++) {
      if (!candles[k]) continue;
      if (wantDir === "bullish" ? candles[k].low <= candles[absIdx].low
                                : candles[k].high >= candles[absIdx].high) absIdx = k;
    }
    // B / C — most recent causally-confirmed opposing swing before the break
    const usable = (arr: ConfirmedSwing[]) =>
      arr.filter((s) => s.type === opposingType && s.index < j && s.confirmedAt <= j)
        .sort((a, b) => b.index - a.index)[0] ?? null;
    const internalAnchor = usable(swings.internal);
    const externalAnchor = usable(swings.external);

    const anchors: Array<{ type: OriginAnchorType; idx: number | null; sig: string | null; confirmedAt: number | null }> = [
      { type: "ABSOLUTE_EXTREME", idx: absIdx, sig: null, confirmedAt: null },
      { type: "INTERNAL_SWING", idx: internalAnchor?.index ?? null, sig: "internal", confirmedAt: internalAnchor?.confirmedAt ?? null },
      { type: "EXTERNAL_SWING", idx: externalAnchor?.index ?? null, sig: "external", confirmedAt: externalAnchor?.confirmedAt ?? null },
    ];

    for (const an of anchors) {
      if (an.idx === null) {
        results.push({ breakIndex: j, breakDate: String(lb.datetime).slice(0, 10),
          anchorType: an.type, anchorIndex: null, note: "no such anchor before the break" });
        continue;
      }
      for (const off of [0, 1, 2, 3]) {
        const launch = an.idx + off;
        if (launch >= j || launch >= candles.length) continue;
        // selectIPOCandle is used UNMODIFIED — only the launch position varies.
        const sel = selectIPOCandle(candles, launch, direction, {
          maxIntervening: opts.maxIntervening,
          interveningMaxRangeAtr: opts.interveningMaxRangeAtr,
          maxLookback: opts.maxLookback,
        });
        const picked = sel?.index ?? null;
        // Did the IPO's extent survive to the break, and did price actually
        // depart through the correct side first?
        let extentHeld = true, departed = false;
        if (picked !== null) {
          const pg = ipoGeometry(candles[picked], direction);
          for (let k = picked + 1; k <= j; k++) {
            const b = candles[k];
            if (demand ? b.close < pg.extent : b.close > pg.extent) { extentHeld = false; break; }
            if (demand ? b.low > pg.zoneHigh : b.high < pg.zoneLow) departed = true;
          }
        }
        results.push({
          breakIndex: j, breakDate: String(lb.datetime).slice(0, 10),
          breakSignificance: lb.significance,
          anchorType: an.type, anchorIndex: an.idx,
          anchorDate: candles[an.idx].datetime.slice(0, 10),
          anchorSignificance: an.sig,
          anchorConfirmedDate: an.confirmedAt !== null && candles[an.confirmedAt]
            ? candles[an.confirmedAt].datetime.slice(0, 10) : null,
          anchorToKnownBars: an.idx - ki,
          launchOffset: off, launchIndex: launch,
          launchDate: candles[launch].datetime.slice(0, 10),
          selectedIndex: picked,
          selectedDate: picked === null ? null : candles[picked].datetime.slice(0, 10),
          matchesKnown: picked === ki,
          interveningCount: sel?.interveningSkipped ?? null,
          interveningRangeAtr: (sel?.intervening ?? []).map((x) => x.rangeAtr),
          barsSelectedToBreak: picked === null ? null : j - picked,
          ipoExtentSurvivedToBreak: picked === null ? null : extentHeld,
          departedThroughCorrectSideBeforeBreak: picked === null ? null : departed,
        });
      }
    }
  }

  const hits = results.filter((r) => r.matchesKnown);
  const misses = results.filter((r) => r.selectedIndex !== null && !r.matchesKnown);
  const byType = (t: OriginAnchorType) => hits.filter((h) => h.anchorType === t).length;
  const intPick = new Set(results.filter((r) => r.anchorType === "INTERNAL_SWING" && r.selectedDate).map((r) => r.selectedDate));
  const extPick = new Set(results.filter((r) => r.anchorType === "EXTERNAL_SWING" && r.selectedDate).map((r) => r.selectedDate));
  const converge = [...intPick].filter((d) => extPick.has(d));

  // RECOVERED vs UNIQUELY RECOVERED. "The known candle was selected" and "the
  // known candle was the ONLY candle selected" are very different evidence.
  // A hypothesis set that recovers the target alongside four competitors has
  // widened the search window rather than found the origin.
  const knownDateStr = candles[ki].datetime.slice(0, 10);
  const allSelected = [...new Set(results.filter((r) => r.selectedDate).map((r) => r.selectedDate as string))];
  const competitors = allSelected.filter((d) => d !== knownDateStr);
  const recoveredBy = hits.map((h) => `${h.anchorType}+${h.launchOffset}`);

  return {
    knownDate, direction,
    knownCandle: { index: ki, datetime: candles[ki].datetime, geometry: g },
    directionalBreaksTotal: breaks.length,
    detailedBreaksReturned: Math.min(breaks.length, detailCap),
    // Detail only. Every statistic below is computed over ALL breaks.
    results: results.filter((r) => breaks.findIndex((b) => b.index === r.breakIndex) < detailCap),
    recovery: {
      knownRecovered: hits.length > 0,
      /**
       * RETIRED. Global uniqueness pooled candidates from every future break and
       * labelled them competitors, which reported "286 other candles also
       * qualify" on BTC 2020-05-11. Multiple IPOs coexist on a chart; a candle
       * belonging to a later move is not a false positive for an earlier one.
       * Use traceEventLocalRecovery().knownEventLocallyUnique instead.
       */
      knownUniquelyRecovered_RETIRED: hits.length > 0 && competitors.length === 0,
      recoveredBy,
      uniqueCandlesSelectedTotal: allSelected.length,
      competingCandles: competitors,
      summary: hits.length === 0
        ? `known candle NOT recovered; ${allSelected.length} other candle(s) selected`
        : competitors.length === 0
          ? `known recovered by ${recoveredBy.join(", ")}; 1 unique candle total`
          : `known recovered by ${recoveredBy.join(", ")}, but ${competitors.length} other candle(s) also qualify`,
    },
    multiplicity: {
      hypothesesSelectingKnownCandle: hits.length,
      hypothesesSelectingAnotherCandle: misses.length,
      hitsByAnchorType: {
        ABSOLUTE_EXTREME: byType("ABSOLUTE_EXTREME"),
        INTERNAL_SWING: byType("INTERNAL_SWING"),
        EXTERNAL_SWING: byType("EXTERNAL_SWING"),
      },
      distinctCandlesSelected: new Set(results.filter((r) => r.selectedDate).map((r) => r.selectedDate)).size,
      internalExternalConverge: converge.length > 0,
      convergedOnKnown: converge.includes(candles[ki].datetime.slice(0, 10)),
    },
  };
}

/** Background ambiguity: how noisy is each anchor across a whole series? */
export function originHypothesisBackground(candles: Candle[], opts: DetectIPOOptions = {}) {
  const canon = analyzeMarketStructureCanonical(candles, {
    policy: "latest_unbroken_structural",
    maxEventAgeBars: opts.maxEventAgeBars === undefined ? DEFAULTS.maxEventAgeBars : opts.maxEventAgeBars,
  });
  const swings = confirmedSwings(candles);
  const ledgerAll = canon.swingLevelBreaks as any[];
  // Statistics run on UNIQUE (bar, direction) events, not raw ledger levels.
  // Several levels closing through on one candle is one market event; counting
  // each separately overweights those bars in every ratio below.
  const events = uniqueBreakEvents(ledgerAll);
  const stats: Record<string, { origins: number; ipos: number; multi: number }> = {
    ABSOLUTE_EXTREME: { origins: 0, ipos: 0, multi: 0 },
    INTERNAL_SWING: { origins: 0, ipos: 0, multi: 0 },
    EXTERNAL_SWING: { origins: 0, ipos: 0, multi: 0 },
  };
  let agree = 0, comparable = 0, breaks = 0;
  const uniquePerBreak: number[] = [];
  let zeroUnique = 0, oneUnique = 0, manyUnique = 0, convergedBreaks = 0, tripleConverged = 0;

  const seen = new Map<string, Set<string>>();
  for (const lb of events) {
    breaks++;
    const j = lb.index;
    const dir: IPODirection = lb.direction === "bullish" ? "demand" : "supply";
    const opposingType = lb.direction === "bullish" ? "low" : "high";
    const swingIdx = lb.swingIndex ?? Math.max(0, j - 10);
    let absIdx = swingIdx;
    for (let k = swingIdx; k <= j; k++) {
      if (!candles[k]) continue;
      if (lb.direction === "bullish" ? candles[k].low <= candles[absIdx].low
                                     : candles[k].high >= candles[absIdx].high) absIdx = k;
    }
    const usable = (arr: ConfirmedSwing[]) =>
      arr.filter((s) => s.type === opposingType && s.index < j && s.confirmedAt <= j)
        .sort((a, b) => b.index - a.index)[0] ?? null;
    const iA = usable(swings.internal);
    const eA = usable(swings.external);

    const pickFor = (idx: number | null) => {
      if (idx === null) return new Set<string>();
      const out = new Set<string>();
      for (const off of [0, 1, 2, 3]) {
        const launch = idx + off;
        if (launch >= j) continue;
        // Caller overrides must reach the selector here as well; hardcoding {}
        // would silently measure default behaviour while reporting the caller's.
        const sel = selectIPOCandle(candles, launch, dir, {
          maxIntervening: opts.maxIntervening,
          interveningMaxRangeAtr: opts.interveningMaxRangeAtr,
          maxLookback: opts.maxLookback,
        });
        if (sel) out.add(candles[sel.index].datetime.slice(0, 10));
      }
      return out;
    };
    const picks: Record<string, Set<string>> = {
      ABSOLUTE_EXTREME: pickFor(absIdx),
      INTERNAL_SWING: pickFor(iA?.index ?? null),
      EXTERNAL_SWING: pickFor(eA?.index ?? null),
    };
    // Dedupe ACROSS hypotheses and offsets for this break. Three hypotheses
    // landing on one candle is far less ambiguous than three landing on three,
    // and counting raw selections would hide that distinction entirely.
    const union = new Set<string>([...picks.ABSOLUTE_EXTREME, ...picks.INTERNAL_SWING, ...picks.EXTERNAL_SWING]);
    uniquePerBreak.push(union.size);
    if (union.size === 0) zeroUnique++;
    else if (union.size === 1) oneUnique++;
    else manyUnique++;
    // Convergence: how many distinct hypotheses picked the single most-agreed candle.
    const tally = new Map<string, number>();
    for (const set of [picks.ABSOLUTE_EXTREME, picks.INTERNAL_SWING, picks.EXTERNAL_SWING]) {
      for (const dte of set) tally.set(dte, (tally.get(dte) ?? 0) + 1);
    }
    const topAgreement = tally.size ? Math.max(...tally.values()) : 0;
    if (topAgreement >= 2) convergedBreaks++;
    if (topAgreement >= 3) tripleConverged++;
    for (const [k, v] of Object.entries(picks)) {
      if (v.size > 0) stats[k].origins++;
      stats[k].ipos += v.size;
      if (v.size > 1) stats[k].multi++;
      const bag = seen.get(k) ?? new Set<string>();
      v.forEach((x) => bag.add(x));
      seen.set(k, bag);
    }
    if (picks.INTERNAL_SWING.size && picks.EXTERNAL_SWING.size) {
      comparable++;
      if ([...picks.INTERNAL_SWING].some((x) => picks.EXTERNAL_SWING.has(x))) agree++;
    }
  }
  const per100 = (n: number) => Math.round((n / candles.length) * 1000) / 10;
  return {
    bars: candles.length,
    ledgerLevelBreaks: ledgerAll.length,
    uniqueBreakEvents: events.length,
    /** Denominator for every ratio below. */
    breaksUsedAsDenominator: breaks,
    byAnchor: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, {
      originsProducingAnIPO: v.origins,
      originsPer100Bars: per100(v.origins),
      distinctIPOCandidates: seen.get(k)?.size ?? 0,
      ipoCandidatesPer100Bars: per100(seen.get(k)?.size ?? 0),
      breaksWithMultipleCompetingIPOs: v.multi,
      percentBreaksWithMultipleIPOs: v.origins ? Math.round((v.multi / v.origins) * 1000) / 10 : 0,
    }])),
    internalExternalComparable: comparable,
    internalExternalAgree: agree,
    percentInternalExternalAgree: comparable ? Math.round((agree / comparable) * 1000) / 10 : null,
    // The measurement that decides whether an anchor is a solution or a wider net.
    uniqueCandidatesPerBreak: (() => {
      const sorted = [...uniquePerBreak].sort((a, b) => a - b);
      const pct = (n: number) => breaks ? Math.round((n / breaks) * 1000) / 10 : 0;
      return {
        breaksWithZeroUnique: zeroUnique, percentZero: pct(zeroUnique),
        breaksWithExactlyOneUnique: oneUnique, percentExactlyOne: pct(oneUnique),
        breaksWithMoreThanOneUnique: manyUnique, percentMoreThanOne: pct(manyUnique),
        medianUniquePerBreak: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        maxUniquePerBreak: sorted.length ? sorted[sorted.length - 1] : null,
      };
    })(),
    hypothesisConvergence: {
      breaksWhereTwoOrMoreHypothesesAgree: convergedBreaks,
      percentTwoOrMoreAgree: breaks ? Math.round((convergedBreaks / breaks) * 1000) / 10 : 0,
      breaksWhereAllThreeAgree: tripleConverged,
      percentAllThreeAgree: breaks ? Math.round((tripleConverged / breaks) * 1000) / 10 : 0,
    },
  };
}

// ─── event-local recovery + parent/child refinement ──────────────────────────
//
// MODEL CORRECTION. The earlier uniqueness metric pooled candidates from EVERY
// future compatible structure break and called them competitors, which reported
// "known recovered, but 286 other candles also qualify" on BTC 2020-05-11. That
// framing was wrong: multiple IPOs coexist on a chart, and a candle belonging to
// a later move is not a false positive for an earlier one.
//
// Uniqueness is therefore EVENT-LOCAL. A known IPO is compared only against the
// candidates for its OWN first relevant confirmation, defined as:
//
//   IPO candle -> directional departure -> extent still valid
//              -> first directionally relevant close-through of structure
//
// Departure must happen before the break counts: a close-through while price is
// still inside the zone is not that zone's confirming move.
//
// knownUniquelyRecovered (global) is retired and deliberately not reported.

export type IPOCandidateRelation =
  | "IPO_CANDIDATE_FOR_EVENT"
  | "OTHER_IPO_OTHER_EVENT"
  | "UNRELATED";

/**
 * Whether departure is PROVABLY before the close-through, or merely consistent
 * with it.
 *
 * On a daily bar a candle can both leave the zone entirely and close through
 * the level. The rule is satisfied — the bar sits fully outside the zone and
 * closes beyond — but the two facts share one bar, and nothing in OHLC fixes
 * their order within it. Price may have broken structure first and only then
 * detached from the zone, which is the opposite of the causal story the rule
 * is meant to capture.
 *
 * These cases are KEPT, not discarded: dropping them would silently shrink the
 * evidence base. They are labelled so they can be counted apart, and the
 * reason string for them never claims a chronological departure -> break.
 */
export type DepartureBreakOrdering =
  | "DEPARTURE_BEFORE_BREAK"
  | "SAME_BAR_UNVERIFIABLE";

export interface FirstRelevantConfirmation {
  found: boolean;
  reason: string;
  breakIndex: number | null;
  breakDate: string | null;
  level: number | null;
  significance: string | null;
  barsFromIPOToBreak: number | null;
  departedAtIndex: number | null;
  departedAtDate: string | null;
  invalidatedAtIndex: number | null;
  /** Null when there is no confirmation to order against. */
  departureBreakOrdering: DepartureBreakOrdering | null;
}

export function findFirstRelevantConfirmation(
  candles: Candle[],
  ipoIndex: number,
  direction: IPODirection,
  ledger: any[],
): FirstRelevantConfirmation {
  const demand = direction === "demand";
  const wantDir = demand ? "bullish" : "bearish";
  const g = ipoGeometry(candles[ipoIndex], direction);
  const byBar = new Map<number, any[]>();
  for (const l of ledger) {
    if (l.direction !== wantDir || l.index <= ipoIndex) continue;
    (byBar.get(l.index) ?? byBar.set(l.index, []).get(l.index)!).push(l);
  }
  let departed: number | null = null;
  for (let j = ipoIndex + 1; j < candles.length; j++) {
    const b = candles[j];
    // Extent must hold. A close beyond it ends the episode with no confirmation.
    if (demand ? b.close < g.extent : b.close > g.extent) {
      return {
        found: false, reason: "extent invalidated before any relevant close-through",
        breakIndex: null, breakDate: null, level: null, significance: null,
        barsFromIPOToBreak: null,
        departedAtIndex: departed, departedAtDate: departed === null ? null : candles[departed].datetime.slice(0, 10),
        invalidatedAtIndex: j,
        departureBreakOrdering: null,
      };
    }
    if (departed === null && (demand ? b.low > g.zoneHigh : b.high < g.zoneLow)) departed = j;
    if (departed === null) continue;                 // the move must leave first
    const here = byBar.get(j);
    if (here && here.length) {
      const rep = uniqueBreakEvents(here)[0];
      const sameBar = departed === j;
      return {
        found: true,
        // Never assert an ordering the bar cannot prove.
        reason: sameBar
          ? "close-through on the SAME BAR the zone was left — ordering within the bar is unverifiable"
          : "first directionally relevant close-through after departure",
        breakIndex: j, breakDate: b.datetime.slice(0, 10),
        level: rep.level, significance: rep.significance,
        barsFromIPOToBreak: j - ipoIndex,
        departedAtIndex: departed, departedAtDate: candles[departed].datetime.slice(0, 10),
        invalidatedAtIndex: null,
        departureBreakOrdering: sameBar ? "SAME_BAR_UNVERIFIABLE" : "DEPARTURE_BEFORE_BREAK",
      };
    }
  }
  return {
    found: false, reason: departed === null
      ? "price never departed the zone on the departure side"
      : "departed, but no directionally relevant close-through before the series ended",
    breakIndex: null, breakDate: null, level: null, significance: null,
    barsFromIPOToBreak: null,
    departedAtIndex: departed, departedAtDate: departed === null ? null : candles[departed].datetime.slice(0, 10),
    invalidatedAtIndex: null,
    departureBreakOrdering: null,
  };
}

/** Candidates produced by all anchors/offsets for ONE break event. */
function candidatesForBreak(
  candles: Candle[], breakIndex: number, direction: IPODirection,
  swings: { internal: ConfirmedSwing[]; external: ConfirmedSwing[] },
  lb: any, opts: DetectIPOOptions,
): Map<string, string[]> {
  const wantDir = direction === "demand" ? "bullish" : "bearish";
  const opposingType = wantDir === "bullish" ? "low" : "high";
  const j = breakIndex;
  const swingIdx = lb?.swingIndex ?? Math.max(0, j - 10);
  let absIdx = swingIdx;
  for (let k = swingIdx; k <= j; k++) {
    if (!candles[k]) continue;
    if (wantDir === "bullish" ? candles[k].low <= candles[absIdx].low
                              : candles[k].high >= candles[absIdx].high) absIdx = k;
  }
  const usable = (arr: ConfirmedSwing[]) =>
    arr.filter((s) => s.type === opposingType && s.index < j && s.confirmedAt <= j)
      .sort((a, b) => b.index - a.index)[0] ?? null;
  const anchors: Array<[OriginAnchorType, number | null]> = [
    ["ABSOLUTE_EXTREME", absIdx],
    ["INTERNAL_SWING", usable(swings.internal)?.index ?? null],
    ["EXTERNAL_SWING", usable(swings.external)?.index ?? null],
  ];
  const out = new Map<string, string[]>();
  for (const [type, idx] of anchors) {
    if (idx === null) continue;
    for (const off of [0, 1, 2, 3]) {
      const launch = idx + off;
      if (launch >= j) continue;
      const sel = selectIPOCandle(candles, launch, direction, {
        maxIntervening: opts.maxIntervening,
        interveningMaxRangeAtr: opts.interveningMaxRangeAtr,
        maxLookback: opts.maxLookback,
      });
      if (!sel) continue;
      const dte = candles[sel.index].datetime.slice(0, 10);
      out.set(dte, [...(out.get(dte) ?? []), `${type}+${off}`]);
    }
  }
  return out;
}

export function traceEventLocalRecovery(
  candles: Candle[],
  knownDate: string,
  direction: IPODirection,
  opts: DetectIPOOptions = {},
) {
  const ki = candles.findIndex((c) => c.datetime.slice(0, 10) === knownDate.slice(0, 10));
  if (ki < 0) return { knownDate, direction, error: "candle not in series" };
  const canon = analyzeMarketStructureCanonical(candles, {
    policy: "latest_unbroken_structural",
    maxEventAgeBars: opts.maxEventAgeBars === undefined ? DEFAULTS.maxEventAgeBars : opts.maxEventAgeBars,
  });
  const ledger = canon.swingLevelBreaks as any[];
  const swings = confirmedSwings(candles);
  const conf = findFirstRelevantConfirmation(candles, ki, direction, ledger);
  const knownStr = candles[ki].datetime.slice(0, 10);

  if (!conf.found || conf.breakIndex === null) {
    return {
      knownDate, direction, knownCandleIndex: ki,
      firstRelevantConfirmation: conf,
      eventCandidates: [], eventUniqueCandidateCount: 0,
      knownAmongEventCandidates: false, knownEventLocallyUnique: false,
      note: "no first relevant confirmation, so event-local uniqueness is undefined",
    };
  }

  const rep = uniqueBreakEvents(ledger.filter((l) => l.index === conf.breakIndex))
    .find((l) => l.direction === (direction === "demand" ? "bullish" : "bearish"));
  const map = candidatesForBreak(candles, conf.breakIndex, direction, swings, rep, opts);
  const dates = [...map.keys()].sort();

  // Candidates belonging to OTHER break events are not false positives — the
  // teaching is explicit that several IPOs coexist. Classify, do not condemn.
  //
  // EVERY other event is evaluated. An earlier version stopped at 120, which
  // made `count` a function of how many events happened to come first rather
  // than of the series — the same defect as the retired 8-break detail cap.
  // Only the returned SAMPLE is capped, and capping it cannot move the count.
  const otherEvents = uniqueBreakEvents(ledger)
    .filter((l) => l.index !== conf.breakIndex);
  const elsewhere = new Set<string>();
  for (const l of otherEvents) {
    const dir: IPODirection = l.direction === "bullish" ? "demand" : "supply";
    for (const dte of candidatesForBreak(candles, l.index, dir, swings, l, opts).keys()) elsewhere.add(dte);
  }
  const sampleCap = opts.detailCap ?? 8;

  return {
    knownDate, direction, knownCandleIndex: ki,
    firstRelevantConfirmation: conf,
    eventCandidates: dates.map((dte) => ({
      date: dte, selectedBy: map.get(dte)!,
      isKnownCandle: dte === knownStr,
      // Everything in this map was selected FOR THIS EVENT by construction.
      relation: "IPO_CANDIDATE_FOR_EVENT" as IPOCandidateRelation,
    })),
    eventUniqueCandidateCount: dates.length,
    knownAmongEventCandidates: dates.includes(knownStr),
    knownEventLocallyUnique: dates.length === 1 && dates[0] === knownStr,
    otherEventCandidates: {
      count: elsewhere.size,
      otherEventsEvaluated: otherEvents.length,
      relation: "OTHER_IPO_OTHER_EVENT" as IPOCandidateRelation,
      note: "candidates belonging to different confirmation episodes — coexisting IPOs, NOT competitors",
      sampleCap,
      sample: [...elsewhere].filter((d) => !dates.includes(d)).slice(0, sampleCap),
    },
  };
}

// ─── parent / child refinement ───────────────────────────────────────────────

export type IPORole = "CONTEXT" | "EXECUTION";

export interface IPOHierarchyNode {
  id: string;
  timeframe: string;
  direction: IPODirection;
  candleDatetime: string;
  geometry: IPOGeometry;
  /** Set ONLY when lineage is unambiguous, or fixed by an explicit context. */
  parentIPOId: string | null;
  parentTimeframe: string | null;
  /** Every HTF IPO that validly contains this one. Length > 1 => ambiguous. */
  possibleParentIPOIds: string[];
  lineageAmbiguous: boolean;
  lineageResolvedBy: LineageResolution;
  childTimeframe: string | null;
  refinementDepth: number;
  role: IPORole;
  containedWithinParent: boolean;
  /** Children whose lineage resolved to THIS node and nothing else. */
  childIds: string[];
  /** Children that might be this node's, but might be another parent's. */
  possibleChildIds: string[];
}

export type LineageResolution =
  | "ROOT"
  | "SINGLE_VALID_PARENT"
  | "EXPLICIT_PARENT_CONTEXT"
  | "AMBIGUOUS_MULTIPLE_PARENTS";

export interface BuildIPOHierarchyOptions extends DetectIPOOptions {
  /**
   * The HTF IPO the caller is deliberately trading under. When an otherwise
   * ambiguous child is contained by this zone, that settles it — the analyst
   * supplied the context, the code did not guess it.
   */
  parentContextId?: string;
}

/**
 * Which HTF IPOs can validly parent this one, and whether that is decidable.
 *
 * Two hard requirements:
 *
 *   1. FULL containment, same direction. Overlap is not refinement.
 *   2. The child cannot predate its parent. A candle that formed before the
 *      HTF candle exists is not a refinement of it, however neatly it nests.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. When several HTF IPOs qualify — which
 * happens whenever HTF zones overlap — it does not pick one. The previous
 * version called .find(), so lineage was decided by detector emission order:
 * re-sorting the zone array would have silently reassigned parents, and the
 * output would have looked equally confident either way.
 *
 * There is no nearest-parent or narrowest-parent tiebreak here on purpose.
 * Both are plausible and neither is taught, so inventing one would bury a
 * guess inside a diagnostic. Ambiguity is reported as ambiguity.
 */
export function resolveParentLineage(
  child: { direction: IPODirection; geometry: IPOGeometry; candleDatetime: string },
  candidates: IPOHierarchyNode[],
  parentContextId?: string,
): {
  parentIPOId: string | null;
  possibleParentIPOIds: string[];
  lineageAmbiguous: boolean;
  lineageResolvedBy: LineageResolution;
} {
  const at = (s: string) => {
    const n = Date.parse(s);
    return Number.isNaN(n) ? null : n;
  };
  const childAt = at(child.candleDatetime);
  const valid = candidates.filter((p) => {
    if (p.direction !== child.direction) return false;
    if (child.geometry.zoneLow < p.geometry.zoneLow) return false;
    if (child.geometry.zoneHigh > p.geometry.zoneHigh) return false;
    const parentAt = at(p.candleDatetime);
    // Unparseable either side: fall back to lexicographic ISO comparison
    // rather than letting the time rule silently pass.
    if (childAt === null || parentAt === null) {
      return child.candleDatetime >= p.candleDatetime;
    }
    return childAt >= parentAt;
  });
  const ids = valid.map((p) => p.id);
  if (ids.length === 0) {
    return { parentIPOId: null, possibleParentIPOIds: [], lineageAmbiguous: false, lineageResolvedBy: "ROOT" };
  }
  if (ids.length === 1) {
    return { parentIPOId: ids[0], possibleParentIPOIds: ids, lineageAmbiguous: false, lineageResolvedBy: "SINGLE_VALID_PARENT" };
  }
  if (parentContextId && ids.includes(parentContextId)) {
    return { parentIPOId: parentContextId, possibleParentIPOIds: ids, lineageAmbiguous: false, lineageResolvedBy: "EXPLICIT_PARENT_CONTEXT" };
  }
  return { parentIPOId: null, possibleParentIPOIds: ids, lineageAmbiguous: true, lineageResolvedBy: "AMBIGUOUS_MULTIPLE_PARENTS" };
}

/**
 * Recursive HTF -> LTF refinement. Weekly -> Daily -> 4H -> execution, and the
 * chain may be any depth; nothing hardcodes a single step.
 *
 * A PARENT IS NEVER INVALIDATED BY FINDING A CHILD. It keeps role CONTEXT and
 * remains a valid IPO in its own right. Only a leaf — a node with no refinement
 * beneath it — carries role EXECUTION.
 *
 * Containment is full, not overlap: a child straddling the parent boundary sits
 * partly outside the zone the parent defines.
 *
 * Not every parent must have a child; a childless parent is simply EXECUTION at
 * its own timeframe.
 *
 * Lineage that cannot be decided is left undecided — see resolveParentLineage.
 * An ambiguous child promotes NO parent to CONTEXT, because we cannot say which
 * HTF IPO was the one refined; each possible parent records it under
 * possibleChildIds instead.
 */
export function buildIPOHierarchy(
  levels: Array<{ timeframe: string; candles: Candle[] }>,
  opts: BuildIPOHierarchyOptions = {},
): IPOHierarchyNode[] {
  const nodes: IPOHierarchyNode[] = [];
  let previous: IPOHierarchyNode[] = [];

  levels.forEach((lvl, depth) => {
    const zones = detectIPOCandidates(lvl.candles, { ...opts, timeframe: lvl.timeframe }).valid;
    const current: IPOHierarchyNode[] = [];
    for (const z of zones) {
      const lin = depth === 0
        ? { parentIPOId: null, possibleParentIPOIds: [] as string[], lineageAmbiguous: false, lineageResolvedBy: "ROOT" as LineageResolution }
        : resolveParentLineage(z, previous, opts.parentContextId);
      // At depth 0 there is no parent to contain anything, which is not a
      // containment failure — it is the top of the chain. Below depth 0, a zone
      // contained by nothing is not a refinement of this chain at all.
      if (depth > 0 && lin.possibleParentIPOIds.length === 0) continue;

      const node: IPOHierarchyNode = {
        id: z.id, timeframe: lvl.timeframe, direction: z.direction,
        candleDatetime: z.candleDatetime, geometry: z.geometry,
        parentIPOId: lin.parentIPOId,
        parentTimeframe: lin.parentIPOId
          ? previous.find((p) => p.id === lin.parentIPOId)?.timeframe ?? null
          : null,
        possibleParentIPOIds: lin.possibleParentIPOIds,
        lineageAmbiguous: lin.lineageAmbiguous,
        lineageResolvedBy: lin.lineageResolvedBy,
        childTimeframe: null,
        refinementDepth: depth,
        role: "EXECUTION",              // provisional; promoted below if refined
        containedWithinParent: lin.possibleParentIPOIds.length > 0,
        childIds: [],
        possibleChildIds: [],
      };

      if (lin.parentIPOId) {
        const parent = previous.find((p) => p.id === lin.parentIPOId)!;
        parent.childIds.push(node.id);
        parent.childTimeframe = lvl.timeframe;
        parent.role = "CONTEXT";        // refined, but still a valid IPO
      } else {
        // Ambiguous. Record the possibility on every candidate; promote none.
        for (const pid of lin.possibleParentIPOIds) {
          previous.find((p) => p.id === pid)?.possibleChildIds.push(node.id);
        }
      }
      current.push(node);
      nodes.push(node);
    }
    previous = current;
  });
  return nodes;
}
