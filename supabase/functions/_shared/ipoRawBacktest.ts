/**
 * Raw expectancy test for the frozen IPO lifecycle. RESEARCH ONLY.
 *
 * THE QUESTION IS NARROW: does the trader-defined lifecycle have positive
 * expectancy when traded mechanically, BEFORE any confluence or ranking? The
 * detector is not tuned here and nothing is filtered on outcome.
 *
 * DISCIPLINE BUILT IN RATHER THAN PROMISED:
 *   - targets are PRE-REGISTERED (1R, 1.5R, 2R, 3R, structural) and fixed
 *   - a bar containing both stop and target is AMBIGUOUS_INTRABAR; the headline
 *     number assumes STOP FIRST. Optimistic is reported beside it, never instead
 *   - costs are charged in price terms and converted to R, so a tight stop is
 *     correctly penalised more than a wide one
 *   - gross and net are kept apart
 *
 * R-MULTIPLES ONLY. No account size, no leverage, no compounding — edge first.
 */

import type { Candle } from "./smcAnalysis.ts";

export type EntryModel = "E1_ZONE_TOUCH" | "E2_50_PERCENT";
export type StopModel = "S1_HARD_EXTREME" | "S2_CLOSE_INVALIDATION";
export type TargetModel = "T_1R" | "T_1_5R" | "T_2R" | "T_3R" | "T_STRUCTURAL";

export const ENTRY_MODELS: EntryModel[] = ["E1_ZONE_TOUCH", "E2_50_PERCENT"];
export const STOP_MODELS: StopModel[] = ["S1_HARD_EXTREME", "S2_CLOSE_INVALIDATION"];
export const TARGET_MODELS: TargetModel[] = ["T_1R", "T_1_5R", "T_2R", "T_3R", "T_STRUCTURAL"];

const R_OF: Record<string, number> = { T_1R: 1, "T_1_5R": 1.5, T_2R: 2, T_3R: 3 };

export interface Costs {
  /** One-way cost in PRICE units (spread, or fee+slippage as a price amount). */
  perSide: number;
  label: string;
}

export interface Setup {
  /** Index of the original IPO candle. */
  ipoIndex: number;
  direction: "demand" | "supply";
  zoneLow: number;
  zoneHigh: number;
  /** Far extreme of the original candle. */
  extreme: number;
  /** Bar at which this touch occurred. */
  touchIndex: number;
  /** 1 = first touch, 2 = second, etc. */
  touchNumber: number;
  hasFvg: boolean;
  afterContraction: boolean;
  /** High-water mark between validation and the touch — the structural target. */
  structuralTarget: number | null;
}

export interface TradeResult {
  setup: Setup;
  entry: number;
  stop: number;
  risk: number;
  target: number | null;
  exitIndex: number | null;
  exitPrice: number | null;
  grossR: number | null;
  netR: number | null;
  ambiguous: boolean;
  optimisticR: number | null;
  outcome: "WIN" | "LOSS" | "OPEN" | "NO_ENTRY";
}

/**
 * Simulates one setup under one model triple.
 *
 * Entry is only taken if the bar actually reaches the entry level, so
 * E2_50_PERCENT correctly declines setups that never retrace that far.
 */
