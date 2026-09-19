// ─── Canonical structure shadow comparison ──────────────────────────────────
//
// Runs analyzeMarketStructureCanonical BESIDE the live engine and reports a
// compact diff. The live engine stays authoritative: nothing here is returned
// in place of an existing value, and no downstream decision reads any of it.
//
// CANDIDATE CONFIGURATION, chosen 2026-09-19 from five-symbol offline
// measurement:
//
//   policy           latest_unbroken_structural
//   maxEventAgeBars  50
//
// Why this pair. latest_confirmed retires 104-115 levels per symbol unbroken,
// and 63-75% of them are subsequently close-broken — and 73-85% of those
// retirements happen because a newer pointer confirmed somewhere the old level
// never even reached. latest_unbroken_structural keeps them, but then emits on
// levels up to 343 bars old. The 50-bar cap removes 5-12 events per symbol,
// essentially all of them BOS (10 CHoCH removals against ~190 BOS across every
// symbol and cap), while preserving the GBP/CAD 1.84018 reference case with a
// wide margin — it fires 5 bars after confirmation.
//
// THE CAP APPLIES TO EVENT ELIGIBILITY ONLY. The factual ledger stays
// unlimited: an over-age level remains in swingLevelBreaks, remains sweepable,
// and is still carried as alsoBrokenLevels metadata. It simply cannot emit a
// BOS/CHoCH. Conflating those two layers is what inflated the first
// chronological attempt threefold.
//
// OFF BY DEFAULT. Enabling needs a Supabase secret, deliberately NOT a
// bot_configs key: config drift is detected by hashing config_json, so adding
// a key there would read as a strategy parameter moving when nothing about the
// strategy changed.
//
//   supabase secrets set STRUCTURE_CANONICAL_SHADOW=true
import {
  analyzeMarketStructureCanonical,
  type Candle,
  type StructureBreak,
} from "./smcAnalysis.ts";

// ── BLOCKER FOR ANY WHOLESALE STRUCTURE REPLACEMENT: derivedSR ──────────────
//
// analyzeMarketStructure returns a `derivedSR` object — auto support/resistance
// derived from each BOS, with active/broken lists. analyzeMarketStructureCanonical
// DOES NOT. Its return has no derivedSR field at all.
//
// Two live consumers would silently degrade if the canonical object were swapped
// in wholesale:
//
//   confluenceScoring.ts:425  reads structure.derivedSR.active and awards +0.2 to
//                             the Market Structure factor when price sits within
//                             0.5 ATR of an unbroken BOS-derived level
//   bot-scanner/index.ts:5226 serialises derivedSR.active / .broken into the
//                             scan detail payload
//
// Neither would throw. `structure.derivedSR` would be undefined, the guard would
// short-circuit, and the bonus would quietly stop being awarded — a silent
// subtraction that type-checks, which is the exact failure shape that has cost
// this repo a day before (the atrValue return that zeroed five consumers).
//
// So the canonical engine is NOT a drop-in replacement for the structure object
// today, only for the BOS/CHoCH/trend parts of it. Closing this means either
// porting the derived-S/R computation into the canonical engine or having
// callers keep reading derivedSR from the live engine. Until then, do not
// substitute the object.
export const SHADOW_POLICY = "latest_unbroken_structural" as const;
export const SHADOW_MAX_EVENT_AGE_BARS = 50;

export type ShadowDisagreementReason =
  | "same"
  | "current_missing"
  | "current_late"
  | "current_early"
  | "different_primary_level"
  | "different_BOS_CHoCH";

export interface ShadowEventSummary {
  index: number;
  datetime: string | null;
  level: number | null;
  significance: string | null;
  type: string | null;
  barsSinceConfirmation: number | null;
}

