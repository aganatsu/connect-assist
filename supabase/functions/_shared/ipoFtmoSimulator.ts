/**
 * FTMO $100K 2-Step Challenge simulator for the locked causal IPO strategy.
 *
 * ACCOUNT LAYER ONLY. It consumes trades the frozen engine already produced and
 * never decides whether to take one. No IPO rule is read, re-derived or altered
 * here — a test asserts this module imports nothing from the strategy stack.
 *
 * WHY EQUITY REPLAY IS THE WHOLE POINT. FTMO measures drawdown on EQUITY,
 * continuously, including floating P/L. The IPO strategy exits on S2 — a CLOSE
 * beyond the IPO candle's extreme — so a position can travel a very long way
 * against the account before the engine does anything about it. Validation
 * measured median MAE at 1.34R and a tail beyond 17R. Judging FTMO compliance
 * from realized results would therefore answer a question nobody asked: the
 * account can be terminated hours before the strategy decides to exit.
 *
 * DOLLARS COME FROM R, NOT FROM LOT SIZES. Risk is fixed per trade, so a
 * position's P/L in dollars is exactly `R_floating x riskDollars`. That is an
 * identity, not an approximation, and it avoids inventing contract sizes and
 * pip values that would each be another unvalidated assumption.
 *
 * AMBIGUITY IS NOT RESOLVED SILENTLY. Within one bar the order of the high and
 * the low is unknowable from OHLC. Both orderings are simulated:
 *   CONSERVATIVE — every open position is marked at its adverse extreme at the
 *     same instant. The worst equity the bar could have produced.
 *   OPTIMISTIC — positions are marked at the bar close only.
 * A breach under conservative but not optimistic is reported as AMBIGUOUS, not
 * counted as a pass or a failure.
 *
 * SWAPS ARE NOT MODELLED. Historical overnight swap rates for these instruments
 * are not in this repository and cannot be reconstructed from candles. They are
 * omitted and their absence is reported, rather than invented. For a strategy
 * holding positions for hours this is a small omission; it is still an omission.
 */

/** A trade as produced by the frozen engine. Nothing here is recomputed. */
export interface SimTrade {
  instrument: string;
  openTime: string;
  closeTime: string;
  direction: "long" | "short";
  entry: number;
  stop: number;
  risk: number;
  /** Realized R from the frozen backtest, net of the frozen cost model. */
  netR: number;
  /**
   * Round-trip transaction cost in R, charged against FLOATING equity from the
   * instant of entry.
   *
   * Realized P/L already carries it inside `netR`, but a broker debits the
   * spread when the position opens, not when it closes. Omitting it from the
   * floating mark understates every drawdown by exactly this amount for the
   * whole life of the trade — which matters when the question is whether an
   * equity threshold was crossed.
   */
  costR?: number;
}

/** One instrument's bar, used only to mark open positions to market. */
export interface MarkBar {
  time: string;
  instrument: string;
  high: number;
  low: number;
  close: number;
}

export interface FtmoPhaseRules {
  name: string;
  startBalance: number;
  profitTarget: number;
  maxDailyLoss: number;
  /** Absolute equity floor. FTMO's standard model is static at start − 10%. */
  maxLossFloor: number;
  minTradingDays: number;
}

export const CHALLENGE: FtmoPhaseRules = {
  name: "Challenge", startBalance: 100_000, profitTarget: 110_000,
  maxDailyLoss: 5_000, maxLossFloor: 90_000, minTradingDays: 4,
};
export const VERIFICATION: FtmoPhaseRules = {
  name: "Verification", startBalance: 100_000, profitTarget: 105_000,
  maxDailyLoss: 5_000, maxLossFloor: 90_000, minTradingDays: 4,
};

/**
 * FTMO's trading day boundary is 00:00 Central European Time, which is UTC+1 in
 * winter and UTC+2 under CEST. EU summer time runs from the last Sunday of March
 * to the last Sunday of October, both at 01:00 UTC.
 */
export function isCEST(d: Date): boolean {
  const y = d.getUTCFullYear();
  const lastSunday = (month: number) => {
    const last = new Date(Date.UTC(y, month + 1, 0));
    return new Date(Date.UTC(y, month, last.getUTCDate() - last.getUTCDay(), 1));
  };
  return d >= lastSunday(2) && d < lastSunday(9);
}

