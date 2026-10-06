/**
 * STEP 8 SIMPLIFICATION — explicit switches for the frozen minimal config.
 *
 * Every switch defaults to the LEGACY behaviour, so deploying this code
 * changes nothing until the config sets the switch. The frozen experiment
 * config sets them explicitly (docs/STEP8_SIMPLIFICATION_PLAN_V1.md).
 *
 * "log" means: the gate is still evaluated and its would-block result is
 * recorded on the decision (for later TEST arms), but it no longer blocks.
 */
import { getQuoteToUSDRate, SPECS } from "./smcAnalysis.ts";

export type GateMode = "gate" | "log";

export interface SimplificationSwitches {
  /** SMC confluence score threshold: decision gate + Gate 9. */
  scoreGateMode: GateMode;
  /** Gate 3b reaction confirmation. */
  reactionGateMode: GateMode;
  /** Gate 10 R:R on the confluence engine's pre-override SL/TP ("legacy"), or the
   *  effective R:R of the Route 2 order as actually placed ("order_geometry"). */
  rrGateMode: "legacy" | "order_geometry";
  /** Minimum effective R:R (after spread + commission) for order_geometry. */
  orderRRMin: number;
  /** Gate 16 news-event filter + the news-alignment gate. */
  newsGateMode: GateMode;
  /** Unified as entry / SL / size modifier and Impulse-gate bypass. Detection and
   *  attribution are always logged. */
  unifiedModifiersEnabled: boolean;
  /** While entries_locked: run the full pipeline and place Route 2 orders flagged
   *  dry_run (never filled into positions) to measure the funnel. */
  dryRunWhenLocked: boolean;
  /** Step 9: "legacy" keeps the placement-time Route 2 size (with the 0.5×
   *  standalone cut); "fill_time" sizes at the actual fill to riskPercent. */
  sizingMode: "legacy" | "fill_time";
  /** Risk per trade (% of balance at fill) for fill_time sizing. */
  riskPercent: number;
  /** Safety ceiling in lots (the 10× leverage cap also applies). */
  maxLotsPerTrade: number;
}

export const LEGACY_SWITCHES: SimplificationSwitches = {
  scoreGateMode: "gate",
  reactionGateMode: "gate",
  rrGateMode: "legacy",
  orderRRMin: 1.0,
  newsGateMode: "gate",
  unifiedModifiersEnabled: true,
  dryRunWhenLocked: false,
  sizingMode: "legacy",
  riskPercent: 0.5,
  maxLotsPerTrade: 20,
};

const mode = (v: unknown, fallback: GateMode): GateMode => (v === "gate" || v === "log" ? v : fallback);

/** Reads `config_json.simplification`. Unknown / absent values → legacy. */
export function resolveSimplification(raw: Record<string, unknown> | null | undefined): SimplificationSwitches {
  const s = (raw?.simplification ?? {}) as Record<string, unknown>;
  const rrMin = typeof s.orderRRMin === "number" && Number.isFinite(s.orderRRMin) && s.orderRRMin > 0 ? s.orderRRMin : LEGACY_SWITCHES.orderRRMin;
  return {
    scoreGateMode: mode(s.scoreGateMode, LEGACY_SWITCHES.scoreGateMode),
    reactionGateMode: mode(s.reactionGateMode, LEGACY_SWITCHES.reactionGateMode),
    rrGateMode: s.rrGateMode === "order_geometry" ? "order_geometry" : "legacy",
    orderRRMin: rrMin,
    newsGateMode: mode(s.newsGateMode, LEGACY_SWITCHES.newsGateMode),
    unifiedModifiersEnabled: s.unifiedModifiersEnabled === false ? false : true,
    dryRunWhenLocked: s.dryRunWhenLocked === true,
    sizingMode: s.sizingMode === "fill_time" ? "fill_time" : "legacy",
    riskPercent: typeof s.riskPercent === "number" && s.riskPercent > 0 && s.riskPercent <= 5 ? s.riskPercent : LEGACY_SWITCHES.riskPercent,
    maxLotsPerTrade: typeof s.maxLotsPerTrade === "number" && s.maxLotsPerTrade > 0 ? s.maxLotsPerTrade : LEGACY_SWITCHES.maxLotsPerTrade,
  };
}

export type GateId = "reaction" | "score" | "rr_legacy" | "news_event" | "news_alignment";
export interface GateResult { passed: boolean; reason: string; gateId?: GateId; loggedOnly?: boolean; wouldBlock?: boolean }