export interface StructureShadowDiff {
  site: string;
  policy: string;
  maxEventAgeBars: number;
  bars: number;
  /** Live engine's trend. SWING GEOMETRY — last 2 highs and last 2 lows. */
  currentTrend: string | null;
  /**
   * Canonical's own `trend`: the running direction of the last emitted event.
   * A DIFFERENT CONCEPT from currentTrend — reported for information, never
   * compared against it. See canonicalGeometricTrend.
   */
  canonicalTrend: string | null;
  /**
   * Canonical's swing points run through the LIVE engine's trend rule, so the
   * comparison is like-for-like. This is what trendAgrees uses.
   */
  canonicalGeometricTrend: string | null;
  /** currentTrend vs canonicalGeometricTrend. Same definition, both sides. */
  trendAgrees: boolean;
  latestBOS: { current: ShadowEventSummary | null; canonical: ShadowEventSummary | null; agrees: boolean; reason: ShadowDisagreementReason };
  latestCHoCH: { current: ShadowEventSummary | null; canonical: ShadowEventSummary | null; agrees: boolean; reason: ShadowDisagreementReason };
  latestEvent: { current: ShadowEventSummary | null; canonical: ShadowEventSummary | null; agrees: boolean; reason: ShadowDisagreementReason };
  counts: {
    currentBOS: number; currentCHoCH: number;
    canonicalBOS: number; canonicalCHoCH: number;
    canonicalLedgerEntries: number;
    canonicalIneligibleByAge: number;
  };
}

/**
 * Off unless the secret is set to exactly "true". Any other value, including
 * "1" or "TRUE", leaves it off — an ambiguous flag that half-enables a second
 * structure engine is worse than one that stays off.
 */
export function isCanonicalShadowEnabled(): boolean {
  try {
    return Deno.env.get("STRUCTURE_CANONICAL_SHADOW") === "true";
  } catch {
    return false;   // no env permission, e.g. under a restricted test runner
  }
}

const summarise = (b: StructureBreak | undefined | null): ShadowEventSummary | null =>
  b
    ? {
      index: b.index,
      datetime: b.datetime ?? null,
      level: b.level ?? null,
      significance: b.significance ?? null,
      type: b.type ?? null,
      barsSinceConfirmation: (b as any).barsSinceConfirmation ?? null,
    }
    : null;

const LEVEL_TOL = 1e-8;

/**
 * The live engine's trend rule, applied to an arbitrary swing set.
 *
 * WHY THIS EXISTS. The two engines define `trend` from different inputs:
 *
 *   live      swing GEOMETRY — bullish only if the last two highs AND the last
 *             two lows both rise; bearish only if both fall; else ranging. It
 *             never reads BOS/CHoCH. (smcAnalysis.ts:1108-1114)
 *   canonical the running direction of the last emitted structure EVENT.
 *
 * Comparing those two directly is apples-to-oranges, and the first version of
 * this diff did exactly that: on 2026-09-19 it reported four BTC/USD "trend
 * disagreements" where live said ranging and canonical said bearish. Both were
 * correct under their own definition. The field was manufacturing findings.
 *
 * Mirroring the rule here lets canonical's swings be judged by the same
 * standard, so a disagreement means the SWINGS differ — which is a real
 * finding — rather than that the definitions differ, which is not.
 */
export function geometricTrendFromSwings(
  swingPoints: Array<{ type: string; price: number; index: number }>,
): "bullish" | "bearish" | "ranging" {
  const ordered = [...swingPoints].sort((a, b) => a.index - b.index);
  const highs = ordered.filter((s) => s.type === "high");
  const lows = ordered.filter((s) => s.type === "low");
  if (highs.length < 2 || lows.length < 2) return "ranging";
  const rH = highs.slice(-2), rL = lows.slice(-2);
  if (rH[1].price > rH[0].price && rL[1].price > rL[0].price) return "bullish";
  if (rH[1].price < rH[0].price && rL[1].price < rL[0].price) return "bearish";
  return "ranging";
}

/**
 * Classify one pair of latest-events.
 *
 * Order matters. `current_missing` is checked first because a missing event is
 * not a late one, and reporting it as late would understate the defect that
 * started this work — the GBP/CAD external low that was never reported at all,
 * not reported slowly.
 */
