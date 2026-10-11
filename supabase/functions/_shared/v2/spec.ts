// V2 frozen constants. Source of truth: ~/strategy-v2/STRATEGY_SPEC_V2.1.1_FROZEN.md.
// Nothing in this file may change without a spec amendment.

export const SPEC_VERSION = "2.1.1";
export const SPEC_SHA256 = "3369eda73a27ecb264dd360de8201e5f7ba772264ad3fac915f747e2fad4fb93";

export const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"] as const;
export type Pair = typeof PAIRS[number];

// §0.1 — pip, typical spread and round-trip commission, in pips.
export const PIP: Record<Pair, number> = {
  "EUR/USD": 0.0001, "GBP/USD": 0.0001, "USD/JPY": 0.01, "CHF/JPY": 0.01, "NZD/CAD": 0.0001, "NZD/CHF": 0.0001,
};
const SPREAD_PIPS: Record<Pair, number> = {
  "EUR/USD": 1.0, "GBP/USD": 1.5, "USD/JPY": 1.0, "CHF/JPY": 2.5, "NZD/CAD": 2.5, "NZD/CHF": 3.0,
};
const COMMISSION_PIPS: Record<Pair, number> = {
  "EUR/USD": 0.50, "GBP/USD": 0.50, "USD/JPY": 0.79, "CHF/JPY": 0.79, "NZD/CAD": 0.71, "NZD/CHF": 0.42,
};

// Prices are held as integers: POINTS_PER_PIP points per pip, so every comparison in the spec is exact.
// 1,000 points per pip covers 7 decimals on 0.0001-pip pairs and 5 decimals on JPY pairs.
export const POINTS_PER_PIP = 1000;
export const PRICE_SCALE: Record<Pair, number> = Object.fromEntries(
  PAIRS.map((p) => [p, Math.round(POINTS_PER_PIP / PIP[p])]),
) as Record<Pair, number>;

export const SPREAD_PTS: Record<Pair, number> = Object.fromEntries(
  PAIRS.map((p) => [p, Math.round(SPREAD_PIPS[p] * POINTS_PER_PIP)]),
) as Record<Pair, number>;
export const COST_PTS: Record<Pair, number> = Object.fromEntries(
  PAIRS.map((p) => [p, Math.round((SPREAD_PIPS[p] + COMMISSION_PIPS[p]) * POINTS_PER_PIP)]),
) as Record<Pair, number>;
export const SPREAD_PIPS_TABLE = SPREAD_PIPS;
export const COMMISSION_PIPS_TABLE = COMMISSION_PIPS;
export const SL_BUFFER_PTS = POINTS_PER_PIP; // §6.2: 1 pip

// §6.4–6.5 research execution profile.
export const RESEARCH_BALANCE_USD = 100_000;
export const RISK_BUDGET_USD = 500;
export const MAX_LOTS = 20;
export const LOT_UNITS = 100_000;
export const RESEARCH_RATES = { USDJPY: 158.31985, USDCAD: 1.42552, USDCHF: 0.83022 } as const;
export const QUOTE_TO_USD: Record<Pair, number> = {
  "EUR/USD": 1, "GBP/USD": 1,
  "USD/JPY": 1 / RESEARCH_RATES.USDJPY, "CHF/JPY": 1 / RESEARCH_RATES.USDJPY,
  "NZD/CAD": 1 / RESEARCH_RATES.USDCAD, "NZD/CHF": 1 / RESEARCH_RATES.USDCHF,
};
export const COMMISSION_USD_PER_LOT = 5.003;

// Structure, direction and POI parameters.
export const WINDOW_1H = 200;          // §2.0
export const WINDOW_15M = 96;          // §2.0
export const VETO_BARS_15M = 10;       // §2.1b
export const POI_LOOKBACK_1H = 120;    // §3.8, §7.1a, §7.6c
export const LEG_MIN_SPAN = 3;         // §3.1  b − o ≥ 3
export const BASELINE_BARS = 20;       // §3.3
export const ATR_PERIOD = 14;          // §0.5

// Calendar and runtime.
export const TRADING_WINDOW_START_MIN = 2 * 60;   // §0.8 [02:00, 12:00)
export const TRADING_WINDOW_END_MIN = 12 * 60;
export const ASIAN_START_MIN = 20 * 60;           // §7.1c [20:00, 02:00)
export const ASIAN_END_MIN = 2 * 60;
export const NEWS_BLOCK_MS = 30 * 60_000;         // §8.1
export const FEED_MAX_AGE_MS = 60 * 60_000;       // §8.2
export const PENDING_GRACE_MS = 30 * 60_000;      // §11.6

export const STEP_MS = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 } as const;
export type TF = keyof typeof STEP_MS;

export function baseQuote(pair: Pair): [string, string] {
  const [b, q] = pair.split("/");
  return [b, q];
}
