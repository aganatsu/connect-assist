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

export type PositionStatus = "open" | "data_gap_suspended";
export type ExitReason = "TARGET_2R" | "S2_CLOSE_INVALIDATION" | "DATA_GAP_ABORTED";

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

export function openPosition(
  intent: PaperIntent, sizing: SizingConfig = DEFAULT_SIZING,
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
  };
}

// ─── management ──────────────────────────────────────────────────────────────

export type StepOutcome =
  | { kind: "HOLD"; position: PaperPosition }
  | { kind: "CLOSED"; result: PaperResult };

/**
 * Advances an open position by exactly one CLOSED bar.
 *
 * IPO semantics only. There is no break-even, no trailing, no partial and no
 * wick-stop: a wick through S2 does NOT close the position, which is the whole
 * character of the rule and the reason IPO must never enter SMC's breach path.
 *
 * Order matches the frozen engine: S2 is tested BEFORE the target, so a bar
 * doing both is a loss. `sameBarAmbiguous` records it so the optimistic reading
 * stays recoverable without changing the result.
 */
export function stepPosition(
  pos: PaperPosition, bar: Candle, barsHeld: number,
): StepOutcome {
  const long = pos.direction === "long";
  const risk = pos.nominalRiskDistance;

  const adverse = long ? pos.entryPrice - bar.low : bar.high - pos.entryPrice;
  const favourable = long ? bar.high - pos.entryPrice : pos.entryPrice - bar.low;
  const maeR = Math.max(pos.maeR, adverse / risk);
  const mfeR = Math.max(pos.mfeR, favourable / risk);

  const hitTarget = long ? bar.high >= pos.targetPrice : bar.low <= pos.targetPrice;
  const closedBeyond = long ? bar.close < pos.s2InvalidationLevel
                            : bar.close > pos.s2InvalidationLevel;

  const advanced: PaperPosition = {
    ...pos, maeR, mfeR, lastManagedBarTime: bar.datetime,
  };

  const close = (exitPrice: number, grossR: number, reason: ExitReason): StepOutcome => {
    const realizedR = grossR - pos.costR;
    return {
      kind: "CLOSED",
      result: {
        position: advanced, exitTime: bar.datetime, exitPrice, exitReason: reason,
        realizedR, grossR, realizedPnlUsd: realizedR * pos.nominalRiskUsd,
        maeR, mfeR, barsHeld,
        sameBarAmbiguous: hitTarget && closedBeyond,
        excludedFromStats: false, exclusionReason: null,
      },
    };
  };

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
  };
}
