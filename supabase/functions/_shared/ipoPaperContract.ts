/**
 * IPO paper-trading contract. Phase D. PURE — no database, no network.
 *
 * Turns frozen-engine events into paper positions and results. It decides
 * nothing about the strategy: entry, target and S2 all arrive already computed
 * by `ipoIncrementalEngine`, and this module only records, sizes and manages.
 *
 * R IS CANONICAL. `realizedR` is the strategy result. `realizedPnlUsd` is a
 * VIEW of it under whatever nominal sizing was configured at the time, never
 * the other way round — so changing a risk policy later cannot retroactively
 * change a historical strategy result.
 *
 * THE SIZING MODEL IS NOT A RISK MODEL. `nominalRiskUsd` is a unit of account,
 * not a maximum loss. S2 is the invalidation, and S2 losses routinely exceed
 * 1R: measured over validation, 97% of losers exceed 1R, median 1.75R, worst
 * 17.3R. At the default $200 per 1R a −3R outcome is about −$600. Nothing here
 * caps that, and nothing should pretend to.
 *
 * THE ONLY EXECUTION RULE ADDED IS DEDUCTIVE. `costR > 2` means the round-trip
 * cost exceeds the entire 2R target, so a perfect win still loses money. That
 * is arithmetic, not a statistical filter — no 0.5R / 0.75R / 1R threshold
 * exists here, and the IPO signal itself stays VALID. Only execution is blocked.
 */

import type { Candle } from "./smcAnalysis.ts";
import type { LiveTrade } from "./ipoLiveEngine.ts";
import {
  CAUSAL_EXECUTION_VERSION,
  type AltBranch, type BarOrdering, type ResolutionMethod,
} from "./ipoCausalOrdering.ts";

export { CAUSAL_EXECUTION_VERSION };

export const STRATEGY_ID = "ipo_cet";
export const STRATEGY_VERSION = "spec-1.1";

/**
 * Paper sizing. Configurable by the caller — the engine never sees it, so a
 * later risk policy cannot leak into signal generation.
 */
export interface SizingConfig {
  referenceBalance: number;
  nominalRiskPct: number;
}

export const DEFAULT_SIZING: SizingConfig = {
  referenceBalance: 100_000,
  nominalRiskPct: 0.20,
};

/** $ per 1R. No compounding: the reference balance is fixed for comparability. */
export function nominalRiskUsd(s: SizingConfig): number {
  return (s.referenceBalance * s.nominalRiskPct) / 100;
}

/**
 * The single deductive execution rule.
 *
 * With a fixed 2R target, a round-trip cost above 2R makes a positive net
 * outcome impossible even on a perfect win.
 */
export const COST_R_HARD_LIMIT = 2;

export type StrategyDecision = "WOULD_ENTER" | "WOULD_NOT_ENTER" | "WOULD_EXIT" | "HOLD";
export type AccountDecision =
  | "ALLOW" | "UNAVAILABLE"
  | "BLOCK_CORRELATION" | "BLOCK_MAX_POSITIONS"
  | "BLOCK_PORTFOLIO_HEAT" | "BLOCK_PROP_FIRM";
export type ExecutionDecision = "EXECUTED" | "BLOCKED";
export type ExecutionBlockReason =
  | "ECONOMICALLY_UNTRADEABLE_COST"
  | "POSITION_ALREADY_OPEN"
  | "ACCOUNT_SAFETY";

export type PositionStatus = "open" | "data_gap_suspended" | "ordering_ambiguous";

/**
 * A position whose own existence-or-exit cannot be established from the data.
 *
 * WHY THIS STATE HAS TO EXIST. When entry and target fall inside one minute
 * there are two viable paths and OHLC cannot separate them:
 *
 *   entry then target  -> the trade closed at +2R gross on its fill bar
 *   target then entry  -> the target was PRE-ENTRY and the trade is STILL OPEN
 *
 * Closing on that ambiguity — which an earlier draft of this fix did — frees the
 * one-position-per-instrument slot and admits later IPOs that exist in only one
 * of the two branches. The unresolved trade would have been excluded from
 * statistics while silently contaminating every trade after it.
 *
 * So the OPEN branch is carried as a real position and the other branch is
 * frozen here beside it. The slot stays held until EVERY branch agrees no
 * position remains.
 */
