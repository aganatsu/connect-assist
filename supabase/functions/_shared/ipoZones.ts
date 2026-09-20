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
import { EVIDENCE_SOURCES, type EvidenceSource } from "./ipoProvenance.ts";

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
 * Resolve a demonstrated candle to its bar index.
 *
 * DATE-ONLY LOOKUP IS WRONG INTRADAY. The three trace diagnostics used
 * `datetime.slice(0,10) === knownDate.slice(0,10)`, which on a 4H series picks
 * the FIRST bar of that day. Asked to trace BTC/USD 4h 2020-05-08 16:00 it
 * silently traced the 00:00 bar and reported a confident failure analysis of a
 * candle nobody demonstrated — the same defect barKey fixed in the coverage
 * evaluator, still live here.
 *
 * When the caller supplies a time, the time is honoured. When they do not, the
 * day is searched and `ambiguous` says whether that day held more than one bar.
 *
 * AMBIGUITY IS INFORMATION, NOT PERMISSION TO GUESS. Every caller REFUSES to
 * run when ambiguous is true. Reporting the flag while analysing the first bar
 * anyway was the same failure in a quieter form: the output still described a
 * candle nobody demonstrated, and a reader scanning for `error` would not see
 * it. This matches the coverage evaluator, where DATE_ONLY_AMBIGUOUS is
 * neither covered nor missed.
 */
export function resolveKnownCandleIndex(
  candles: Candle[], knownDate: string,
): {
  index: number;
  ambiguous: boolean;
  barsOnThatDay: number;
  resolvedDatetime: string | null;
  /** Every bar on that calendar day, so an ambiguous caller can pick one. */
  candidateDatetimes: string[];
} {
  const day = knownDate.slice(0, 10);
  const sameDay = candles
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.datetime.slice(0, 10) === day);
  const candidateDatetimes = sameDay.map(({ c }) => c.datetime);
  if (!sameDay.length) {
    return { index: -1, ambiguous: false, barsOnThatDay: 0, resolvedDatetime: null, candidateDatetimes };
  }

  if (!isDateOnly(knownDate)) {
    const want = String(knownDate).replace(" ", "T").slice(0, 16);
    const exact = sameDay.find(({ c }) => c.datetime.replace(" ", "T").slice(0, 16) === want);
    if (exact) {
      return {
        index: exact.i, ambiguous: false, barsOnThatDay: sameDay.length,
        resolvedDatetime: exact.c.datetime, candidateDatetimes,
      };
    }
    // A time was given and no bar carries it. Refuse rather than fall back to
    // the first bar of the day: that is how the wrong candle gets analysed.
    return {
      index: -1, ambiguous: false, barsOnThatDay: sameDay.length,
      resolvedDatetime: null, candidateDatetimes,
    };
  }
  return {
    index: sameDay[0].i,
    ambiguous: sameDay.length > 1,
    barsOnThatDay: sameDay.length,
    resolvedDatetime: sameDay[0].c.datetime,
    candidateDatetimes,
  };
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
  const resolved = resolveKnownCandleIndex(candles, knownDate);
  const ki = resolved.index;
  if (ki < 0) {
    return {
      knownDate, direction,
      error: resolved.barsOnThatDay > 0
        ? `no bar at that exact time — ${resolved.barsOnThatDay} bar(s) exist on ${knownDate.slice(0, 10)}. ` +
          "Falling back to the first bar of the day would analyse a candle nobody demonstrated."
        : "candle not in series",
      barsOnThatDay: resolved.barsOnThatDay,
      candidateDatetimes: resolved.candidateDatetimes,
    };
  }
  if (resolved.ambiguous) {
    // A date-only request on an intraday chart. Running the trace would produce
    // a confident analysis of whichever bar happens to open the day.
    return {
      knownDate, direction,
      error: "DATE_ONLY_AMBIGUOUS",
      reason: `${resolved.barsOnThatDay} bars exist on ${knownDate.slice(0, 10)} and the request named no time. ` +
        "Re-send with the demonstrated timestamp; the first bar of the day is a guess, not a resolution.",
      barsOnThatDay: resolved.barsOnThatDay,
      candidateDatetimes: resolved.candidateDatetimes,
    };
  }

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
  const resolved = resolveKnownCandleIndex(candles, knownDate);
  const ki = resolved.index;
  if (ki < 0) {
    return {
      knownDate, direction,
      error: resolved.barsOnThatDay > 0
        ? `no bar at that exact time — ${resolved.barsOnThatDay} bar(s) exist on ${knownDate.slice(0, 10)}. ` +
          "Falling back to the first bar of the day would analyse a candle nobody demonstrated."
        : "candle not in series",
      barsOnThatDay: resolved.barsOnThatDay,
      candidateDatetimes: resolved.candidateDatetimes,
    };
  }
  if (resolved.ambiguous) {
    // A date-only request on an intraday chart. Running the trace would produce
    // a confident analysis of whichever bar happens to open the day.
    return {
      knownDate, direction,
      error: "DATE_ONLY_AMBIGUOUS",
      reason: `${resolved.barsOnThatDay} bars exist on ${knownDate.slice(0, 10)} and the request named no time. ` +
        "Re-send with the demonstrated timestamp; the first bar of the day is a guess, not a resolution.",
      barsOnThatDay: resolved.barsOnThatDay,
      candidateDatetimes: resolved.candidateDatetimes,
    };
  }
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
// A confirming break requires the zone to have DEPARTED BY the break bar: a
// close-through while price is still inside the zone is not that zone's
// confirming move. Where departure occurs on an earlier bar the ordering is
// strict. Where departure and break fall on the SAME bar the case is preserved
// and classified SAME_BAR_UNVERIFIABLE, because OHLC cannot establish intrabar
// ordering — see DepartureBreakOrdering.
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
    // The zone must have been departed BY this bar. Same-bar departure and
    // break is allowed here and labelled below; it is not silently dropped.
    if (departed === null) continue;
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
  const resolved = resolveKnownCandleIndex(candles, knownDate);
  const ki = resolved.index;
  if (ki < 0) {
    return {
      knownDate, direction,
      error: resolved.barsOnThatDay > 0
        ? `no bar at that exact time — ${resolved.barsOnThatDay} bar(s) exist on ${knownDate.slice(0, 10)}. ` +
          "Falling back to the first bar of the day would analyse a candle nobody demonstrated."
        : "candle not in series",
      barsOnThatDay: resolved.barsOnThatDay,
      candidateDatetimes: resolved.candidateDatetimes,
    };
  }
  if (resolved.ambiguous) {
    // A date-only request on an intraday chart. Running the trace would produce
    // a confident analysis of whichever bar happens to open the day.
    return {
      knownDate, direction,
      error: "DATE_ONLY_AMBIGUOUS",
      reason: `${resolved.barsOnThatDay} bars exist on ${knownDate.slice(0, 10)} and the request named no time. ` +
        "Re-send with the demonstrated timestamp; the first bar of the day is a guess, not a resolution.",
      barsOnThatDay: resolved.barsOnThatDay,
      candidateDatetimes: resolved.candidateDatetimes,
    };
  }
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
      resolvedDatetime: resolved.resolvedDatetime,
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
    resolvedDatetime: resolved.resolvedDatetime,
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

