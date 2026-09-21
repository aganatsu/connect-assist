/**
 * Forward/paper-trading event ledger for the frozen IPO candidate.
 *
 * WHAT THIS IS FOR. Every live candidate emits one row, whether or not it is
 * filled, so the forward record can be audited bar by bar against the spec. A
 * ledger that only records fills cannot answer "why did nothing trade on
 * Tuesday", which is the question a forward test exists to answer.
 *
 * THIS MODULE MAKES NO DECISIONS. It records what the frozen rules produced:
 * lifecycle state, volatility bucket, contraction state, zone, entry, target,
 * invalidation. It has no thresholds and no filters of its own. If a number here
 * disagrees with the frozen modules, this module is wrong.
 *
 * REJECTED CANDIDATES ARE ROWS TOO. A setup refused because BTC was not
 * HIGH_VOL, or because price never reached the 50% level, is written with
 * `filled: false` and a reason. Those rows are how the live volatility gate and
 * the fill assumption get validated in production rather than assumed.
 *
 * R IS NOMINAL AND THAT IS NOT THE REAL RISK. `realizedR` is denominated in the
 * IPO geometry's 1R. Under S2 invalidation 97% of losing trades realize MORE
 * than 1R (median 1.75R, p95 4.35R, max 17.3R measured over validation). `mae`
 * is recorded on every row precisely so position sizing can be set against
 * observed excursion rather than against nominal R.
 */

import type { Candle } from "./smcAnalysis.ts";

export type ExitReason =
  | "TARGET_2R"
  | "S2_CLOSE_INVALIDATION"
  | "OPEN"
  | "NOT_FILLED";

export type NoFillReason =
  | "VOLATILITY_NOT_ELIGIBLE"
  | "PRICE_DID_NOT_REACH_50_PERCENT"
  | "POSITION_ALREADY_OPEN"
  | null;

export interface LedgerRow {
  /** Bar timestamp at which the candidate was evaluated (the touch bar). */
  timestamp: string;
  instrument: string;
  timeframe: string;
  direction: "long" | "short";

  /** The originating IPO candle. */
  ipoCandleTimestamp: string;
  ipoZoneLow: number;
  ipoZoneHigh: number;
  /** The frozen E2 level: the distal half-way price of the IPO candle. */
  entryLevel: number;
  /** Far extreme of the IPO candle. A CLOSE beyond this invalidates. */
  invalidationLevel: number;
  targetPrice: number | null;

  /** Quality marker, never a gate. Null when no aligned FVG was found. */
  fvgPresent: boolean;
  fvgTimestamp: string | null;

  volatilityBucket: string;
  /** Whether the bar sat inside an ACTIVE contraction episode. */
  contractionState: "INSIDE_CONTRACTION" | "OUTSIDE_CONTRACTION";
  lifecycleState: string;

  filled: boolean;
  noFillReason: NoFillReason;
  fillPrice: number | null;
  exitTimestamp: string | null;
  exitPrice: number | null;
  exitReason: ExitReason;

  /** Nominal R. See the header: this understates realized loss under S2. */
  realizedR: number | null;
  /** Max adverse / favourable excursion while open, in nominal R. */
  mae: number | null;
  mfe: number | null;
}

export const LEDGER_FIELDS: Array<keyof LedgerRow> = [
  "timestamp", "instrument", "timeframe", "direction",
  "ipoCandleTimestamp", "ipoZoneLow", "ipoZoneHigh", "entryLevel",
  "invalidationLevel", "targetPrice", "fvgPresent", "fvgTimestamp",
  "volatilityBucket", "contractionState", "lifecycleState",
  "filled", "noFillReason", "fillPrice", "exitTimestamp", "exitPrice",
  "exitReason", "realizedR", "mae", "mfe",
];

/**
 * Excursion in nominal R over the holding period.
 *
 * Measured from the FILL, not from the signal bar, and over closed bars only —
 * an excursion the position never actually experienced is not an excursion.
 */