function classify(
  cur: ShadowEventSummary | null,
  can: ShadowEventSummary | null,
): ShadowDisagreementReason {
  if (!can && !cur) return "same";
  if (can && !cur) return "current_missing";
  if (!can && cur) return "different_primary_level";  // current has one canonical does not
  const sameLevel = Math.abs((cur!.level ?? NaN) - (can!.level ?? NaN)) < LEVEL_TOL;
  if (!sameLevel) return "different_primary_level";
  // Exhaustive in BOTH directions. The earlier version returned "same" when
  // the live engine reported the level EARLIER than canonical, which marked a
  // genuine timing disagreement as agreement — the one outcome a comparison
  // tool must never produce, because it hides the thing it exists to surface.
  //
  // current_early is not merely the mirror of current_late. Canonical emits on
  // the first close through an already-confirmed swing, so the live engine
  // beating it means one of them is reading the level or its confirmation
  // differently, and that is worth seeing rather than smoothing over.
  if (cur!.index > can!.index) return "current_late";
  if (cur!.index < can!.index) return "current_early";
  return "same";
}

/**
 * Build the compact diff. Returns null when the flag is off, so callers can
 * attach the result unconditionally without branching.
 *
 * The full ledger is deliberately NOT included: this runs per analysis, per
 * symbol, per scan cycle, and logging ~100 ledger entries every time would
 * bury the signal and cost more than the comparison is worth.
 */
export function buildStructureShadowDiff(
  candles: Candle[],
  current: {
    trend?: string;
    bos?: StructureBreak[];
    choch?: StructureBreak[];
    swingPoints?: Array<{ type: string; price: number; index: number }>;
  },
  site: string,
): StructureShadowDiff | null {
  if (!isCanonicalShadowEnabled()) return null;
  if (!Array.isArray(candles) || candles.length < 20) return null;

  let canonical;
  try {
    canonical = analyzeMarketStructureCanonical(candles, {
      policy: SHADOW_POLICY,
      maxEventAgeBars: SHADOW_MAX_EVENT_AGE_BARS,
    });
  } catch {
    // A shadow must never be able to break the live path. If the candidate
    // engine throws, the caller gets null and production carries on unaware.
    return null;
  }

  const canonicalGeometric = geometricTrendFromSwings(canonical.swingPoints ?? []);

  const last = <T extends { index: number }>(xs: T[] | undefined) =>
    xs && xs.length ? xs.reduce((a, b) => (b.index >= a.index ? b : a)) : null;

  const curBos = summarise(last(current.bos));
  const canBos = summarise(last(canonical.bos));
  const curCh = summarise(last(current.choch));
  const canCh = summarise(last(canonical.choch));
  const curAny = summarise(last([...(current.bos ?? []), ...(current.choch ?? [])]));
  const canAny = summarise(last([...canonical.bos, ...canonical.choch]));

  // Kind disagreement is only meaningful when both engines are talking about
  // the same level on the same bar; otherwise they are different events, not a
  // reclassification.
  const anyReason: ShadowDisagreementReason = (() => {
    const base = classify(curAny, canAny);
    if (base !== "same" || !curAny || !canAny) return base;
    const curIsBos = (current.bos ?? []).some(b => b.index === curAny.index);
    const canIsBos = canonical.bos.some(b => b.index === canAny.index);
    return curIsBos === canIsBos ? "same" : "different_BOS_CHoCH";
  })();

  return {
    site,
    policy: SHADOW_POLICY,
    maxEventAgeBars: SHADOW_MAX_EVENT_AGE_BARS,
    bars: candles.length,
    currentTrend: current.trend ?? null,
    canonicalTrend: canonical.trend ?? null,
    canonicalGeometricTrend: canonicalGeometric,
    // Like-for-like. NOT current.trend vs canonical.trend — those are two
    // different definitions and comparing them produced false disagreements.
    trendAgrees: (current.trend ?? null) === canonicalGeometric,
    latestBOS: { current: curBos, canonical: canBos, agrees: classify(curBos, canBos) === "same", reason: classify(curBos, canBos) },
    latestCHoCH: { current: curCh, canonical: canCh, agrees: classify(curCh, canCh) === "same", reason: classify(curCh, canCh) },
    latestEvent: { current: curAny, canonical: canAny, agrees: anyReason === "same", reason: anyReason },
    counts: {
      currentBOS: (current.bos ?? []).length,
      currentCHoCH: (current.choch ?? []).length,
      canonicalBOS: canonical.bos.length,
      canonicalCHoCH: canonical.choch.length,
      canonicalLedgerEntries: canonical.swingLevelBreaks.length,
      canonicalIneligibleByAge:
        canonical.swingLevelBreaks.filter((x: any) => x.structureEventEligible === false).length,
    },
  };
}

