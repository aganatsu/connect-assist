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
  type Candle,
  type FairValueGap,
  type LiquidityPool,
} from "./smcAnalysis.ts";

export type IPODirection = "demand" | "supply";
export type IPOStatus =
  /** Price has not yet left the zone on the departure side, so no retest can count. */
  | "UNARMED_FOR_RETEST"
  | "ACTIVE" | "TESTED" | "BROKEN" | "FLIPPED";

export type IPORejectionReason = "INSIDE_CONSOLIDATION";

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
  /** Passed every rule. These are the detections. */
  valid: IPOZone[];
  /** Found structurally, then refused by interpretation. NEVER a detection. */
  rejected: IPOZone[];
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
  return { valid: all.filter((z) => z.valid), rejected: all.filter((z) => !z.valid) };
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

    // An IPO formed inside consolidation is not a valid IPO. It is still built
    // and returned as REJECTED so the evidence survives.
    const con = assessConsolidation(candles, i);
    const rejectionReason: IPORejectionReason | null =
      con.insideConsolidation ? "INSIDE_CONSOLIDATION" : null;

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