export interface AmbiguityState {
  kind: "ENTRY_VS_TARGET_SAME_MINUTE" | "ENTRY_BAR_TARGET_TOUCH_NO_TAPE"
      | "ENTRY_NOT_PROVEN_IN_TAPE";
  /** The minute, or the bar, whose internal order is unknown. */
  atTime: string;
  /** What the branch that is NOT open asserts. */
  altBranch: AltBranch;
  /** Its exit, when it has one. Null for the NO_POSITION branch. */
  altExitTime: string | null;
  altExitPrice: number | null;
  altNetR: number | null;
  /**
   * The bar on which the alternative branch freed the slot. Compared against
   * the open branch's eventual exit bar to decide whether the two futures
   * actually diverged, or merely took different routes to the same bar.
   */
  altFreedAtBarTime: string;
  detail: string;
}
/**
 * `ORDERING_UNRESOLVED` is a DATA verdict, not a strategy outcome. It is emitted
 * when competing events cannot be ordered against the fill — most often entry
 * and target inside the same minute with no tick feed to separate them. Like
 * `DATA_GAP_ABORTED` it carries no realized R and is excluded from statistics:
 * inventing a winner or a loser there is exactly the contamination the causal
 * ordering work exists to remove.
 */
export type ExitReason =
  | "TARGET_2R" | "S2_CLOSE_INVALIDATION" | "DATA_GAP_ABORTED" | "ORDERING_UNRESOLVED";

/** How an ambiguity ended. Recorded on the closed row; never a strategy input. */
export type AmbiguityResolution =
  /** Every branch reached the same outcome with the same R. The result stands. */
  | "CONVERGED_SAME_OUTCOME"
  /** Branches ended differently. No R can be claimed; the row is excluded. */
  | "DIVERGED_TERMINAL"
  /** The trade ended while a branch disagreed about whether it ever existed. */
  | "EXISTENCE_UNPROVEN";

/**
 * Repeated-zone exposure telemetry. OBSERVATION ONLY.
 *
 * The frozen sequencing rule is `touchIndex > previousExitIndex`, so a still
 * valid IPO may be entered again once the previous trade on it has exited. That
 * is deliberate and is NOT changed here: no cooldown, no one-trade-per-zone, no
 * retirement. Altering it would be a strategy change requiring its own research
 * and version.
 *
 * What was missing is the ability to MEASURE it afterwards. A fixture run showed
 * four consecutive fills on one zone at an identical entry, target and stop, and
 * nothing recorded made that visible in the data. These fields make questions
 * like "win rate by re-entry ordinal" and "worst cumulative loss from one IPO"
 * answerable without re-deriving them from bars.
 *
 * NOTHING HERE FEEDS A DECISION. A test asserts the ordinal cannot reach the
 * execution verdict.
 */
export interface ZoneTelemetry {
  /**
   * 1 for the first trade on this IPO candle, 2 for the next, and so on.
   *
   * Counted over the ENGINE's trade list, which at activation already contains
   * the history the bootstrap replayed. So an ordinal of 3 on the first paper
   * trade means the engine had already taken this zone twice before paper
   * trading began — which is the honest answer to "how often has this zone been
   * traded", and is not the same as "how many paper rows exist for it".
   */
  zoneEntryOrdinal: number;
  /** Exit time of the previous trade on this same zone, or null for the first. */
  zonePreviousExitTime: string | null;
}

