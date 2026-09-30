/**
 * SMC TRADE TELEMETRY — immutable entry record and realized R.
 *
 * WHY THIS EXISTS. `paper_trade_history.stop_loss` is the stop AT CLOSE, not
 * the stop at entry: management moves it, and on an SL exit the close writes
 * the same level as the exit. Measured on the live table, `stop_loss` equals
 * `exit_price` exactly on 354 of 453 rows (78.1%). Any R computed from it is a
 * division artifact — it produced +270 avgR on ETH/USD before the defect was
 * caught. There is no realized-R column, and no field records which execution
 * route opened the trade, so production trades cannot be checked against
 * causal research.
 *
 * This module supplies ONE definition of the entry facts and of R. It is pure:
 * no clock, no database, no config reads. Callers pass what they already have.
 *
 * TELEMETRY ONLY. Nothing here participates in a trade decision. It is written
 * after the decision is made and read only by analysis.
 */

import { SMC_CONTRACT_VERSION } from "./smcScanSnapshot.ts";

/** How the position was opened. Decided at entry, never inferred later. */
export type EntryRoute = "route1_market" | "route2_pending" | "legacy_unknown";

export interface EntryTelemetryInput {
  route: EntryRoute;
  direction: "long" | "short";
  /** The price actually transacted. For Route 1 this is production's
   *  `marketEntryPrice`; for Route 2 the observed fill, not the limit level. */
  entryPrice: number;
  /** Stop and target AS OF ENTRY, before any management touches them. */
  entryStopLoss: number;
  entryTakeProfit: number | null;
  /** Exact execution instant. NOT the parent candle's open. */
  entryTime: string;
  /** The strategy bar that contained the decision. May equal entryTime. */
  strategyBarTime: string | null;
  pipSize: number;
  tradingStyle: string | null;
  zoneTimeframe: string | null;
  configSnapshot: Record<string, unknown> | null;
  decisionSnapshot: Record<string, unknown> | null;
}

export interface EntryTelemetry {
  entry_route: EntryRoute;
  entry_price_at_open: number;
  entry_stop_loss: number;
  entry_take_profit: number | null;
  initial_risk_price: number;
  initial_risk_pips: number;
  entry_time: string;
  strategy_bar_time: string | null;
  strategy_name: "smc";
  strategy_version: string;
  trading_style: string | null;
  entry_zone_timeframe: string | null;
  entry_config_snapshot: Record<string, unknown> | null;
  entry_decision_snapshot: Record<string, unknown> | null;
}

/**
 * Risk at entry, in price units. Positive by construction.
 *
 * Returns null rather than a clamped value when the stop is on the wrong side
 * of the entry or equal to it: a non-positive risk means the row cannot carry
 * a meaningful R, and inventing one is the failure this module removes.
 */