/** Which gate ids are log-only under these switches. */
export function loggedOnlyGateIds(sw: SimplificationSwitches): Set<GateId> {
  const ids = new Set<GateId>();
  if (sw.reactionGateMode === "log") ids.add("reaction");
  if (sw.scoreGateMode === "log") ids.add("score");
  if (sw.rrGateMode === "order_geometry") ids.add("rr_legacy");
  if (sw.newsGateMode === "log") { ids.add("news_event"); ids.add("news_alignment"); }
  return ids;
}

/**
 * Turns a log-only gate's block into a pass that records it would have
 * blocked. Every other gate is returned unchanged. Pure.
 */
export function applyLoggedOnlyGates(gates: GateResult[], sw: SimplificationSwitches): { gates: GateResult[]; wouldHaveBlocked: { gateId: GateId; reason: string }[] } {
  const ids = loggedOnlyGateIds(sw);
  const wouldHaveBlocked: { gateId: GateId; reason: string }[] = [];
  const out = gates.map((g) => {
    if (!g.gateId || !ids.has(g.gateId)) return g;
    if (g.passed) return { ...g, loggedOnly: true, wouldBlock: false };
    wouldHaveBlocked.push({ gateId: g.gateId, reason: g.reason });
    return { ...g, passed: true, loggedOnly: true, wouldBlock: true, reason: `[logged only — would block] ${g.reason}` };
  });
  return { gates: out, wouldHaveBlocked };
}

/**
 * Effective R:R of an order as placed: (|target − entry| − costs) / |entry − stop|,
 * costs = typical spread + commission converted to price — the same cost model
 * as Gate 10, applied to the geometry that is actually placed.
 */
export function orderEffectiveRR(o: {
  entry: number; stop: number; target: number; symbol: string;
  rateMap?: Record<string, number>; commissionPerLot?: number;
}): { rawRR: number; effectiveRR: number; costInPrice: number; spreadPips: number } {
  const spec = SPECS[o.symbol] || SPECS["EUR/USD"];
  const risk = Math.abs(o.entry - o.stop);
  const reward = Math.abs(o.target - o.entry);
  const spreadPips = spec.typicalSpread ?? 1;
  const spreadCost = spreadPips * spec.pipSize;
  const q = getQuoteToUSDRate(o.symbol, o.rateMap);
  const comm = (o.commissionPerLot ?? 0) > 0 ? (o.commissionPerLot as number) / (spec.lotUnits * q) : 0;
  const cost = spreadCost + comm;
  return {
    rawRR: risk > 0 ? reward / risk : 0,
    effectiveRR: risk > 0 ? Math.max(0, reward - cost) / risk : 0,
    costInPrice: cost,
    spreadPips,
  };
}

/**
 * Unified's entry/SL/TP/risk next to the Impulse values the same setup would
 * have used, so Unified's effect stays measurable after it stops modifying.
 */
export function unifiedVsImpulse(input: {
  direction: "long" | "short" | null;
  tpRatio: number;
  pipSize: number;
  unified: { entryPrice?: number | null; slPrice?: number | null; state?: string | null; score?: number | null } | null;
  impulse: { refinedEntry?: number | null; high?: number | null; low?: number | null; originSL?: number | null } | null;
}) {
  const side = input.direction === "long" ? 1 : input.direction === "short" ? -1 : 0;
  const leg = (entry: number | null | undefined, sl: number | null | undefined) => {
    if (entry == null || sl == null || !side) return null;
    const risk = Math.abs(entry - sl);
    return { entry, sl, tp: entry + side * risk * input.tpRatio, riskPrice: risk, riskPips: risk / input.pipSize };
  };
  const impEntry = input.impulse?.refinedEntry ?? (input.impulse?.high != null && input.impulse?.low != null ? (input.impulse.high + input.impulse.low) / 2 : null);
  const u = leg(input.unified?.entryPrice, input.unified?.slPrice);
  const i = leg(impEntry, input.impulse?.originSL ?? null);
  return {
    unified: u ? { ...u, state: input.unified?.state ?? null, score: input.unified?.score ?? null } : null,
    impulse: i,
    entryDiffPips: u && i ? (u.entry - i.entry) / input.pipSize : null,
    riskRatioUnifiedToImpulse: u && i && i.riskPrice > 0 ? u.riskPrice / i.riskPrice : null,
  };
}