export interface PaperPosition extends ZoneTelemetry {
  strategyId: string;
  strategyVersion: string;
  setupId: string;
  intentId: string;
  symbol: string;
  timeframe: string;
  direction: "long" | "short";
  entryTime: string;
  entryPrice: number;
  targetPrice: number;
  s2InvalidationLevel: number;
  nominalRiskDistance: number;
  costR: number;
  referenceBalanceAtEntry: number;
  nominalRiskPct: number;
  nominalRiskUsd: number;
  ipoCandleTime: string;
  volatilityBucket: string;
  executionMode: "paper";
  status: PositionStatus;
  maeR: number;
  mfeR: number;
  lastManagedBarTime: string;
  gapFromBarTime: string | null;
  gapToBarTime: string | null;
  gapReason: string | null;
  // ── causal execution provenance (forward evidence boundary) ──
  /** Identity of the ordering model that produced this row. Null = legacy. */
  causalExecutionVersion: string | null;
  /** The minute the position actually came into existence, when 1m proved it. */
  entryMinuteTime: string | null;
  /** How the fill bar was ordered. */
  entryResolutionMethod: ResolutionMethod | null;
  /** Feed that supplied the HTF bars, and the one that supplied the minutes. */
  htfSource: string | null;
  minuteSource: string | null;
  /**
   * Set when the tape refused an exit the frozen engine booked from whole-bar
   * OHLC. The paper record then legitimately outlives the engine's trade, and
   * the runner's engine/paper agreement check must be told so explicitly rather
   * than discovering a divergence it cannot explain.
   */
  engineExitOverridden: boolean;
  engineExitBarTime: string | null;
  /** Non-null while a branch of this position's history cannot be ruled out. */
  ambiguity: AmbiguityState | null;
  /**
   * Set once an ambiguity on this instrument forked the trade SEQUENCE — the
   * branches freed the slot on different bars and a candidate existed in the
   * gap. From then on this instrument's forward trades are conditional on which
   * branch was real, so they are recorded with their outcomes but kept out of
   * the validated forward population.
   */
  sequenceContaminated: boolean;
  // ── observational context tag. NOT a gate. Never read by any decision. ──
  dailyStructure: string | null;
  dailyStructureAlignment: string | null;
  dailyStructureAsOf: string | null;
}

export interface PaperResult {
  position: PaperPosition;
  exitTime: string;
  exitPrice: number | null;
  exitReason: ExitReason;
  /** CANONICAL. Null only for a data-gap abort, which has no strategy outcome. */
  realizedR: number | null;
  grossR: number | null;
  realizedPnlUsd: number | null;
  maeR: number;
  mfeR: number;
  barsHeld: number;
  sameBarAmbiguous: boolean;
  excludedFromStats: boolean;
  exclusionReason: string | null;
  // ── causal execution provenance ──
  causalExecutionVersion: string | null;
  entryMinuteTime: string | null;
  targetMinuteTime: string | null;
  s2CloseBarTime: string | null;
  exitResolutionMethod: ResolutionMethod | null;
  /** What whole-bar OHLC alone would have booked, when it differs. Diagnostic. */
  htfWouldHaveBooked: string | null;
  // ── ambiguity reconciliation ──
  ambiguityKind: string | null;
  ambiguityResolution: AmbiguityResolution | null;
  /** Every branch's ending, as text, so the row explains itself. */
  branchOutcomes: string | null;
  /**
   * TRUE when the outcome is known but WHEN it happened is not. Both branches
   * of an entry-versus-target ambiguity that later reaches target are +2R with
   * the same cost, so the R is provable and the exit timestamp is not.
   */
  exitTimeAmbiguous: boolean;
  altExitTime: string | null;
  sequenceContaminated: boolean;
}

// ─── identity ────────────────────────────────────────────────────────────────

/**
 * Content-addressed keys, so retrying a bar is a no-op rather than a duplicate.
 *
 * A non-cryptographic digest is deliberate: these are uniqueness keys inside one
 * project's own tables, not security tokens, and a stable synchronous function
 * keeps the contract module pure.
 */
function digest(parts: Array<string | number>): string {
  const s = parts.join("|");
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i) + 1, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
}