export function excursions(
  s: Candle[], from: number, to: number, entry: number, risk: number, long: boolean,
): { mae: number; mfe: number } {
  let mae = 0, mfe = 0;
  for (let k = from; k <= Math.min(to, s.length - 1); k++) {
    const adverse = long ? entry - s[k].low : s[k].high - entry;
    const favourable = long ? s[k].high - entry : entry - s[k].low;
    if (adverse > mae) mae = adverse;
    if (favourable > mfe) mfe = favourable;
  }
  return { mae: risk > 0 ? mae / risk : 0, mfe: risk > 0 ? mfe / risk : 0 };
}

/** One JSON object per line. Append-only; never rewrite a past line. */
export function toJsonl(rows: LedgerRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

export function parseJsonl(text: string): LedgerRow[] {
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LedgerRow);
}

/**
 * Structural check that a ledger can actually be audited.
 *
 * Catches the failure modes that make a forward record worthless after the
 * fact: rows missing fields, fills without a price, unfilled rows carrying a
 * result, and results whose sign disagrees with the exit reason.
 */
export function auditLedger(rows: LedgerRow[]): string[] {
  const problems: string[] = [];
  rows.forEach((r, i) => {
    const where = `row ${i} (${r.instrument} ${r.timestamp})`;
    for (const f of LEDGER_FIELDS) {
      if (!(f in r)) problems.push(`${where}: missing field ${f}`);
    }
    if (r.filled) {
      if (r.fillPrice === null) problems.push(`${where}: filled with no fill price`);
      if (r.noFillReason !== null) problems.push(`${where}: filled but carries a no-fill reason`);
      if (r.exitReason === "NOT_FILLED") problems.push(`${where}: filled but exit reason says otherwise`);
    } else {
      if (r.noFillReason === null) problems.push(`${where}: not filled and no reason given`);
      if (r.realizedR !== null) problems.push(`${where}: not filled but reports a result`);
      if (r.fillPrice !== null) problems.push(`${where}: not filled but reports a fill price`);
    }
    if (r.exitReason === "TARGET_2R" && r.realizedR === null) {
      problems.push(`${where}: hit target but reports no result`);
    }
    if (r.mae !== null && r.mae < 0) problems.push(`${where}: negative MAE`);
    if (r.mfe !== null && r.mfe < 0) problems.push(`${where}: negative MFE`);
    if (r.ipoZoneLow > r.ipoZoneHigh) problems.push(`${where}: inverted zone`);
  });
  return problems;
}

export interface LedgerSummary {
  rows: number;
  filled: number;
  notFilled: number;
  byNoFillReason: Record<string, number>;
  byExitReason: Record<string, number>;
  byVolatilityBucket: Record<string, number>;
  totalR: number;
  expectancyR: number | null;
  /**
   * Trades that REACHED the 2R target and still finished net negative, because
   * the round-trip cost exceeded the target in R terms. Not an error — an
   * economic fact about small-risk setups, and the reason `costRatio` belongs
   * in front of a human before any money moves.
   */
  costDominatedWins: number;
}

export function summarize(rows: LedgerRow[]): LedgerSummary {
  const filled = rows.filter((r) => r.filled && r.realizedR !== null);
  const count = (xs: string[]) =>
    xs.reduce((a: Record<string, number>, k) => (a[k] = (a[k] ?? 0) + 1, a), {});
  const total = filled.reduce((a, r) => a + (r.realizedR ?? 0), 0);
  return {
    rows: rows.length,
    filled: filled.length,
    notFilled: rows.length - filled.length,
    byNoFillReason: count(rows.filter((r) => !r.filled).map((r) => r.noFillReason ?? "UNKNOWN")),
    byExitReason: count(rows.map((r) => r.exitReason)),
    byVolatilityBucket: count(rows.map((r) => r.volatilityBucket)),
    totalR: total,
    expectancyR: filled.length ? total / filled.length : null,
    costDominatedWins: filled.filter((r) =>
      r.exitReason === "TARGET_2R" && (r.realizedR ?? 0) <= 0).length,
  };
}
