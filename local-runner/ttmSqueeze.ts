/**
 * TTM Squeeze — frozen definition for IPO_TTM_SQUEEZE_TELEMETRY_V1.
 *
 * RESEARCH TELEMETRY ONLY. Not imported by any edge function; it cannot
 * change an IPO decision.
 *
 * PARAMETERS ARE FROZEN (length 20, BB x2.0, KC x1.5). No sweep, no
 * alternates. Choices the spec left open, fixed BEFORE any result was seen:
 *   - stdev is the POPULATION standard deviation (TradingView ta.stdev).
 *   - ATR is Wilder's RMA of true range, seeded with the SMA of the first
 *     `length` true ranges (TradingView ta.atr).
 *   - EMA is seeded with the SMA of the first `length` closes.
 *   - linearRegression returns the fitted value at the LAST point of the
 *     window (TradingView ta.linreg(src, length, 0)).
 *   - momentum needs `length` values of momentumRaw, each needing `length`
 *     bars, so the first momentum is at index 2*length - 2.
 *
 * CAUSALITY. Every series value at index i is computed from bars[0..i] only:
 * SMA/stdev/highest/lowest look back, EMA and RMA recurse forward. So the
 * value at i does not depend on any bar after i, and `ttmAtDecision(prefix)`
 * reads ONLY the prefix it is handed. The study passes
 * bars.slice(0, entryIndex): the bars strictly before the IPO touch bar,
 * which is exactly the `barsBefore` prefix the frozen engine hands its own
 * research hooks.
 */

export const TTM_LENGTH = 20;
export const TTM_BB_MULT = 2.0;
export const TTM_KC_MULT = 1.5;
/** "Recently released" means within this many bars of the decision bar. */
export const RECENT_RELEASE_BARS = 3;

export interface Bar { open?: number; high: number; low: number; close: number }

export interface TtmSeries {
  squeezeOn: (boolean | null)[];
  momentum: (number | null)[];
}

const sma = (v: number[], i: number, n: number) => {
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += v[k];
  return s / n;
};