export const setupId = (symbol: string, timeframe: string, ipoCandleTime: string, direction: string) =>
  `stp_${digest([STRATEGY_ID, symbol, timeframe, ipoCandleTime, direction])}`;

export const intentId = (setup: string, entryBarTime: string) =>
  `int_${digest([setup, entryBarTime])}`;

export const eventId = (type: string, ref: string, barTime: string) =>
  `evt_${digest([type, ref, barTime])}`;

// ─── intent ──────────────────────────────────────────────────────────────────

export interface PaperIntent extends ZoneTelemetry {
  setupId: string;
  intentId: string;
  symbol: string;
  timeframe: string;
  direction: "long" | "short";
  barTime: string;
  ipoCandleTime: string;
  entryPrice: number;
  targetPrice: number;
  s2InvalidationLevel: number;
  nominalRiskDistance: number;
  costR: number;
  volatilityBucket: string;
  strategyDecision: StrategyDecision;
  accountDecision: AccountDecision;
  execution: ExecutionDecision;
  blockReason: ExecutionBlockReason | null;
  reasonCodes: string[];
}

/**
 * Builds the intent for an `ENTERED` event.
 *
 * The strategy decision is always WOULD_ENTER here — the frozen engine already
 * admitted it. Execution is a separate verdict, and a block never rewrites the
 * strategy decision: that separation is what lets a forward test later measure
 * how much the economic rule cost.
 */
export function buildIntent(
  trade: LiveTrade, bars: Candle[], timeframe: string,
  accountDecision: AccountDecision = "UNAVAILABLE",
  zone: ZoneTelemetry = { zoneEntryOrdinal: 1, zonePreviousExitTime: null },
): PaperIntent {
  const barTime = bars[trade.entryIndex].datetime;
  const ipoCandleTime = bars[trade.ipoIndex].datetime;
  const direction = trade.direction === "demand" ? "long" : "short";
  const sid = setupId(trade.instrument, timeframe, ipoCandleTime, direction);

  const reasonCodes: string[] = [];
  let execution: ExecutionDecision = "EXECUTED";
  let blockReason: ExecutionBlockReason | null = null;

  if (trade.costR > COST_R_HARD_LIMIT) {
    execution = "BLOCKED";
    blockReason = "ECONOMICALLY_UNTRADEABLE_COST";
    reasonCodes.push("ECONOMICALLY_UNTRADEABLE_COST");
  }
  if (accountDecision !== "ALLOW" && accountDecision !== "UNAVAILABLE") {
    execution = "BLOCKED";
    blockReason = blockReason ?? "ACCOUNT_SAFETY";
    reasonCodes.push(accountDecision);
  }

  return {
    setupId: sid,
    intentId: intentId(sid, barTime),
    symbol: trade.instrument, timeframe, direction, barTime, ipoCandleTime,
    entryPrice: trade.entry, targetPrice: trade.target,
    s2InvalidationLevel: trade.stop, nominalRiskDistance: trade.risk,
    costR: trade.costR, volatilityBucket: trade.vol,
    // The signal is VALID regardless of the execution verdict.
    strategyDecision: "WOULD_ENTER",
    accountDecision, execution, blockReason, reasonCodes,
    // Recorded, never consulted: nothing above reads these.
    zoneEntryOrdinal: zone.zoneEntryOrdinal,
    zonePreviousExitTime: zone.zonePreviousExitTime,
  };
}

export interface CausalProvenance {
  causalExecutionVersion: string | null;
  entryMinuteTime: string | null;
  entryResolutionMethod: ResolutionMethod | null;
  htfSource: string | null;
  minuteSource: string | null;
  dailyStructure: string | null;
  dailyStructureAlignment: string | null;
  dailyStructureAsOf: string | null;
}

export const NO_RESULT_AMBIGUITY = {
  ambiguityKind: null, ambiguityResolution: null, branchOutcomes: null,
  exitTimeAmbiguous: false, altExitTime: null,
} as const;

