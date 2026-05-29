/**
 * shadowTrading.ts — Shadow Trading Mode Engine
 * ──────────────────────────────────────────────────────────────────────
 * Shadow trading allows the bot to "virtually" take trades that it would
 * normally skip due to gate failures, low confidence, or risk limits.
 * These shadow trades are tracked separately and their outcomes measured
 * to answer: "What would have happened if we took this trade?"
 *
 * Key use cases:
 *   1. **Gate Validation** — Track trades that failed specific gates to
 *      measure if those gates are actually adding value
 *   2. **Threshold Tuning** — Track trades just below the confidence
 *      threshold to find the optimal cutoff
 *   3. **New Strategy Testing** — Shadow-execute a new strategy alongside
 *      the live one to compare performance
 *   4. **Risk Limit Impact** — Measure P&L of trades skipped due to
 *      correlation limits or max-position caps
 *
 * Shadow trades:
 *   - Are NEVER sent to any broker
 *   - Are tracked in a separate DB table (shadow_trades)
 *   - Are closed using the same exit logic as paper trades
 *   - Generate performance metrics for comparison
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface ShadowTrade {
  /** Unique ID */
  id: string;
  /** User ID (owner of the bot) */
  userId: string;
  /** Symbol traded */
  symbol: string;
  /** Trade direction */
  direction: "long" | "short";
  /** Hypothetical entry price */
  entryPrice: number;
  /** Stop loss price */
  stopLoss: number;
  /** Take profit price */
  takeProfit: number;
  /** Hypothetical position size (lots) */
  size: number;
  /** Why this trade was shadowed (which gate/rule blocked it) */
  shadowReason: ShadowReason;
  /** The confluence score at time of signal */
  score: number;
  /** Which gates passed/failed */
  gateResults: Record<string, boolean>;
  /** Timestamp of entry signal */
  entryTime: string;
  /** Current status */
  status: "open" | "closed_tp" | "closed_sl" | "closed_time" | "closed_manual";
  /** Exit price (null if still open) */
  exitPrice: number | null;
  /** Exit time (null if still open) */
  exitTime: string | null;
  /** P&L in pips (null if still open) */
  pnlPips: number | null;
  /** P&L in account currency (null if still open) */
  pnlUsd: number | null;
  /** Maximum favorable excursion in pips */
  mfe: number;
  /** Maximum adverse excursion in pips */
  mae: number;
  /** Metadata: factor scores, regime, etc. */
  metadata: Record<string, any>;
}

export type ShadowReason =
  | { type: "gate_failure"; gateName: string; gateNumber: number; detail: string }
  | { type: "below_threshold"; score: number; threshold: number }
  | { type: "correlation_block"; conflictsWith: string[]; correlation: number }
  | { type: "max_positions"; currentCount: number; maxAllowed: number }
  | { type: "risk_limit"; riskPercent: number; maxRisk: number }
  | { type: "strategy_test"; strategyName: string; version: string }
  | { type: "session_filter"; session: string; reason: string }
  | { type: "news_filter"; event: string; minutesUntil: number };

export interface ShadowTradeInput {
  userId: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  size: number;
  score: number;
  shadowReason: ShadowReason;
  gateResults: Record<string, boolean>;
  metadata?: Record<string, any>;
}

export interface ShadowPerformance {
  /** Total shadow trades in the period */
  totalTrades: number;
  /** Trades that would have hit TP */
  wins: number;
  /** Trades that would have hit SL */
  losses: number;
  /** Still open */
  openCount: number;
  /** Win rate (0-1) */
  winRate: number;
  /** Average win in pips */
  avgWinPips: number;
  /** Average loss in pips */
  avgLossPips: number;
  /** Profit factor (gross wins / gross losses) */
  profitFactor: number;
  /** Total P&L in pips */
  totalPnlPips: number;
  /** Average R:R achieved */
  avgRR: number;
  /** Breakdown by shadow reason type */
  byReason: Record<string, { count: number; winRate: number; pnlPips: number }>;
  /** Breakdown by gate that blocked the trade */
  byGate: Record<string, { count: number; winRate: number; pnlPips: number }>;
}

// ─── Shadow Trade Creation ───────────────────────────────────────────

/**
 * Create a shadow trade record from a blocked signal.
 */