/** Full causal series. Value at i uses bars[0..i] only. */
export function ttmSeries(
  bars: Bar[], length = TTM_LENGTH, bbMult = TTM_BB_MULT, kcMult = TTM_KC_MULT,
): TtmSeries {
  const n = bars.length;
  const close = bars.map((b) => b.close);
  const squeezeOn: (boolean | null)[] = new Array(n).fill(null);
  const momentum: (number | null)[] = new Array(n).fill(null);
  if (n < length) return { squeezeOn, momentum };

  // EMA(close) and Wilder ATR, both seeded with an SMA of the first `length`.
  const ema: (number | null)[] = new Array(n).fill(null);
  const atr: (number | null)[] = new Array(n).fill(null);
  const tr = bars.map((b, i) => i === 0
    ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
  const alpha = 2 / (length + 1);
  for (let i = length - 1; i < n; i++) {
    if (i === length - 1) {
      ema[i] = sma(close, i, length);
      atr[i] = sma(tr, i, length);
    } else {
      ema[i] = alpha * close[i] + (1 - alpha) * (ema[i - 1] as number);
      atr[i] = ((atr[i - 1] as number) * (length - 1) + tr[i]) / length;
    }
  }

  const raw: (number | null)[] = new Array(n).fill(null);
  for (let i = length - 1; i < n; i++) {
    const basis = sma(close, i, length);
    let ss = 0;
    for (let k = i - length + 1; k <= i; k++) ss += (close[k] - basis) ** 2;
    const sd = Math.sqrt(ss / length);
    const bbU = basis + bbMult * sd, bbL = basis - bbMult * sd;
    const kcU = (ema[i] as number) + kcMult * (atr[i] as number);
    const kcL = (ema[i] as number) - kcMult * (atr[i] as number);
    squeezeOn[i] = bbU < kcU && bbL > kcL;

    let hh = -Infinity, ll = Infinity;
    for (let k = i - length + 1; k <= i; k++) { hh = Math.max(hh, bars[k].high); ll = Math.min(ll, bars[k].low); }
    const meanPrice = ((hh + ll) / 2 + basis) / 2;
    raw[i] = close[i] - meanPrice;
  }

  // linreg over the last `length` raw values, evaluated at the last point.
  const xMean = (length - 1) / 2;
  let sxx = 0;
  for (let x = 0; x < length; x++) sxx += (x - xMean) ** 2;
  for (let i = 2 * length - 2; i < n; i++) {
    let yMean = 0;
    for (let k = 0; k < length; k++) yMean += raw[i - length + 1 + k] as number;
    yMean /= length;
    let sxy = 0;
    for (let k = 0; k < length; k++) sxy += (k - xMean) * ((raw[i - length + 1 + k] as number) - yMean);
    const slope = sxy / sxx;
    momentum[i] = yMean + slope * (length - 1 - xMean);
  }
  return { squeezeOn, momentum };
}

export type Alignment = "aligned" | "opposed" | "neutral";

export interface TtmTelemetry {
  ttm_length: number;
  ttm_bb_mult: number;
  ttm_kc_mult: number;
  ttm_timeframe: string;
  /** Index of the decision bar inside the prefix (its last bar), or null. */
  ttm_decision_bar_index: number | null;
  ttm_squeeze_on: boolean | null;
  ttm_release_detected: boolean;
  /** Bars since the most recent squeeze release, 0 = on the decision bar. */
  ttm_release_bars_ago: number | null;
  ttm_momentum: number | null;
  ttm_momentum_direction: "bullish" | "bearish" | null;
  ttm_momentum_slope: "rising" | "falling" | null;
  ttm_direction_alignment: Alignment;
}

/**
 * TTM state at the IPO entry decision.
 *
 * `prefix` MUST be the bars strictly before the entry (touch) bar; its LAST
 * element is the decision bar. Nothing outside `prefix` is read.
 *
 * A RELEASE at bar i is squeezeOn[i-1] === true && squeezeOn[i] === false:
 * the band containment ended on a bar whose close is already known.
 */
export function ttmAtDecision(
  prefix: Bar[], direction: "demand" | "supply", timeframe: string,
  length = TTM_LENGTH, bbMult = TTM_BB_MULT, kcMult = TTM_KC_MULT,
): TtmTelemetry {
  const base: TtmTelemetry = {
    ttm_length: length, ttm_bb_mult: bbMult, ttm_kc_mult: kcMult, ttm_timeframe: timeframe,
    ttm_decision_bar_index: null, ttm_squeeze_on: null, ttm_release_detected: false,
    ttm_release_bars_ago: null, ttm_momentum: null, ttm_momentum_direction: null,
    ttm_momentum_slope: null, ttm_direction_alignment: "neutral",
  };
  if (prefix.length === 0) return base;
  const s = ttmSeries(prefix, length, bbMult, kcMult);
  const d = prefix.length - 1;
  base.ttm_decision_bar_index = d;
  base.ttm_squeeze_on = s.squeezeOn[d];

  for (let i = d; i >= 1; i--) {
    if (s.squeezeOn[i - 1] === true && s.squeezeOn[i] === false) { base.ttm_release_bars_ago = d - i; break; }
  }
  base.ttm_release_detected = base.ttm_release_bars_ago !== null && base.ttm_release_bars_ago <= RECENT_RELEASE_BARS;

  const m = s.momentum[d];
  base.ttm_momentum = m;
  if (m !== null && m !== 0) base.ttm_momentum_direction = m > 0 ? "bullish" : "bearish";
  const prev = d >= 1 ? s.momentum[d - 1] : null;
  if (m !== null && prev !== null && m !== prev) base.ttm_momentum_slope = m > prev ? "rising" : "falling";

  if (base.ttm_momentum_direction) {
    const long = direction === "demand";
    base.ttm_direction_alignment =
      (long && base.ttm_momentum_direction === "bullish") || (!long && base.ttm_momentum_direction === "bearish")
        ? "aligned" : "opposed";
  }
  return base;
}

/** Mutually exclusive squeeze-timing cohort. SQUEEZE_ON takes precedence. */
export type SqueezePhase =
  | "SQUEEZE_ON" | "RELEASED_SAME_BAR" | "RELEASED_1_BAR_AGO" | "RELEASED_2_TO_3_BARS_AGO" | "NO_RECENT_SQUEEZE" | "UNAVAILABLE";

export function squeezePhase(t: TtmTelemetry): SqueezePhase {
  if (t.ttm_squeeze_on === null) return "UNAVAILABLE";
  if (t.ttm_squeeze_on) return "SQUEEZE_ON";
  const a = t.ttm_release_bars_ago;
  if (a === 0) return "RELEASED_SAME_BAR";
  if (a === 1) return "RELEASED_1_BAR_AGO";
  if (a === 2 || a === 3) return "RELEASED_2_TO_3_BARS_AGO";
  return "NO_RECENT_SQUEEZE";
}