export const NO_PROVENANCE: CausalProvenance = {
  causalExecutionVersion: null, entryMinuteTime: null, entryResolutionMethod: null,
  htfSource: null, minuteSource: null,
  dailyStructure: null, dailyStructureAlignment: null, dailyStructureAsOf: null,
};

export function openPosition(
  intent: PaperIntent, sizing: SizingConfig = DEFAULT_SIZING,
  provenance: CausalProvenance = NO_PROVENANCE,
): PaperPosition {
  return {
    strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION,
    setupId: intent.setupId, intentId: intent.intentId,
    symbol: intent.symbol, timeframe: intent.timeframe, direction: intent.direction,
    entryTime: intent.barTime, entryPrice: intent.entryPrice,
    targetPrice: intent.targetPrice, s2InvalidationLevel: intent.s2InvalidationLevel,
    nominalRiskDistance: intent.nominalRiskDistance, costR: intent.costR,
    referenceBalanceAtEntry: sizing.referenceBalance,
    nominalRiskPct: sizing.nominalRiskPct,
    nominalRiskUsd: nominalRiskUsd(sizing),
    ipoCandleTime: intent.ipoCandleTime, volatilityBucket: intent.volatilityBucket,
    zoneEntryOrdinal: intent.zoneEntryOrdinal,
    zonePreviousExitTime: intent.zonePreviousExitTime,
    executionMode: "paper", status: "open",
    maeR: 0, mfeR: 0, lastManagedBarTime: intent.barTime,
    gapFromBarTime: null, gapToBarTime: null, gapReason: null,
    ...provenance,
    engineExitOverridden: false, engineExitBarTime: null,
    ambiguity: null, sequenceContaminated: false,
  };
}

/**
 * Puts a freshly filled position into the ambiguous state.
 *
 * The OPEN branch becomes the live position — it is managed by later bars under
 * the ordinary rules, because that branch simply is an open position. The other
 * branch is frozen in `ambiguity` and reconciled when the open one terminates.
 */
export function openAmbiguous(
  pos: PaperPosition, ambiguity: AmbiguityState,
): PaperPosition {
  return { ...pos, status: "ordering_ambiguous", ambiguity };
}

/** The +2R the CLOSED_AT_TARGET branch claims, under this position's own cost. */
export function altTargetNetR(pos: PaperPosition): number {
  return Math.abs(pos.targetPrice - pos.entryPrice) / pos.nominalRiskDistance - pos.costR;
}

// ─── management ──────────────────────────────────────────────────────────────

export type StepOutcome =
  | { kind: "HOLD"; position: PaperPosition }
  | { kind: "CLOSED"; result: PaperResult };

/**
 * Settles a closed result against the branch that was carried beside it.
 *
 * THE ONE CASE WHERE AMBIGUITY STILL YIELDS A REAL RESULT. If the open branch
 * also ends at the target, both branches are +2R gross under the same cost
 * fixed at entry, so the realized R is provably identical and only the exit
 * TIMESTAMP is unknown. That is a converged outcome and it counts. Everything
 * else ends with no R at all — including the case where a branch says the trade
 * never existed, because an unprovable trade cannot contribute a number.
 */
function reconcile(result: PaperResult, a: AmbiguityState): PaperResult {
  const withAmbiguity = {
    ...result,
    ambiguityKind: a.kind,
    altExitTime: a.altExitTime,
  };

  if (a.altBranch === "NO_POSITION") {
    return {
      ...withAmbiguity,
      exitReason: "ORDERING_UNRESOLVED",
      exitPrice: null, realizedR: null, grossR: null, realizedPnlUsd: null,
      excludedFromStats: true,
      ambiguityResolution: "EXISTENCE_UNPROVEN",
      branchOutcomes: `NO_POSITION | ${result.exitReason}`,
      exclusionReason:
        `${a.detail} — one branch has no position at all, so no R can be claimed`,
    };
  }

  if (result.exitReason === "TARGET_2R") {
    return {
      ...withAmbiguity,
      ambiguityResolution: "CONVERGED_SAME_OUTCOME",
      branchOutcomes: "TARGET_2R | TARGET_2R",
      exitTimeAmbiguous: true,
      exclusionReason: null,
      excludedFromStats: false,
    };
  }

  return {
    ...withAmbiguity,
    exitReason: "ORDERING_UNRESOLVED",
    exitPrice: null, realizedR: null, grossR: null, realizedPnlUsd: null,
    excludedFromStats: true,
    ambiguityResolution: "DIVERGED_TERMINAL",
    branchOutcomes: `TARGET_2R | ${result.exitReason}`,
    exclusionReason:
      `${a.detail} — the branches ended differently (+2R against ${result.exitReason}), ` +
      `so no R is claimable`,
  };
}

