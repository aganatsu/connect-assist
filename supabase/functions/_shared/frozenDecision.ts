/**
 * The decision, frozen at the moment it was made.
 *
 * See docs/FROZEN_DECISION_RECORD.md. The short version: the system overwrites
 * what it decided with what happened. `stop_loss` trails and the entry stop is
 * lost. `balance` mutates with no ledger. So "was that an 8.4-pip stop, or a
 * 25-pip stop that moved?" and "why did identical setups risk $270 then $540?"
 * were both unanswerable across 65 Era C trades.
 *
 * WHY THIS IS SHARED CODE AND NOT A BLOCK AT EACH CALL SITE
 *
 * sizingProvenance and slFloorTrace already exist and are correct — and reach
 * 3 of 63 trades, because they were added to one of four position-creation
 * routes. Measured, not feared. Coverage is the whole problem, so the builder
 * lives in one place and a test asserts every route calls it.
 *
 * WHAT GOES IN
 *
 * Only facts known at the decision, and only facts that were unanswerable.
 * An oversized context is a migration cost on every future change.
 *
 * WHAT STAYS OUT
 *
 * `crossTimeframeContext`. All 34 generated columns on these tables read that
 * subtree and it belongs to a feature that is not running. Writing plausible
 * values so those columns show something would recreate the exact failure this
 * exists to fix. Left absent, every related CHECK passes — each is guarded on
 * IS NULL.
 *
 * THE HASH
 *
 * Do not set frozen_strategy_hash. A BEFORE trigger computes it as md5 of
 * Postgres's own normalised jsonb text, which cannot be reproduced client-side.
 * See 20260915120000_frozen_decision_hash_trigger.sql.
 */

export const FROZEN_DECISION_CONTRACT = "frozen-decision.v1";

export interface FrozenDecisionInput {
  /** Which path created this. "manual" has no analysis behind it. */
  route: "market-entry" | "pending-order" | "confirmation-fill" | "manual";
  balanceAtEntry?: number | null;
  riskPercent?: number | null;
  sizeLots?: number | null;
  entryPrice?: number | null;
  /** The stop as placed. NOT the current stop — that is what gets overwritten. */
  stopAtEntry?: number | null;
  pipSize?: number | null;
  /** From slFloorTrace, when the route computed one. */
  slFloor?: {
    staticMinSlPips?: number | null;
    atrFloorPips?: number | null;
    effectiveMinSlPips?: number | null;
    actualSlPips?: number | null;
    widened?: boolean | null;
  } | null;
  /** From sizingProvenance, when the route computed one. */
  sizing?: Record<string, unknown> | null;
  configHash?: string | null;
  tradingStyle?: string | null;
  /** displacement / candleQuality / sequence off the impulse leg. */
  leg?: Record<string, unknown> | null;
}

export interface FrozenDecision {
  contractVersion: string;
  frozenAt: string;
  route: string;
  risk: {
    balanceAtEntry: number | null;
    riskPercent: number | null;
    riskDollars: number | null;
    sizeLots: number | null;
  };
  stop: {
    entryPrice: number | null;
    priceAtEntry: number | null;
    distancePips: number | null;
    floorPips: number | null;
    floorApplied: boolean | null;
    source: "floor" | "structure" | "unknown";
  };
  config: { hash: string | null; tradingStyle: string | null };
  sizing: Record<string, unknown> | null;
  leg: Record<string, unknown> | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Build the record. Every field is nullable on purpose: a route that cannot
 * know something records null rather than a plausible default. A default here
 * would be indistinguishable from a measurement later, which is the failure
 * mode this file exists to prevent.
 */
export function buildFrozenDecision(input: FrozenDecisionInput): FrozenDecision {
  const balance = num(input.balanceAtEntry);
  const riskPct = num(input.riskPercent);
  const entry = num(input.entryPrice);
  const stop = num(input.stopAtEntry);
  const pip = num(input.pipSize);

  // Distance measured from the prices as placed, not read back from a column
  // that trailing will later overwrite.
  const distancePips = entry !== null && stop !== null && pip !== null && pip > 0
    ? Math.round((Math.abs(entry - stop) / pip) * 10) / 10
    : num(input.slFloor?.actualSlPips);

  const floorPips = num(input.slFloor?.effectiveMinSlPips);
  const widened = typeof input.slFloor?.widened === "boolean" ? input.slFloor.widened : null;

  return {
    contractVersion: FROZEN_DECISION_CONTRACT,
    frozenAt: new Date().toISOString(),
    route: input.route,
    risk: {
      balanceAtEntry: balance,
      riskPercent: riskPct,
      // Derived rather than passed, so it cannot disagree with its own inputs.
      riskDollars: balance !== null && riskPct !== null
        ? Math.round(balance * (riskPct / 100) * 100) / 100
        : null,
      sizeLots: num(input.sizeLots),
    },
    stop: {
      entryPrice: entry,
      priceAtEntry: stop,
      distancePips,
      floorPips,
      floorApplied: widened,
      // "unknown" when the route did not compute a floor — not "structure",
      // which would assert something nobody checked.
      source: widened === true ? "floor" : widened === false ? "structure" : "unknown",
    },
    config: {
      hash: input.configHash ?? null,
      tradingStyle: input.tradingStyle ?? null,
    },
    sizing: input.sizing ?? null,
    leg: input.leg ?? null,
  };
}