/**
 * True when the diff contains at least one disagreement.
 *
 * Telemetry is gated on this. A scan cycle produces one diff per symbol, so
 * recording agreements would generate thousands of identical "same" rows that
 * say nothing and make the disagreements harder to find. The consequence,
 * stated on the table comment too: row count is a DISAGREEMENT count, not a
 * scan count, and must never be read as a rate without a denominator from
 * somewhere else.
 */
export function shadowDisagrees(d: StructureShadowDiff): boolean {
  return !d.trendAgrees ||
    d.latestEvent.reason !== "same" ||
    d.latestBOS.reason !== "same" ||
    d.latestCHoCH.reason !== "same";
}

/**
 * Persist one disagreement row. Compact by design: no candles, no swing list,
 * no ledger — a row is a verdict, not a snapshot.
 *
 * Never throws and never blocks. A telemetry write that can fail a scan is
 * worse than no telemetry, and this repo has already lost trades to a
 * diagnostic insert being refused by a trigger while the caller swallowed the
 * error. Here the swallow is deliberate and the table carries no trigger.
 */
export async function recordStructureShadow(
  supabase: any,
  params: {
    userId: string;
    botId?: string | null;
    symbol: string;
    timeframe?: string | null;
    diff: StructureShadowDiff | null;
  },
): Promise<"skipped" | "written" | "failed"> {
  const d = params.diff;
  if (!d) return "skipped";                 // flag off, or shadow unavailable
  if (!shadowDisagrees(d)) return "skipped";
  try {
    const { error } = await supabase.from("structure_shadow_telemetry").insert({
      user_id: params.userId,
      bot_id: params.botId ?? null,
      symbol: params.symbol,
      timeframe: params.timeframe ?? null,
      site: d.site,
      bars: d.bars,
      policy: d.policy,
      max_event_age_bars: d.maxEventAgeBars,
      current_trend: d.currentTrend,
      canonical_trend: d.canonicalTrend,
      canonical_geometric_trend: d.canonicalGeometricTrend,
      trend_agrees: d.trendAgrees,
      latest_event_reason: d.latestEvent.reason,
      latest_bos_reason: d.latestBOS.reason,
      latest_choch_reason: d.latestCHoCH.reason,
      current_index: d.latestEvent.current?.index ?? null,
      current_datetime: d.latestEvent.current?.datetime ?? null,
      current_level: d.latestEvent.current?.level ?? null,
      current_significance: d.latestEvent.current?.significance ?? null,
      current_type: d.latestEvent.current?.type ?? null,
      canonical_index: d.latestEvent.canonical?.index ?? null,
      canonical_datetime: d.latestEvent.canonical?.datetime ?? null,
      canonical_level: d.latestEvent.canonical?.level ?? null,
      canonical_significance: d.latestEvent.canonical?.significance ?? null,
      canonical_type: d.latestEvent.canonical?.type ?? null,
      canonical_bars_since_confirmation: d.latestEvent.canonical?.barsSinceConfirmation ?? null,
      current_bos_count: d.counts.currentBOS,
      current_choch_count: d.counts.currentCHoCH,
      canonical_bos_count: d.counts.canonicalBOS,
      canonical_choch_count: d.counts.canonicalCHoCH,
      canonical_ledger_entries: d.counts.canonicalLedgerEntries,
      canonical_ineligible_by_age: d.counts.canonicalIneligibleByAge,
    });
    if (error) {
      // Surfaced in logs, never rethrown. Silent swallowing is what made the
      // 2026-09-16 insert failure invisible for a day.
      console.warn(`[structureShadow] telemetry insert failed: ${error.message}`);
      return "failed";
    }
    return "written";
  } catch (e) {
    console.warn(`[structureShadow] telemetry insert threw: ${(e as Error)?.message}`);
    return "failed";
  }
}