/**
 * Advances an open position by exactly one CLOSED bar.
 *
 * IPO semantics only. There is no break-even, no trailing, no partial and no
 * wick-stop: a wick through S2 does NOT close the position, which is the whole
 * character of the rule and the reason IPO must never enter SMC's breach path.
 *
 * TWO MODES, AND THE DEFAULT IS THE OLD ONE.
 *
 * Without `ordering` this is the legacy whole-bar step: S2 tested before the
 * target, so a bar doing both is a loss, and every extreme of the bar counts
 * whether or not the position existed when it happened. That reading is
 * preserved deliberately — the forensic tests pin it, and it is the arithmetic
 * reference — but the forward runner NEVER calls it that way.
 *
 * With `ordering` the outcome has already been established chronologically by
 * `ipoCausalOrdering.resolveBar`, from the minute tape where the HTF bar alone
 * was ambiguous. This function then only prices it. Nothing about S2, the target
 * or the entry level changes: the lower timeframe supplies order, not levels.
 */
export function stepPosition(
  pos: PaperPosition, bar: Candle, barsHeld: number, ordering?: BarOrdering,
): StepOutcome {
  const long = pos.direction === "long";
  const risk = pos.nominalRiskDistance;

  // Post-entry excursions when the tape proved them; whole-bar otherwise, which
  // is correct for every bar after the fill because the position held all of it.
  const adverse = ordering?.postEntryAdverse ?? (long ? pos.entryPrice - bar.low : bar.high - pos.entryPrice);
  const favourable = ordering?.postEntryFavourable ?? (long ? bar.high - pos.entryPrice : pos.entryPrice - bar.low);
  const maeR = Math.max(pos.maeR, adverse / risk);
  const mfeR = Math.max(pos.mfeR, favourable / risk);

  const hitTarget = long ? bar.high >= pos.targetPrice : bar.low <= pos.targetPrice;
  const closedBeyond = long ? bar.close < pos.s2InvalidationLevel
                            : bar.close > pos.s2InvalidationLevel;

  const advanced: PaperPosition = {
    ...pos, maeR, mfeR, lastManagedBarTime: bar.datetime,
    entryMinuteTime: pos.entryMinuteTime ?? ordering?.entryMinute ?? null,
  };

  const close = (
    exitPrice: number | null, grossR: number | null, reason: ExitReason,
    extra: Partial<PaperResult> = {},
  ): StepOutcome => {
    const realizedR = grossR === null ? null : grossR - pos.costR;
    const result: PaperResult = {
      position: advanced, exitTime: bar.datetime, exitPrice, exitReason: reason,
      realizedR, grossR,
      realizedPnlUsd: realizedR === null ? null : realizedR * pos.nominalRiskUsd,
      maeR, mfeR, barsHeld,
      sameBarAmbiguous: hitTarget && closedBeyond,
      excludedFromStats: false, exclusionReason: null,
      causalExecutionVersion: pos.causalExecutionVersion,
      entryMinuteTime: advanced.entryMinuteTime,
      targetMinuteTime: ordering?.targetMinute ?? null,
      s2CloseBarTime: ordering?.s2CloseBarTime ?? null,
      exitResolutionMethod: ordering?.method ?? null,
      htfWouldHaveBooked: null,
      ...NO_RESULT_AMBIGUITY,
      sequenceContaminated: pos.sequenceContaminated,
      ...extra,
    };
    return { kind: "CLOSED", result: pos.ambiguity ? reconcile(result, pos.ambiguity) : result };
  };

  // ── causally ordered path ──────────────────────────────────────────────────
  if (ordering) {
    if (ordering.kind === "TARGET") {
      const gross = Math.abs(pos.targetPrice - pos.entryPrice) / risk;
      return close(pos.targetPrice, gross, "TARGET_2R");
    }
    if (ordering.kind === "S2_CLOSE") {
      const gross = (long ? bar.close - pos.entryPrice : pos.entryPrice - bar.close) / risk;
      return close(bar.close, gross, "S2_CLOSE_INVALIDATION");
    }
    if (ordering.kind === "UNRESOLVED_TERMINAL") {
      // The outcome is unknown, but EVERY branch exits on this bar, so the slot
      // is genuinely free and closing fabricates nothing.
      return close(null, null, "ORDERING_UNRESOLVED", {
        excludedFromStats: true,
        exclusionReason: ordering.detail,
      });
    }
    // AMBIGUOUS_OPEN_OR_CLOSED: a branch leaves the position running, so the
    // open branch holds. The caller records the alternative branch beside it;
    // it must NOT be applied as an exit here. HOLD and NEED_MINUTES likewise.
    return { kind: "HOLD", position: advanced };
  }

  // ── legacy whole-bar path, stop-first ──────────────────────────────────────
  if (closedBeyond) {
    const gross = (long ? bar.close - pos.entryPrice : pos.entryPrice - bar.close) / risk;
    return close(bar.close, gross, "S2_CLOSE_INVALIDATION");
  }
  if (hitTarget) {
    const gross = Math.abs(pos.targetPrice - pos.entryPrice) / risk;
    return close(pos.targetPrice, gross, "TARGET_2R");
  }
  return { kind: "HOLD", position: advanced };
}