export function createShadowTrade(input: ShadowTradeInput): Omit<ShadowTrade, "id"> {
  return {
    userId: input.userId,
    symbol: input.symbol,
    direction: input.direction,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    size: input.size,
    shadowReason: input.shadowReason,
    score: input.score,
    gateResults: input.gateResults,
    entryTime: new Date().toISOString(),
    status: "open",
    exitPrice: null,
    exitTime: null,
    pnlPips: null,
    pnlUsd: null,
    mfe: 0,
    mae: 0,
    metadata: input.metadata || {},
  };
}

// ─── Shadow Trade Exit Logic ─────────────────────────────────────────

export interface PriceUpdate {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: string;
}

/**
 * Check if a shadow trade should be closed based on current price.
 * Returns the updated trade if closed, or null if still open.
 */
export function checkShadowTradeExit(
  trade: ShadowTrade,
  price: PriceUpdate,
  pipSize: number,
): ShadowTrade | null {
  if (trade.status !== "open") return null;
  if (trade.symbol !== price.symbol) return null;

  const currentPrice = trade.direction === "long" ? price.bid : price.ask;

  // Update MFE/MAE
  const pipsFromEntry = trade.direction === "long"
    ? (currentPrice - trade.entryPrice) / pipSize
    : (trade.entryPrice - currentPrice) / pipSize;

  const updatedMfe = Math.max(trade.mfe, pipsFromEntry);
  const updatedMae = Math.max(trade.mae, -pipsFromEntry);

  // Check TP hit
  if (trade.direction === "long" && currentPrice >= trade.takeProfit) {
    const pnlPips = (trade.takeProfit - trade.entryPrice) / pipSize;
    return {
      ...trade,
      status: "closed_tp",
      exitPrice: trade.takeProfit,
      exitTime: price.timestamp,
      pnlPips,
      pnlUsd: pnlPips * pipSize * trade.size * 100000, // Approximate
      mfe: updatedMfe,
      mae: updatedMae,
    };
  }
  if (trade.direction === "short" && currentPrice <= trade.takeProfit) {
    const pnlPips = (trade.entryPrice - trade.takeProfit) / pipSize;
    return {
      ...trade,
      status: "closed_tp",
      exitPrice: trade.takeProfit,
      exitTime: price.timestamp,
      pnlPips,
      pnlUsd: pnlPips * pipSize * trade.size * 100000,
      mfe: updatedMfe,
      mae: updatedMae,
    };
  }

  // Check SL hit
  if (trade.direction === "long" && currentPrice <= trade.stopLoss) {
    const pnlPips = (trade.stopLoss - trade.entryPrice) / pipSize;
    return {
      ...trade,
      status: "closed_sl",
      exitPrice: trade.stopLoss,
      exitTime: price.timestamp,
      pnlPips,
      pnlUsd: pnlPips * pipSize * trade.size * 100000,
      mfe: updatedMfe,
      mae: updatedMae,
    };
  }
  if (trade.direction === "short" && currentPrice >= trade.stopLoss) {
    const pnlPips = (trade.entryPrice - trade.stopLoss) / pipSize;
    return {
      ...trade,
      status: "closed_sl",
      exitPrice: trade.stopLoss,
      exitTime: price.timestamp,
      pnlPips,
      pnlUsd: pnlPips * pipSize * trade.size * 100000,
      mfe: updatedMfe,
      mae: updatedMae,
    };
  }

  // Still open — just update MFE/MAE
  return null;
}

/**
 * Update MFE/MAE for an open shadow trade without closing it.
 */
export function updateShadowTradeExcursion(
  trade: ShadowTrade,
  currentPrice: number,
  pipSize: number,
): { mfe: number; mae: number } {
  const pipsFromEntry = trade.direction === "long"
    ? (currentPrice - trade.entryPrice) / pipSize
    : (trade.entryPrice - currentPrice) / pipSize;

  return {
    mfe: Math.max(trade.mfe, pipsFromEntry),
    mae: Math.max(trade.mae, -pipsFromEntry),
  };
}

// ─── Performance Analytics ───────────────────────────────────────────

/**
 * Compute performance metrics for a set of shadow trades.
 */