export function simulate(
  s: Candle[], setup: Setup, entryModel: EntryModel, stopModel: StopModel,
  targetModel: TargetModel, costs: Costs,
): TradeResult {
  const long = setup.direction === "demand";
  // Approaching from outside, a demand zone is hit at its HIGH, a supply zone at
  // its LOW. The 50% level is the far side in both cases.
  const touchLevel = long ? setup.zoneHigh : setup.zoneLow;
  const halfLevel = long ? setup.zoneLow : setup.zoneHigh;
  const entry = entryModel === "E1_ZONE_TOUCH" ? touchLevel : halfLevel;

  const bar = s[setup.touchIndex];
  const reached = long ? bar.low <= entry : bar.high >= entry;
  const base: TradeResult = {
    setup, entry, stop: setup.extreme, risk: 0, target: null,
    exitIndex: null, exitPrice: null, grossR: null, netR: null,
    ambiguous: false, optimisticR: null, outcome: "NO_ENTRY",
  };
  if (!reached) return base;

  const stop = setup.extreme;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return base;

  let target: number | null = null;
  if (targetModel === "T_STRUCTURAL") {
    if (setup.structuralTarget === null) return { ...base, risk };
    target = setup.structuralTarget;
    // A structural target behind the entry is not tradable.
    if (long ? target <= entry : target >= entry) return { ...base, risk };
  } else {
    const m = R_OF[targetModel];
    target = long ? entry + m * risk : entry - m * risk;
  }

  const costR = (2 * costs.perSide) / risk;   // entry + exit
  let ambiguous = false;

  for (let k = setup.touchIndex; k < s.length; k++) {
    const c = s[k];
    const hitTarget = long ? c.high >= target : c.low <= target;
    const hitStopIntrabar = long ? c.low <= stop : c.high >= stop;
    const closedBeyond = long ? c.close < stop : c.close > stop;

    if (stopModel === "S1_HARD_EXTREME") {
      if (hitTarget && hitStopIntrabar) {
        ambiguous = true;
        const gross = -1;                                   // conservative: stop first
        const optimistic = Math.abs(target - entry) / risk;
        return { ...base, risk, target, exitIndex: k, exitPrice: stop,
          grossR: gross, netR: gross - costR, ambiguous, optimisticR: optimistic - costR,
          outcome: "LOSS" };
      }
      if (hitStopIntrabar) {
        return { ...base, risk, target, exitIndex: k, exitPrice: stop,
          grossR: -1, netR: -1 - costR, ambiguous, optimisticR: -1 - costR, outcome: "LOSS" };
      }
      if (hitTarget) {
        const gross = Math.abs(target - entry) / risk;
        return { ...base, risk, target, exitIndex: k, exitPrice: target,
          grossR: gross, netR: gross - costR, ambiguous, optimisticR: gross - costR, outcome: "WIN" };
      }
    } else {
      // S2: only a CLOSE beyond the extreme ends it. Realized R uses that close.
      if (hitTarget && closedBeyond) {
        ambiguous = true;
        const loss = (long ? c.close - entry : entry - c.close) / risk;
        const optimistic = Math.abs(target - entry) / risk;
        return { ...base, risk, target, exitIndex: k, exitPrice: c.close,
          grossR: loss, netR: loss - costR, ambiguous, optimisticR: optimistic - costR,
          outcome: "LOSS" };
      }
      if (closedBeyond) {
        const loss = (long ? c.close - entry : entry - c.close) / risk;
        return { ...base, risk, target, exitIndex: k, exitPrice: c.close,
          grossR: loss, netR: loss - costR, ambiguous, optimisticR: loss - costR, outcome: "LOSS" };
      }
      if (hitTarget) {
        const gross = Math.abs(target - entry) / risk;
        return { ...base, risk, target, exitIndex: k, exitPrice: target,
          grossR: gross, netR: gross - costR, ambiguous, optimisticR: gross - costR, outcome: "WIN" };
      }
    }
  }
  return { ...base, risk, target, outcome: "OPEN" };
}

export interface Metrics {
  trades: number; wins: number; losses: number; winRate: number;
  avgWinR: number | null; avgLossR: number | null;
  expectancyR: number; profitFactor: number | null;
  maxDrawdownR: number; longestLosingStreak: number; totalR: number;
  ambiguous: number; optimisticExpectancyR: number;
}

export function metrics(rs: TradeResult[], useNet = true): Metrics {
  const done = rs.filter((r) => r.outcome === "WIN" || r.outcome === "LOSS");
  const val = (r: TradeResult) => (useNet ? r.netR : r.grossR) ?? 0;
  const wins = done.filter((r) => val(r) > 0), losses = done.filter((r) => val(r) <= 0);
  const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const r of done) {
    eq += val(r);
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
    if (val(r) <= 0) { streak++; if (streak > worst) worst = streak; } else streak = 0;
  }
  const grossWin = wins.reduce((a, r) => a + val(r), 0);
  const grossLoss = Math.abs(losses.reduce((a, r) => a + val(r), 0));
  return {
    trades: done.length, wins: wins.length, losses: losses.length,
    winRate: done.length ? (100 * wins.length) / done.length : 0,
    avgWinR: mean(wins.map(val)), avgLossR: mean(losses.map(val)),
    expectancyR: done.length ? eq / done.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownR: dd, longestLosingStreak: worst, totalR: eq,
    ambiguous: done.filter((r) => r.ambiguous).length,
    optimisticExpectancyR: done.length
      ? done.reduce((a, r) => a + (r.optimisticR ?? 0), 0) / done.length : 0,
  };
}
