// §0.5 ATR14(1H) and §11.4: the only Baseline A function V2 uses is calculateATR.
// calculateATR cannot see MISSING bars and returns 0 for short input, so the presence check is done here.
import { calculateATR } from "../smcAnalysis.ts";
import { ATR_PERIOD } from "./spec.ts";
import { type Series, contiguous } from "./barStore.ts";

/**
 * Sum of the 14 true ranges ending at slot `i` (integer points), or null when not computable.
 * ATR = sum / 14; callers compare via the sum so every threshold test stays exact.
 */
export function atrSum(s: Series, i: number): number | null {
  const from = i - ATR_PERIOD;           // 15 consecutive present bars: i-14 … i
  if (!contiguous(s, from, i)) return null;
  const candles = [];
  for (let k = from; k <= i; k++) {
    const b = s.bars[k]!;
    candles.push({ datetime: new Date(b.t).toISOString(), open: b.o, high: b.h, low: b.l, close: b.c, volume: 0 });
  }
  const atr = calculateATR(candles as never, ATR_PERIOD);
  const sum = Math.round(atr * ATR_PERIOD);
  if (Math.abs(atr * ATR_PERIOD - sum) > 1e-6) throw new Error("calculateATR result is not an exact mean of integer true ranges");
  return sum;
}
