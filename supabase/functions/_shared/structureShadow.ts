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
  currentTrend: string | null;
  canonicalTrend: string | null;
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
  current: { trend?: string; bos?: StructureBreak[]; choch?: StructureBreak[] },
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
    trendAgrees: (current.trend ?? null) === (canonical.trend ?? null),
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