export function computeShadowPerformance(trades: ShadowTrade[]): ShadowPerformance {
  const closed = trades.filter((t) => t.status !== "open");
  const wins = closed.filter((t) => t.status === "closed_tp");
  const losses = closed.filter((t) => t.status === "closed_sl");
  const openCount = trades.filter((t) => t.status === "open").length;

  const winPips = wins.reduce((s, t) => s + (t.pnlPips || 0), 0);
  const lossPips = Math.abs(losses.reduce((s, t) => s + (t.pnlPips || 0), 0));

  const avgWinPips = wins.length > 0 ? winPips / wins.length : 0;
  const avgLossPips = losses.length > 0 ? lossPips / losses.length : 0;
  const profitFactor = lossPips > 0 ? winPips / lossPips : winPips > 0 ? Infinity : 0;

  // Breakdown by reason type
  const byReason: Record<string, { count: number; winRate: number; pnlPips: number }> = {};
  for (const t of closed) {
    const key = t.shadowReason.type;
    if (!byReason[key]) byReason[key] = { count: 0, winRate: 0, pnlPips: 0 };
    byReason[key].count++;
    byReason[key].pnlPips += t.pnlPips || 0;
  }
  for (const key of Object.keys(byReason)) {
    const reasonTrades = closed.filter((t) => t.shadowReason.type === key);
    const reasonWins = reasonTrades.filter((t) => t.status === "closed_tp");
    byReason[key].winRate = reasonTrades.length > 0 ? reasonWins.length / reasonTrades.length : 0;
  }

  // Breakdown by gate
  const byGate: Record<string, { count: number; winRate: number; pnlPips: number }> = {};
  for (const t of closed) {
    if (t.shadowReason.type === "gate_failure") {
      const gateName = (t.shadowReason as { type: "gate_failure"; gateName: string }).gateName;
      if (!byGate[gateName]) byGate[gateName] = { count: 0, winRate: 0, pnlPips: 0 };
      byGate[gateName].count++;
      byGate[gateName].pnlPips += t.pnlPips || 0;
    }
  }
  for (const key of Object.keys(byGate)) {
    const gateTrades = closed.filter(
      (t) => t.shadowReason.type === "gate_failure" && (t.shadowReason as any).gateName === key
    );
    const gateWins = gateTrades.filter((t) => t.status === "closed_tp");
    byGate[key].winRate = gateTrades.length > 0 ? gateWins.length / gateTrades.length : 0;
  }

  // Average R:R
  const rrValues = closed
    .filter((t) => t.pnlPips !== null)
    .map((t) => {
      const slDist = Math.abs(t.entryPrice - t.stopLoss);
      if (slDist === 0) return 0;
      const tpDist = Math.abs(t.takeProfit - t.entryPrice);
      return t.status === "closed_tp" ? tpDist / slDist : -(slDist / slDist);
    });
  const avgRR = rrValues.length > 0 ? rrValues.reduce((s, v) => s + v, 0) / rrValues.length : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    openCount,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    avgWinPips,
    avgLossPips,
    profitFactor,
    totalPnlPips: winPips - lossPips,
    avgRR,
    byReason,
    byGate,
  };
}

/**
 * Determine if a gate is "value-adding" based on shadow trade performance.
 * If trades blocked by this gate would have been profitable, the gate
 * might be too restrictive.
 *
 * @returns positive = gate is protecting (blocked trades lost money)
 *          negative = gate is costing money (blocked trades would have won)
 */
export function evaluateGateValue(
  shadowTrades: ShadowTrade[],
  gateName: string,
): { value: number; sampleSize: number; winRate: number; detail: string } {
  const gateTrades = shadowTrades.filter(
    (t) => t.status !== "open" &&
    t.shadowReason.type === "gate_failure" &&
    (t.shadowReason as any).gateName === gateName
  );

  if (gateTrades.length < 5) {
    return {
      value: 0,
      sampleSize: gateTrades.length,
      winRate: 0,
      detail: `Insufficient data (${gateTrades.length} trades) to evaluate gate "${gateName}"`,
    };
  }

  const wins = gateTrades.filter((t) => t.status === "closed_tp");
  const winRate = wins.length / gateTrades.length;
  const totalPnl = gateTrades.reduce((s, t) => s + (t.pnlPips || 0), 0);

  // Value = negative of total P&L (if blocked trades lost money, gate is valuable)
  const value = -totalPnl;

  const detail = totalPnl > 0
    ? `Gate "${gateName}" is COSTING money: blocked trades would have netted +${totalPnl.toFixed(1)} pips (${(winRate * 100).toFixed(0)}% WR)`
    : `Gate "${gateName}" is PROTECTING: blocked trades would have lost ${Math.abs(totalPnl).toFixed(1)} pips (${(winRate * 100).toFixed(0)}% WR)`;

  return { value, sampleSize: gateTrades.length, winRate, detail };
}