/** The CE(S)T calendar day a UTC instant belongs to, as YYYY-MM-DD. */
export function ftmoDay(iso: string): string {
  const d = new Date(iso);
  const shifted = new Date(d.getTime() + (isCEST(d) ? 2 : 1) * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

export type Ordering = "CONSERVATIVE" | "OPTIMISTIC";

export type Outcome =
  | "PASS"
  | "FAIL_DAILY_LOSS"
  | "FAIL_MAX_LOSS"
  | "INCOMPLETE_NO_TARGET"
  | "INCOMPLETE_MIN_DAYS";

export interface PhaseResult {
  phase: string;
  outcome: Outcome;
  endingBalance: number;
  tradesUsed: number;
  /** Index into the supplied trade list of the first trade NOT consumed. */
  nextTradeIndex: number;
  tradingDays: number;
  breachTime: string | null;
  breachInstrument: string | null;
  worstDailyLoss: number;
  closestToDailyLimit: number;
  lowestEquity: number;
  closestToFloor: number;
  maxIntradayDrawdown: number;
  maxTotalDrawdown: number;
  ambiguousBars: number;
  statement: StatementLine[];
  /** Worst equity drawdown within each CE(S)T day, and who was open for it. */
  dayLog: DayRecord[];
}

export interface DayRecord {
  day: string;
  startBalance: number;
  worstLoss: number;
  worstTime: string | null;
  openAtWorst: string[];
}

export interface StatementLine {
  time: string;
  kind: "OPEN" | "CLOSE" | "BREACH" | "TARGET";
  instrument: string;
  detail: string;
  realizedR: number | null;
  balance: number;
  equityLow: number;
}

interface Open { t: SimTrade; riskDollars: number }

/**
 * Runs one phase over a chronological trade list against a bar timeline.
 *
 * `bars` must be sorted by time and cover every instrument that appears in
 * `trades`. The walk is bar-driven rather than trade-driven precisely so that
 * floating equity is checked on every bar a position is open.
 */
export function runPhase(
  rules: FtmoPhaseRules,
  trades: SimTrade[],
  bars: MarkBar[],
  riskDollars: number,
  ordering: Ordering,
  fromIndex = 0,
  keepStatement = false,
): PhaseResult {
  let balance = rules.startBalance;
  let ti = fromIndex;
  const open = new Map<string, Open>();
  const days = new Set<string>();
  let dayKey: string | null = null;
  let dayStartBalance = balance;

  let worstDailyLoss = 0, lowestEquity = balance;
  const dayLog: DayRecord[] = [];
  let curDay: DayRecord | null = null;
  let peakEquity = balance, maxTotalDD = 0, maxIntradayDD = 0;
  let ambiguous = 0;
  const statement: StatementLine[] = [];
  const say = (l: StatementLine) => { if (keepStatement) statement.push(l); };

  const floatingR = (o: Open, price: number) =>
    (o.t.direction === "long" ? price - o.t.entry : o.t.entry - price) / o.t.risk
    - (o.t.costR ?? 0);

  const finish = (outcome: Outcome, time: string | null, instrument: string | null): PhaseResult => ({
    phase: rules.name, outcome, endingBalance: balance, tradesUsed: ti - fromIndex,
    nextTradeIndex: ti, tradingDays: days.size, breachTime: time, breachInstrument: instrument,
    worstDailyLoss, closestToDailyLimit: rules.maxDailyLoss - worstDailyLoss,
    lowestEquity, closestToFloor: lowestEquity - rules.maxLossFloor,
    maxIntradayDrawdown: maxIntradayDD, maxTotalDrawdown: maxTotalDD,
    ambiguousBars: ambiguous, statement, dayLog,
  });

  for (const bar of bars) {
    const day = ftmoDay(bar.time);
    if (day !== dayKey) {
      // FTMO resets the daily reference at 00:00 CE(S)T, on BALANCE at that
      // instant — floating P/L carried across midnight counts against the new day.
      dayKey = day;
      dayStartBalance = balance;
      curDay = { day, startBalance: balance, worstLoss: 0, worstTime: null, openAtWorst: [] };
      dayLog.push(curDay);
    }

    // Open any trades whose entry time has arrived, before marking to market:
    // a position opened on this bar is exposed to this bar's excursion.
    while (ti < trades.length && trades[ti].openTime <= bar.time) {
      const t = trades[ti];
      if (!open.has(t.instrument)) {
        open.set(t.instrument, { t, riskDollars });
        days.add(ftmoDay(t.openTime));
        say({ time: t.openTime, kind: "OPEN", instrument: t.instrument,
          detail: `${t.direction} @ ${t.entry.toFixed(5)} stop ${t.stop.toFixed(5)} risk $${riskDollars}`,
          realizedR: null, balance, equityLow: balance });
      }
      ti++;
    }

    // Mark to market. CONSERVATIVE puts every open position at its adverse
    // extreme simultaneously; OPTIMISTIC marks at the close.
    let floatWorst = 0, floatClose = 0;
    for (const o of open.values()) {
      const adverse = o.t.direction === "long" ? bar.low : bar.high;
      const markAdverse = o.t.instrument === bar.instrument ? adverse : null;
      const markClose = o.t.instrument === bar.instrument ? bar.close : null;
      if (markAdverse === null) continue;
      floatWorst += Math.min(0, floatingR(o, markAdverse)) * o.riskDollars;
      floatClose += floatingR(o, markClose!) * o.riskDollars;
    }
    const equityWorst = balance + floatWorst;
    const equityClose = balance + floatClose;
    const equity = ordering === "CONSERVATIVE" ? equityWorst : equityClose;

    if (equityWorst !== equityClose && equityWorst < equityClose) ambiguous++;
    if (equity < lowestEquity) lowestEquity = equity;
    if (equity > peakEquity) peakEquity = equity;
    if (peakEquity - equity > maxTotalDD) maxTotalDD = peakEquity - equity;
    const dayLoss = dayStartBalance - equity;
    if (curDay && dayLoss > curDay.worstLoss) {
      curDay.worstLoss = dayLoss; curDay.worstTime = bar.time;
      curDay.openAtWorst = [...open.values()].map((o) => o.t.instrument);
    }
    if (dayLoss > worstDailyLoss) worstDailyLoss = dayLoss;
    if (dayLoss > maxIntradayDD) maxIntradayDD = dayLoss;

    if (equity <= rules.maxLossFloor) {
      const who = [...open.values()][0]?.t.instrument ?? bar.instrument;
      say({ time: bar.time, kind: "BREACH", instrument: who,
        detail: `MAX LOSS — equity ${equity.toFixed(2)} <= floor ${rules.maxLossFloor}`,
        realizedR: null, balance, equityLow: equity });
      return finish("FAIL_MAX_LOSS", bar.time, who);
    }
    if (dayLoss >= rules.maxDailyLoss) {
      const who = [...open.values()][0]?.t.instrument ?? bar.instrument;
      say({ time: bar.time, kind: "BREACH", instrument: who,
        detail: `DAILY LOSS — ${dayLoss.toFixed(2)} >= ${rules.maxDailyLoss} (day opened ${dayStartBalance.toFixed(2)})`,
        realizedR: null, balance, equityLow: equity });
      return finish("FAIL_DAILY_LOSS", bar.time, who);
    }

    // Close positions whose exit bar has been reached.
    for (const [inst, o] of [...open.entries()]) {
      if (o.t.closeTime > bar.time) continue;
      const pnl = o.t.netR * o.riskDollars;
      balance += pnl;
      open.delete(inst);
      days.add(ftmoDay(o.t.closeTime));
      say({ time: o.t.closeTime, kind: "CLOSE", instrument: inst,
        detail: `${o.t.netR >= 0 ? "win" : "loss"} ${o.t.netR.toFixed(3)}R = ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
        realizedR: o.t.netR, balance, equityLow: balance });
    }

    // Target is only valid with everything flat and the minimum days met.
    if (balance >= rules.profitTarget && open.size === 0 && days.size >= rules.minTradingDays) {
      say({ time: bar.time, kind: "TARGET", instrument: "-",
        detail: `target reached, balance ${balance.toFixed(2)}, ${days.size} trading days`,
        realizedR: null, balance, equityLow: balance });
      return finish("PASS", bar.time, null);
    }
  }

  if (balance >= rules.profitTarget && days.size < rules.minTradingDays) {
    return finish("INCOMPLETE_MIN_DAYS", null, null);
  }
  return finish("INCOMPLETE_NO_TARGET", null, null);
}

export interface TwoStepResult {
  riskPct: number;
  ordering: Ordering;
  phase1: PhaseResult;
  phase2: PhaseResult | null;
  passed: boolean;
}

/** Phase 2 continues from the first trade Phase 1 did not consume. */
export function runTwoStep(
  trades: SimTrade[], bars: MarkBar[], riskDollars: number, riskPct: number,
  ordering: Ordering, keepStatement = false,
): TwoStepResult {
  const p1 = runPhase(CHALLENGE, trades, bars, riskDollars, ordering, 0, keepStatement);
  if (p1.outcome !== "PASS") return { riskPct, ordering, phase1: p1, phase2: null, passed: false };
  const barsAfter = bars.filter((b) => b.time >= (p1.breachTime ?? bars[0].time));
  const p2 = runPhase(VERIFICATION, trades, barsAfter, riskDollars, ordering,
    p1.nextTradeIndex, keepStatement);
  return { riskPct, ordering, phase1: p1, phase2: p2, passed: p2.outcome === "PASS" };
}