export function initialRiskPrice(
  direction: "long" | "short", entryPrice: number, entryStopLoss: number,
): number | null {
  const r = direction === "long" ? entryPrice - entryStopLoss : entryStopLoss - entryPrice;
  return Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * The immutable entry record. Throws on a non-positive risk so a malformed
 * position is loud at write time rather than silently unanalysable later.
 */
export function buildEntryTelemetry(i: EntryTelemetryInput): EntryTelemetry {
  const risk = initialRiskPrice(i.direction, i.entryPrice, i.entryStopLoss);
  if (risk === null) {
    throw new Error(
      `smcTradeTelemetry: non-positive initial risk (${i.direction} entry ${i.entryPrice} stop ${i.entryStopLoss})`,
    );
  }
  return {
    entry_route: i.route,
    entry_price_at_open: i.entryPrice,
    entry_stop_loss: i.entryStopLoss,
    entry_take_profit: i.entryTakeProfit,
    initial_risk_price: risk,
    initial_risk_pips: i.pipSize > 0 ? risk / i.pipSize : 0,
    entry_time: i.entryTime,
    strategy_bar_time: i.strategyBarTime,
    strategy_name: "smc",
    strategy_version: SMC_CONTRACT_VERSION,
    trading_style: i.tradingStyle,
    entry_zone_timeframe: i.zoneTimeframe,
    entry_config_snapshot: i.configSnapshot,
    entry_decision_snapshot: i.decisionSnapshot,
  };
}

/**
 * The entry-time settings that materially change a trade.
 *
 * Deliberately a short allow-list. The point is reproducibility, and dumping
 * the whole config object would bury the dozen fields that matter and bloat
 * every row.
 */
export function entryConfigSnapshot(cfg: Record<string, unknown>): Record<string, unknown> {
  const pick = [
    "tradingStyle", "tpRatio", "minZoneScore", "minConfluence", "marketFillAtZone",
    "limitOrderEnabled", "impulseZoneGateMode", "requireUnifiedZone",
    "breakEvenEnabled", "trailingStopEnabled", "partialTPEnabled",
    "maxHoldEnabled", "maxHoldHours", "riskPerTrade", "minStopPips",
    "atrDerivedFloorsEnabled", "impulseSlCapMultiplier",
  ];
  const out: Record<string, unknown> = {};
  for (const k of pick) if (cfg[k] !== undefined) out[k] = cfg[k];
  return out;
}

/**
 * What the strategy believed when it approved the trade.
 *
 * Every value is READ from what the caller already computed. Nothing is
 * recalculated here — a recomputed field would describe a different moment.
 */
export function entryDecisionSnapshot(i: {
  zoneScore?: number | null; confluenceScore?: number | null;
  directionVerdict?: string | null; directionConfidence?: number | null;
  zoneTimeframe?: string | null; zoneHigh?: number | null; zoneLow?: number | null;
  zoneType?: string | null; impulseDirection?: string | null;
  displacementCandles?: number | null;
  priceAtZoneStrict?: boolean | null; sideOk?: boolean | null;
  signalSource?: string | null; setupId?: string | null;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(i)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Realized R from the IMMUTABLE entry values.
 *
 * Never reads the current stop. `initialRiskPrice` is the denominator, which
 * is the whole point: the live stop moves and the history row's copy of it is
 * the exit level on most rows.
 */
export function realizedRGross(
  direction: "long" | "short", entryPrice: number, exitPrice: number,
  initialRisk: number | null,
): number | null {
  if (initialRisk === null || !(initialRisk > 0)) return null;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) return null;
  const move = direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return move / initialRisk;
}

/**
 * Net R, or null.
 *
 * Null is the correct answer when cost is unknown. A fabricated net R is worse
 * than an absent one, because it reads as measured.
 */
export function realizedRNet(gross: number | null, costR: number | null): number | null {
  if (gross === null || costR === null || !Number.isFinite(costR)) return null;
  return gross - costR;
}

/** Columns carried verbatim from the open position onto its history row. */
export const IMMUTABLE_COLUMNS = [
  "entry_route", "entry_price_at_open", "entry_stop_loss", "entry_take_profit",
  "initial_risk_price", "initial_risk_pips", "entry_time", "strategy_bar_time",
  "strategy_name", "strategy_version", "trading_style", "entry_zone_timeframe",
  "entry_config_snapshot", "entry_decision_snapshot",
] as const;

/**
 * Copy the immutable entry block off an open-position row for archival, and
 * attach realized R.
 *
 * A legacy position carries none of these columns; it yields nulls and a
 * `legacy_unknown` route rather than reconstructed values, because the only
 * stop such a row has is the one management already overwrote.
 */
export function carryToHistory(
  pos: Record<string, unknown>,
  exit: { exitPrice: number; direction: "long" | "short"; costR?: number | null },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of IMMUTABLE_COLUMNS) out[c] = pos[c] ?? null;
  if (out.entry_route == null) out.entry_route = "legacy_unknown";

  const risk = typeof pos.initial_risk_price === "number"
    ? pos.initial_risk_price
    : (pos.initial_risk_price != null ? Number(pos.initial_risk_price) : null);
  const entry = typeof pos.entry_price_at_open === "number"
    ? pos.entry_price_at_open
    : (pos.entry_price_at_open != null ? Number(pos.entry_price_at_open) : null);

  const gross = entry !== null && risk !== null && Number.isFinite(risk)
    ? realizedRGross(exit.direction, entry, exit.exitPrice, risk)
    : null;
  out.realized_r_gross = gross;
  out.realized_r_net = realizedRNet(gross, exit.costR ?? null);
  return out;
}