// ─── data-gap handling ───────────────────────────────────────────────────────

export function suspendForGap(
  pos: PaperPosition, from: string, to: string, reason: string,
): PaperPosition {
  return { ...pos, status: "data_gap_suspended",
    gapFromBarTime: from, gapToBarTime: to, gapReason: reason };
}

export function resumeFromGap(pos: PaperPosition): PaperPosition {
  return { ...pos, status: "open",
    gapFromBarTime: null, gapToBarTime: null, gapReason: null };
}

/**
 * Abandons a position whose missing bars are permanently unavailable.
 *
 * NO FABRICATED EXIT. Marking it out at the first price seen after a gap would
 * invent a strategy outcome that never happened and contaminate the R
 * distribution — so there is no exit price, no realized R, and the row is
 * excluded from clean statistics at the column level rather than by a
 * convention every reader has to remember. This is a data-quality failure, not
 * an S2 or target result.
 */
export function abortForGap(pos: PaperPosition, at: string, reason: string): PaperResult {
  return {
    position: pos, exitTime: at, exitPrice: null, exitReason: "DATA_GAP_ABORTED",
    realizedR: null, grossR: null, realizedPnlUsd: null,
    maeR: pos.maeR, mfeR: pos.mfeR, barsHeld: 0,
    sameBarAmbiguous: false,
    excludedFromStats: true,
    exclusionReason: reason,
    causalExecutionVersion: pos.causalExecutionVersion,
    entryMinuteTime: pos.entryMinuteTime,
    targetMinuteTime: null, s2CloseBarTime: null,
    exitResolutionMethod: null, htfWouldHaveBooked: null,
    ...NO_RESULT_AMBIGUITY,
    ambiguityKind: pos.ambiguity?.kind ?? null,
    branchOutcomes: pos.ambiguity ? `${pos.ambiguity.altBranch} | DATA_GAP_ABORTED` : null,
    sequenceContaminated: pos.sequenceContaminated,
  };
}