// ─── A. multi-IPO inventory ──────────────────────────────────────────────────
//
// THIS LAYER DOES NOT CHOOSE. Every IPO candidate is returned as an independent
// zone with its own confirmation, lifecycle, context and lineage. Two zones
// existing at once is the normal case, not a contradiction to be resolved — the
// teaching is explicit that several IPOs coexist on a chart.
//
// So there is no winner, no ranking and no rejection-by-competition here. A
// zone is never called a false positive for coexisting with another, and no
// discriminator is applied: the selector rules are exactly the ones already
// frozen, and this file adds none.
//
// What the inventory adds over detectIPOCandidates is per-zone CONTEXT the
// earlier diagnostics only computed for known boxes: each zone's own first
// relevant confirmation and its ordering, its place in a refinement chain, and
// the provenance of the rules that produced it.

export type ConfirmationOrdering =
  | "DEPARTURE_BEFORE_BREAK"
  | "SAME_BAR_UNVERIFIABLE"
  | "NO_CONFIRMATION";

export interface IPOInventoryLineage {
  timeframe: string;
  refinementDepth: number;
  parentIPOId: string | null;
  parentTimeframe: string | null;
  possibleParentIPOIds: string[];
  lineageAmbiguous: boolean;
  lineageResolvedBy: LineageResolution;
  childIds: string[];
  possibleChildIds: string[];
  role: IPORole;
  /**
   * True for a zone below the top level that no HTF zone contains. It is a
   * perfectly good IPO at its own timeframe — it is simply not a refinement of
   * anything in this chain. buildIPOHierarchy drops these; an inventory must
   * not, or the count becomes a function of which timeframes were requested.
   */
  standalone: boolean;
  /**
   * False when this zone HAS a parent but the parent fell outside the returned
   * date range. Lineage is resolved over the whole series, so without this a
   * reader sees a child holding a parent id with no parent present, and the
   * role counts read as broken rather than clipped.
   */
  parentInView: boolean;
  /**
   * How old the parent is at the moment the child forms. MEASUREMENT ONLY —
   * nothing filters on it and no cap exists.
   *
   * It is here because the first live run parented a 2026-05-06 daily zone to a
   * 2015-11-30 weekly zone. Containment and the time rule both hold, so the
   * rules accept it, but an eleven-year-old parent is worth being able to SEE
   * before anyone decides whether it should be allowed. Adding a limit would be
   * a new discriminator, so the gap is reported and left alone.
   *
   * parentAgeBars counts bars of the PARENT's own timeframe between the two
   * candles; comparing raw indices across timeframes would be meaningless.
   */
  parentAgeDays: number | null;
  parentAgeBars: number | null;
}

export interface IPOInventoryEntry {
  id: string;
  symbol: string;
  timeframe: string;
  direction: IPODirection;
  candleIndex: number;
  candleDatetime: string;
  candle: { open: number; high: number; low: number; close: number };
  geometry: IPOGeometry;
  confirmation: {
    ordering: ConfirmationOrdering;
    /** The zone's OWN first relevant confirmation, recomputed from its candle. */
    firstRelevant: FirstRelevantConfirmation;
    /** The break the detector originally attached the zone to, for comparison. */
    detectorBreak: IPOZone["structure"];
  };
  liquidity: IPOZone["liquidity"];
  departureFvg: IPOZone["departureFvg"];
  consolidation: {
    status: ConsolidationStatus;
    interpretation: ConsolidationInterpretation;
    flagRaised: boolean;
    profile: IPOZone["consolidation"];
    note: string;
  };
  lifecycle: IPOZone["lifecycle"];
  lineage: IPOInventoryLineage;
  selection: IPOZone["selection"];
  atrAtCandle: number;
  /** Detector-level validity. Today nothing sets this false — see consolidation. */
  valid: boolean;
  researchStatus: IPOResearchStatus;
  coexistenceNote: string;
}

export interface BuildIPOInventoryOptions extends BuildIPOHierarchyOptions {
  /** Inclusive ISO date bounds on the RETURNED zones. */
  from?: string;
  to?: string;
}

const COEXISTENCE_NOTE =
  "An independent zone. Coexisting with other IPOs is expected and is not evidence against any of them.";

const CONSOLIDATION_NOTE =
  "UNRESOLVED. The taught rule (no IPO inside consolidation) stands; the predicate " +
  "for it was retired as indefensible, so this zone is neither cleared of " +
  "consolidation nor refused by it.";

/**
 * Every IPO candidate across one or more timeframes, as independent zones.
 *
 * Levels are ordered highest timeframe first. Lineage is resolved against the
 * level above using resolveParentLineage, which leaves ambiguous parentage
 * ambiguous rather than picking by array order.
 *
 * DATE RANGE. from/to filter only what is RETURNED. Detection always runs on
 * the full series, because a zone's structure break, lifecycle and ATR all need
 * the bars around it; trimming the input first would silently change the zones
 * themselves rather than the view of them.
 */
export function buildIPOInventory(
  levels: Array<{ timeframe: string; candles: Candle[] }>,
  opts: BuildIPOInventoryOptions = {},
): IPOInventoryEntry[] {
  const out: IPOInventoryEntry[] = [];
  let previous: IPOHierarchyNode[] = [];

  levels.forEach((lvl, depth) => {
    const detected = detectIPOCandidates(lvl.candles, { ...opts, timeframe: lvl.timeframe });
    // Rejected candidates are included: today nothing rejects, and if something
    // ever does, an inventory that hides it would make an interpretation
    // failure look like a detection failure.
    const zones = [...detected.valid, ...detected.rejected]
      .sort((a, b) => a.candleIndex - b.candleIndex);

    const canon = analyzeMarketStructureCanonical(lvl.candles, {
      policy: "latest_unbroken_structural",
      maxEventAgeBars: opts.maxEventAgeBars === undefined ? DEFAULTS.maxEventAgeBars : opts.maxEventAgeBars,
    });
    const ledger = (canon as any).swingLevelBreaks as any[];

    const levelNodes: IPOHierarchyNode[] = [];
    const levelEntries: IPOInventoryEntry[] = [];

    for (const z of zones) {
      const lin = depth === 0
        ? {
          parentIPOId: null, possibleParentIPOIds: [] as string[],
          lineageAmbiguous: false, lineageResolvedBy: "ROOT" as LineageResolution,
        }
        : resolveParentLineage(z, previous, opts.parentContextId);

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
        role: "EXECUTION",
        containedWithinParent: lin.possibleParentIPOIds.length > 0,
        childIds: [],
        possibleChildIds: [],
      };
      if (lin.parentIPOId) {
        const parent = previous.find((p) => p.id === lin.parentIPOId)!;
        parent.childIds.push(node.id);
        parent.childTimeframe = lvl.timeframe;
        parent.role = "CONTEXT";
      } else {
        for (const pid of lin.possibleParentIPOIds) {
          previous.find((p) => p.id === pid)?.possibleChildIds.push(node.id);
        }
      }
      levelNodes.push(node);

      const firstRelevant = findFirstRelevantConfirmation(lvl.candles, z.candleIndex, z.direction, ledger);
      levelEntries.push({
        id: z.id, symbol: z.symbol, timeframe: lvl.timeframe, direction: z.direction,
        candleIndex: z.candleIndex, candleDatetime: z.candleDatetime, candle: z.candle,
        geometry: z.geometry,
        confirmation: {
          ordering: firstRelevant.departureBreakOrdering ?? "NO_CONFIRMATION",
          firstRelevant,
          detectorBreak: z.structure,
        },
        liquidity: z.liquidity,
        departureFvg: z.departureFvg,
        consolidation: {
          status: z.consolidationStatus,
          interpretation: z.consolidationInterpretation,
          flagRaised: z.consolidationFlagRaised,
          profile: z.consolidation,
          note: CONSOLIDATION_NOTE,
        },
        lifecycle: z.lifecycle,
        lineage: {
          timeframe: lvl.timeframe, refinementDepth: depth,
          parentIPOId: node.parentIPOId, parentTimeframe: node.parentTimeframe,
          possibleParentIPOIds: node.possibleParentIPOIds,
          lineageAmbiguous: node.lineageAmbiguous,
          lineageResolvedBy: node.lineageResolvedBy,
          childIds: node.childIds, possibleChildIds: node.possibleChildIds,
          role: node.role,
          standalone: depth > 0 && node.possibleParentIPOIds.length === 0,
          parentInView: true,          // set for real after the range filter
          parentAgeDays: null,         // both filled once every level is resolved
          parentAgeBars: null,
        },
        selection: z.selection,
        atrAtCandle: z.atrAtCandle,
        valid: z.valid,
        researchStatus: z.researchStatus,
        coexistenceNote: COEXISTENCE_NOTE,
      });
    }

    out.push(...levelEntries);
    previous = levelNodes;
  });

  // Child lists and roles are only knowable once every level has been resolved,
  // so they are derived here from the finished set rather than patched onto
  // parents as children appear.
  const nodeById = new Map(out.map((e) => [e.id, e]));
  for (const e of out) {
    const kids = out.filter((c) => c.lineage.parentIPOId === e.id);
    e.lineage.childIds = kids.map((c) => c.id);
    e.lineage.possibleChildIds = out
      .filter((c) => c.lineage.parentIPOId === null && c.lineage.possibleParentIPOIds.includes(e.id))
      .map((c) => c.id);
    e.lineage.role = kids.length > 0 ? "CONTEXT" : "EXECUTION";
    if (e.lineage.parentIPOId) {
      const p = nodeById.get(e.lineage.parentIPOId) ?? null;
      e.lineage.parentTimeframe = p?.timeframe ?? null;
      if (p) {
        const pt = Date.parse(p.candleDatetime), ct = Date.parse(e.candleDatetime);
        e.lineage.parentAgeDays = Number.isNaN(pt) || Number.isNaN(ct)
          ? null : Math.round(((ct - pt) / 86400000) * 10) / 10;
        const parentLevel = levels.find((l) => l.timeframe === p.timeframe);
        e.lineage.parentAgeBars = parentLevel
          ? parentLevel.candles.filter((k) => k.datetime > p.candleDatetime && k.datetime <= e.candleDatetime).length
          : null;
      }
    }
  }

  const from = opts.from ? opts.from.slice(0, 10) : null;
  const to = opts.to ? opts.to.slice(0, 10) : null;
  const shown = out.filter((e) => {
    const d = e.candleDatetime.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
  const visible = new Set(shown.map((e) => e.id));
  for (const e of shown) {
    e.lineage.parentInView = e.lineage.parentIPOId === null || visible.has(e.lineage.parentIPOId);
  }
  return shown;
}

/**
 * Bars of each level that fall INSIDE the requested date range.
 *
 * Density must use the same window as the zones it counts. Dividing zones from
 * a three-month slice by a fifteen-year bar count understates IPOs per 100 bars
 * by two orders of magnitude, and the number still looks plausible — the first
 * live run reported 0.6 per 100 bars for a slice whose real density was 1.4.
 */
export function inventoryViewBars(
  levels: Array<{ timeframe: string; candles: Candle[] }>,
  opts: { from?: string; to?: string } = {},
): Record<string, number> {
  const from = opts.from ? opts.from.slice(0, 10) : null;
  const to = opts.to ? opts.to.slice(0, 10) : null;
  const out: Record<string, number> = {};
  for (const l of levels) {
    out[l.timeframe] = l.candles.filter((c) => {
      const d = c.datetime.slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    }).length;
  }
  return out;
}

/** Aggregate shape of an inventory. No precision term — see the note. */
export function inventorySummary(
  entries: IPOInventoryEntry[],
  barsByTimeframe: Record<string, number>,
) {
  const n = entries.length;
  const pct = (k: number) => (n ? Math.round((k / n) * 1000) / 10 : 0);
  const ord = (o: ConfirmationOrdering) => entries.filter((e) => e.confirmation.ordering === o).length;
  const totalBars = Object.values(barsByTimeframe).reduce((a, b) => a + b, 0);
  const withParent = entries.filter((e) => e.lineage.parentIPOId !== null).length;
  const ambiguous = entries.filter((e) => e.lineage.lineageAmbiguous).length;
  return {
    zones: n,
    iposPer100Bars: totalBars ? Math.round((n / totalBars) * 1000) / 10 : null,
    perTimeframe: Object.fromEntries(
      Object.entries(barsByTimeframe).map(([tf, bars]) => {
        const k = entries.filter((e) => e.timeframe === tf).length;
        return [tf, { zones: k, bars, per100Bars: bars ? Math.round((k / bars) * 1000) / 10 : null }];
      }),
    ),
    confirmation: {
      strictConfirmedPct: pct(ord("DEPARTURE_BEFORE_BREAK")),
      sameBarPct: pct(ord("SAME_BAR_UNVERIFIABLE")),
      noConfirmationPct: pct(ord("NO_CONFIRMATION")),
      counts: {
        DEPARTURE_BEFORE_BREAK: ord("DEPARTURE_BEFORE_BREAK"),
        SAME_BAR_UNVERIFIABLE: ord("SAME_BAR_UNVERIFIABLE"),
        NO_CONFIRMATION: ord("NO_CONFIRMATION"),
      },
    },
    lineage: {
      withResolvedParent: withParent,
      ambiguousParentage: ambiguous,
    parentOutsideView: entries.filter((e) => !e.lineage.parentInView).length,
      standalone: entries.filter((e) => e.lineage.standalone).length,
      contextRole: entries.filter((e) => e.lineage.role === "CONTEXT").length,
      executionRole: entries.filter((e) => e.lineage.role === "EXECUTION").length,
    },
    consolidation: {
      UNRESOLVED: entries.filter((e) => e.consolidation.status === "UNRESOLVED").length,
      note: CONSOLIDATION_NOTE,
    },
    note:
      "No precision or false-positive rate is computed. An inventory zone that " +
      "matches no demonstrated example is UNLABELLED, not wrong — nobody has " +
      "said it is not an IPO.",
  };
}

// ─── D. evaluation against demonstrated IPOs ─────────────────────────────────
//
// THE OLD SCORE IS RETIRED. "One correct IPO per break" treated the detector as
// a classifier with exactly one right answer per event, so every extra zone was
// a mistake by construction and the only way to improve was to suppress zones.
// That is the opposite of the model: IPOs coexist.
//
// The question here is COVERAGE. Of the IPOs actually demonstrated, how many
// does the inventory contain? Zones with no matching demonstration are
// UNLABELLED — nobody has said they are not IPOs — so no precision, accuracy or
// false-positive rate is computed anywhere in this file. Reporting one would
// require negatives that do not exist.
//
// CORRELATED DEMONSTRATIONS. A Weekly -> Daily -> 4H refinement of one move is
// a single demonstration shown at three scales, not three independent
// confirmations. Counting it as three would let one well-chosen example inflate
// the headline threefold, so the primary figure is computed per demonstration
// GROUP and the per-example figure is reported beside it, never instead of it.

export interface DemonstratedExample {
  id: string;
  symbol: string;
  timeframe: string;
  direction: IPODirection;
  /** Null when the exact bar could not be recovered from the demonstration. */
  candleDatetime: string | null;
  /** Zone bounds as drawn in the demonstration, when they were recoverable. */
  demonstratedZoneLow?: number | null;
  demonstratedZoneHigh?: number | null;
  /** All rows sharing a group are ONE demonstration seen at several scales. */
  exampleGroupId: string | null;
  parentExampleId: string | null;
  evidenceSource: EvidenceSource;
}

export type MatchState =
  | "EXACT_CANDLE"
  /**
   * A screenshot gave only the calendar day, the timeframe is intraday, and
   * exactly ONE direction-compatible zone exists on that day. Distinct from
   * EXACT_CANDLE on purpose: the demonstration did not name the bar, we
   * inferred it from there being no alternative. If a later corpus row pins the
   * time and disagrees, this is the match that was wrong.
   */
  | "DATE_ONLY_SINGLE_MATCH"
  /** Same, but several zones share the day. Which one was shown is unknown. */
  | "DATE_ONLY_AMBIGUOUS"
  | "SAME_BAR_OTHER_DIRECTION"
  | "ABSENT"
  | "UNDATED_EXAMPLE";
export type GeometryMatch = "MATCH" | "MISMATCH" | "NOT_DEMONSTRATED";
export type LineageMatch =
  | "MATCHED"
  | "MISMATCHED"
  | "AMBIGUOUS_IN_INVENTORY"
  | "PARENT_NOT_IN_INVENTORY"
  | "NOT_DEMONSTRATED";

export interface DemonstratedExampleResult {
  exampleId: string;
  symbol: string;
  timeframe: string;
  direction: IPODirection;
  candleDatetime: string | null;
  exampleGroupId: string | null;
  evidenceSource: EvidenceSource;
  presentInInventory: boolean;
  matchState: MatchState;
  matchedZoneId: string | null;
  /** Populated for DATE_ONLY_AMBIGUOUS: the zones that share the day. */
  candidateZoneIds: string[];
  geometryMatch: GeometryMatch;
  geometryDetail: { expected: [number, number] | null; actual: [number, number] | null; toleranceAtr: number | null };
  confirmationState: ConfirmationOrdering | null;
  lifecycleState: IPOStatus | null;
  lineageMatch: LineageMatch;
  lineageDetail: { demonstratedParentExampleId: string | null; inventoryParentId: string | null; possibleParents: string[] };
}

/**
 * How many minutes one bar of this timeframe spans, or null if unrecognised.
 * Accepts the forms this project actually passes around: 1d, 1day, 1week, 4h,
 * 15min, 1h, 30m.
 */
export function timeframeMinutes(tf: string): number | null {
  const m = String(tf).trim().toLowerCase().match(/^(\d+)\s*(min|mins|minute|minutes|m|h|hr|hour|hours|d|day|days|w|week|weeks|mo|month|months)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (/^(min|mins|minute|minutes|m)$/.test(unit)) return n;
  if (/^(h|hr|hour|hours)$/.test(unit)) return n * 60;
  if (/^(d|day|days)$/.test(unit)) return n * 1440;
  if (/^(w|week|weeks)$/.test(unit)) return n * 10080;
  return n * 43200;
}

/** True for a timeframe whose bars are shorter than one day. */
export function isIntradayTimeframe(tf: string): boolean {
  const m = timeframeMinutes(tf);
  return m === null || m < 1440;
}

/** True when a datetime carries no time component at all. */
export function isDateOnly(dt: string): boolean {
  return !/\d{2}:\d{2}/.test(String(dt));
}

/**
 * Match key precision, chosen by timeframe.
 *
 * COLLAPSING TO A DATE IS WRONG INTRADAY. A 4H chart has six bars per calendar
 * day and a 15m chart has ninety-six; keying on the date alone makes them all
 * the same bar, so a demonstrated 04:00 IPO would match a 20:00 zone and report
 * as covered. On daily and above the reverse risk applies — providers stamp
 * daily bars 00:00:00, 00:00:00Z or 21:00:00 depending on the feed — so those
 * keep date-only keys and stay robust to the stamp.
 *
 * Unrecognised timeframes get MINUTE precision: matching too strictly reports a
 * miss, which is visible and correctable, whereas matching too loosely reports
 * false coverage.
 */
export function barKey(datetime: string | null, timeframe: string): string | null {
  if (!datetime) return null;
  const norm = String(datetime).replace(" ", "T");
  const mins = timeframeMinutes(timeframe);
  const intraday = mins === null || mins < 1440;
  return intraday ? norm.slice(0, 16) : norm.slice(0, 10);
}

/**
 * Coverage of demonstrated IPOs by an inventory.
 *
 * Geometry is compared within a tolerance derived from the matched zone's own
 * ATR, because a zone read off a video screenshot cannot be expected to agree
 * to the tick. When the demonstration did not record bounds the result is
 * NOT_DEMONSTRATED rather than a pass — an unrecorded value must not count as
 * agreement.
 */
export function evaluateDemonstratedCoverage(
  entries: IPOInventoryEntry[],
  examples: DemonstratedExample[],
  barsByTimeframe: Record<string, number> = {},
  geometryToleranceAtr = 0.25,
): {
  demonstratedIPOCoverage: Record<string, unknown>;
  reconstructedExamples: Record<string, unknown>;
  secondary: Record<string, unknown>;
  results: DemonstratedExampleResult[];
  unlabelled: Record<string, unknown>;
  note: string;
} {
  const byKey = new Map<string, IPOInventoryEntry>();
  for (const e of entries) {
    byKey.set(`${e.symbol}|${e.timeframe}|${e.direction}|${barKey(e.candleDatetime, e.timeframe)}`, e);
  }
  const anyDirection = new Map<string, IPOInventoryEntry[]>();
  for (const e of entries) {
    const k = `${e.symbol}|${e.timeframe}|${barKey(e.candleDatetime, e.timeframe)}`;
    anyDirection.set(k, [...(anyDirection.get(k) ?? []), e]);
  }

  const matchedIdByExample = new Map<string, string>();
  const results: DemonstratedExampleResult[] = examples.map((x) => {
    const d = barKey(x.candleDatetime, x.timeframe);
    let hit = d ? byKey.get(`${x.symbol}|${x.timeframe}|${x.direction}|${d}`) ?? null : null;

    // DATE-ONLY EXAMPLE ON AN INTRADAY CHART.
    //
    // A screenshot often gives 2020-05-08 and nothing finer. On a 4H chart the
    // inventory keys that day as six separate bars, so the exact-key lookup
    // misses every one of them and the example reads ABSENT — a detector
    // failure reported where the only thing missing was a timestamp in OUR
    // records. Fall back to the calendar day, and say so in the match state
    // rather than dressing an inference up as an exact match.
    let candidateZoneIds: string[] = [];
    let dateOnly = false;
    if (!hit && x.candleDatetime && isDateOnly(x.candleDatetime) &&
        isIntradayTimeframe(x.timeframe)) {
      dateOnly = true;
      const day = x.candleDatetime.slice(0, 10);
      candidateZoneIds = entries
        .filter((e) => e.symbol === x.symbol && e.timeframe === x.timeframe &&
          e.direction === x.direction && e.candleDatetime.slice(0, 10) === day)
        .map((e) => e.id);
      if (candidateZoneIds.length === 1) hit = entries.find((e) => e.id === candidateZoneIds[0])!;
    }
    if (hit) matchedIdByExample.set(x.id, hit.id);

    let matchState: MatchState;
    if (!d) matchState = "UNDATED_EXAMPLE";
    else if (dateOnly && candidateZoneIds.length === 1) matchState = "DATE_ONLY_SINGLE_MATCH";
    else if (dateOnly && candidateZoneIds.length > 1) matchState = "DATE_ONLY_AMBIGUOUS";
    else if (hit) matchState = "EXACT_CANDLE";
    else if ((anyDirection.get(`${x.symbol}|${x.timeframe}|${d}`) ?? []).length) {
      matchState = "SAME_BAR_OTHER_DIRECTION";
    } else matchState = "ABSENT";

    // geometry
    let geometryMatch: GeometryMatch = "NOT_DEMONSTRATED";
    let expected: [number, number] | null = null;
    let actual: [number, number] | null = null;
    let tol: number | null = null;
    if (x.demonstratedZoneLow != null && x.demonstratedZoneHigh != null) {
      expected = [x.demonstratedZoneLow, x.demonstratedZoneHigh];
      if (hit) {
        actual = [hit.geometry.zoneLow, hit.geometry.zoneHigh];
        tol = geometryToleranceAtr * (hit.atrAtCandle || 0);
        geometryMatch = (Math.abs(actual[0] - expected[0]) <= tol && Math.abs(actual[1] - expected[1]) <= tol)
          ? "MATCH" : "MISMATCH";
      } else {
        geometryMatch = "MISMATCH";
      }
    }

    return {
      exampleId: x.id, symbol: x.symbol, timeframe: x.timeframe, direction: x.direction,
      candleDatetime: x.candleDatetime, exampleGroupId: x.exampleGroupId,
      evidenceSource: x.evidenceSource,
      presentInInventory: hit !== null,
      matchState, matchedZoneId: hit?.id ?? null, candidateZoneIds,
      geometryMatch,
      geometryDetail: { expected, actual, toleranceAtr: tol },
      confirmationState: hit ? hit.confirmation.ordering : null,
      lifecycleState: hit ? hit.lifecycle.status : null,
      lineageMatch: "NOT_DEMONSTRATED",
      lineageDetail: {
        demonstratedParentExampleId: x.parentExampleId,
        inventoryParentId: hit?.lineage.parentIPOId ?? null,
        possibleParents: hit?.lineage.possibleParentIPOIds ?? [],
      },
    };
  });

  // Lineage needs every example resolved first, because a demonstrated parent
  // is identified by ITS match, not by its example id.
  for (let i = 0; i < examples.length; i++) {
    const x = examples[i];
    if (!x.parentExampleId) continue;
    const r = results[i];
    const expectedParentZoneId = matchedIdByExample.get(x.parentExampleId) ?? null;
    if (!expectedParentZoneId) { r.lineageMatch = "PARENT_NOT_IN_INVENTORY"; continue; }
    if (!r.matchedZoneId) { r.lineageMatch = "MISMATCHED"; continue; }
    if (r.lineageDetail.inventoryParentId === expectedParentZoneId) r.lineageMatch = "MATCHED";
    else if (r.lineageDetail.possibleParents.includes(expectedParentZoneId)) r.lineageMatch = "AMBIGUOUS_IN_INVENTORY";
    else r.lineageMatch = "MISMATCHED";
  }

  // ── primary metric, group-aware and demonstration-only ────────────────────
  //
  // A ROW WE RECONSTRUCTED IS NOT A DEMONSTRATION. OPERATIONAL_INTERPRETATION
  // exists in the corpus so a row inferred by us — a bar read off a chart we
  // redrew, an example rebuilt from a description — cannot masquerade as one
  // that was shown. Counting those in the headline would let the coverage
  // figure be raised by adding our own guesses to the corpus, which is the
  // cheapest possible way to make this number look good and the least
  // informative. They are evaluated in full and reported in their own block.
  const isDemonstrated = (x: DemonstratedExample) => x.evidenceSource !== "OPERATIONAL_INTERPRETATION";
  const demoIdx: number[] = [];
  const reconIdx: number[] = [];
  examples.forEach((x, i) => (isDemonstrated(x) ? demoIdx : reconIdx).push(i));

  const groupOf = (x: DemonstratedExample) => x.exampleGroupId ?? `solo:${x.id}`;
  const groupCounts = (idx: number[]) => {
    const groups = new Map<string, DemonstratedExampleResult[]>();
    for (const i of idx) {
      const g = groupOf(examples[i]);
      groups.set(g, [...(groups.get(g) ?? []), results[i]]);
    }
    let full = 0, partial = 0, missed = 0;
    for (const rs of groups.values()) {
      const hits = rs.filter((r) => r.presentInInventory).length;
      if (hits === rs.length) full++;
      else if (hits > 0) partial++;
      else missed++;
    }
    return { total: groups.size, full, partial, missed };
  };

  const rnd = (v: number) => Math.round(v * 1000) / 10;
  const g = groupCounts(demoIdx);
  const matchedExamples = demoIdx.filter((i) => results[i].presentInInventory).length;
  const rg = groupCounts(reconIdx);

  // An ambiguous date-only example is neither covered nor missed: a zone for
  // that day exists, but the demonstration did not say which one, so claiming
  // it would assert an identification we have not made. It is excluded from the
  // headline and reported as the gap between a lower and an upper bound.
  const ambiguous = demoIdx.filter((i) => results[i].matchState === "DATE_ONLY_AMBIGUOUS").length;
  const dateOnlySingle = demoIdx.filter((i) => results[i].matchState === "DATE_ONLY_SINGLE_MATCH").length;

  const demonstratedIPOCoverage = {
    byDemonstration: {
      total: g.total,
      fullyCovered: g.full,
      partiallyCovered: g.partial,
      missed: g.missed,
      /** THE HEADLINE. A W->D->4H chain counts once, however many rows it has. */
      fullyCoveredPct: g.total ? rnd(g.full / g.total) : null,
      anyCoveragePct: g.total ? rnd((g.full + g.partial) / g.total) : null,
    },
    byExample: {
      total: demoIdx.length,
      matched: matchedExamples,
      pct: demoIdx.length ? rnd(matchedExamples / demoIdx.length) : null,
      note: "Reported beside the group figure, never instead of it: a single " +
        "demonstration shown at three timeframes contributes three rows here.",
    },
    evidenceBasis: {
      countedSources: EVIDENCE_SOURCES.filter((e) => e !== "OPERATIONAL_INTERPRETATION"),
      counted: demoIdx.length,
      byEvidenceSource: Object.fromEntries(EVIDENCE_SOURCES.map((e) =>
        [e, examples.filter((x) => x.evidenceSource === e).length])),
      note: "OPERATIONAL_INTERPRETATION rows are EXCLUDED from every figure above. " +
        "A row we reconstructed is not a demonstration, and letting one raise " +
        "coverage would make the metric self-serving.",
    },
    dateOnlyExamples: {
      singleMatch: dateOnlySingle,
      ambiguous,
      note: "Calendar-day-only examples on an intraday chart. A single match is " +
        "counted as covered but flagged DATE_ONLY_SINGLE_MATCH, because the bar " +
        "was inferred from having no alternative rather than demonstrated. An " +
        "ambiguous one is counted as NEITHER covered nor missed — see " +
        "coverageUpperBoundPct — and recording the demonstrated time resolves it.",
    },
    coverageUpperBoundPct: demoIdx.length
      ? rnd((matchedExamples + ambiguous) / demoIdx.length)
      : null,
    undatedExamples: demoIdx.filter((i) => results[i].matchState === "UNDATED_EXAMPLE").length,
  };

  const reconstructedExamples = {
    total: reconIdx.length,
    matched: reconIdx.filter((i) => results[i].presentInInventory).length,
    demonstrations: rg.total,
    fullyCovered: rg.full,
    note: "OPERATIONAL_INTERPRETATION rows. Evaluated in full and reported here " +
      "only — never folded into demonstrated coverage.",
  };

  const demoResults = demoIdx.map((i) => results[i]);
  const withLineage = demoResults.filter((r) => r.lineageMatch !== "NOT_DEMONSTRATED");
  const secondary = {
    ...inventorySummary(entries, barsByTimeframe),
    parentChildCoverage: {
      demonstratedRelationships: withLineage.length,
      matched: withLineage.filter((r) => r.lineageMatch === "MATCHED").length,
      ambiguousInInventory: withLineage.filter((r) => r.lineageMatch === "AMBIGUOUS_IN_INVENTORY").length,
      mismatched: withLineage.filter((r) => r.lineageMatch === "MISMATCHED").length,
      parentNotInInventory: withLineage.filter((r) => r.lineageMatch === "PARENT_NOT_IN_INVENTORY").length,
      pct: withLineage.length
        ? rnd(withLineage.filter((r) => r.lineageMatch === "MATCHED").length / withLineage.length)
        : null,
    },
    geometryAgreement: {
      demonstrated: demoResults.filter((r) => r.geometryMatch !== "NOT_DEMONSTRATED").length,
      match: demoResults.filter((r) => r.geometryMatch === "MATCH").length,
      mismatch: demoResults.filter((r) => r.geometryMatch === "MISMATCH").length,
      note: "NOT_DEMONSTRATED where the demonstration recorded no bounds. An " +
        "unrecorded value is not agreement.",
    },
  };

  const matchedZoneIds = new Set(results.map((r) => r.matchedZoneId).filter(Boolean) as string[]);
  const unlabelled = {
    count: entries.length - matchedZoneIds.size,
    label: "UNLABELLED_COEXISTING",
    note: "Zones matching no demonstrated example. These are NOT false positives " +
      "and are not counted against coverage: no one has evaluated them, and " +
      "coexisting IPOs are expected. Turning them into negatives would " +
      "manufacture the labels this research does not have.",
  };

  return {
    demonstratedIPOCoverage, reconstructedExamples, secondary, results, unlabelled,
    note: "Coverage only. No precision, accuracy or false-positive rate is " +
      "computed, because there are no labelled negatives to compute one against.",
  };
}

// ─── C. corpus intake validation ─────────────────────────────────────────────

/**
 * Validates demonstrated-IPO rows before they reach the corpus table.
 *
 * The database enforces what it can — direction, evidence source, paired zone
 * bounds, self-parenthood — but three things it cannot: a cycle deeper than one
 * hop, a parent that is not in the same demonstration group, and a row trying
 * to carry a LABEL. The last one matters most. This corpus is positives only;
 * accepting a `label` field would be the first step to inferring negatives from
 * unmarked candles, so it is refused loudly rather than ignored silently.
 */
export function validateCorpusExamples(rows: any[]): Array<{ row: number; why: string }> {
  const problems: Array<{ row: number; why: string }> = [];

  // A row may name its parent either by a batch-local handle (localId /
  // localParentId, used when neither row exists yet) or by a real stored id.
  // Both forms resolve through the same map so a cycle is caught either way.
  const handleOf = (e: any) => (e.localId ?? e.id) == null ? null : String(e.localId ?? e.id);
  const parentOf = (e: any) =>
    (e.localParentId ?? e.parentExampleId) == null ? null : String(e.localParentId ?? e.parentExampleId);

  const idAt = new Map<string, number>();
  rows.forEach((e, i) => { const h = handleOf(e); if (h !== null) idAt.set(h, i); });

  rows.forEach((e, i) => {
    const bad = (why: string) => problems.push({ row: i, why });
    if (!e.symbol) bad("symbol required");
    if (!e.timeframe) bad("timeframe required");
    if (e.direction !== "demand" && e.direction !== "supply") bad("direction must be demand or supply");
    if (e.evidenceSource && !EVIDENCE_SOURCES.includes(e.evidenceSource)) {
      bad(`evidenceSource must be one of ${EVIDENCE_SOURCES.join(", ")}`);
    }
    if ("label" in e) {
      bad("this corpus holds POSITIVES ONLY — it has no label column, and an " +
        "unmarked candle must never be recorded as a negative");
    }
    const lo = e.demonstratedZoneLow, hi = e.demonstratedZoneHigh;
    if ((lo == null) !== (hi == null)) bad("demonstrated zone bounds must be given as a pair or not at all");
    if (lo != null && hi != null && !(lo < hi)) bad("demonstratedZoneLow must be below demonstratedZoneHigh");

    const parent = parentOf(e);
    if (!parent) return;
    const parentIsLocal = idAt.has(parent);
    if (handleOf(e) !== null && parent === handleOf(e)) bad("a row cannot be its own parent");

    // A chain built inside the batch has its group MINTED by the planner, so
    // requiring one here would reject a perfectly well-formed W->D->4H send.
    // A parent that already lives in the database is different: minting a new
    // group would split one demonstration in two, so the caller must name the
    // existing group explicitly.
    if (!parentIsLocal && !e.exampleGroupId) {
      bad("a child of an already-stored parent must name that parent's exampleGroupId — " +
        "minting a new one would split the demonstration");
    }

    if (!parentIsLocal) return;
    const seen = new Set<number>([i]);
    let cur: number | undefined = idAt.get(parent);
    while (cur !== undefined) {
      if (seen.has(cur)) { bad("refinement chain contains a cycle"); break; }
      seen.add(cur);
      const pRow = rows[cur];
      if (e.exampleGroupId && pRow.exampleGroupId &&
          String(pRow.exampleGroupId) !== String(e.exampleGroupId)) {
        bad("parent belongs to a different demonstration group");
        break;
      }
      const pp = parentOf(pRow);
      cur = pp === null ? undefined : idAt.get(pp);
    }
  });
  return problems;
}
